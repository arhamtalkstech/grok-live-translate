import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { config } from './config.js';

const DEBUG = process.env.LT_DEBUG === '1';

/**
 * One Grok Voice realtime session acting as an interpreter.
 *
 * Turn handling (all verified against the live API):
 * - `turn_detection: null`; the caller commits each turn and we send `response.create`.
 * - After every response the turn's user and assistant items are deleted. With history kept,
 *   the model sometimes re-spoke the end of the previous translation or answered the speaker.
 * - Only one response runs at a time; a turn committed during a response waits for it.
 */

export type InterpreterOptions = {
  instructions: string;
  voice: string;
  /** BCP-47 hint for input ASR; omit for auto-detect (same-device mode). */
  languageHint?: string;
  keyterms: string[];
  label: string;
  /**
   * Optional extra instructions per response (simultaneous mode passes the text already
   * interpreted for the current utterance). Unset everywhere else, so nothing changes there.
   */
  responseInstructions?: (turnIds: string[]) => string | undefined;
};

export type InterpreterEvents = {
  ready: [model: string];
  source: [turnId: string, text: string, final: boolean];
  translation: [turnId: string, delta: string];
  audio: [turnId: string, pcm16Base64: string];
  responseStarted: [turnId: string];
  done: [turnId: string, transcript: string];
  error: [message: string];
  closed: [];
};

type PendingTurn = { id: string; itemId?: string };
type Op =
  | { kind: 'audio'; turnId: string; data: Buffer }
  | { kind: 'commit'; turnId: string }
  | { kind: 'clear'; turnId: string };

export class Interpreter extends EventEmitter<InterpreterEvents> {
  private ws: WebSocket | null = null;
  private opts: InterpreterOptions;
  private openTurn: string | null = null;
  /** Committed turns waiting for the server to acknowledge the commit. */
  private awaitingCommit: string[] = [];
  /** Committed turns waiting for a response. */
  private queued: PendingTurn[] = [];
  private active: { turns: PendingTurn[]; responseId?: string; outputIds: string[]; transcript: string } | null =
    null;
  private itemToTurn = new Map<string, string>();
  private ops: Op[] = [];
  /** Turn whose audio is currently in the API's input buffer. */
  private sentTurn: string | null = null;
  private watchdog: NodeJS.Timeout | null = null;
  private closedByUs = false;
  model: string | null = null;

  constructor(opts: InterpreterOptions) {
    super();
    this.opts = opts;
  }

  connect(): Promise<string> {
    return new Promise((resolve, reject) => {
      const url = `${config.realtimeUrl}?model=${encodeURIComponent(config.model)}`;
      const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${config.apiKey}` } });
      this.ws = ws;
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error('Timed out connecting to the Grok Voice API'));
          ws.terminate();
        }
      }, 10_000);

      ws.on('open', () => this.send({ type: 'session.update', session: this.sessionConfig() }));
      ws.on('message', raw => {
        let e: Record<string, any>;
        try {
          e = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (e.type === 'session.created') this.model = e.session?.model ?? null;
        if (DEBUG && e.type === 'session.updated') console.log(`[xai ${this.opts.label}] input config`, JSON.stringify(e.session?.audio?.input?.transcription));
        if (e.type === 'session.updated' && !settled) {
          settled = true;
          clearTimeout(timer);
          this.emit('ready', this.model ?? config.model);
          resolve(this.model ?? config.model);
        }
        if (e.type === 'error' && !settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error(e.error?.message ?? 'Grok Voice API error'));
          return;
        }
        this.onEvent(e);
      });
      ws.on('unexpected-response', (_req, res) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error(`Grok Voice API rejected the connection (HTTP ${res.statusCode})`));
        }
      });
      ws.on('error', err => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(err);
        } else this.emit('error', err.message);
      });
      ws.on('close', () => {
        if (!this.closedByUs) this.emit('closed');
      });
    });
  }

  private sessionConfig() {
    const { instructions, voice, languageHint, keyterms } = this.opts;
    return {
      instructions,
      voice,
      reasoning: { effort: config.reasoningEffort },
      turn_detection: { type: null },
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: 24000 },
          transport: 'binary',
          transcription: {
            // grok-transcribe streams cumulative partials while the speaker talks (live captions).
            model: 'grok-transcribe',
            ...(languageHint ? { language_hint: languageHint } : {}),
            ...(keyterms.length ? { keyterms: keyterms.slice(0, 100).map(k => k.slice(0, 50)) } : {}),
          },
        },
        output: { format: { type: 'audio/pcm', rate: 24000 } },
      },
    };
  }

  update(opts: Partial<InterpreterOptions>): void {
    this.opts = { ...this.opts, ...opts };
    this.send({ type: 'session.update', session: this.sessionConfig() });
  }

  get busy(): boolean {
    return this.blocked || this.ops.length > 0;
  }

  /** A turn is in flight at the API: wait for its response before sending more audio. */
  private get blocked(): boolean {
    return this.active != null || this.queued.length > 0 || this.awaitingCommit.length > 0;
  }

  /** Start a new turn. Audio appended until commit belongs to it. */
  beginTurn(turnId: string): void {
    this.openTurn = turnId;
  }

  appendAudio(pcm16: Int16Array): void {
    if (!this.openTurn) return;
    this.ops.push({ kind: 'audio', turnId: this.openTurn, data: Buffer.from(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength) });
    this.pump();
  }

  commitTurn(): void {
    const id = this.openTurn;
    if (!id) return;
    this.openTurn = null;
    this.ops.push({ kind: 'commit', turnId: id });
    this.pump();
  }

  discardTurn(): void {
    const id = this.openTurn;
    this.openTurn = null;
    if (!id) return;
    this.ops = this.ops.filter(op => op.turnId !== id);
    for (const [item, turn] of this.itemToTurn) if (turn === id) this.itemToTurn.delete(item);
    if (this.sentTurn === id) this.ops.push({ kind: 'clear', turnId: id });
    this.pump();
  }

  /**
   * Send queued audio/commits while no turn is in flight. The API treats speech that arrives
   * during an active response as a barge-in (even with turn_detection: null) and merges turns,
   * so the next turn's audio waits here until the current translation has been generated.
   */
  private pump(): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    while (this.ops.length && !this.blocked) {
      const op = this.ops.shift()!;
      if (op.kind === 'audio') {
        this.sentTurn = op.turnId;
        this.ws.send(op.data);
      } else if (op.kind === 'commit') {
        this.awaitingCommit.push(op.turnId);
        this.sentTurn = null;
        this.send({ type: 'input_audio_buffer.commit' });
      } else {
        this.sentTurn = null;
        this.send({ type: 'input_audio_buffer.clear' });
      }
    }
    // Bound memory if the API stalls: keep at most ~60 s of held audio.
    let audioOps = 0;
    for (const op of this.ops) if (op.kind === 'audio') audioOps++;
    if (audioOps > 3000) this.ops.splice(this.ops.findIndex(op => op.kind === 'audio'), 1);
  }

  close(): void {
    this.closedByUs = true;
    this.clearWatchdog();
    this.ws?.close();
    this.ws = null;
  }

  private send(msg: { type: string } & Record<string, unknown>): void {
    if (DEBUG) console.log(`${new Date().toISOString().slice(11, 23)} [app ${this.opts.label}] ${msg.type}`);
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private turnForItem(itemId: string | undefined): string | null {
    if (!itemId) return null;
    const known = this.itemToTurn.get(itemId);
    if (known) return known;
    // Partials for a new item arrive before the commit; they belong to the turn being spoken.
    const guess = this.sentTurn ?? this.awaitingCommit[0] ?? null;
    if (guess) this.itemToTurn.set(itemId, guess);
    return guess;
  }

  private maybeStartResponse(): void {
    if (this.active || this.queued.length === 0) return;
    const turns = this.queued.splice(0);
    this.active = { turns, outputIds: [], transcript: '' };
    const extra = this.opts.responseInstructions?.(turns.map(t => t.id));
    this.send({
      type: 'response.create',
      response: {
        metadata: { turns: turns.map(t => t.id).join(',') },
        ...(extra ? { instructions: `${this.opts.instructions}\n\n${extra}` } : {}),
      },
    });
    this.armWatchdog();
  }

  private onEvent(e: Record<string, any>): void {
    if (DEBUG && !String(e.type).endsWith('.delta') && e.type !== 'ping') {
      console.log(`${new Date().toISOString().slice(11, 23)} [xai ${this.opts.label}] ${e.type}`, e.type === 'error' ? e.error?.message : (e.transcript ?? e.item_id ?? '').toString().slice(0, 60));
    }
    switch (e.type) {
      case 'conversation.item.input_audio_transcription.updated':
      case 'conversation.item.input_audio_transcription.completed': {
        const turn = this.turnForItem(e.item_id);
        const final = e.type.endsWith('completed') && e.status === 'completed';
        if (turn && typeof e.transcript === 'string') this.emit('source', turn, e.transcript, final);
        break;
      }
      case 'input_audio_buffer.committed': {
        const turn = this.awaitingCommit.shift();
        if (!turn) break;
        if (e.item_id) this.itemToTurn.set(e.item_id, turn);
        this.queued.push({ id: turn, itemId: e.item_id });
        this.maybeStartResponse();
        break;
      }
      case 'response.created':
        if (this.active) {
          this.active.responseId = e.response?.id;
          for (const t of this.active.turns) this.emit('responseStarted', t.id);
        }
        break;
      case 'response.output_item.added':
        if (this.active && e.item?.id) this.active.outputIds.push(e.item.id);
        break;
      case 'response.output_audio_transcript.delta':
        if (this.active && e.delta) {
          this.active.transcript += e.delta;
          this.emit('translation', this.lastTurn(), e.delta);
        }
        break;
      case 'response.output_audio.delta':
        if (this.active && e.delta) this.emit('audio', this.lastTurn(), e.delta);
        break;
      case 'response.done': {
        const done = this.active;
        this.active = null;
        if (!done) break;
        const transcript = done.transcript || extractTranscript(e.response);
        for (const t of done.turns) this.emit('done', t.id, t === done.turns.at(-1) ? transcript : '');
        // Stateless: drop this exchange so the next turn is translated on its own.
        const ids = new Set<string>([...done.outputIds, ...(e.response?.output ?? []).map((o: any) => o.id)]);
        for (const t of done.turns) if (t.itemId) ids.add(t.itemId);
        for (const id of ids) {
          if (!id) continue;
          this.send({ type: 'conversation.item.delete', item_id: id });
          this.itemToTurn.delete(id);
        }
        this.clearWatchdog();
        this.maybeStartResponse();
        this.pump();
        break;
      }
      case 'error': {
        const message: string = e.error?.message ?? 'Grok Voice API error';
        // Deleting an item the server already dropped is harmless.
        if (/item not found/i.test(message)) break;
        this.emit('error', message);
        break;
      }
    }
  }

  /** If a response never finishes, release the queue so the conversation keeps going. */
  private armWatchdog(): void {
    this.clearWatchdog();
    this.watchdog = setTimeout(() => {
      const stuck = this.active;
      if (!stuck) return;
      this.active = null;
      for (const t of stuck.turns) this.emit('done', t.id, stuck.transcript);
      this.emit('error', 'A translation took too long and was skipped.');
      this.maybeStartResponse();
      this.pump();
    }, 45_000);
  }

  private clearWatchdog(): void {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = null;
  }

  private lastTurn(): string {
    return this.active?.turns.at(-1)?.id ?? '';
  }
}

function extractTranscript(response: any): string {
  for (const item of response?.output ?? []) {
    for (const c of item?.content ?? []) if (typeof c?.transcript === 'string') return c.transcript;
  }
  return '';
}

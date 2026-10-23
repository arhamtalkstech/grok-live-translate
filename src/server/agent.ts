import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { config } from './config.js';

const DEBUG = process.env.LT_DEBUG === '1';

/**
 * A persona agent on its own Grok Voice session. It hears the other party only as the
 * interpreter's translated audio (appended here), and its spoken reply is real model audio.
 * Unlike the interpreter it keeps its conversation history.
 */
export type AgentEvents = {
  audio: [pcm16Base64: string];
  transcript: [delta: string];
  responseStarted: [];
  done: [transcript: string];
  endCall: [];
  error: [message: string];
};

export class AgentSession extends EventEmitter<AgentEvents> {
  private ws: WebSocket | null = null;
  private responding = false;
  private awaitingCommit = false;
  private transcript = '';
  private closed = false;
  /** Text of a scripted opening, used as the transcript if the server sends none. */
  private forced = '';
  /** Responses we asked for and have not seen start yet. */
  private expected = 0;
  /** Responses the server started on its own; they are cancelled and their output dropped. */
  private ignored = new Set<string>();

  constructor(
    private readonly label: string,
    private readonly instructions: string,
    private readonly voice: string,
    /** Language this agent hears (the interpreter's output), pinned for its input recognition. */
    private readonly hears: string,
  ) {
    super();
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${config.realtimeUrl}?model=${encodeURIComponent(config.model)}`, {
        headers: { Authorization: `Bearer ${config.apiKey}` },
      });
      this.ws = ws;
      let ready = false;
      const timer = setTimeout(() => !ready && (ws.terminate(), reject(new Error('Timed out connecting an agent'))), 10_000);
      ws.on('open', () =>
        this.send({
          type: 'session.update',
          session: {
            instructions: this.instructions,
            voice: this.voice,
            reasoning: { effort: config.reasoningEffort },
            turn_detection: { type: null },
            tools: [
              {
                type: 'function',
                name: 'end_call',
                description: 'End the phone call. Call this right after you have said your final goodbye.',
                parameters: { type: 'object', properties: {} },
              },
            ],
            audio: {
              input: {
                format: { type: 'audio/pcm', rate: 24000 },
                transport: 'binary',
                transcription: { model: 'grok-transcribe', language_hint: this.hears },
              },
              output: { format: { type: 'audio/pcm', rate: 24000 } },
            },
          },
        }),
      );
      ws.on('message', raw => {
        let e: Record<string, any>;
        try {
          e = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (DEBUG && !String(e.type).endsWith('.delta')) console.log(`${new Date().toISOString().slice(11, 23)} [agent ${this.label}] ${e.type}`, e.type === 'error' ? e.error?.message : '');
        if (DEBUG && e.type === 'session.updated') console.log(`[agent ${this.label}] input config`, JSON.stringify(e.session?.audio?.input?.transcription));
        if (e.type === 'session.updated' && !ready) {
          ready = true;
          clearTimeout(timer);
          resolve();
        }
        if (e.type === 'error' && !ready) {
          clearTimeout(timer);
          reject(new Error(e.error?.message ?? 'Agent session error'));
        }
        this.onEvent(e);
      });
      ws.on('error', err => (ready ? this.emit('error', err.message) : reject(err)));
      ws.on('close', () => {
        if (!this.closed) this.emit('error', 'An agent session closed unexpectedly.');
      });
    });
  }

  /** Translated audio of the other party, as the agent hears it. */
  hear(pcm16: Buffer): void {
    if (this.ws?.readyState === WebSocket.OPEN && !this.responding) {
      this.heardBytes += pcm16.length;
      this.ws.send(pcm16);
    }
  }

  /** Audio sent since the last commit. */
  private heardBytes = 0;
  /** Line to speak verbatim once the pending commit lands (see `reply(line)`). */
  private pendingLine: string | null = null;
  private commitTimer: NodeJS.Timeout | null = null;

  /**
   * The other party finished: commit what was heard and answer. With `line`, the answer is that
   * line spoken verbatim (a scripted turn) instead of a generated reply.
   */
  reply(line?: string): void {
    this.pendingLine = line?.trim() || null;
    const heard = this.heardBytes;
    this.heardBytes = 0;
    if (DEBUG) console.log(`${new Date().toISOString().slice(11, 23)} [agent-app ${this.label}] reply after hearing ${(heard / 48000).toFixed(1)} s`);
    // Committing an empty buffer gets no reply at all from the API (no ack, no error), which
    // left the call waiting forever when a translation came back empty. Answer directly instead.
    if (heard < 4800) {
      this.answer();
      return;
    }
    this.awaitingCommit = true;
    this.send({ type: 'input_audio_buffer.commit' });
    // Same safety net if the acknowledgement never arrives.
    if (this.commitTimer) clearTimeout(this.commitTimer);
    this.commitTimer = setTimeout(() => {
      if (!this.awaitingCommit || this.closed) return;
      this.awaitingCommit = false;
      this.answer();
    }, 3000);
  }

  /** Open the conversation, verbatim when a line is given. */
  open(line: string): void {
    this.transcript = '';
    if (line.trim()) {
      this.responding = true;
      this.expected++;
      this.forced = line.trim();
      this.send({
        type: 'conversation.item.create',
        item: { type: 'force_message', role: 'assistant', content: [{ type: 'output_text', text: line.trim() }] },
      });
    } else {
      this.startResponse('Begin the call now with your opening line.');
    }
  }

  private answer(): void {
    const line = this.pendingLine;
    this.pendingLine = null;
    if (line) this.open(line);
    else this.startResponse();
  }

  close(): void {
    this.closed = true;
    if (this.commitTimer) clearTimeout(this.commitTimer);
    this.ws?.close();
    this.ws = null;
  }

  private startResponse(instructions?: string): void {
    this.responding = true;
    this.expected++;
    this.transcript = '';
    this.send({ type: 'response.create', ...(instructions ? { response: { instructions: `${this.instructions}\n\n${instructions}` } } : {}) });
  }

  private send(msg: Record<string, unknown>): void {
    if (DEBUG) console.log(`${new Date().toISOString().slice(11, 23)} [agent-app ${this.label}] ${String(msg.type)}`);
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private onEvent(e: Record<string, any>): void {
    const responseId: string | undefined = e.response_id ?? e.response?.id;
    if (responseId && this.ignored.has(responseId)) {
      if (e.type === 'response.done') this.ignored.delete(responseId);
      return;
    }
    switch (e.type) {
      case 'input_audio_buffer.committed':
        if (this.awaitingCommit) {
          this.awaitingCommit = false;
          this.answer();
        }
        break;
      case 'response.created':
        if (this.expected === 0) {
          // Only one agent may talk at a time; drop a turn the server started by itself.
          if (responseId) {
            this.ignored.add(responseId);
            this.send({ type: 'response.cancel', response_id: responseId });
          }
          break;
        }
        this.expected--;
        this.responding = true;
        this.emit('responseStarted');
        break;
      case 'response.output_audio.delta':
        if (e.delta) this.emit('audio', e.delta);
        break;
      case 'response.output_audio_transcript.delta':
        if (e.delta) {
          this.transcript += e.delta;
          this.emit('transcript', e.delta);
        }
        break;
      case 'response.function_call_arguments.done':
        if (e.name === 'end_call') this.emit('endCall');
        break;
      case 'response.done': {
        this.responding = false;
        const calledEnd = (e.response?.output ?? []).some((o: any) => o.type === 'function_call' && o.name === 'end_call');
        if (calledEnd) this.emit('endCall');
        this.emit('done', this.transcript || this.forced);
        this.forced = '';
        break;
      }
      case 'error': {
        const message: string = e.error?.message ?? 'Agent error';
        // A commit with an empty buffer (nothing heard) is not fatal; just reply anyway.
        if (/buffer.*(empty|too small)|no audio/i.test(message) && this.awaitingCommit && !this.responding) {
          this.awaitingCommit = false;
          this.answer();
          break;
        }
        this.emit('error', message);
      }
    }
  }
}

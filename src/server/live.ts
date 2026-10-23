import { randomUUID } from 'node:crypto';
import { AgentSession } from './agent.js';
import { Interpreter } from './interpreter.js';
import { Pacer } from './pacer.js';
import { fragmentContext, simultaneousPrompt } from './prompts.js';
import { getScenario, SCENARIOS } from './scenarios.js';
import { TurnDetector } from './turn-detector.js';
import { SAMPLE_RATE, type AgentsState, type Segment, type ServerMessage, type Slot } from '../shared/protocol.js';

const OTHER: Record<Slot, Slot> = { a: 'b', b: 'a' };

/** What the live conversation needs from its room. */
export type LiveHost = {
  id: string;
  languages: Record<Slot, string>;
  keyterms: string[];
  upsert(seg: Segment): void;
  patch(id: string, patch: Partial<Segment>): void;
  segment(id: string): Segment | undefined;
  clearSegments(): void;
  broadcast(msg: ServerMessage): void;
  /** Audio for one seat's window; falls back to whichever window is open. */
  sendToSeat(slot: Slot, msg: ServerMessage): void;
  stateChanged(): void;
  setModel(model: string): void;
};

type Utterance = {
  segId: string;
  speaker: Slot;
  /** First agent audio (≈ when the speaker starts talking in the window). */
  startedAt: number;
  /** Fragment ids in order, and their latest source captions. */
  chunks: string[];
  chunkText: Map<string, string>;
  /** Interpreted text so far, fragment by fragment. */
  said: string[];
  pending: number;
  /** Index of the fragment whose translation may play now; later ones wait, in order. */
  released: number;
  held: Map<string, string[]>;
  finished: Set<string>;
  agentDone: boolean;
  allCommitted: boolean;
  firstAudio: boolean;
};

/**
 * Simultaneous interpretation of the two-agent call (mode "live").
 *
 * The speaking agent's audio is paced like a live mic into its interpreter. A turn detector cuts
 * it into fragments at short pauses; each fragment is committed and interpreted while the agent
 * keeps talking, with the text already said passed as context so the fragments read as one
 * utterance. The listening agent hears the translated audio as it plays and replies once the
 * last fragment has been heard. The single window plays the original voice quietly under the
 * translation.
 */
export class LiveConversation {
  state: AgentsState;
  private run: {
    agents: Record<Slot, AgentSession>;
    /**
     * Two interpreter sessions per direction, used in turn: while one interprets a fragment,
     * the next fragment streams live into the other. With one session the next fragment had to
     * wait and then arrive in a burst, and the lag grew with every fragment.
     */
    interps: Record<Slot, Interpreter[]>;
    feed: Record<Slot, Pacer>;
    ears: Record<Slot, Pacer>;
    chunker: Record<Slot, TurnDetector>;
    utt: Record<Slot, Utterance | null>;
    /** Fragment id → utterance. */
    chunkOf: Map<string, Utterance>;
    openChunk: Record<Slot, string | null>;
    chunkSession: Map<string, Interpreter>;
    nextSession: Record<Slot, number>;
    ending: boolean;
    timers: Set<NodeJS.Timeout>;
    scenarioNames: Record<Slot, string>;
  } | null = null;

  constructor(private readonly host: LiveHost) {
    this.state = LiveConversation.idle(SCENARIOS[0]!.id);
  }

  static idle(scenarioId: string): AgentsState {
    const sc = getScenario(scenarioId);
    return {
      running: false,
      scenarioId: sc.id,
      active: null,
      phase: 'idle',
      turns: 0,
      maxTurns: 12,
      names: { a: sc.agents.a.name, b: sc.agents.b.name },
      roles: { a: sc.agents.a.role, b: sc.agents.b.role },
    };
  }

  get running(): boolean {
    return this.run != null;
  }

  private set(patch: Partial<AgentsState>): void {
    this.state = { ...this.state, ...patch };
    this.host.stateChanged();
  }

  private later(ms: number, fn: () => void): void {
    const run = this.run;
    if (!run) return;
    const t = setTimeout(() => {
      run.timers.delete(t);
      if (this.run === run) fn();
    }, Math.max(0, ms));
    run.timers.add(t);
  }

  async start(scenarioId: string, opening: string | undefined, maxTurns: number | undefined): Promise<void> {
    if (this.run) return;
    const sc = getScenario(scenarioId);
    const langs = this.host.languages;
    const terms = [...new Set([...this.host.keyterms, sc.agents.a.name, sc.agents.b.name])];
    this.host.clearSegments();

    const run: NonNullable<LiveConversation['run']> = {
      agents: {
        a: new AgentSession(`${this.host.id}:live-a`, sc.agents.a.instructions, sc.agents.a.voice, langs.a),
        b: new AgentSession(`${this.host.id}:live-b`, sc.agents.b.instructions, sc.agents.b.voice, langs.b),
      },
      interps: { a: [], b: [] },
      feed: {} as Record<Slot, Pacer>,
      ears: {} as Record<Slot, Pacer>,
      chunker: {} as Record<Slot, TurnDetector>,
      utt: { a: null, b: null },
      chunkOf: new Map(),
      openChunk: { a: null, b: null },
      chunkSession: new Map(),
      nextSession: { a: 0, b: 0 },
      ending: false,
      timers: new Set(),
      scenarioNames: { a: sc.agents.a.name, b: sc.agents.b.name },
    };
    for (const slot of ['a', 'b'] as const) {
      for (let i = 0; i < 2; i++) {
        run.interps[slot].push(
          new Interpreter({
            instructions: simultaneousPrompt(langs[slot], langs[OTHER[slot]], terms),
            voice: sc.agents[slot].voice,
            languageHint: langs[slot],
            keyterms: terms,
            label: `${this.host.id}:live-interp-${slot}${i}`,
            responseInstructions: ids => {
              const u = ids[0] ? run.chunkOf.get(ids[0]) : undefined;
              if (!u) return undefined;
              const idx = u.chunks.indexOf(ids[0]!);
              const heard = u.chunks.slice(0, idx).map(c => u.chunkText.get(c) ?? '').filter(Boolean).join(' ');
              return fragmentContext(u.said.slice(0, idx).filter(Boolean).join(' '), idx + 1, heard);
            },
          }),
        );
      }
      run.chunker[slot] = new TurnDetector({
        sampleRate: SAMPLE_RATE,
        // Fragments end at short pauses (commas, sentence ends) once they have some substance.
        endSilenceMs: 300,
        prerollMs: 150,
        // A sliver after a cut (the end of a word) is dropped instead of interpreted on its own.
        minSpeechMs: 450,
        chunkAfterMs: 1500,
        chunkPauseMs: 200,
        maxTurnMs: 7000,
      });
      run.feed[slot] = new Pacer(frame => this.onFeedFrame(slot, frame));
      run.ears[slot] = new Pacer(frame => run.agents[slot].hear(Buffer.from(frame)));
    }
    this.run = run;
    this.state = {
      ...LiveConversation.idle(sc.id),
      running: true,
      phase: 'connecting',
      active: sc.starter,
      maxTurns: Math.min(30, Math.max(2, Math.round(maxTurns ?? 12))),
    };
    this.host.stateChanged();

    for (const slot of ['a', 'b'] as const) {
      this.wireAgent(slot);
      this.wireInterp(slot);
    }
    try {
      const [, , model] = await Promise.all([
        run.agents.a.connect(),
        run.agents.b.connect(),
        ...run.interps.a.map(i => i.connect()),
        ...run.interps.b.map(i => i.connect()),
      ]);
      this.host.setModel(model as string);
    } catch (err) {
      this.host.broadcast({ type: 'error', message: `Could not start: ${(err as Error).message}` });
      return this.stop('Connection failed');
    }
    if (this.run !== run) return;
    this.set({ phase: 'thinking', active: sc.starter });
    run.agents[sc.starter].open(opening ?? sc.opening);
  }

  stop(reason: string): void {
    const run = this.run;
    if (!run) return;
    this.run = null;
    for (const t of run.timers) clearTimeout(t);
    for (const slot of ['a', 'b'] as const) {
      run.feed[slot].stop();
      run.ears[slot].stop();
      run.agents[slot].removeAllListeners();
      run.agents[slot].close();
      for (const i of run.interps[slot]) {
        i.removeAllListeners();
        i.close();
      }
    }
    this.set({ running: false, phase: 'ended', active: null, endedReason: reason });
  }

  // --- speaker side --------------------------------------------------------------------------

  private wireAgent(slot: Slot): void {
    const run = this.run!;
    const agent = run.agents[slot];
    const langs = this.host.languages;

    agent.on('audio', b64 => {
      if (this.run !== run || this.state.active !== slot) return;
      let u = run.utt[slot];
      if (!u) {
        u = {
          segId: randomUUID(),
          speaker: slot,
          startedAt: Date.now(),
          chunks: [],
          chunkText: new Map(),
          said: [],
          pending: 0,
          released: 0,
          held: new Map(),
          finished: new Set(),
          agentDone: false,
          allCommitted: false,
          firstAudio: false,
        };
        run.utt[slot] = u;
        run.chunker[slot].reset();
        this.host.upsert({
          id: u.segId,
          slot,
          speakerName: run.scenarioNames[slot],
          srcLang: langs[slot],
          dstLang: langs[OTHER[slot]],
          source: '',
          sourceFinal: false,
          translation: '',
          translationFinal: false,
          status: 'listening',
          startedAt: u.startedAt,
        });
        this.set({ phase: 'speaking', active: slot, turns: this.state.turns + 1 });
      }
      // The window plays the original voice (quietly) from the first delta; the pacer feeds
      // the interpreter on the same real-time clock.
      // The speaker's own window plays their voice (quietly); a single window plays everything.
      this.host.sendToSeat(slot, { type: 'audio', segmentId: u.segId, kind: 'original', data: b64 });
      run.feed[slot].push(Buffer.from(b64, 'base64'));
    });

    agent.on('endCall', () => {
      if (this.run) this.run.ending = true;
    });

    agent.on('done', () => {
      if (this.run !== run || this.state.active !== slot) return;
      const u = run.utt[slot];
      if (!u) {
        if (run.ending) this.stop(`${run.scenarioNames[slot]} ended the call`);
        else run.agents[OTHER[slot]].reply();
        return;
      }
      u.agentDone = true;
      this.host.broadcast({ type: 'audio_end', segmentId: u.segId, kind: 'original' });
      // When the original has been fed completely, close the last fragment.
      run.feed[slot].whenDrained(() =>
        this.later(120, () => {
          for (const ev of run.chunker[slot].flush()) this.onChunkEvent(slot, ev);
          if (run.openChunk[slot]) this.commitChunk(slot);
          u.allCommitted = true;
          this.host.patch(u.segId, { sourceFinal: true });
          this.maybeFinish(slot);
        }),
      );
    });

    agent.on('error', message => this.host.broadcast({ type: 'error', message: `${run.scenarioNames[slot]}: ${message}` }));
  }

  private onFeedFrame(slot: Slot, frame: Buffer): void {
    const run = this.run;
    if (!run) return;
    const copy = new Uint8Array(frame.byteLength & ~1);
    copy.set(frame.subarray(0, copy.byteLength));
    for (const ev of run.chunker[slot].push(new Int16Array(copy.buffer))) this.onChunkEvent(slot, ev);
  }

  private onChunkEvent(slot: Slot, ev: ReturnType<TurnDetector['push']>[number]): void {
    const run = this.run;
    const u = run?.utt[slot];
    if (!run || !u) return;
    const open = run.openChunk[slot];
    switch (ev.type) {
      case 'start': {
        const id = randomUUID();
        const pool = run.interps[slot];
        // Prefer an idle session; otherwise alternate.
        let interp = pool.find(i => !i.busy);
        if (!interp) {
          interp = pool[run.nextSession[slot] % pool.length]!;
          run.nextSession[slot]++;
        }
        run.openChunk[slot] = id;
        run.chunkSession.set(id, interp);
        u.chunks.push(id);
        run.chunkOf.set(id, u);
        interp.beginTurn(id);
        for (const f of ev.preroll) interp.appendAudio(f);
        break;
      }
      case 'audio':
        if (open) run.chunkSession.get(open)?.appendAudio(ev.frame);
        break;
      case 'end':
        this.commitChunk(slot);
        break;
      case 'discard': {
        const id = run.openChunk[slot];
        run.openChunk[slot] = null;
        if (id) {
          u.chunks = u.chunks.filter(c => c !== id);
          run.chunkOf.delete(id);
          run.chunkSession.get(id)?.discardTurn();
          run.chunkSession.delete(id);
        }
        break;
      }
    }
  }

  private commitChunk(slot: Slot): void {
    const run = this.run;
    const u = run?.utt[slot];
    const id = run?.openChunk[slot];
    if (!run || !u || !id) return;
    run.openChunk[slot] = null;
    u.pending++;
    run.chunkSession.get(id)?.commitTurn();
    if (this.state.phase === 'speaking') this.host.patch(u.segId, { status: 'translating' });
  }

  // --- interpreter side ----------------------------------------------------------------------

  private wireInterp(slot: Slot): void {
    for (const interp of this.run!.interps[slot]) this.wireSession(slot, interp);
  }

  private wireSession(slot: Slot, interp: Interpreter): void {
    const run = this.run!;

    interp.on('source', (chunkId, text) => {
      const u = run.chunkOf.get(chunkId);
      if (!u) return;
      u.chunkText.set(chunkId, text);
      const source = u.chunks.map(c => u.chunkText.get(c) ?? '').filter(Boolean).join(' ');
      this.host.patch(u.segId, { source });
    });

    interp.on('translation', (chunkId, delta) => {
      const u = run.chunkOf.get(chunkId);
      if (!u || !this.host.segment(u.segId)) return;
      const idx = u.chunks.indexOf(chunkId);
      u.said[idx] = (u.said[idx] ?? '') + delta;
      this.host.patch(u.segId, { translation: joinFragments(u.said) });
    });

    interp.on('audio', (chunkId, b64) => {
      const u = run.chunkOf.get(chunkId);
      if (!u) return;
      if (u.chunks.indexOf(chunkId) === u.released) this.emitTranslation(slot, u, b64);
      else u.held.set(chunkId, [...(u.held.get(chunkId) ?? []), b64]);
    });

    interp.on('done', chunkId => {
      const u = run.chunkOf.get(chunkId);
      if (!u) return;
      u.pending = Math.max(0, u.pending - 1);
      u.finished.add(chunkId);
      // Release fragments in order: everything up to the first one still being interpreted.
      while (u.released < u.chunks.length && u.finished.has(u.chunks[u.released]!)) {
        u.released++;
        const next = u.chunks[u.released];
        if (!next) break;
        for (const b64 of u.held.get(next) ?? []) this.emitTranslation(slot, u, b64);
        u.held.delete(next);
      }
      this.maybeFinish(slot);
    });

    interp.on('error', message => this.host.broadcast({ type: 'error', message }));
    interp.on('closed', () => this.stop('An interpreter session closed'));
  }

  private emitTranslation(slot: Slot, u: Utterance, b64: string): void {
    const run = this.run;
    if (!run) return;
    if (!u.firstAudio) {
      u.firstAudio = true;
      const now = Date.now();
      this.host.patch(u.segId, { status: 'speaking', firstAudioAt: now, lagMs: now - u.startedAt });
    }
    // The interpretation plays in the listener's window.
    this.host.sendToSeat(OTHER[slot], { type: 'audio', segmentId: u.segId, kind: 'translation', data: b64 });
    run.ears[OTHER[slot]].push(Buffer.from(b64, 'base64'));
  }

  /** All fragments interpreted: once the listener has heard them, it replies. */
  private maybeFinish(slot: Slot): void {
    const run = this.run;
    const u = run?.utt[slot];
    if (!run || !u || !u.agentDone || !u.allCommitted || u.pending > 0 || u.released < u.chunks.length) return;
    run.utt[slot] = null;
    const seg = this.host.segment(u.segId);
    this.host.patch(u.segId, { status: 'done', translationFinal: true, translation: joinFragments(u.said) || seg?.translation || '' });
    this.host.broadcast({ type: 'audio_end', segmentId: u.segId, kind: 'translation' });
    const listener = OTHER[slot];
    this.set({ phase: 'interpreting', active: slot });
    run.ears[listener].whenDrained(() =>
      this.later(300, () => {
        if (run.ending) return this.stop(`${run.scenarioNames[slot]} ended the call`);
        if (this.state.turns >= this.state.maxTurns) return this.stop('Turn limit reached');
        this.set({ phase: 'thinking', active: listener });
        run.agents[listener].reply();
      }),
    );
  }
}

/** Join fragment translations; capitalize a fragment that starts a new sentence. */
export function joinFragments(parts: (string | undefined)[]): string {
  let out = '';
  for (const raw of parts) {
    const p = (raw ?? '').trim();
    if (!p) continue;
    const startsSentence = out === '' || /[.!?।]["»”']?$/.test(out);
    const piece = startsSentence ? p.charAt(0).toLocaleUpperCase() + p.slice(1) : p;
    out = out ? `${out} ${piece}` : piece;
  }
  return out;
}

import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { config } from './config.js';
import { detectLanguage } from './detect.js';
import { AgentSession } from './agent.js';
import { Interpreter } from './interpreter.js';
import { SCENARIOS, getScenario, type Scenario } from './scenarios.js';
import { BuilderCall } from './builder/call.js';
import { getBuilderConfig } from './builder/index.js';
import { LiveConversation } from './live.js';
import { Pacer } from './pacer.js';
import { oneWayPrompt, twoWayPrompt } from './prompts.js';
import { TurnDetector, levelDb } from './turn-detector.js';

const DEBUG = process.env.LT_DEBUG === '1';
import { getLanguage, isLanguage } from '../shared/languages.js';
import {
  SAMPLE_RATE,
  type AgentsState,
  type ClientMessage,
  type Mode,
  type ParticipantSettings,
  type RoomSettings,
  type RoomSnapshot,
  type Segment,
  type ServerMessage,
  type Slot,
  type SlotState,
} from '../shared/protocol.js';

const OTHER: Record<Slot, Slot> = { a: 'b', b: 'a' };
const MAX_SEGMENTS = 300;

type Client = {
  ws: WebSocket;
  slot: Slot;
  participant: ParticipantSettings;
  state: SlotState;
  interpreter: Interpreter | null;
  detector: TurnDetector;
  /** Segment currently being spoken. */
  turnId: string | null;
  pttDown: boolean;
};

export class Room {
  readonly id: string;
  readonly mode: Mode;
  settings: RoomSettings;
  private clients = new Map<Slot, Client>();
  private names: Record<Slot, string> = { a: '', b: '' };
  private voices: Record<Slot, string> = { a: 'eve', b: 'rex' };
  private segments = new Map<string, Segment>();
  private audioBytes = new Map<string, number>();
  private model: string | null = null;
  private debugFrames = new Map<Slot, number>();

  /** Simultaneous mode controller (mode "live" only). */
  private live: LiveConversation | null = null;
  /** Agent builder call (mode "builder" only). */
  private builder: BuilderCall | null = null;

  constructor(id: string, mode: Mode, settings: RoomSettings) {
    this.id = id;
    this.mode = mode;
    this.settings = settings;
    if (mode === 'live') {
      this.settings.languages = { a: 'hi', b: 'de' };
      this.live = new LiveConversation({
        id,
        languages: this.settings.languages,
        keyterms: this.settings.keyterms,
        upsert: seg => this.upsert(seg),
        patch: (segId, p) => this.patch(segId, p),
        segment: segId => this.segments.get(segId),
        clearSegments: () => {
          this.segments.clear();
          this.broadcast({ type: 'segments', segments: [] });
        },
        broadcast: msg => this.broadcast(msg),
        sendToSeat: (slot, msg) => {
          const c = this.clients.get(slot) ?? this.clients.get(OTHER[slot]);
          if (c) this.sendTo(c, msg);
        },
        stateChanged: () => this.broadcastRoom(),
        setModel: m => (this.model = m),
      });
      const st = this.live.state;
      this.names = { ...st.names };
    }
  }

  get empty(): boolean {
    return this.clients.size === 0;
  }

  hasSlot(slot: Slot): boolean {
    return this.clients.has(slot);
  }

  join(ws: WebSocket, slot: Slot, participant: ParticipantSettings): void {
    const existing = this.clients.get(slot);
    if (existing) this.leave(existing.ws, 'Another browser took over this seat.');
    const client: Client = {
      ws,
      slot,
      participant,
      state: 'idle',
      interpreter: null,
      detector: new TurnDetector({
        sampleRate: SAMPLE_RATE,
        endSilenceMs: participant.endSilenceMs,
        maxTurnMs: config.maxTurnMs,
      }),
      turnId: null,
      pttDown: false,
    };
    this.clients.set(slot, client);
    if (this.mode !== 'agents' && this.mode !== 'live') {
      this.names[slot] = participant.name;
      this.voices[slot] = participant.voice;
    }
    this.sendTo(client, {
      type: 'joined',
      slot,
      room: this.snapshot(),
      segments: [...this.segments.values()],
    });
    this.broadcastRoom();
  }

  leave(ws: WebSocket, reason?: string): void {
    for (const [slot, c] of this.clients) {
      if (c.ws !== ws) continue;
      if (reason) this.sendTo(c, { type: 'error', message: reason });
      this.stopClient(c, true);
      this.clients.delete(slot);
    }
    if (this.clients.size === 0) {
      this.stopAgents('Everyone left');
      this.live?.stop('Everyone left');
      this.builder?.stop('Everyone left');
      this.builder = null;
    }
    this.broadcastRoom();
  }

  handle(ws: WebSocket, msg: ClientMessage): void {
    const client = [...this.clients.values()].find(c => c.ws === ws);
    if (!client) return;
    switch (msg.type) {
      case 'start':
        if (this.mode !== 'agents' && this.mode !== 'live' && this.mode !== 'builder') void this.startClient(client);
        break;
      case 'agents_start':
        if (this.mode === 'agents') void this.startAgents(msg.scenarioId, msg.opening, msg.maxTurns);
        else if (this.mode === 'live') void this.live?.start(msg.scenarioId, msg.opening, msg.maxTurns);
        break;
      case 'agents_stop':
        this.stopAgents('Stopped');
        this.live?.stop('Stopped');
        break;
      case 'builder_start':
        if (this.mode === 'builder') void this.startBuilder(msg.configId, msg.caller, msg.scriptId);
        break;
      case 'builder_stop':
        this.builder?.stop('Stopped');
        this.builder = null;
        break;
      case 'stop':
        this.stopClient(client, false);
        break;
      case 'participant':
        this.updateParticipant(client, msg.participant);
        break;
      case 'room':
        this.updateRoom(msg.settings);
        break;
      case 'ptt':
        this.onPtt(client, msg.down);
        break;
      case 'clear':
        this.segments.clear();
        this.broadcast({ type: 'segments', segments: [] });
        break;
    }
  }

  /** Mic audio from a browser: PCM16 mono 24 kHz. */
  audio(ws: WebSocket, data: Buffer): void {
    if (this.mode === 'builder') {
      this.builder?.micAudio(data);
      return;
    }
    const client = [...this.clients.values()].find(c => c.ws === ws);
    if (!client || client.state !== 'listening' || !client.interpreter) return;
    const samples = new Int16Array(data.buffer.slice(data.byteOffset, data.byteOffset + (data.byteLength & ~1)));

    if (DEBUG) {
      const n = (this.debugFrames.get(client.slot) ?? 0) + 1;
      this.debugFrames.set(client.slot, n);
      if (n % 50 === 0) console.log(`[mic ${this.id}:${client.slot}] ${samples.length} samples/frame, level ${levelDb(samples).toFixed(1)} dBFS`);
    }
    if (client.participant.turnMode === 'ptt') {
      if (client.pttDown && client.turnId) client.interpreter.appendAudio(samples);
      return;
    }
    for (const ev of client.detector.push(samples)) this.onTurnEvent(client, ev);
  }

  private onTurnEvent(client: Client, ev: ReturnType<TurnDetector['push']>[number]): void {
    const interp = client.interpreter;
    if (!interp) return;
    switch (ev.type) {
      case 'start':
        this.openTurn(client);
        for (const f of ev.preroll) interp.appendAudio(f);
        this.sendTo(client, { type: 'vad', speaking: true });
        break;
      case 'audio':
        interp.appendAudio(ev.frame);
        break;
      case 'end':
        this.commitTurn(client);
        this.sendTo(client, { type: 'vad', speaking: false });
        // A chunked monologue continues straight into the next turn.
        if (ev.reason !== 'silence') {
          this.openTurn(client);
          this.sendTo(client, { type: 'vad', speaking: true });
        }
        break;
      case 'discard':
        this.discardTurn(client);
        this.sendTo(client, { type: 'vad', speaking: false });
        break;
    }
  }

  private onPtt(client: Client, down: boolean): void {
    if (client.participant.turnMode !== 'ptt' || client.state !== 'listening') return;
    if (down && !client.pttDown) {
      client.pttDown = true;
      this.openTurn(client);
      this.sendTo(client, { type: 'vad', speaking: true });
    } else if (!down && client.pttDown) {
      client.pttDown = false;
      this.commitTurn(client);
      this.sendTo(client, { type: 'vad', speaking: false });
    }
  }

  private openTurn(client: Client): void {
    const id = randomUUID();
    client.turnId = id;
    client.interpreter?.beginTurn(id);
    const known = this.mode === 'pair';
    this.upsert({
      id,
      slot: known ? client.slot : null,
      speakerName: known ? this.names[client.slot] : '',
      srcLang: known ? this.settings.languages[client.slot] : null,
      dstLang: known ? this.settings.languages[OTHER[client.slot]] : null,
      source: '',
      sourceFinal: false,
      translation: '',
      translationFinal: false,
      status: 'listening',
      startedAt: Date.now(),
    });
  }

  private commitTurn(client: Client): void {
    const id = client.turnId;
    if (!id) return;
    client.turnId = null;
    client.interpreter?.commitTurn();
    this.patch(id, { status: 'translating', committedAt: Date.now() });
  }

  private discardTurn(client: Client): void {
    const id = client.turnId;
    if (!id) return;
    client.turnId = null;
    client.interpreter?.discardTurn();
    this.segments.delete(id);
    this.broadcast({ type: 'segment', segment: { ...this.blank(id), status: 'discarded' } });
  }

  private async startClient(client: Client): Promise<void> {
    if (client.interpreter) return;
    this.setState(client, 'connecting');
    const interp = new Interpreter(this.interpreterOptions(client.slot));
    client.interpreter = interp;
    this.wire(client.slot, interp, client);
    try {
      this.model = await interp.connect();
      if (client.interpreter !== interp) return interp.close();
      client.detector.reset();
      this.setState(client, 'listening');
    } catch (err) {
      if (client.interpreter === interp) client.interpreter = null;
      this.setState(client, 'error');
      this.sendTo(client, { type: 'error', message: (err as Error).message });
    }
  }

  private stopClient(client: Client, immediate: boolean): void {
    const interp = client.interpreter;
    if (client.turnId) this.commitTurn(client);
    client.interpreter = null;
    client.pttDown = false;
    client.detector.reset();
    if (client.ws.readyState === WebSocket.OPEN) this.setState(client, 'idle');
    if (!interp) return;
    if (immediate || !interp.busy) return interp.close();
    // Let the last translation finish before closing the session.
    const deadline = Date.now() + 15_000;
    const poll = setInterval(() => {
      if (!interp.busy || Date.now() > deadline) {
        clearInterval(poll);
        interp.close();
      }
    }, 250);
  }

  private interpreterOptions(slot: Slot) {
    const { languages, keyterms } = this.settings;
    if (this.mode === 'same') {
      return {
        instructions: twoWayPrompt(languages.a, languages.b, keyterms),
        voice: this.voices.a,
        keyterms,
        label: `${this.id}:same`,
      };
    }
    const src = languages[slot];
    const dst = languages[OTHER[slot]];
    return {
      instructions: oneWayPrompt(src, dst, keyterms),
      voice: this.voices[slot],
      languageHint: src,
      keyterms,
      label: `${this.id}:${slot}`,
    };
  }

  private wire(slot: Slot, interp: Interpreter, client: Client | null): void {
    interp.on('source', (turnId, text, final) => {
      const seg = this.segments.get(turnId);
      // In agents mode the agent's own transcript is the original text.
      if (!seg || this.mode === 'agents') return;
      this.patch(turnId, { source: text, sourceFinal: final || seg.sourceFinal });
      if (this.mode === 'same' && (seg.slot == null || final)) void this.placeSegment(turnId, text, final);
    });
    interp.on('responseStarted', turnId => {
      const seg = this.segments.get(turnId);
      if (seg && seg.status === 'listening') this.patch(turnId, { status: 'translating' });
    });
    interp.on('translation', (turnId, delta) => {
      const seg = this.segments.get(turnId);
      if (!seg) return;
      this.patch(turnId, { translation: seg.translation + delta });
    });
    interp.on('audio', (turnId, data) => {
      const seg = this.segments.get(turnId);
      if (!seg) return;
      const bytes = (data.length * 3) / 4;
      this.audioBytes.set(turnId, (this.audioBytes.get(turnId) ?? 0) + bytes);
      if (seg.firstAudioAt == null) {
        const now = Date.now();
        this.patch(turnId, {
          status: 'speaking',
          firstAudioAt: now,
          latencyMs: seg.committedAt != null ? now - seg.committedAt : undefined,
        });
      }
      for (const listener of this.listenersFor(slot)) {
        this.sendTo(listener, { type: 'audio', segmentId: turnId, kind: 'translation', data });
      }
      // The listening agent hears the translation at real-time pace, as it plays.
      this.agentsRun?.ears[OTHER[slot]].push(Buffer.from(data, 'base64'));
    });
    interp.on('done', (turnId, transcript) => {
      const seg = this.segments.get(turnId);
      if (!seg) return;
      const audioMs = Math.round(((this.audioBytes.get(turnId) ?? 0) / 2 / SAMPLE_RATE) * 1000);
      this.audioBytes.delete(turnId);
      this.patch(turnId, {
        status: 'done',
        translation: transcript || seg.translation,
        translationFinal: true,
        audioMs,
      });
      for (const listener of this.listenersFor(slot)) {
        this.sendTo(listener, { type: 'audio_end', segmentId: turnId, kind: 'translation' });
      }
      if (this.agentsRun) this.onAgentTranslated(slot, turnId);
    });
    interp.on('error', message => (client ? this.sendTo(client, { type: 'error', message }) : this.broadcast({ type: 'error', message })));
    interp.on('closed', () => {
      if (!client) return this.stopAgents('An interpreter session closed.');
      if (client.interpreter !== interp) return;
      client.interpreter = null;
      this.setState(client, 'error');
      this.sendTo(client, { type: 'error', message: 'The Grok Voice session closed. Press Start to reconnect.' });
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Agents mode: two persona agents talk through the two interpreters. Every hop is real audio:
  // agent voice → interpreter → translated audio → the other agent's input. Each step waits for
  // the previous audio to finish playing, so the windows play one piece at a time.

  private agentsRun: {
    scenario: Scenario;
    agents: Record<Slot, AgentSession>;
    interps: Record<Slot, Interpreter>;
    /** Agent voice → its interpreter, paced like a live mic. */
    feed: Record<Slot, Pacer>;
    /** Translated audio → the listening agent, paced. */
    ears: Record<Slot, Pacer>;
    current: Record<Slot, { segId: string; firstAt: number; bytes: number } | null>;
    ending: boolean;
    timers: Set<NodeJS.Timeout>;
  } | null = null;

  private agentsState: AgentsState = this.idleAgentsState(SCENARIOS[0]!.id);

  private idleAgentsState(scenarioId: string): AgentsState {
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

  private setAgents(patch: Partial<AgentsState>): void {
    this.agentsState = { ...this.agentsState, ...patch };
    this.broadcastRoom();
  }

  private later(ms: number, fn: () => void): void {
    const run = this.agentsRun;
    if (!run) return;
    const t = setTimeout(() => {
      run.timers.delete(t);
      if (this.agentsRun === run) fn();
    }, Math.max(0, ms));
    run.timers.add(t);
  }

  private async startAgents(scenarioId: string, opening: string | undefined, maxTurns: number | undefined): Promise<void> {
    if (this.agentsRun) return;
    const sc = getScenario(scenarioId);
    this.settings.languages = { a: 'hi', b: 'de' };
    this.names = { a: sc.agents.a.name, b: sc.agents.b.name };
    this.segments.clear();
    this.broadcast({ type: 'segments', segments: [] });
    const { keyterms } = this.settings;
    const terms = [...new Set([...keyterms, sc.agents.a.name, sc.agents.b.name])];
    const interp = (slot: Slot) =>
      new Interpreter({
        instructions: oneWayPrompt(this.settings.languages[slot], this.settings.languages[OTHER[slot]], terms),
        // The interpreter speaks with the same voice as the agent it translates.
        voice: sc.agents[slot].voice,
        languageHint: this.settings.languages[slot],
        keyterms: terms,
        label: `${this.id}:interp-${slot}`,
      });
    const run = {
      scenario: sc,
      agents: {
        a: new AgentSession(`${this.id}:a`, sc.agents.a.instructions, sc.agents.a.voice, this.settings.languages.a),
        b: new AgentSession(`${this.id}:b`, sc.agents.b.instructions, sc.agents.b.voice, this.settings.languages.b),
      },
      interps: { a: interp('a'), b: interp('b') },
      feed: {} as Record<Slot, Pacer>,
      ears: {} as Record<Slot, Pacer>,
      current: { a: null, b: null } as Record<Slot, { segId: string; firstAt: number; bytes: number } | null>,
      ending: false,
      timers: new Set<NodeJS.Timeout>(),
    };
    for (const slot of ['a', 'b'] as const) {
      run.feed[slot] = new Pacer(frame => run.interps[slot].appendAudio(toInt16(frame)));
      run.ears[slot] = new Pacer(frame => run.agents[slot].hear(Buffer.from(frame)));
    }
    this.agentsRun = run;
    this.agentsState = {
      ...this.idleAgentsState(sc.id),
      running: true,
      phase: 'connecting',
      active: sc.starter,
      maxTurns: Math.min(30, Math.max(2, Math.round(maxTurns ?? 12))),
    };
    delete this.agentsState.endedReason;
    this.broadcastRoom();

    for (const slot of ['a', 'b'] as const) {
      this.wire(slot, run.interps[slot], null);
      this.wireAgent(slot, run.agents[slot]);
    }
    try {
      const [, , ma] = await Promise.all([run.agents.a.connect(), run.agents.b.connect(), run.interps.a.connect(), run.interps.b.connect()]);
      this.model = ma;
    } catch (err) {
      this.broadcast({ type: 'error', message: `Could not start the agents: ${(err as Error).message}` });
      return this.stopAgents('Connection failed');
    }
    if (this.agentsRun !== run) return;
    this.setAgents({ phase: 'thinking', active: sc.starter });
    run.agents[sc.starter].open(opening ?? sc.opening);
  }

  private wireAgent(slot: Slot, agent: AgentSession): void {
    agent.on('audio', b64 => {
      const run = this.agentsRun;
      if (!run || run.agents[slot] !== agent) return;
      // Defensive: only the agent whose turn it is may speak.
      if (this.agentsState.active !== slot || this.agentsState.phase === 'interpreting') return;
      let cur = run.current[slot];
      if (!cur) {
        const id = randomUUID();
        cur = { segId: id, firstAt: Date.now(), bytes: 0 };
        run.current[slot] = cur;
        run.interps[slot].beginTurn(id);
        this.upsert({
          id,
          slot,
          speakerName: run.scenario.agents[slot].name,
          srcLang: this.settings.languages[slot],
          dstLang: this.settings.languages[OTHER[slot]],
          source: '',
          sourceFinal: false,
          translation: '',
          translationFinal: false,
          status: 'listening',
          startedAt: Date.now(),
        });
        this.setAgents({ phase: 'speaking', active: slot, turns: this.agentsState.turns + 1 });
      }
      const buf = Buffer.from(b64, 'base64');
      cur.bytes += buf.length;
      // The agent's voice is the "microphone" of its seat: it goes to the interpreter as-is.
      run.feed[slot].push(buf);
      const own = this.clients.get(slot);
      if (own) this.sendTo(own, { type: 'audio', segmentId: cur.segId, kind: 'original', data: b64 });
    });
    agent.on('transcript', delta => {
      const cur = this.agentsRun?.current[slot];
      const seg = cur && this.segments.get(cur.segId);
      if (seg) this.patch(seg.id, { source: seg.source + delta });
    });
    agent.on('endCall', () => {
      if (this.agentsRun) this.agentsRun.ending = true;
    });
    agent.on('done', transcript => {
      const run = this.agentsRun;
      if (!run || run.agents[slot] !== agent || this.agentsState.active !== slot) return;
      const cur = run.current[slot];
      run.current[slot] = null;
      if (!cur) {
        // Only a tool call (end_call) and no speech.
        if (run.ending) this.stopAgents(`${run.scenario.agents[slot].name} ended the call`);
        else run.agents[OTHER[slot]].reply();
        return;
      }
      if (transcript) this.patch(cur.segId, { source: transcript });
      this.patch(cur.segId, { sourceFinal: true });
      const own = this.clients.get(slot);
      if (own) this.sendTo(own, { type: 'audio_end', segmentId: cur.segId, kind: 'original' });
      // Commit once the paced feed (and so the playback in the speaker's window) has finished.
      run.feed[slot].whenDrained(() => this.later(150, () => {
        run.interps[slot].commitTurn();
        this.patch(cur.segId, { status: 'translating', committedAt: Date.now() });
        this.setAgents({ phase: 'interpreting', active: slot });
      }));
    });
    agent.on('error', message => this.broadcast({ type: 'error', message: `${this.agentsRun?.scenario.agents[slot].name ?? 'Agent'}: ${message}` }));
  }

  private async startBuilder(configId: string, caller: 'mic' | 'script', scriptId?: string): Promise<void> {
    this.builder?.stop('Restarted');
    const cfg = getBuilderConfig(configId);
    const script = cfg.scripts.find(s => s.id === scriptId) ?? cfg.scripts[0]!;
    const call = new BuilderCall(cfg, { send: msg => this.broadcast(msg) }, caller === 'mic' ? { kind: 'mic' } : { kind: 'script', script });
    this.builder = call;
    this.broadcast({ type: 'builder_state', state: call.state });
    try {
      await call.start();
    } catch (err) {
      this.broadcast({ type: 'error', message: `Could not start the call: ${(err as Error).message}` });
      call.stop('Connection failed');
    }
  }

  /** A translation finished generating; once it has played, the other agent replies. */
  private onAgentTranslated(speaker: Slot, segId: string): void {
    const run = this.agentsRun;
    const seg = this.segments.get(segId);
    if (!run || !seg) return;
    const listener = OTHER[speaker];
    run.ears[listener].whenDrained(() => this.later(300, () => {
      if (run.ending) return this.stopAgents(`${run.scenario.agents[speaker].name} ended the call`);
      if (this.agentsState.turns >= this.agentsState.maxTurns) return this.stopAgents('Turn limit reached');
      this.setAgents({ phase: 'thinking', active: listener });
      run.agents[listener].reply();
    }));
  }

  private stopAgents(reason: string): void {
    const run = this.agentsRun;
    if (!run) return;
    this.agentsRun = null;
    for (const t of run.timers) clearTimeout(t);
    for (const slot of ['a', 'b'] as const) {
      run.feed[slot]?.stop();
      run.ears[slot]?.stop();
      run.agents[slot].removeAllListeners();
      run.agents[slot].close();
      run.interps[slot].removeAllListeners();
      run.interps[slot].close();
    }
    this.setAgents({ running: false, phase: 'ended', active: null, endedReason: reason });
  }

  /** Same-device mode: put the segment in the column of the language that was spoken. */
  private async placeSegment(turnId: string, text: string, final: boolean): Promise<void> {
    const { a, b } = this.settings.languages;
    const sameScript = getLanguage(a).script === getLanguage(b).script;
    if (sameScript && !final) return;
    const lang = await detectLanguage(text, a, b);
    if (!lang) return;
    const slot: Slot = lang === a ? 'a' : 'b';
    const seg = this.segments.get(turnId);
    if (!seg || seg.slot === slot) return;
    this.patch(turnId, {
      slot,
      speakerName: this.names[slot],
      srcLang: lang,
      dstLang: this.settings.languages[OTHER[slot]],
    });
  }

  /** Who hears translations of `speaker`. */
  private listenersFor(speaker: Slot): Client[] {
    if (this.mode === 'same') return [...this.clients.values()];
    const other = this.clients.get(OTHER[speaker]);
    return other ? [other] : [];
  }

  private updateParticipant(client: Client, p: Partial<ParticipantSettings>): void {
    client.participant = { ...client.participant, ...p };
    if (p.name != null) this.names[client.slot] = p.name;
    if (p.voice) this.voices[client.slot] = p.voice;
    if (p.endSilenceMs) client.detector.setEndSilence(p.endSilenceMs);
    if (p.turnMode && client.turnId && p.turnMode === 'ptt') this.commitTurn(client);
    if (p.voice) this.refreshInterpreters();
    this.broadcastRoom();
  }

  private updateRoom(s: Partial<RoomSettings>): void {
    if (s.languages) {
      const next = { ...this.settings.languages };
      for (const slot of ['a', 'b'] as const) if (isLanguage(s.languages[slot])) next[slot] = s.languages[slot]!;
      if (next.a !== next.b) this.settings.languages = next;
    }
    if (s.keyterms) this.settings.keyterms = s.keyterms.map(k => k.trim()).filter(Boolean).slice(0, 100);
    if (s.names) for (const slot of ['a', 'b'] as const) if (typeof s.names[slot] === 'string') this.names[slot] = s.names[slot]!;
    this.refreshInterpreters();
    this.broadcastRoom();
  }

  private refreshInterpreters(): void {
    for (const c of this.clients.values()) c.interpreter?.update(this.interpreterOptions(c.slot));
  }

  private setState(client: Client, state: SlotState): void {
    client.state = state;
    this.broadcastRoom();
  }

  private blank(id: string): Segment {
    return {
      id,
      slot: null,
      speakerName: '',
      srcLang: null,
      dstLang: null,
      source: '',
      sourceFinal: false,
      translation: '',
      translationFinal: false,
      status: 'listening',
      startedAt: Date.now(),
    };
  }

  private upsert(seg: Segment): void {
    this.segments.set(seg.id, seg);
    if (this.segments.size > MAX_SEGMENTS) this.segments.delete(this.segments.keys().next().value!);
    this.broadcast({ type: 'segment', segment: seg });
  }

  private patch(id: string, patch: Partial<Segment>): void {
    const seg = this.segments.get(id);
    if (!seg) return;
    const next = { ...seg, ...patch };
    this.segments.set(id, next);
    this.broadcast({ type: 'segment', segment: next });
  }

  snapshot(): RoomSnapshot {
    const slot = (s: Slot) => {
      const c = this.clients.get(s);
      const sameDevicePeer = this.mode === 'same' && s === 'b' && this.clients.get('a');
      return {
        present: Boolean(c) || Boolean(sameDevicePeer),
        name: this.names[s],
        voice: this.voices[s],
        state: c?.state ?? (sameDevicePeer ? sameDevicePeer.state : 'empty'),
        turnMode: c?.participant.turnMode ?? 'auto',
      };
    };
    return {
      id: this.id,
      mode: this.mode,
      settings: { ...this.settings, names: { ...this.names } },
      slots: { a: slot('a'), b: slot('b') },
      model: this.model,
      agents: this.mode === 'agents' ? this.agentsState : this.mode === 'live' ? (this.live?.state ?? null) : null,
    };
  }

  private broadcastRoom(): void {
    this.broadcast({ type: 'room', room: this.snapshot() });
  }

  private broadcast(msg: ServerMessage): void {
    const data = JSON.stringify(msg);
    for (const c of this.clients.values()) if (c.ws.readyState === WebSocket.OPEN) c.ws.send(data);
  }

  private sendTo(client: Client, msg: ServerMessage): void {
    if (client.ws.readyState === WebSocket.OPEN) client.ws.send(JSON.stringify(msg));
  }
}

function toInt16(frame: Buffer): Int16Array {
  // Copy so the view is aligned regardless of the source buffer's offset.
  const copy = new Uint8Array(frame.byteLength & ~1);
  copy.set(frame.subarray(0, copy.byteLength));
  return new Int16Array(copy.buffer);
}

const rooms = new Map<string, Room>();

export function getOrCreateRoom(id: string, mode: Mode, settings: RoomSettings): Room {
  let room = rooms.get(id);
  if (!room || room.empty) {
    room = new Room(id, mode, settings);
    rooms.set(id, room);
  }
  return room;
}

export function dropIfEmpty(room: Room): void {
  if (room.empty) rooms.delete(room.id);
}

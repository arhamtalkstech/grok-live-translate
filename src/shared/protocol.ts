/** Messages between the browser and the demo server (JSON text frames). Mic audio goes up as binary PCM16 frames. */

/**
 * same: one device, one mic. pair: one device per person. agents: two persona agents talk
 * through the interpreter. live: the agents call with simultaneous interpretation in one window.
 */
export type Mode = 'same' | 'pair' | 'agents' | 'live' | 'builder';
export type Slot = 'a' | 'b';

export type TurnMode = 'auto' | 'ptt';

export type ParticipantSettings = {
  name: string;
  /** Voice the listener hears this participant's translation in. */
  voice: string;
  /** Silence (ms) that ends a turn in hands-free mode. */
  endSilenceMs: number;
  turnMode: TurnMode;
};

export type RoomSettings = {
  languages: Record<Slot, string>;
  /** Names, products, and terms passed to ASR keyterms and the prompt. */
  keyterms: string[];
  /** Display names per seat; in same-device mode both are set from one browser. */
  names?: Record<Slot, string>;
};

export type SegmentStatus = 'listening' | 'translating' | 'speaking' | 'done' | 'discarded' | 'error';

export type Segment = {
  id: string;
  /** Who spoke. null while same-device mode is still detecting the language. */
  slot: Slot | null;
  speakerName: string;
  srcLang: string | null;
  dstLang: string | null;
  source: string;
  sourceFinal: boolean;
  translation: string;
  translationFinal: boolean;
  status: SegmentStatus;
  startedAt: number;
  /** Server time the turn was committed (end of speech). */
  committedAt?: number;
  /** Server time the first translated audio arrived from xAI. */
  firstAudioAt?: number;
  /** committedAt → firstAudioAt. */
  latencyMs?: number;
  audioMs?: number;
  /** Simultaneous mode: speaker started talking → first translated audio (ear-voice span). */
  lagMs?: number;
};

export type SlotState = 'empty' | 'idle' | 'connecting' | 'listening' | 'hearing' | 'error';

export type AgentPhase = 'idle' | 'connecting' | 'speaking' | 'interpreting' | 'thinking' | 'ended';

export type AgentsState = {
  running: boolean;
  scenarioId: string;
  /** Seat whose turn it is (speaking or about to reply). */
  active: Slot | null;
  phase: AgentPhase;
  turns: number;
  maxTurns: number;
  names: Record<Slot, string>;
  roles: Record<Slot, string>;
  endedReason?: string;
};

export type RoomSnapshot = {
  id: string;
  mode: Mode;
  settings: RoomSettings;
  slots: Record<Slot, { present: boolean; name: string; voice: string; state: SlotState; turnMode: TurnMode }>;
  model: string | null;
  agents: AgentsState | null;
};

export type ClientMessage =
  | {
      type: 'join';
      room: string;
      mode: Mode;
      slot: Slot;
      settings?: Partial<RoomSettings>;
      participant: ParticipantSettings;
    }
  | { type: 'start' }
  | { type: 'stop' }
  | { type: 'participant'; participant: Partial<ParticipantSettings> }
  | { type: 'room'; settings: Partial<RoomSettings> }
  | { type: 'ptt'; down: boolean }
  | { type: 'clear' }
  | { type: 'agents_start'; scenarioId: string; opening?: string; maxTurns?: number }
  | { type: 'agents_stop' }
  /** Agent builder tab: call the multi-agent line with the mic, or play a scripted caller. */
  | { type: 'builder_start'; configId: string; caller: 'mic' | 'script'; scriptId?: string }
  | { type: 'builder_stop' };

export type ServerMessage =
  | { type: 'joined'; slot: Slot; room: RoomSnapshot; segments: Segment[] }
  | { type: 'room'; room: RoomSnapshot }
  | { type: 'segment'; segment: Segment }
  | { type: 'segments'; segments: Segment[] }
  /** kind "original" = an agent's own voice (agents mode); "translation" = interpreter output. */
  | { type: 'audio'; segmentId: string; kind: 'original' | 'translation'; data: string }
  | { type: 'audio_end'; segmentId: string; kind: 'original' | 'translation' }
  | { type: 'vad'; speaking: boolean }
  | { type: 'builder_state'; state: BuilderState }
  | { type: 'builder_event'; event: BuilderEvent }
  | { type: 'builder_line'; line: BuilderLine }
  /** The caller started talking over the agent: stop playback. */
  | { type: 'barge_in' }
  | { type: 'error'; message: string };

export const SAMPLE_RATE = 24_000;

export type BuilderState = {
  running: boolean;
  configId: string;
  activeAgent: string;
  caller: 'mic' | 'script';
  scriptId?: string;
  step: number;
  phase: 'connecting' | 'agent' | 'caller' | 'tool' | 'ended';
  model: string | null;
  endedReason?: string;
};

export type BuilderEvent = {
  id: string;
  at: number;
  kind: 'session' | 'handoff' | 'tool' | 'end' | 'error';
  agentId?: string;
  title: string;
  detail?: string;
  data?: unknown;
  /** Tool calls: live = the real endpoint answered; mock = stand-in; local = in-process. */
  source?: 'live' | 'mock' | 'local';
  ok?: boolean;
  ms?: number;
  status?: number;
};

export type BuilderLine = {
  id: string;
  role: 'caller' | 'agent';
  agentId?: string;
  agentName?: string;
  text: string;
  final: boolean;
  at: number;
  removed?: boolean;
};

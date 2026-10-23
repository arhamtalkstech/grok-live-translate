import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  BuilderEvent,
  BuilderLine,
  BuilderState,
  ClientMessage,
  Mode,
  ParticipantSettings,
  RoomSettings,
  RoomSnapshot,
  Segment,
  ServerMessage,
  Slot,
} from '../../../src/shared/protocol';
import { AudioCapture, AudioPlayer, type InputSource } from './audio';

export type LocalPrefs = {
  playAudio: boolean;
  /** Keep the mic open while translated audio plays (only safe with headphones). */
  headphones: boolean;
  source: InputSource;
};

type Options = {
  roomId: string;
  mode: Mode;
  slot: Slot;
  initialSettings: RoomSettings;
  participant: ParticipantSettings;
};

export type ConnectionState = 'connecting' | 'open' | 'closed';

export function useRoom(opts: Options) {
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const [room, setRoom] = useState<RoomSnapshot | null>(null);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [speaking, setSpeaking] = useState(false);
  const [outputPlaying, setOutputPlaying] = useState(false);
  const [playingSegment, setPlayingSegment] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [audioReady, setAudioReady] = useState(false);
  // Agent builder tab.
  const [builderState, setBuilderState] = useState<BuilderState | null>(null);
  const [builderEvents, setBuilderEvents] = useState<BuilderEvent[]>([]);
  const [builderLines, setBuilderLines] = useState<BuilderLine[]>([]);
  const [prefs, setPrefs] = useState<LocalPrefs>(() => ({
    playAudio: true,
    headphones: localStorage.getItem('lt.headphones') === '1',
    source: 'mic',
  }));

  const wsRef = useRef<WebSocket | null>(null);
  const captureRef = useRef(new AudioCapture());
  const playerRef = useRef(new AudioPlayer());
  // Simultaneous mode only: the original voice gets its own quiet player so it can overlap the interpretation.
  const originalRef = useRef(new AudioPlayer());
  const [originalVolume, setOriginalVolumeState] = useState(() => Number(localStorage.getItem('lt.originalVolume') ?? '0.05'));
  const [originalPlaying, setOriginalPlaying] = useState(false);
  const [playingKeys, setPlayingKeys] = useState<string[]>([]);
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const silence = useMemo(() => new Int16Array(new ArrayBuffer(1920)), []);

  const send = useCallback((msg: ClientMessage) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }, []);

  // One socket per room/seat; reconnects with backoff.
  useEffect(() => {
    let stopped = false;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const open = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}/ws`);
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;
      setConnection('connecting');

      ws.onopen = () => {
        retry = 0;
        setConnection('open');
        const o = optsRef.current;
        ws.send(
          JSON.stringify({
            type: 'join',
            room: o.roomId,
            mode: o.mode,
            slot: o.slot,
            settings: o.initialSettings,
            participant: o.participant,
          } satisfies ClientMessage),
        );
      };
      ws.onmessage = ev => {
        if (typeof ev.data !== 'string') return;
        const msg = JSON.parse(ev.data) as ServerMessage;
        switch (msg.type) {
          case 'joined':
            setRoom(msg.room);
            setSegments(msg.segments);
            break;
          case 'room':
            setRoom(msg.room);
            break;
          case 'segment':
            setSegments(prev => {
              if (msg.segment.status === 'discarded') return prev.filter(s => s.id !== msg.segment.id);
              const i = prev.findIndex(s => s.id === msg.segment.id);
              if (i === -1) return [...prev, msg.segment];
              const next = prev.slice();
              next[i] = msg.segment;
              return next;
            });
            break;
          case 'segments':
            setSegments(msg.segments);
            break;
          case 'audio':
            // Counter read by the browser checks in scripts/browser-check.ts.
            (window as { __ltAudioChunks?: number }).__ltAudioChunks = ((window as { __ltAudioChunks?: number }).__ltAudioChunks ?? 0) + 1;
            if (!prefsRef.current.playAudio) break;
            if (optsRef.current.mode === 'live' && msg.kind === 'original') originalRef.current.enqueue(`${msg.segmentId}:original`, msg.data);
            else playerRef.current.enqueue(`${msg.segmentId}:${msg.kind}`, msg.data);
            break;
          case 'vad':
            setSpeaking(msg.speaking);
            break;
          case 'builder_state':
            setBuilderState(msg.state);
            break;
          case 'builder_event':
            setBuilderEvents(prev => [...prev, msg.event]);
            break;
          case 'builder_line':
            setBuilderLines(prev => {
              if (msg.line.removed) return prev.filter(l => l.id !== msg.line.id);
              const i = prev.findIndex(l => l.id === msg.line.id);
              if (i === -1) return [...prev, msg.line];
              const next = prev.slice();
              next[i] = msg.line;
              return next;
            });
            break;
          case 'barge_in':
            playerRef.current.stopAll();
            break;
          case 'error':
            setError(msg.message);
            break;
        }
      };
      ws.onclose = () => {
        if (wsRef.current === ws) wsRef.current = null;
        setConnection('closed');
        if (stopped) return;
        captureRef.current.stop();
        setCapturing(false);
        timer = setTimeout(open, Math.min(5000, 500 * 2 ** retry++));
      };
    };
    open();
    return () => {
      stopped = true;
      clearTimeout(timer);
      wsRef.current?.close();
      captureRef.current.stop();
      playerRef.current.stopAll();
      originalRef.current.stopAll();
    };
  }, [opts.roomId, opts.mode, opts.slot]);

  // Poll playback state for the output waveform, highlighting, and mic gating.
  useEffect(() => {
    const id = setInterval(() => {
      setOutputPlaying(playerRef.current.playing);
      setPlayingSegment(playerRef.current.currentSegment);
      setAudioReady(playerRef.current.ready);
      if (optsRef.current.mode === 'live') {
        setOriginalPlaying(originalRef.current.playing);
        setPlayingKeys([playerRef.current.currentSegment, originalRef.current.currentSegment].filter((k): k is string => k != null));
      }
    }, 80);
    return () => clearInterval(id);
  }, []);

  const start = useCallback(async () => {
    setError(null);
    playerRef.current.warmUp();
    try {
      captureRef.current.onEnded = () => stop();
      await captureRef.current.start(prefsRef.current.source, (pcm: Int16Array<ArrayBuffer>) => {
        const ws = wsRef.current;
        if (ws?.readyState !== WebSocket.OPEN) return;
        // Without headphones the mic would hear the translation; send silence while it plays.
        const gated = !prefsRef.current.headphones && prefsRef.current.source === 'mic' && playerRef.current.playing;
        ws.send(gated ? silence : pcm);
      });
      setCapturing(true);
      send({ type: 'start' });
    } catch (err) {
      const e = err as DOMException;
      if (e?.name === 'NotAllowedError' && prefsRef.current.source === 'tab') return;
      setError(e?.name === 'NotAllowedError' ? 'Microphone access was blocked. Allow it in the address bar and try again.' : e.message);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [send, silence]);

  const stop = useCallback(() => {
    captureRef.current.stop();
    setCapturing(false);
    setSpeaking(false);
    send({ type: 'stop' });
  }, [send]);

  const updatePrefs = useCallback((patch: Partial<LocalPrefs>) => {
    setPrefs(p => {
      const next = { ...p, ...patch };
      if (patch.headphones != null) localStorage.setItem('lt.headphones', patch.headphones ? '1' : '0');
      if (patch.playAudio === false) {
        playerRef.current.stopAll();
        originalRef.current.stopAll();
      }
      return next;
    });
  }, []);

  const inputAnalyser = useCallback(() => captureRef.current.analyser, []);
  const outputAnalyser = useCallback(() => playerRef.current.analyser, []);
  const originalAnalyser = useCallback(() => originalRef.current.analyser, []);
  useEffect(() => originalRef.current.setVolume(originalVolume), [originalVolume]);
  const warmAll = () => {
    playerRef.current.warmUp();
    if (optsRef.current.mode === 'live') originalRef.current.warmUp();
  };

  return {
    connection,
    room,
    segments,
    error,
    dismissError: () => setError(null),
    speaking,
    capturing,
    outputPlaying,
    playingSegment,
    prefs,
    updatePrefs,
    inputAnalyser,
    outputAnalyser,
    start,
    stop,
    ptt: (down: boolean) => send({ type: 'ptt', down }),
    setParticipant: (participant: Partial<ParticipantSettings>) => send({ type: 'participant', participant }),
    setRoomSettings: (settings: Partial<RoomSettings>) => send({ type: 'room', settings }),
    clear: () => send({ type: 'clear' }),
    audioReady,
    enableAudio: warmAll,
    originalAnalyser,
    originalPlaying,
    playingKeys,
    originalVolume,
    setOriginalVolume: (v: number) => {
      localStorage.setItem('lt.originalVolume', String(v));
      setOriginalVolumeState(v);
    },
    agentsStart: (scenarioId: string, opening: string, maxTurns: number) => {
      warmAll();
      send({ type: 'agents_start', scenarioId, opening, maxTurns });
    },
    agentsStop: () => send({ type: 'agents_stop' }),
    builderState,
    builderEvents,
    builderLines,
    builderStart: (configId: string, caller: 'mic' | 'script', scriptId?: string) => {
      warmAll();
      setBuilderEvents([]);
      setBuilderLines([]);
      send({ type: 'builder_start', configId, caller, scriptId });
    },
    builderStop: () => send({ type: 'builder_stop' }),
  };
}

export type RoomApi = ReturnType<typeof useRoom>;

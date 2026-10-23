import { AlertCircle, Check, Copy, Link2, X } from 'lucide-react';
import { motion } from 'motion/react';
import { useEffect, useMemo, useState } from 'react';
import { LANGUAGES, getLanguage, type Language } from '../../src/shared/languages';
import type { Mode, ParticipantSettings, RoomSettings, Segment, Slot, TurnMode } from '../../src/shared/protocol';
import { LanguagePicker, VoicePill, type Voice } from './components/Pickers';
import { AgentBar, type ScenarioInfo } from './components/AgentBar';
import { BuilderView } from './components/BuilderView';
import { InputBar, OutputBar } from './components/PlayerBars';
import { SettingsMenu } from './components/SettingsMenu';
import { TranscriptCard, type CardEntry } from './components/TranscriptCard';
import { cn } from './lib/cn';
import { useRoom } from './lib/use-room';

const OTHER: Record<Slot, Slot> = { a: 'b', b: 'a' };

type AppConfig = { model: string; reasoningEffort: string; languages: Language[]; voices: Voice[]; scenarios: ScenarioInfo[] };

type Route = { mode: Mode; room: string; seat: Slot };

function readRoute(): Route {
  const q = new URLSearchParams(location.search);
  const m = q.get('mode');
  const mode: Mode = m === 'pair' || m === 'agents' || m === 'live' || m === 'builder' ? m : 'same';
  const seat: Slot = q.get('seat') === 'b' ? 'b' : 'a';
  let room = q.get('room') ?? '';
  if (!room) {
    room = sessionStorage.getItem('lt.room') ?? Math.random().toString(36).slice(2, 8);
    sessionStorage.setItem('lt.room', room);
  }
  return { mode, room, seat };
}

function writeRoute(r: Route) {
  const q = new URLSearchParams();
  if (r.mode !== 'same') {
    q.set('mode', r.mode);
    q.set('room', r.room);
    q.set('seat', r.seat);
  }
  history.replaceState(null, '', q.size ? `?${q}` : location.pathname);
}

export default function App() {
  const [route, setRoute] = useState(readRoute);
  const [cfg, setCfg] = useState<AppConfig | null>(null);

  useEffect(() => {
    fetch('/api/config')
      .then(r => r.json())
      .then(setCfg)
      .catch(() => setCfg({ model: 'grok-voice-latest', reasoningEffort: 'high', languages: [...LANGUAGES], voices: [], scenarios: [] }));
  }, []);

  const changeMode = (mode: Mode) => {
    const next: Route = { mode, room: mode === 'same' ? route.room : Math.random().toString(36).slice(2, 8), seat: 'a' };
    writeRoute(next);
    setRoute(next);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <TopBar mode={route.mode} onMode={changeMode} model={cfg?.model ?? null} seat={route.seat} />
      {route.mode === 'builder' ? (
        <BuilderView key={`builder:${route.room}`} room={route.room} />
      ) : (
        <Translator key={`${route.mode}:${route.room}:${route.seat}`} route={route} cfg={cfg} />
      )}
    </div>
  );
}

function TopBar({ mode, onMode, model, seat }: { mode: Mode; onMode: (m: Mode) => void; model: string | null; seat: Slot }) {
  return (
    <div className="bg-surface-l1 flex h-12 shrink-0 items-center justify-between gap-3 border-b border-primary/10 px-3 sm:px-4">
      <div className="flex min-w-0 items-center gap-2.5">
        <Logo />
        <span className="text-primary truncate text-sm font-semibold tracking-[-0.2px]">Live Translation</span>
        <span className="text-tertiary hidden text-sm sm:inline">Grok Voice</span>
      </div>
      {seat === 'a' && (
        <div className="ring-hairline flex h-8 items-center gap-0.5 rounded-full p-0.5" role="tablist" aria-label="Mode">
          {(
            [
              ['same', 'Same device'],
              ['pair', 'Two devices'],
              ['agents', 'Agents'],
              ['live', 'Simultaneous'],
              ['builder', 'Agent builder'],
            ] as const
          ).map(([m, label]) => (
            <button
              key={m}
              role="tab"
              aria-selected={mode === m}
              onClick={() => mode !== m && onMode(m)}
              className={cn(
                'relative h-7 rounded-full px-3 text-xs font-medium transition-colors',
                mode === m ? 'text-primary' : 'text-muted hover:text-primary',
              )}
            >
              {mode === m && (
                <motion.span
                  layoutId="mode-pill"
                  className="absolute inset-0 rounded-full bg-primary/[0.12]"
                  transition={{ type: 'spring', stiffness: 420, damping: 32, mass: 0.7 }}
                />
              )}
              <span className="relative">{label}</span>
            </button>
          ))}
        </div>
      )}
      <div className="text-tertiary hidden min-w-0 items-center gap-2 font-mono text-[11px] md:flex">{model}</div>
    </div>
  );
}

function Logo() {
  return (
    <svg width="18" height="18" viewBox="0 0 32 32" aria-hidden="true" className="text-primary shrink-0">
      <g fill="currentColor">
        <rect x="3" y="12" width="3" height="8" rx="1.5" />
        <rect x="9" y="7" width="3" height="18" rx="1.5" />
        <rect x="15" y="10" width="3" height="12" rx="1.5" />
        <rect x="21" y="4" width="3" height="24" rx="1.5" />
        <rect x="27" y="12" width="3" height="8" rx="1.5" opacity=".5" />
      </g>
    </svg>
  );
}

function loadParticipant(route: Route): ParticipantSettings {
  const key = `lt.participant.${route.mode}.${route.seat}`;
  const fallbackVoice = route.mode === 'same' ? 'eve' : route.seat === 'a' ? 'rex' : 'eve';
  const saved = JSON.parse(localStorage.getItem(key) ?? '{}') as Partial<ParticipantSettings>;
  return {
    name: saved.name ?? '',
    voice: saved.voice ?? fallbackVoice,
    endSilenceMs: saved.endSilenceMs ?? 650,
    turnMode: saved.turnMode ?? 'auto',
  };
}

function Translator({ route, cfg }: { route: Route; cfg: AppConfig | null }) {
  const [participant, setParticipantState] = useState(() => loadParticipant(route));
  const initialSettings = useMemo<RoomSettings>(
    () => ({
      languages: { a: 'hi', b: 'de' },
      keyterms: JSON.parse(localStorage.getItem('lt.keyterms') ?? '["Vantorra Bank"]'),
      names: route.mode === 'same' ? JSON.parse(localStorage.getItem('lt.names') ?? '{"a":"","b":""}') : undefined,
    }),
    [route.mode],
  );
  const api = useRoom({ roomId: route.room, mode: route.mode, slot: route.seat, initialSettings, participant });
  const { room, prefs } = api;

  const mine = route.seat;
  const other = OTHER[mine];
  const languages = cfg?.languages ?? [...LANGUAGES];
  const voices = cfg?.voices ?? [];
  const langs = room?.settings.languages ?? initialSettings.languages;
  // Simultaneous ("live") is the agents call with live interpretation in one window.
  const isLive = route.mode === 'live';
  const isAgents = route.mode === 'agents' || isLive;
  const agents = room?.agents ?? null;
  const names = room?.settings.names ?? { a: '', b: '' };
  const scenarios = cfg?.scenarios ?? [];
  const myState = room?.slots[mine].state ?? 'idle';
  const otherPresent = room?.slots[other].present ?? false;
  const live = api.capturing || myState === 'listening' || myState === 'connecting';
  const connecting = myState === 'connecting' || (api.capturing && myState !== 'listening');
  const gated = live && !prefs.headphones && prefs.source === 'mic' && api.outputPlaying;

  const updateParticipant = (patch: Partial<ParticipantSettings>) => {
    setParticipantState(p => {
      const next = { ...p, ...patch };
      localStorage.setItem(`lt.participant.${route.mode}.${route.seat}`, JSON.stringify(next));
      return next;
    });
    api.setParticipant(patch);
  };

  // Push-to-talk on Space.
  useEffect(() => {
    if (participant.turnMode !== 'ptt' || !live) return;
    let down = false;
    const isField = (t: EventTarget | null) => t instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName);
    const onDown = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || isField(e.target) || e.repeat) return;
      e.preventDefault();
      if (!down) api.ptt((down = true));
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || isField(e.target)) return;
      e.preventDefault();
      if (down) api.ptt((down = false));
    };
    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', onUp);
    return () => {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
    };
  }, [participant.turnMode, live, api]);

  const displayName = (s: Segment): Segment => {
    if (s.speakerName || !s.slot) return s;
    const lang = s.srcLang ? getLanguage(s.srcLang).label : '';
    return { ...s, speakerName: route.mode === 'pair' && s.slot === mine ? 'You' : `${lang} speaker` };
  };

  const entriesFor = (slot: Slot): CardEntry[] => {
    const out: CardEntry[] = [];
    for (const raw of [...api.segments].sort((x, y) => x.startedAt - y.startedAt)) {
      const s = displayName(raw);
      if (s.slot === slot) out.push({ segment: s, kind: 'original' });
      else if (s.slot === OTHER[slot]) out.push({ segment: s, kind: 'translation' });
      else if (s.slot == null && slot === mine) out.push({ segment: s, kind: 'original' });
    }
    return out;
  };

  const translating = api.segments.some(s => s.status === 'translating');
  const latencies = api.segments
    .map(s => (isLive ? s.lagMs : s.latencyMs))
    .filter((x): x is number => x != null)
    .sort((x, y) => x - y);
  const median = latencies.length ? latencies[Math.floor(latencies.length / 2)]! : null;

  const setLang = (slot: Slot, code: string) => api.setRoomSettings({ languages: { ...langs, [slot]: code } });
  const leftLabel = getLanguage(langs[mine]).label;
  const rightLabel = getLanguage(langs[other]).label;
  const nameOf = (slot: Slot) =>
    isAgents && agents
      ? agents.names[slot]
      : names[slot] || (route.mode === 'pair' && slot === mine ? 'You' : `${getLanguage(langs[slot]).label} speaker`);
  const agentStatus = (): string => {
    if (!agents) return '';
    const who = agents.active ? agents.names[agents.active] : '';
    const lang = agents.active ? getLanguage(langs[agents.active]).label : '';
    const into = agents.active ? getLanguage(langs[OTHER[agents.active]]).label : '';
    switch (agents.phase) {
      case 'connecting':
        return 'Connecting four Grok Voice sessions…';
      case 'thinking':
        return `${who} is thinking…`;
      case 'speaking':
        return isLive ? `${who} is speaking ${lang} · interpreting into ${into} live` : `${who} is speaking ${lang}`;
      case 'interpreting':
        return `Interpreting ${who} into ${into}`;
      case 'ended':
        return agents.endedReason ? `Call ended · ${agents.endedReason}` : 'Call ended';
      default:
        return otherPresent ? 'Ready' : `Open the ${getLanguage(langs[other]).label} window, then start`;
    }
  };

  const empty = (slot: Slot) => {
    if (isAgents) {
      if (agents?.running) return slot === mine ? `Waiting for ${nameOf(slot)}…` : `Waiting for ${nameOf(slot)}…`;
      return route.seat === 'a' ? 'Pick a scenario and press Start conversation' : 'The conversation starts from the other window';
    }
    if (slot === mine) return live ? (connecting ? 'Connecting to Grok Voice…' : participant.turnMode === 'ptt' ? 'Hold Space and speak' : 'Listening…') : 'Press Start and speak';
    if (route.mode === 'pair' && !otherPresent) return `Waiting for the ${rightLabel} speaker to join`;
    return live || otherPresent ? 'Waiting for speech…' : 'Translation will appear here';
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {api.error && (
        <div className="bg-danger/10 text-danger flex shrink-0 items-center gap-2 border-b border-danger/20 px-4 py-2 text-sm" role="alert">
          <AlertCircle size={15} />
          <span className="min-w-0 flex-1">{api.error}</span>
          <button onClick={api.dismissError} aria-label="Dismiss" className="hover:text-primary">
            <X size={15} />
          </button>
        </div>
      )}
      {api.connection === 'closed' && (
        <div className="bg-sunset/10 text-sunset shrink-0 border-b border-sunset/20 px-4 py-2 text-sm">Reconnecting to the demo server…</div>
      )}

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden px-3 py-4 sm:px-4 sm:py-6">
        <div className="mx-auto flex w-full max-w-[66rem] flex-1 flex-col gap-3.5 md:gap-4 lg:min-h-0">
          <header className="flex w-full shrink-0 flex-col items-center gap-1 text-center">
            <h1 className="text-primary text-sm font-semibold tracking-[-0.2px]">Translate speech in real time</h1>
            <p className="text-muted text-sm font-medium tracking-[-0.3px]">
              {isLive
                ? `Simultaneous interpretation: ${nameOf(mine)} speaks ${leftLabel}, ${nameOf(other)} speaks ${rightLabel}. The interpretation starts while each one is still talking; the original voice plays quietly underneath.`
                : isAgents
                ? `Two Grok Voice agents on a call. ${nameOf(mine)} speaks ${leftLabel}, ${nameOf(other)} speaks ${rightLabel}; each only hears the other through the live interpreter.`
                : route.mode === 'same'
                ? `Two people, one device. Speak ${leftLabel} or ${rightLabel} and Grok interprets both ways.`
                : `Speak ${leftLabel}. ${otherPresent ? nameOf(other) : `The ${rightLabel} speaker`} hears you in ${rightLabel}, and you hear them in ${leftLabel}.`}
            </p>
          </header>

          {isAgents && (
            <div className="flex justify-center">
              <span
                className="ring-hairline bg-surface-l0 text-primary inline-flex h-7 items-center gap-2 rounded-full px-3 text-xs font-medium"
                aria-live="polite"
                data-testid="agent-status"
              >
                <span
                  className={cn(
                    'size-1.5 rounded-full',
                    agents?.phase === 'speaking' ? 'bg-success animate-pulse' : agents?.running ? 'bg-sunset animate-pulse' : 'bg-tertiary',
                  )}
                />
                {agentStatus()}
              </span>
            </div>
          )}

          {route.mode !== 'same' && route.seat === 'a' && !otherPresent && (
            <InviteCard room={route.room} mode={route.mode} language={rightLabel} />
          )}

          <div className="grid min-w-0 gap-3.5 lg:min-h-0 lg:flex-1 lg:grid-cols-2 lg:gap-4">
            <div className="flex min-w-0 flex-col gap-3 lg:h-full lg:min-h-0">
              {isAgents ? (
                <AgentBar
                  host={route.seat === 'a'}
                  state={agents}
                  scenarios={scenarios}
                  speaking={isLive ? api.originalPlaying : (api.playingSegment?.endsWith(':original') ?? false)}
                  analyser={isLive ? api.originalAnalyser : api.outputAnalyser}
                  audioReady={api.audioReady}
                  onEnableAudio={api.enableAudio}
                  onStart={api.agentsStart}
                  onStop={api.agentsStop}
                  disabled={api.connection !== 'open'}
                />
              ) : (
              <InputBar
                live={live}
                connecting={connecting}
                speaking={api.speaking}
                gated={gated}
                analyser={api.inputAnalyser}
                source={prefs.source}
                onSource={source => api.updatePrefs({ source })}
                onToggle={() => (live ? api.stop() : void api.start())}
                ptt={participant.turnMode === 'ptt'}
                onPtt={api.ptt}
                disabled={api.connection !== 'open'}
              />
              )}
              <TranscriptCard
                toolbar={
                  <>
                    <LanguagePicker
                      ariaLabel={route.mode === 'same' ? 'Left language' : 'Your language'}
                      value={langs[mine]}
                      languages={languages}
                      exclude={langs[other]}
                      disabled={isAgents}
                      onChange={code => setLang(mine, code)}
                    />
                    <SettingsMenu
                      agents={isAgents}
                      originalVolume={isLive ? api.originalVolume : undefined}
                      onOriginalVolume={api.setOriginalVolume}
                      mode={route.mode}
                      playAudio={prefs.playAudio}
                      onPlayAudio={playAudio => api.updatePrefs({ playAudio })}
                      headphones={prefs.headphones}
                      onHeadphones={headphones => api.updatePrefs({ headphones })}
                      turnMode={participant.turnMode}
                      onTurnMode={(turnMode: TurnMode) => updateParticipant({ turnMode })}
                      endSilenceMs={participant.endSilenceMs}
                      onEndSilence={endSilenceMs => updateParticipant({ endSilenceMs })}
                      names={{ mine: names[mine] ?? '', other: names[other] ?? '' }}
                      onNames={(m, o) => {
                        if (route.mode === 'same') {
                          const next = { ...names, [mine]: m, [other]: o };
                          localStorage.setItem('lt.names', JSON.stringify(next));
                          api.setRoomSettings({ names: next as Record<Slot, string> });
                        } else updateParticipant({ name: m });
                      }}
                      keyterms={room?.settings.keyterms ?? initialSettings.keyterms}
                      onKeyterms={keyterms => {
                        localStorage.setItem('lt.keyterms', JSON.stringify(keyterms));
                        api.setRoomSettings({ keyterms });
                      }}
                      onClear={api.clear}
                    />
                  </>
                }
                label={isAgents && agents ? `${nameOf(mine)} · ${agents.roles[mine]}` : nameOf(mine)}
                entries={entriesFor(mine)}
                empty={empty(mine)}
                playingSegment={isLive ? api.playingKeys : api.playingSegment}
              />
            </div>

            <div className="flex min-w-0 flex-col gap-3 lg:h-full lg:min-h-0">
              <OutputBar
                live={api.connection === 'open'}
                playing={isLive ? api.outputPlaying : isAgents ? (api.playingSegment?.endsWith(':translation') ?? false) : api.outputPlaying}
                processing={translating}
                analyser={api.outputAnalyser}
                label={
                  prefs.playAudio
                    ? isLive
                      ? `Interpretation 100% · original ${Math.round(api.originalVolume * 100)}%`
                      : route.mode === 'same'
                      ? 'Interpreter'
                      : `${isAgents ? '' : 'You hear '}${nameOf(other)} in ${leftLabel}`
                    : 'Audio off'
                }
              />
              <TranscriptCard
                toolbar={
                  <>
                    <LanguagePicker
                      ariaLabel={route.mode === 'same' ? 'Right language' : 'Their language'}
                      value={langs[other]}
                      languages={languages}
                      exclude={langs[mine]}
                      disabled={route.mode !== 'same'}
                      onChange={code => setLang(other, code)}
                    />
                    {voices.length > 0 && !isAgents && (
                      <VoicePill
                        label={route.mode === 'same' ? 'Interpreter voice' : `Your voice in ${rightLabel}`}
                        value={participant.voice}
                        voices={voices}
                        onChange={voice => updateParticipant({ voice })}
                      />
                    )}
                  </>
                }
                label={isAgents && agents ? `${nameOf(other)} · ${agents.roles[other]}` : nameOf(other)}
                entries={entriesFor(other)}
                empty={empty(other)}
                playingSegment={isLive ? api.playingKeys : api.playingSegment}
              />
            </div>
          </div>

          <footer className="text-tertiary flex shrink-0 flex-wrap items-center justify-center gap-x-4 gap-y-1 pb-1 text-[11px]">
            <span className="font-mono">{room?.model ?? cfg?.model ?? 'grok-voice-latest'}</span>
            {median != null && (
              <span>
                {isLive ? 'Median lag behind the speaker' : 'Median response'} <span className="text-muted font-mono tabular-nums">{(median / 1000).toFixed(2)} s</span> over {latencies.length}{' '}
                {latencies.length === 1 ? 'turn' : 'turns'}
              </span>
            )}
            {route.mode === 'pair' && <span>Room {route.room}</span>}
          </footer>
        </div>
      </div>
    </div>
  );
}

function InviteCard({ room, mode, language }: { room: string; mode: Mode; language: string }) {
  const [copied, setCopied] = useState(false);
  const url = `${location.origin}${location.pathname}?mode=${mode}&room=${room}&seat=b`;
  const agents = mode === 'agents' || mode === 'live';
  return (
    <div className="ring-hairline bg-surface-l0 flex min-w-0 flex-wrap items-center gap-3 rounded-2xl px-4 py-3">
      <Link2 size={16} className="text-muted shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="text-primary text-sm font-medium">
          {agents ? `Open the ${language} window (it plays the ${language} side)` : `Invite the ${language} speaker`}
        </p>
        <p className="text-muted truncate font-mono text-xs" data-testid="invite-url">
          {url}
        </p>
      </div>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard?.writeText(url);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
        className="ring-hairline text-primary inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-sm hover:bg-primary/5"
      >
        {copied ? <Check size={14} /> : <Copy size={14} />}
        {copied ? 'Copied' : 'Copy link'}
      </button>
      {agents && (
        <button
          type="button"
          onClick={() => window.open(url, `lt-${room}-b`, 'popup,width=1280,height=820')}
          className="bg-primary text-primary-foreground inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-sm font-medium hover:bg-primary/90"
        >
          Open window
        </button>
      )}
    </div>
  );
}

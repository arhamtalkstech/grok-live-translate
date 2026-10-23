import { ArrowRight, Bot, ChevronDown, Mic, Phone, PhoneOff, Search, Shield, Square, Wrench } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { BuilderEvent, BuilderLine } from '../../../src/shared/protocol';
import { cn } from '../lib/cn';
import { useRoom } from '../lib/use-room';
import { LiveWaveform } from './LiveWaveform';
import { Button, Popover, Switch } from './ui';

type ToolInfo = { name: string; type: string; method?: string; url?: string; auth?: string | null; mock?: boolean; targets?: string[] };
type AgentInfo = {
  id: string;
  name: string;
  voice: string;
  greeting: string | null;
  timezone: string | null;
  knowledge: string[];
  guardrails: string[];
  tools: ToolInfo[];
  instructions: string;
};
type ScriptInfo = { id: string; title: string; opening: string; language: string; listenFor: string | null };
type ConfigInfo = { id: string; title: string; description: string; startAgent: string; agents: AgentInfo[]; scripts: ScriptInfo[] };

const PANEL = 'ring-hairline bg-surface-l0 flex min-h-0 flex-col rounded-[1.25rem]';

/**
 * Agent builder tab: a multi-agent voice line (personas, tools, guardrails, handoffs) run on the
 * public speech-to-speech API. Left: the call. Right: the agents and a live log of what happens.
 */
export function BuilderView({ room }: { room: string }) {
  const api = useRoom({
    roomId: room,
    mode: 'builder',
    slot: 'a',
    initialSettings: { languages: { a: 'en', b: 'de' }, keyterms: [] },
    participant: { name: '', voice: 'eve', endSilenceMs: 650, turnMode: 'auto' },
  });
  const [cfg, setCfg] = useState<ConfigInfo | null>(null);
  const [caller, setCaller] = useState<string>('password-reset');
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/builder')
      .then(r => r.json())
      .then(d => setCfg(d.configs[0]));
  }, []);

  const st = api.builderState;
  const running = st?.running ?? false;
  const active = st?.activeAgent ?? cfg?.startAgent ?? null;
  const agentById = useMemo(() => new Map((cfg?.agents ?? []).map(a => [a.id, a])), [cfg]);
  const activeAgent = active ? agentById.get(active) : undefined;
  const script = cfg?.scripts.find(s => s.id === caller);

  const start = async () => {
    if (!cfg) return;
    if (caller === 'mic') {
      await api.start();
      api.builderStart(cfg.id, 'mic');
    } else api.builderStart(cfg.id, 'script', caller);
  };
  const stop = () => {
    api.builderStop();
    if (api.capturing) api.stop();
  };
  useEffect(() => {
    if (st && !st.running && api.capturing) api.stop();
  }, [st, api]);

  const status = !st
    ? 'Ready'
    : st.phase === 'ended'
      ? `Call ended · ${st.endedReason ?? ''}`
      : st.phase === 'connecting'
        ? 'Connecting…'
        : st.phase === 'tool'
          ? `${activeAgent?.name} is calling a tool…`
          : st.phase === 'caller'
            ? 'Caller is speaking'
            : `${activeAgent?.name} · voice ${activeAgent?.voice}`;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 py-4 md:px-4 md:py-6">
      <div className="mx-auto flex w-full max-w-[76rem] flex-1 flex-col gap-3.5 lg:min-h-0">
        <header className="flex flex-col items-center gap-1 text-center">
          <h1 className="text-primary text-sm font-semibold tracking-[-0.2px]">Multi-agent voice line on speech-to-speech</h1>
          <p className="text-muted max-w-3xl text-sm">
            {cfg?.title ?? '…'}: {cfg?.agents.length ?? 0} agents on one Grok Voice session. A handoff is a tool call that swaps the session's instructions, tools, and voice
            with <code className="text-primary font-mono text-xs">session.update</code>; the conversation carries over.
          </p>
        </header>
        {api.error && (
          <div className="bg-danger/10 text-danger rounded-xl px-3 py-2 text-sm" role="alert">
            {api.error}
          </div>
        )}

        <div className="grid min-w-0 gap-3.5 lg:min-h-0 lg:flex-1 lg:grid-cols-[1.05fr_1fr] lg:gap-4">
          {/* Call */}
          <div className="flex min-w-0 flex-col gap-3 lg:min-h-0">
            <div className="ring-hairline bg-surface-l0 flex h-[3.25rem] min-w-0 items-center gap-2 rounded-full px-2" data-testid="builder-bar">
              <CallerPicker scripts={cfg?.scripts ?? []} value={caller} onChange={setCaller} disabled={running} />
              <div className="relative flex h-8 min-w-0 grow items-center px-1">
                <LiveWaveform className="text-primary" active={api.outputPlaying} processing={st?.phase === 'connecting' || st?.phase === 'tool'} analyser={api.outputAnalyser} />
              </div>
              {running ? (
                <Button variant="outline" onClick={stop}>
                  <PhoneOff size={13} />
                  <span className="max-sm:hidden">Hang up</span>
                </Button>
              ) : (
                <Button variant="primary" className="px-4" onClick={() => void start()} disabled={!cfg || api.connection !== 'open'}>
                  <Phone size={13} />
                  <span className="max-sm:hidden">Start call</span>
                </Button>
              )}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 px-1">
              <span className="text-primary inline-flex items-center gap-2 text-xs font-medium" data-testid="builder-status">
                <span className={cn('size-1.5 rounded-full', running ? 'bg-success animate-pulse' : 'bg-tertiary')} />
                {status}
              </span>
              {caller === 'mic' ? (
                <label className="text-muted inline-flex items-center gap-2 text-xs">
                  Headphones (talk over the agent)
                  <Switch label="Headphones" checked={api.prefs.headphones} onChange={headphones => api.updatePrefs({ headphones })} />
                </label>
              ) : (
                script?.listenFor && <span className="text-tertiary max-w-[60%] truncate text-xs" title={script.listenFor}>Listen for: {script.listenFor}</span>
              )}
            </div>
            <CallTranscript lines={api.builderLines} events={api.builderEvents} agents={agentById} />
          </div>

          {/* Agents and log */}
          <div className="flex min-w-0 flex-col gap-3 lg:min-h-0">
            <section className={cn(PANEL, 'max-h-[26rem] lg:max-h-[55%]')}>
              <div className="flex items-center justify-between px-4 pb-2 pt-3">
                <span className="text-primary text-sm font-medium">Agents</span>
                <span className="text-tertiary text-xs">click an agent for its prompt, tools, and guardrails</span>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
                {(cfg?.agents ?? []).map(a => (
                  <AgentRow key={a.id} agent={a} active={a.id === active && running} start={a.id === cfg?.startAgent} open={open === a.id} onToggle={() => setOpen(o => (o === a.id ? null : a.id))} />
                ))}
              </div>
            </section>
            <section className={cn(PANEL, 'h-[22rem] lg:h-auto lg:flex-1')}>
              <div className="flex items-center justify-between px-4 pb-2 pt-3">
                <span className="text-primary text-sm font-medium">Handoffs and tool calls</span>
                <span className="text-tertiary text-xs">{api.builderEvents.filter(e => e.kind === 'tool').length} tool calls</span>
              </div>
              <EventLog events={api.builderEvents} />
            </section>
          </div>
        </div>
        <footer className="text-tertiary flex flex-wrap justify-center gap-x-4 text-[11px]">
          <span className="font-mono">{st?.model ?? 'grok-voice-latest'}</span>
          <span>wss://api.x.ai/v1/realtime · function calling · session.update · force_message</span>
        </footer>
      </div>
    </div>
  );
}

function CallerPicker({ scripts, value, onChange, disabled }: { scripts: ScriptInfo[]; value: string; onChange: (v: string) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const label = value === 'mic' ? 'You (microphone)' : (scripts.find(s => s.id === value)?.title ?? 'Caller');
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      className="w-[22rem] p-1.5"
      trigger={
        <button
          type="button"
          aria-label="Caller"
          disabled={disabled}
          onClick={() => setOpen(o => !o)}
          className="ring-hairline text-primary inline-flex h-8 min-w-0 max-w-[18rem] shrink items-center gap-1.5 whitespace-nowrap rounded-full px-3 text-sm hover:bg-primary/5 disabled:opacity-50"
        >
          {value === 'mic' ? <Mic size={14} /> : <Bot size={14} />}
          <span className="truncate">{label}</span>
          <ChevronDown size={14} className="text-muted shrink-0" />
        </button>
      }
    >
      <p className="text-muted px-2 pb-1 pt-1 text-xs">Who calls the line</p>
      {[{ id: 'mic', title: 'You (microphone)', opening: 'Speak to the agents yourself. Headphones recommended.', language: '', listenFor: null }, ...scripts].map(s => (
        <button
          key={s.id}
          type="button"
          role="option"
          aria-selected={s.id === value}
          onClick={() => {
            onChange(s.id);
            setOpen(false);
          }}
          className={cn('flex w-full flex-col items-start gap-0.5 rounded-xl px-2 py-1.5 text-left', s.id === value ? 'bg-primary/10' : 'hover:bg-primary/5')}
        >
          <span className="text-primary text-sm font-medium">
            {s.id === 'mic' ? s.title : `Simulated caller · ${s.title}`}
            {s.language && s.language !== 'en' ? <span className="text-tertiary ml-1.5 text-xs uppercase">{s.language}</span> : null}
          </span>
          <span className="text-muted line-clamp-2 text-xs leading-5">{s.id === 'mic' ? s.opening : `“${s.opening}”`}</span>
        </button>
      ))}
    </Popover>
  );
}

type Item = { at: number; line?: BuilderLine; event?: BuilderEvent };

function CallTranscript({ lines, events, agents }: { lines: BuilderLine[]; events: BuilderEvent[]; agents: Map<string, AgentInfo> }) {
  const listRef = useRef<HTMLDivElement>(null);
  const items: Item[] = [
    ...lines.filter(l => l.text.trim()).map(l => ({ at: l.at, line: l })),
    ...events.filter(e => e.kind === 'handoff' || e.kind === 'tool' || e.kind === 'end').map(e => ({ at: e.at, event: e })),
  ].sort((a, b) => a.at - b.at);
  const last = lines.at(-1)?.text;
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  }, [items.length, last]);
  return (
    <section className={cn(PANEL, 'h-[30rem] lg:h-auto lg:flex-1')} data-testid="builder-transcript">
      <div ref={listRef} className="scrollbar-none min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4 md:px-5">
        {items.length === 0 && <p className="text-muted py-16 text-center text-sm">Pick who calls, then press Start call.</p>}
        {items.map(it =>
          it.line ? (
            <div key={it.line.id} className={cn('flex flex-col gap-0.5', it.line.role === 'caller' && 'items-end text-right')} data-role={it.line.role}>
              <span className="text-tertiary text-[11px] font-medium">
                {it.line.role === 'caller' ? 'Caller' : (it.line.agentName ?? 'Agent')}
                {it.line.role === 'agent' && it.line.agentId ? <span className="ml-1.5 font-mono">{agents.get(it.line.agentId)?.voice}</span> : null}
              </span>
              <p
                className={cn(
                  'max-w-[88%] rounded-2xl px-3 py-1.5 text-[14.5px] leading-6',
                  it.line.role === 'caller' ? 'bg-primary/[0.07] text-primary' : 'text-primary',
                  !it.line.final && 'text-muted',
                )}
              >
                {it.line.text}
              </p>
            </div>
          ) : it.event!.kind === 'handoff' ? (
            <div key={it.event!.id} className="text-sunset flex items-center gap-2 py-1 text-xs font-medium" data-kind="handoff">
              <span className="bg-sunset/30 h-px flex-1" />
              <ArrowRight size={13} />
              {it.event!.title}
              <span className="text-tertiary font-normal">· session.update</span>
              <span className="bg-sunset/30 h-px flex-1" />
            </div>
          ) : it.event!.kind === 'tool' ? (
            <div key={it.event!.id} className="text-tertiary flex items-center gap-1.5 font-mono text-[11px]" data-kind="tool">
              <Wrench size={11} />
              {it.event!.title}
              <SourceBadge source={it.event!.source} ok={it.event!.ok} />
              <span>{it.event!.ms} ms</span>
            </div>
          ) : (
            <div key={it.event!.id} className="text-tertiary py-1 text-center text-xs">
              {it.event!.title} · {it.event!.detail}
            </div>
          ),
        )}
      </div>
    </section>
  );
}

function SourceBadge({ source, ok }: { source?: string; ok?: boolean }) {
  const label = source === 'live' ? 'HTTP' : source === 'mock' ? 'mock' : 'local';
  return (
    <span
      className={cn(
        'rounded-full px-1.5 py-px text-[10px] font-medium uppercase tracking-wide',
        ok === false ? 'bg-danger/15 text-danger' : source === 'live' ? 'bg-success/15 text-success' : source === 'mock' ? 'bg-sunset/15 text-sunset' : 'bg-primary/10 text-muted',
      )}
    >
      {label}
      {ok === false ? ' · failed' : ''}
    </span>
  );
}

function AgentRow({ agent, active, start, open, onToggle }: { agent: AgentInfo; active: boolean; start: boolean; open: boolean; onToggle: () => void }) {
  const [prompt, setPrompt] = useState(false);
  return (
    <div className={cn('rounded-xl transition-colors', active ? 'bg-success/[0.08] ring-1 ring-success/30' : open ? 'bg-primary/[0.04]' : '')} data-agent={agent.id} data-active={active}>
      <button type="button" onClick={onToggle} className="flex w-full items-center gap-2.5 px-2.5 py-2 text-left" aria-expanded={open}>
        <span className={cn('size-2 shrink-0 rounded-full', active ? 'bg-success animate-pulse' : 'bg-primary/20')} />
        <span className="text-primary min-w-0 flex-1 truncate text-sm font-medium">
          {agent.name}
          {start && <span className="text-tertiary ml-1.5 text-[11px] font-normal">starts the call</span>}
        </span>
        <span className="text-muted font-mono text-[11px]">{agent.voice}</span>
        <span className="text-tertiary inline-flex items-center gap-0.5 text-[11px]" title="tools">
          <Wrench size={11} />
          {agent.tools.length}
        </span>
        <span className="text-tertiary inline-flex items-center gap-0.5 text-[11px]" title="guardrails">
          <Shield size={11} />
          {agent.guardrails.length}
        </span>
        <ChevronDown size={14} className={cn('text-muted transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="space-y-2.5 px-3 pb-3 text-xs">
          {agent.greeting && (
            <p className="text-muted">
              Greeting <span className="text-primary">“{agent.greeting}”</span>
            </p>
          )}
          <div className="flex flex-wrap gap-1.5">
            {agent.tools.map(t => (
              <span key={t.name} className="ring-hairline text-primary inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-mono text-[11px]" title={t.url ?? t.targets?.join(', ')}>
                {t.type === 'transfer' ? <ArrowRight size={11} /> : t.type === 'search_knowledge' ? <Search size={11} /> : t.type === 'end_call' ? <Square size={9} /> : <Wrench size={11} />}
                {t.name}
                {t.type === 'api_request' && <span className="text-tertiary">{t.method}</span>}
                {t.mock && t.auth && <span className="text-sunset">oauth→mock</span>}
              </span>
            ))}
          </div>
          {agent.tools
            .filter(t => t.type === 'transfer')
            .map(t => (
              <p key={t.name} className="text-muted">
                Hands off to: <span className="text-primary">{t.targets?.map(x => x.replace('Continue — ', '')).join(', ')}</span>
              </p>
            ))}
          {agent.tools
            .filter(t => t.type === 'api_request')
            .map(t => (
              <p key={t.name} className="text-muted break-all font-mono text-[11px]">
                {t.name}: {t.method} {t.url}
              </p>
            ))}
          {agent.knowledge.length > 0 && <p className="text-muted">Knowledge: <span className="text-primary">{agent.knowledge.join(', ')}</span></p>}
          <p className="text-muted">
            Guardrails: <span className="text-primary">{agent.guardrails.join(', ') || 'none'}</span>
          </p>
          <button type="button" onClick={() => setPrompt(p => !p)} className="text-muted hover:text-primary underline-offset-2 hover:underline">
            {prompt ? 'Hide' : 'Show'} the system prompt the session receives ({agent.instructions.length.toLocaleString()} chars)
          </button>
          {prompt && (
            <pre className="bg-surface-l1 ring-hairline text-muted max-h-72 overflow-auto whitespace-pre-wrap rounded-lg p-2.5 font-mono text-[11px] leading-5">
              {agent.instructions}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function EventLog({ events }: { events: BuilderEvent[] }) {
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  }, [events.length]);
  return (
    <div ref={listRef} className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 pb-3" data-testid="builder-events">
      {events.length === 0 && <p className="text-muted py-8 text-center text-sm">Handoffs and tool calls appear here during the call.</p>}
      {events.map(e => (
        <details key={e.id} className="ring-hairline group rounded-xl px-3 py-2" data-kind={e.kind} open={e.kind === 'handoff'}>
          <summary className="flex cursor-pointer list-none items-center gap-2 text-xs">
            <span
              className={cn(
                'rounded-full px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide',
                e.kind === 'handoff' ? 'bg-sunset/15 text-sunset' : e.kind === 'tool' ? 'bg-primary/10 text-primary' : e.kind === 'error' ? 'bg-danger/15 text-danger' : 'bg-primary/5 text-muted',
              )}
            >
              {e.kind}
            </span>
            <span className="text-primary min-w-0 flex-1 truncate font-mono">{e.title}</span>
            {e.kind === 'tool' && <SourceBadge source={e.source} ok={e.ok} />}
            {e.ms != null && <span className="text-tertiary font-mono">{e.ms} ms</span>}
            <span className="text-tertiary font-mono">{new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
          </summary>
          <div className="mt-2 space-y-1.5">
            {e.kind === 'tool' && e.data != null && (
              <p className="text-muted break-all font-mono text-[11px]">args {JSON.stringify((e.data as { args?: unknown }).args)}</p>
            )}
            {e.kind === 'handoff' && e.data != null && (
              <p className="text-muted text-[11px]">
                session.update → voice <span className="text-primary font-mono">{(e.data as { voice: string }).voice}</span>, tools{' '}
                <span className="text-primary font-mono">{(e.data as { tools: string[] }).tools.join(', ')}</span>
              </p>
            )}
            {e.detail && <pre className="text-muted max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-5">{e.detail}</pre>}
          </div>
        </details>
      ))}
    </div>
  );
}

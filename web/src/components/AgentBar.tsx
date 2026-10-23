import { Bot, ChevronDown, Play, Square, Volume2 } from 'lucide-react';
import { useState } from 'react';
import type { AgentsState } from '../../../src/shared/protocol';
import { cn } from '../lib/cn';
import { LiveWaveform } from './LiveWaveform';
import { Button, Popover } from './ui';

export type ScenarioInfo = {
  id: string;
  title: string;
  description: string;
  opening: string;
  starter: 'a' | 'b';
  agents: Record<'a' | 'b', { name: string; role: string }>;
};

const BAR = 'ring-hairline bg-surface-l0 flex h-[3.25rem] min-w-0 shrink-0 items-center gap-2 rounded-full px-2 md:gap-2.5';

const field =
  'bg-surface-l1 ring-hairline text-primary placeholder:text-tertiary w-full rounded-lg px-2.5 py-1.5 text-sm outline-none focus:ring-2 focus:ring-primary/30';

/** Agents mode replacement for the mic bar: pick a scenario, start or stop the call, see who is talking. */
export function AgentBar({
  host,
  state,
  scenarios,
  speaking,
  analyser,
  audioReady,
  onEnableAudio,
  onStart,
  onStop,
  disabled,
}: {
  host: boolean;
  state: AgentsState | null;
  scenarios: ScenarioInfo[];
  /** This window is playing its own agent's voice. */
  speaking: boolean;
  analyser: () => AnalyserNode | null;
  audioReady: boolean;
  onEnableAudio: () => void;
  onStart: (scenarioId: string, opening: string, maxTurns: number) => void;
  onStop: () => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [scenarioId, setScenarioId] = useState(scenarios[0]?.id ?? '');
  const scenario = scenarios.find(s => s.id === scenarioId) ?? scenarios[0];
  const [opening, setOpening] = useState<string | null>(null);
  const [maxTurns, setMaxTurns] = useState(12);
  const running = state?.running ?? false;
  const connecting = state?.phase === 'connecting';
  const openingText = opening ?? scenario?.opening ?? '';

  return (
    <div className={BAR} data-testid="agent-bar">
      {host ? (
        <Popover
          open={open}
          onOpenChange={setOpen}
          className="w-[22rem] p-2"
          trigger={
            <button
              type="button"
              disabled={running}
              onClick={() => setOpen(o => !o)}
              aria-label="Scenario"
              className="ring-hairline text-primary inline-flex h-8 min-w-0 max-w-[14rem] shrink items-center gap-1.5 whitespace-nowrap rounded-full px-3 text-sm transition-colors hover:bg-primary/5 disabled:opacity-50 disabled:hover:bg-transparent"
            >
              <Bot size={14} />
              <span className="hidden truncate min-[560px]:inline">{scenario?.title ?? 'Scenario'}</span>
              <ChevronDown size={14} className="text-muted shrink-0" />
            </button>
          }
        >
          <p className="text-muted px-2 pb-1 pt-1.5 text-xs">Scenario</p>
          {scenarios.map(s => (
            <button
              key={s.id}
              type="button"
              role="option"
              aria-selected={s.id === scenarioId}
              onClick={() => {
                setScenarioId(s.id);
                setOpening(null);
              }}
              className={cn(
                'flex w-full flex-col items-start gap-0.5 rounded-xl px-2 py-1.5 text-left transition-colors',
                s.id === scenarioId ? 'bg-primary/10' : 'hover:bg-primary/5',
              )}
            >
              <span className="text-primary text-sm font-medium">{s.title}</span>
              <span className="text-muted text-xs leading-5">{s.description}</span>
            </button>
          ))}
          <div className="bg-primary/10 mx-2 my-2 h-px" />
          <label className="flex flex-col gap-1 px-2 py-1">
            <span className="text-muted text-xs">
              Opening line ({scenario ? scenario.agents[scenario.starter].name : ''}, spoken word for word; leave empty to let the agent open)
            </span>
            <textarea
              className={field + ' min-h-24 resize-none'}
              value={openingText}
              onChange={e => setOpening(e.target.value)}
              aria-label="Opening line"
            />
          </label>
          <label className="flex items-center justify-between gap-3 px-2 py-2">
            <span className="text-muted text-xs">Stop after</span>
            <span className="flex items-center gap-2">
              <input
                type="range"
                min={4}
                max={24}
                step={2}
                value={maxTurns}
                onChange={e => setMaxTurns(Number(e.target.value))}
                className="accent-primary w-32"
                aria-label="Maximum turns"
              />
              <span className="text-primary w-14 text-right font-mono text-xs tabular-nums">{maxTurns} turns</span>
            </span>
          </label>
        </Popover>
      ) : (
        <span className="text-muted grid size-8 shrink-0 place-items-center">
          <Bot size={15} />
        </span>
      )}

      <div className="relative flex h-8 min-w-0 grow items-center px-1">
        <LiveWaveform className="text-primary" active={speaking} processing={connecting} analyser={analyser} />
      </div>

      {!host && !audioReady && (
        <Button variant="outline" onClick={onEnableAudio}>
          <Volume2 size={14} />
          <span className="hidden sm:inline">Enable audio</span>
        </Button>
      )}
      {host &&
        (running ? (
          <Button variant="outline" onClick={onStop}>
            <Square size={12} fill="currentColor" />
            <span className="hidden sm:inline">Stop</span>
          </Button>
        ) : (
          <Button variant="primary" className="px-3 sm:px-4" disabled={disabled || !scenario} onClick={() => scenario && onStart(scenario.id, openingText, maxTurns)}>
            <Play size={13} fill="currentColor" />
            <span className="hidden sm:inline">Start conversation</span>
          </Button>
        ))}
    </div>
  );
}

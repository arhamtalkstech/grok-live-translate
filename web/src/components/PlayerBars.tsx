import { Mic, Square, Volume2 } from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import type { InputSource } from '../lib/audio';
import { LiveWaveform } from './LiveWaveform';
import { SourceSelect } from './Pickers';
import { Button } from './ui';

const BAR = 'ring-hairline bg-surface-l0 flex h-[3.25rem] min-w-0 shrink-0 items-center gap-2 rounded-full px-2 md:gap-2.5';
const SWAP = { duration: 0.18, ease: [0.3, 0.7, 0.2, 1] } as const;

export function InputBar({
  live,
  connecting,
  speaking,
  gated,
  analyser,
  source,
  onSource,
  onToggle,
  ptt,
  onPtt,
  disabled,
}: {
  live: boolean;
  connecting: boolean;
  speaking: boolean;
  /** Mic muted because a translation is playing on this device. */
  gated: boolean;
  analyser: () => AnalyserNode | null;
  source: InputSource;
  onSource: (s: InputSource) => void;
  onToggle: () => void;
  ptt: boolean;
  onPtt: (down: boolean) => void;
  disabled?: boolean;
}) {
  const still = Boolean(useReducedMotion());
  const motionProps = still
    ? {}
    : { initial: { opacity: 0, x: 6 }, animate: { opacity: 1, x: 0 }, exit: { opacity: 0, x: -6 }, transition: SWAP };
  const key = live ? (connecting ? 'cancel' : 'stop') : 'start';

  return (
    <div className={BAR} data-testid="input-bar">
      <SourceSelect value={source} onChange={onSource} disabled={live} />
      <div className="relative flex h-8 min-w-0 grow items-center px-1">
        <LiveWaveform
          className={speaking ? 'text-primary' : 'text-muted'}
          active={live && !connecting && !gated}
          processing={connecting}
          analyser={analyser}
        />
        {live && !connecting && (
          <span className="bg-surface-l0 text-tertiary pointer-events-none absolute right-0 hidden pl-2 pr-1 text-[11px] sm:block" aria-live="polite">
            {gated ? 'Mic paused while translation plays' : speaking ? 'Hearing you' : ptt ? 'Hold Space to talk' : 'Listening'}
          </span>
        )}
      </div>
      <AnimatePresence initial={false} mode="popLayout">
        <motion.div key={key} layout {...motionProps} className="flex shrink-0 items-center gap-1.5">
          {live && ptt && !connecting && (
            <Button
              variant="primary"
              className="px-4"
              onPointerDown={e => {
                (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
                onPtt(true);
              }}
              onPointerUp={() => onPtt(false)}
              onPointerCancel={() => onPtt(false)}
              aria-label="Hold to talk"
            >
              <Mic size={14} />
              <span className="hidden sm:inline">Hold to talk</span>
            </Button>
          )}
          {live ? (
            <Button variant="outline" onClick={onToggle}>
              <Square size={12} fill="currentColor" />
              <span className="hidden sm:inline">{connecting ? 'Cancel' : 'Stop'}</span>
            </Button>
          ) : (
            <Button variant="primary" className="px-3 sm:px-4" onClick={onToggle} disabled={disabled}>
              <Mic size={14} />
              <span className="max-sm:hidden">Start</span>
            </Button>
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

export function OutputBar({
  live,
  playing,
  processing,
  analyser,
  label,
}: {
  live: boolean;
  playing: boolean;
  processing: boolean;
  analyser: () => AnalyserNode | null;
  label: string;
}) {
  return (
    <div className={BAR} data-testid="output-bar">
      <span className="text-muted grid size-8 shrink-0 place-items-center" title={label}>
        <Volume2 size={15} />
      </span>
      <div className="relative flex h-8 min-w-0 grow items-center px-1">
        <LiveWaveform className="text-muted" active={live && playing} processing={live && processing && !playing} analyser={analyser} />
      </div>
      <span className="text-tertiary hidden shrink-0 pr-3 text-[11px] sm:block">{label}</span>
    </div>
  );
}

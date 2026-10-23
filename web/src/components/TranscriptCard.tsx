import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useEffect, useRef, type ReactNode } from 'react';
import type { Segment } from '../../../src/shared/protocol';
import { cn } from '../lib/cn';

const PANEL = 'ring-hairline bg-surface-l0 flex h-[26rem] max-h-[60dvh] min-h-[15rem] flex-col rounded-[1.25rem] lg:h-auto lg:max-h-none lg:min-h-0 lg:flex-1';
const SETTLE = [0.2, 0.8, 0.25, 1] as const;

export type CardEntry = {
  segment: Segment;
  /** "original" = spoken in this card's language; "translation" = interpreted into it. */
  kind: 'original' | 'translation';
};

export function TranscriptCard({
  toolbar,
  label,
  entries,
  empty,
  playingSegment,
}: {
  toolbar: ReactNode;
  label?: ReactNode;
  entries: CardEntry[];
  empty: string;
  /** `${segmentId}:${kind}` playing now; simultaneous mode passes two (original + interpretation). */
  playingSegment: string | string[] | null;
}) {
  const still = Boolean(useReducedMotion());
  const listRef = useRef<HTMLDivElement>(null);
  const isEmpty = entries.length === 0;
  const last = entries.at(-1);
  const lastText = last ? (last.kind === 'original' ? last.segment.source : last.segment.translation) : '';

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: still ? 'auto' : 'smooth' });
  }, [entries.length, lastText, still]);

  return (
    <section className={PANEL}>
      <div className="flex min-w-0 shrink-0 flex-wrap items-center gap-2 px-3 pb-2 pt-3">
        {toolbar}
        {label && <div className="text-muted ml-auto truncate pr-1 text-xs">{label}</div>}
      </div>
      <div ref={listRef} className="scrollbar-none min-h-0 flex-1 overflow-y-auto px-4 pb-5 sm:px-6">
        <AnimatePresence initial={false} mode="wait">
          <motion.div
            key={isEmpty ? `empty:${empty}` : 'content'}
            className={cn('flex min-h-full min-w-0 flex-col gap-4', isEmpty && 'items-center justify-center')}
            initial={still ? false : { opacity: 0, y: 3 }}
            animate={{ opacity: 1, y: 0, transition: { duration: 0.18, ease: SETTLE } }}
            exit={still ? undefined : { opacity: 0, y: -4, transition: { duration: 0.1 } }}
          >
            {isEmpty ? (
              <p className="text-muted text-center text-sm leading-6">{empty}</p>
            ) : (
              entries.map(e => (
                <Entry
                  key={e.segment.id}
                  entry={e}
                  playing={
                    Array.isArray(playingSegment)
                      ? playingSegment.includes(`${e.segment.id}:${e.kind}`)
                      : playingSegment === `${e.segment.id}:${e.kind}`
                  }
                  still={still}
                />
              ))
            )}
          </motion.div>
        </AnimatePresence>
      </div>
    </section>
  );
}

function Entry({ entry, playing, still }: { entry: CardEntry; playing: boolean; still: boolean }) {
  const { segment: s, kind } = entry;
  const text = kind === 'original' ? s.source : s.translation;
  const final = kind === 'original' ? s.sourceFinal : s.translationFinal;
  const words = text.split(/\s+/).filter(Boolean);
  const pending = kind === 'translation' && !text && (s.status === 'translating' || s.status === 'listening');

  return (
    <motion.article
      layout={still ? false : 'position'}
      initial={still ? false : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0, transition: { duration: 0.22, ease: SETTLE } }}
      className="min-w-0"
      data-segment={s.id}
      data-kind={kind}
    >
      <header className="text-tertiary mb-1 flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.06em]">
        <span className="text-muted normal-case tracking-normal">{s.speakerName || (kind === 'original' ? 'Speaker' : 'Interpreter')}</span>
        <span>{kind === 'original' ? 'Original' : 'Translated'}</span>
        {kind === 'translation' && s.lagMs != null && (
          <span className="font-mono normal-case tracking-normal tabular-nums" title="Time from the speaker starting to the first interpreted word">
            {(s.lagMs / 1000).toFixed(1)} s behind
          </span>
        )}
        {kind === 'translation' && s.lagMs == null && s.latencyMs != null && (
          <span className="font-mono normal-case tracking-normal tabular-nums" title="Time from end of speech to first translated audio">
            {(s.latencyMs / 1000).toFixed(2)} s
          </span>
        )}
        {playing && <PlayingDots />}
      </header>
      {pending ? (
        <TypingDots />
      ) : (
        <p className="text-primary text-pretty break-words text-[15px] leading-7">
          {words.map((w, i) => (
            <motion.span
              key={`${i}-${w}`}
              className={cn(!final && i >= words.length - 3 ? 'text-muted' : undefined)}
              initial={still ? false : { opacity: 0.2 }}
              animate={{ opacity: 1, transition: { duration: 0.3 } }}
            >
              {w}{' '}
            </motion.span>
          ))}
        </p>
      )}
    </motion.article>
  );
}

function TypingDots() {
  return (
    <span className="inline-flex h-7 items-center gap-1" aria-label="Translating">
      {[0, 1, 2].map(i => (
        <span key={i} className="bg-muted size-1.5 animate-pulse rounded-full" style={{ animationDelay: `${i * 150}ms` }} />
      ))}
    </span>
  );
}

function PlayingDots() {
  return (
    <span className="inline-flex h-3 items-end gap-[2px]" aria-label="Playing">
      {[0, 1, 2].map(i => (
        <span
          key={i}
          className="bg-primary w-[2px] animate-[lt-eq_0.9s_ease-in-out_infinite] rounded-full"
          style={{ animationDelay: `${i * 0.15}s`, height: '100%' }}
        />
      ))}
    </span>
  );
}

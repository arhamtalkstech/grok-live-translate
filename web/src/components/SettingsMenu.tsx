import { SlidersHorizontal } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import type { Mode, TurnMode } from '../../../src/shared/protocol';
import { IconButton, InfoTip, Popover, Switch } from './ui';

function Row({ label, tip, children }: { label: string; tip: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 px-2 py-2">
      <span className="text-muted inline-flex items-center gap-1 text-xs">
        {label}
        <InfoTip text={tip} />
      </span>
      {children}
    </div>
  );
}

const field =
  'bg-surface-l1 ring-hairline text-primary placeholder:text-tertiary w-full rounded-lg px-2.5 py-1.5 text-sm outline-none focus:ring-2 focus:ring-primary/30';

export function SettingsMenu(props: {
  mode: Mode;
  /** Agents mode: no microphone, so mic settings are hidden. */
  agents?: boolean;
  /** Simultaneous mode: volume of the original voice under the interpretation (0–1). */
  originalVolume?: number;
  onOriginalVolume?: (v: number) => void;
  playAudio: boolean;
  onPlayAudio: (v: boolean) => void;
  headphones: boolean;
  onHeadphones: (v: boolean) => void;
  turnMode: TurnMode;
  onTurnMode: (v: TurnMode) => void;
  endSilenceMs: number;
  onEndSilence: (v: number) => void;
  names: { mine: string; other: string };
  onNames: (mine: string, other: string) => void;
  keyterms: string[];
  onKeyterms: (terms: string[]) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [mine, setMine] = useState(props.names.mine);
  const [other, setOther] = useState(props.names.other);
  const [terms, setTerms] = useState(props.keyterms.join(', '));

  useEffect(() => {
    if (!open) {
      setMine(props.names.mine);
      setOther(props.names.other);
      setTerms(props.keyterms.join(', '));
    }
  }, [open, props.names.mine, props.names.other, props.keyterms]);

  const commitNames = () => props.onNames(mine.trim(), other.trim());
  const commitTerms = () =>
    props.onKeyterms(
      terms
        .split(/[,\n]/)
        .map(t => t.trim())
        .filter(Boolean),
    );

  return (
    <Popover
      open={open}
      onOpenChange={o => {
        if (!o) {
          commitNames();
          commitTerms();
        }
        setOpen(o);
      }}
      align="start"
      className="w-80 p-2"
      trigger={
        <IconButton aria-label="Translation settings" aria-expanded={open} onClick={() => setOpen(o => !o)}>
          <SlidersHorizontal size={15} />
        </IconButton>
      }
    >
      <Row label="Play translated audio" tip="Hear the interpreter on this device. Captions keep updating when this is off.">
        <Switch label="Play translated audio" checked={props.playAudio} onChange={props.onPlayAudio} />
      </Row>
      {props.originalVolume != null && (
        <div className="px-2 py-2">
          <div className="flex items-center justify-between">
            <span className="text-muted inline-flex items-center gap-1 text-xs">
              Original voice volume
              <InfoTip text="The speaker's own voice plays quietly under the interpretation, so the audience can hear that someone is talking." />
            </span>
            <span className="text-primary font-mono text-xs tabular-nums">{Math.round(props.originalVolume * 100)}%</span>
          </div>
          <input
            type="range"
            min={0}
            max={0.5}
            step={0.01}
            value={props.originalVolume}
            onChange={e => props.onOriginalVolume?.(Number(e.target.value))}
            className="accent-primary mt-2 w-full"
            aria-label="Original voice volume"
          />
        </div>
      )}
      {!props.agents && (<>
      <Row
        label="Headphones"
        tip="Keep the mic open while a translation plays. Leave off on laptop speakers so the mic does not pick up the interpreter."
      >
        <Switch label="Headphones" checked={props.headphones} onChange={props.onHeadphones} />
      </Row>
      <Row label="Push to talk" tip="Hold Space (or the Talk button) while speaking. Useful in noisy rooms.">
        <Switch label="Push to talk" checked={props.turnMode === 'ptt'} onChange={v => props.onTurnMode(v ? 'ptt' : 'auto')} />
      </Row>
      <div className="px-2 py-2">
        <div className="flex items-center justify-between">
          <span className="text-muted inline-flex items-center gap-1 text-xs">
            Pause before translating
            <InfoTip text="How long a silence ends your turn in hands-free mode. Shorter feels faster; longer avoids cutting a sentence in half." />
          </span>
          <span className="text-primary font-mono text-xs tabular-nums">{(props.endSilenceMs / 1000).toFixed(2)} s</span>
        </div>
        <input
          type="range"
          min={350}
          max={1500}
          step={50}
          value={props.endSilenceMs}
          disabled={props.turnMode === 'ptt'}
          onChange={e => props.onEndSilence(Number(e.target.value))}
          className="accent-primary mt-2 w-full disabled:opacity-40"
          aria-label="Pause before translating"
        />
      </div>
      <div className="bg-primary/10 mx-2 my-1 h-px" />
      <div className="grid grid-cols-2 gap-2 px-2 py-2">
        <label className="flex flex-col gap-1">
          <span className="text-muted text-xs">{props.mode === 'same' ? 'Left speaker' : 'Your name'}</span>
          <input className={field} value={mine} onChange={e => setMine(e.target.value)} onBlur={commitNames} placeholder="Name" maxLength={40} />
        </label>
        {props.mode === 'same' && (
          <label className="flex flex-col gap-1">
            <span className="text-muted text-xs">Right speaker</span>
            <input className={field} value={other} onChange={e => setOther(e.target.value)} onBlur={commitNames} placeholder="Name" maxLength={40} />
          </label>
        )}
      </div>
      </>)}
      <label className="flex flex-col gap-1 px-2 py-2">
        <span className="text-muted inline-flex items-center gap-1 text-xs">
          Names &amp; terms
          <InfoTip text="Comma-separated. Biases speech recognition (keyterms) and tells the interpreter to keep these spellings." />
        </span>
        <textarea
          className={field + ' min-h-16 resize-none'}
          value={terms}
          onChange={e => setTerms(e.target.value)}
          onBlur={commitTerms}
          placeholder="Rahul Sharma, Vantorra Bank, Halvorsen"
        />
      </label>
      <div className="flex justify-end px-2 pb-1 pt-1">
        <button
          type="button"
          onClick={() => {
            props.onClear();
            setOpen(false);
          }}
          className="text-muted hover:text-primary rounded-full px-2 py-1 text-xs"
        >
          Clear transcript
        </button>
      </div>
    </Popover>
  );
}

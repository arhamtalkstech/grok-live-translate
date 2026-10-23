import { AudioLines, Check, ChevronDown, Mic, Monitor } from 'lucide-react';
import { useState } from 'react';
import type { Language } from '../../../src/shared/languages';
import { cn } from '../lib/cn';
import type { InputSource } from '../lib/audio';
import { Popover } from './ui';

export type Voice = { voice_id: string; name: string; gender?: string };

function Option({ selected, label, hint, onSelect }: { selected: boolean; label: string; hint?: string; onSelect: () => void }) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={onSelect}
      className={cn(
        'flex w-full items-center gap-2 rounded-xl px-2 py-1.5 text-left text-sm transition-colors',
        selected ? 'bg-primary/10 text-primary' : 'text-foreground hover:bg-primary/5',
      )}
    >
      <span className="min-w-0 grow truncate font-medium">{label}</span>
      {hint && <span className="text-muted text-xs">{hint}</span>}
      {selected && <Check size={12} />}
    </button>
  );
}

export function LanguagePicker({
  value,
  languages,
  onChange,
  disabled,
  ariaLabel,
  exclude,
}: {
  value: string;
  languages: readonly Language[];
  onChange: (code: string) => void;
  disabled?: boolean;
  ariaLabel: string;
  exclude?: string;
}) {
  const [open, setOpen] = useState(false);
  const label = languages.find(l => l.code === value)?.label ?? value;
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      trigger={
        <button
          type="button"
          disabled={disabled}
          aria-label={ariaLabel}
          aria-expanded={open}
          aria-haspopup="listbox"
          onClick={() => setOpen(o => !o)}
          className="ring-hairline text-primary inline-flex h-9 max-w-full items-center gap-1.5 rounded-full px-3 text-sm font-medium transition-colors hover:bg-primary/5 disabled:cursor-default disabled:hover:bg-transparent"
        >
          <span className="max-w-[9rem] truncate">{label}</span>
          {!disabled && <ChevronDown size={14} className="text-muted" />}
        </button>
      }
      className="w-56"
    >
      <div role="listbox" aria-label={ariaLabel} className="scrollbar-none flex max-h-[300px] flex-col gap-0.5 overflow-y-auto">
        {languages
          .filter(l => l.code !== exclude)
          .map(l => (
            <Option
              key={l.code}
              selected={l.code === value}
              label={l.label}
              onSelect={() => {
                onChange(l.code);
                setOpen(false);
              }}
            />
          ))}
      </div>
    </Popover>
  );
}

export function VoicePill({
  value,
  voices,
  onChange,
  label,
  disabled,
}: {
  value: string;
  voices: Voice[];
  onChange: (voice: string) => void;
  label: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const name = voices.find(v => v.voice_id === value)?.name ?? value;
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      trigger={
        <button
          type="button"
          disabled={disabled}
          title={label}
          aria-label={label}
          onClick={() => setOpen(o => !o)}
          className="ring-hairline text-primary inline-flex h-9 items-center gap-1.5 rounded-full px-3 text-sm font-medium transition-colors hover:bg-primary/5 disabled:opacity-50 disabled:hover:bg-transparent"
        >
          <AudioLines size={15} />
          <span className="max-w-[8rem] truncate">{name}</span>
        </button>
      }
      className="w-60"
    >
      <p className="text-muted px-2 pb-1 pt-1.5 text-xs">{label}</p>
      <div role="listbox" aria-label={label} className="scrollbar-none flex max-h-[300px] flex-col gap-0.5 overflow-y-auto">
        {voices.map(v => (
          <Option
            key={v.voice_id}
            selected={v.voice_id === value}
            label={v.name}
            hint={v.gender}
            onSelect={() => {
              onChange(v.voice_id);
              setOpen(false);
            }}
          />
        ))}
      </div>
    </Popover>
  );
}

export function SourceSelect({ value, onChange, disabled }: { value: InputSource; onChange: (v: InputSource) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const Icon = value === 'tab' ? Monitor : Mic;
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      trigger={
        <button
          type="button"
          disabled={disabled}
          aria-label="Audio source"
          title={value === 'tab' ? 'Translate audio from another browser tab' : 'Use microphone'}
          onClick={() => setOpen(o => !o)}
          className="ring-hairline text-primary inline-flex h-8 shrink-0 items-center gap-1 rounded-full px-2 text-sm transition-colors hover:bg-primary/5 disabled:opacity-50 disabled:hover:bg-transparent sm:gap-1.5 sm:px-3"
        >
          <Icon size={14} />
          <span className="hidden min-[480px]:inline">{value === 'tab' ? 'Tab' : 'Mic'}</span>
          <ChevronDown size={14} className="text-muted" />
        </button>
      }
      className="w-48"
    >
      <p className="text-muted px-2 pb-1 pt-1.5 text-xs">Audio source</p>
      <Option selected={value === 'mic'} label="Microphone" onSelect={() => (onChange('mic'), setOpen(false))} />
      <Option selected={value === 'tab'} label="Browser tab" onSelect={() => (onChange('tab'), setOpen(false))} />
    </Popover>
  );
}

import { Info } from 'lucide-react';
import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cn } from '../lib/cn';

export function Button({
  variant = 'primary',
  size = 'sm',
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'outline' | 'ghost'; size?: 'sm' | 'md' }) {
  return (
    <button
      type="button"
      {...props}
      className={cn(
        'inline-flex shrink-0 select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-full text-sm font-medium transition-[background-color,color,box-shadow,opacity] duration-150 outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-40',
        size === 'sm' ? 'h-8 px-3' : 'h-9 px-3',
        variant === 'primary' && 'bg-primary text-primary-foreground hover:bg-primary/90',
        variant === 'outline' && 'ring-hairline text-primary hover:bg-primary/5',
        variant === 'ghost' && 'text-muted hover:text-primary hover:bg-primary/5',
        className,
      )}
    />
  );
}

export function IconButton({ className, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      {...props}
      className={cn(
        'ring-hairline text-primary inline-grid size-9 shrink-0 place-items-center rounded-full transition-colors hover:bg-primary/5 disabled:opacity-40 outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
        className,
      )}
    />
  );
}

export function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-[18px] w-8 shrink-0 items-center rounded-full transition-colors disabled:opacity-40',
        checked ? 'bg-primary' : 'bg-primary/15',
      )}
    >
      <span
        className={cn(
          'absolute size-3.5 rounded-full transition-transform duration-150',
          checked ? 'translate-x-4 bg-primary-foreground' : 'translate-x-0.5 bg-primary/80',
        )}
      />
    </button>
  );
}

export function InfoTip({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative inline-flex" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button type="button" aria-label={text} className="text-muted hover:text-primary" onFocus={() => setOpen(true)} onBlur={() => setOpen(false)}>
        <Info size={14} />
      </button>
      {open && (
        <span className="bg-surface-l4 text-primary ring-hairline pointer-events-none absolute bottom-full left-1/2 z-50 mb-2 w-60 -translate-x-1/2 rounded-lg px-2.5 py-1.5 text-xs leading-5 shadow-xl">
          {text}
        </span>
      )}
    </span>
  );
}

/** Minimal popover: click outside or Escape closes it. */
export function Popover({
  open,
  onOpenChange,
  trigger,
  children,
  align = 'start',
  className,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trigger: ReactNode;
  children: ReactNode;
  align?: 'start' | 'end';
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onOpenChange(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onOpenChange(false);
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onOpenChange]);
  return (
    <div ref={ref} className="relative min-w-0">
      {trigger}
      {open && (
        <div
          className={cn(
            'bg-surface-l2 ring-hairline absolute top-full z-40 mt-2 rounded-2xl p-1 shadow-2xl shadow-black/60',
            align === 'start' ? 'left-0' : 'right-0',
            className,
          )}
        >
          {children}
        </div>
      )}
    </div>
  );
}

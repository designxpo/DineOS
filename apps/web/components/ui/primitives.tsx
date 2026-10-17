'use client';

import { Info } from 'lucide-react';
import { forwardRef, useId, useLayoutEffect, useRef, useState } from 'react';
import { cn } from './cn';

export function Card({ className, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('rounded-[var(--radius-card)] border border-line bg-surface shadow-[var(--shadow-card)]', className)} {...rest} />;
}

const BADGE_TONES = {
  neutral: 'bg-stone-100 text-ink-soft',
  brand: 'bg-brand-100 text-brand-700',
  amber: 'bg-amber-100 text-amber-800',
  green: 'bg-emerald-100 text-emerald-800',
  blue: 'bg-sky-100 text-sky-800',
  violet: 'bg-violet-100 text-violet-800',
  rose: 'bg-rose-100 text-rose-800',
} as const;

export function Badge({ tone = 'neutral', className, ...rest }: React.HTMLAttributes<HTMLSpanElement> & { tone?: keyof typeof BADGE_TONES }) {
  return (
    <span
      className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap', BADGE_TONES[tone], className)}
      {...rest}
    />
  );
}

export function Spinner({ className }: { className?: string }) {
  return <span role="status" aria-label="Loading" className={cn('inline-block size-5 animate-spin rounded-full border-2 border-line border-t-[var(--brand)]', className)} />;
}

export function EmptyState({ icon, title, hint, action }: { icon?: React.ReactNode; title: string; hint?: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
      {icon && <div className="mb-3 grid size-12 place-items-center rounded-2xl bg-stone-100 text-ink-faint">{icon}</div>}
      <p className="font-medium text-ink">{title}</p>
      {hint && <p className="mt-1 max-w-sm text-sm text-ink-faint">{hint}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
  className,
}: {
  label: string;
  hint?: string;
  error?: string | null;
  children: (id: string) => React.ReactNode;
  className?: string;
}) {
  const id = useId();
  return (
    <div className={cn('space-y-1.5', className)}>
      <label htmlFor={id} className="block text-sm font-medium text-ink">
        {label}
      </label>
      {children(id)}
      {error ? (
        <p className="text-sm text-rose-700" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs text-ink-faint">{hint}</p>
      ) : null}
    </div>
  );
}

const inputBase =
  'w-full rounded-xl border border-line bg-surface px-3.5 text-[15px] text-ink placeholder:text-ink-faint transition focus:border-[var(--brand)] focus:outline-none focus:ring-2 focus:ring-[var(--brand)]/20 disabled:bg-stone-50';

export const Input = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return <input ref={ref} className={cn(inputBase, 'h-11', className)} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={cn(inputBase, 'min-h-20 py-2.5', className)} {...rest} />;
});

export const Select = forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, ...rest }, ref) {
  return <select ref={ref} className={cn(inputBase, 'h-11 appearance-none bg-[length:16px] pr-9', className)} {...rest} />;
});

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-7 w-12 shrink-0 cursor-pointer items-center rounded-full transition disabled:opacity-50',
        checked ? 'bg-[var(--brand)]' : 'bg-stone-300',
      )}
    >
      <span className={cn('inline-block size-5 rounded-full bg-white shadow transition', checked ? 'translate-x-6' : 'translate-x-1')} />
    </button>
  );
}

/** Segmented control: a small set of mutually exclusive views. */
/**
 * A row of choices with one highlight that slides to the picked option, so the eye follows the
 * change instead of seeing it jump. The highlight is measured from the picked button and follows
 * resizes (labels, language, window).
 */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  className,
  size = 'md',
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: React.ReactNode; count?: number }[];
  className?: string;
  size?: 'sm' | 'md';
}) {
  const box = useRef<HTMLDivElement>(null);
  const placed = useRef(false);
  const [thumb, setThumb] = useState<{ x: number; w: number; animate: boolean } | null>(null);
  // On a narrow screen the tabs scroll sideways; the edge that hides more tabs fades out.
  const [edges, setEdges] = useState({ left: false, right: false });
  const measure = () => {
    const el = box.current;
    if (!el) return;
    const left = el.scrollLeft > 1;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setEdges((e) => (e.left === left && e.right === right ? e : { left, right }));
  };
  useLayoutEffect(() => {
    const picked = box.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!picked) {
      setThumb(null);
      return;
    }
    const place = (animate: boolean) => setThumb({ x: picked.offsetLeft, w: picked.offsetWidth, animate });
    place(placed.current);
    // Bring the picked tab into view without moving the page.
    const el = box.current!;
    if (el.scrollWidth > el.clientWidth) {
      const target = picked.offsetLeft - (el.clientWidth - picked.offsetWidth) / 2;
      el.scrollTo({ left: Math.max(0, target), behavior: placed.current ? 'smooth' : 'auto' });
    }
    placed.current = true;
    measure();
    const watch = new ResizeObserver(() => {
      place(false);
      measure();
    });
    watch.observe(picked);
    watch.observe(el);
    return () => watch.disconnect();
  }, [value, options.length]);

  const mask =
    edges.left || edges.right
      ? `linear-gradient(to right, ${edges.left ? 'transparent 0, #000 1.5rem' : '#000 0'}, ${edges.right ? '#000 calc(100% - 1.5rem), transparent 100%' : '#000 100%'})`
      : undefined;

  return (
    <div
      ref={box}
      role="tablist"
      onScroll={measure}
      style={mask ? { maskImage: mask, WebkitMaskImage: mask } : undefined}
      className={cn('no-scrollbar relative inline-flex max-w-full overflow-x-auto rounded-xl bg-stone-100 p-1', className)}
    >
      {thumb && (
        <span
          aria-hidden
          className="pointer-events-none absolute top-1 bottom-1 left-0 rounded-lg bg-surface shadow-sm"
          style={{
            width: thumb.w,
            transform: `translateX(${thumb.x}px)`,
            transition: thumb.animate ? 'transform 260ms cubic-bezier(0.32, 0.72, 0, 1), width 260ms cubic-bezier(0.32, 0.72, 0, 1)' : 'none',
          }}
        />
      )}
      {options.map((o) => (
        <button
          key={o.value}
          role="tab"
          type="button"
          aria-selected={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            'relative inline-flex cursor-pointer items-center gap-1.5 rounded-lg px-3 font-medium whitespace-nowrap transition active:scale-[0.97]',
            size === 'sm' ? 'h-8 text-xs' : 'h-9 text-sm',
            value === o.value ? cn('text-ink', !thumb && 'bg-surface shadow-sm') : 'text-ink-soft hover:text-ink',
          )}
        >
          {o.label}
          {o.count !== undefined && o.count > 0 && (
            <span className={cn('rounded-full px-1.5 text-[11px] tabular', value === o.value ? 'bg-[var(--brand)] text-white' : 'bg-stone-200 text-ink-soft')}>
              {o.count}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

/** A small (i) that shows what a figure means, in place, on tap or click. */
export function InfoToggle({ label, open, onToggle, className }: { label: string; open: boolean; onToggle: () => void; className?: string }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-label={`What "${label}" means`}
      title={`What "${label}" means`}
      className={cn('-m-1.5 grid size-7 shrink-0 cursor-pointer place-items-center rounded-full p-1.5 transition', open ? 'text-[var(--brand)]' : 'text-ink-faint hover:text-ink-soft', className)}
    >
      <Info className="size-3.5" />
    </button>
  );
}

export function Stat({ label, value, sub, className, info }: { label: string; value: React.ReactNode; sub?: React.ReactNode; className?: string; info?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Card className={cn('p-4', className)}>
      <div className="flex items-start gap-1">
        <p className="min-w-0 flex-1 text-xs font-medium tracking-wide text-ink-faint uppercase">{label}</p>
        {info && <InfoToggle label={label} open={open} onToggle={() => setOpen(!open)} />}
      </div>
      <p className="mt-1.5 text-2xl font-semibold text-ink">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-ink-faint">{sub}</p>}
      {info && open && <p className="mt-2 rounded-lg bg-stone-50 px-2.5 py-2 text-xs leading-relaxed text-ink-soft">{info}</p>}
    </Card>
  );
}

/** FSSAI-style marks: green square with a dot for veg, brown square with a triangle for non-veg. */
export function VegMark({ veg, className }: { veg: boolean; className?: string }) {
  return (
    <span
      role="img"
      aria-label={veg ? 'Vegetarian' : 'Non-vegetarian'}
      className={cn('inline-grid size-4 shrink-0 place-items-center rounded-[3px] border-[1.5px]', veg ? 'border-veg' : 'border-nonveg', className)}
    >
      {veg ? (
        <span className="size-2 rounded-full bg-veg" />
      ) : (
        <span className="size-0 border-x-[4px] border-b-[7px] border-x-transparent border-b-nonveg" />
      )}
    </span>
  );
}

'use client';

import { useState } from 'react';
import type { Reward } from '@mezmitra/shared/loyalty';
import { cn } from '@/components/ui/cn';
import { Input, Segmented } from '@/components/ui/primitives';

export interface LoyaltyCategory {
  id: string;
  name: string;
  outlet_name: string;
  outlet_id: string;
}

/** A whole-rupee amount kept in paise. Empty means null when `optional`. */
export function RupeeInput({
  paise,
  onChange,
  optional,
  placeholder,
  label,
  className,
}: {
  paise: number | null;
  onChange: (paise: number | null) => void;
  optional?: boolean;
  placeholder?: string;
  label: string;
  className?: string;
}) {
  return (
    <div className={cn('relative', className)}>
      <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm text-ink-faint">₹</span>
      <Input
        inputMode="numeric"
        aria-label={label}
        placeholder={placeholder}
        value={paise === null ? '' : String(Math.round(paise / 100))}
        onChange={(e) => {
          const v = e.target.value.replace(/\D/g, '');
          onChange(v === '' ? (optional ? null : 0) : Number(v) * 100);
        }}
        className="h-10 pl-7 tabular"
      />
    </div>
  );
}

/** A whole number with a unit after it ("visits", "days", "%"). */
export function NumberInput({ value, onChange, unit, label, className, min = 0 }: { value: number; onChange: (n: number) => void; unit?: string; label: string; className?: string; min?: number }) {
  return (
    <div className={cn('relative', className)}>
      <Input inputMode="numeric" aria-label={label} value={String(value)} onChange={(e) => onChange(Math.max(min, Number(e.target.value.replace(/\D/g, '') || 0)))} className={cn('h-10 tabular', unit && 'pr-16')} />
      {unit && <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-sm text-ink-faint">{unit}</span>}
    </div>
  );
}

/** A decimal kept as an integer (value / scale shown); typed text is kept only while focused. */
function DecimalInput({ value, scale, onChange, label, unit, className }: { value: number; scale: number; onChange: (n: number) => void; label: string; unit: string; className?: string }) {
  const [text, setText] = useState<string | null>(null);
  return (
    <div className={cn('relative', className)}>
      <Input
        inputMode="decimal"
        aria-label={label}
        value={text ?? String(value / scale)}
        onFocus={() => setText(String(value / scale))}
        onBlur={() => setText(null)}
        onChange={(e) => {
          setText(e.target.value);
          const n = Number(e.target.value.replace(/[^\d.]/g, ''));
          if (e.target.value.trim() && Number.isFinite(n)) onChange(Math.round(n * scale));
        }}
        className="h-10 pr-8 tabular"
      />
      <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-sm text-ink-faint">{unit}</span>
    </div>
  );
}

/** Basis points shown as a percentage (500 → 5%). */
export function PercentInput({ bp, onChange, label, className }: { bp: number; onChange: (bp: number) => void; label: string; className?: string }) {
  return <DecimalInput value={bp} scale={100} onChange={onChange} label={label} unit="%" className={className} />;
}

/** A multiplier in basis points shown as "1.5×". */
export function TimesInput({ bp, onChange, label, className }: { bp: number; onChange: (bp: number) => void; label: string; className?: string }) {
  return <DecimalInput value={bp} scale={10_000} onChange={onChange} label={label} unit="×" className={className} />;
}

/** Which menu categories count; none picked means any. */
export function CategoryPicker({ categories, value, onChange, anyLabel = 'Any item' }: { categories: LoyaltyCategory[]; value: string[]; onChange: (ids: string[]) => void; anyLabel?: string }) {
  const outlets = new Set(categories.map((c) => c.outlet_id)).size;
  const chip = (on: boolean) =>
    cn('min-h-9 cursor-pointer rounded-full border px-3 text-sm transition active:scale-[0.97]', on ? 'border-[var(--brand)] bg-brand-50 font-medium text-brand-700' : 'border-line text-ink-soft hover:bg-stone-50');
  return (
    <div className="flex flex-wrap gap-1.5">
      <button type="button" aria-pressed={value.length === 0} onClick={() => onChange([])} className={chip(value.length === 0)}>
        {anyLabel}
      </button>
      {categories.map((c) => {
        const on = value.includes(c.id);
        return (
          <button key={c.id} type="button" aria-pressed={on} onClick={() => onChange(on ? value.filter((x) => x !== c.id) : [...value, c.id])} className={chip(on)}>
            {c.name}
            {outlets > 1 && <span className="ml-1 text-xs text-ink-faint">{c.outlet_name}</span>}
          </button>
        );
      })}
    </div>
  );
}

const KIND_LABEL = { free_item: 'Free item', amount_off: '₹ off', percent_off: '% off' } as const;

/** A reward: a free dish (from some categories, up to a price), money off, or a percentage off. */
export function RewardEditor({ value, onChange, categories }: { value: Reward; onChange: (r: Reward) => void; categories: LoyaltyCategory[] }) {
  const switchTo = (kind: Reward['kind']) => {
    if (kind === value.kind) return;
    onChange(kind === 'free_item' ? { kind, category_ids: [], max_value_paise: 25_000 } : kind === 'amount_off' ? { kind, paise: 10_000 } : { kind, bp: 1000, max_paise: 30_000 });
  };
  return (
    <div className="space-y-3">
      <Segmented size="sm" value={value.kind} onChange={switchTo} options={(Object.keys(KIND_LABEL) as Reward['kind'][]).map((k) => ({ value: k, label: KIND_LABEL[k] }))} />
      {value.kind === 'free_item' && (
        <>
          <CategoryPicker categories={categories} value={value.category_ids} onChange={(category_ids) => onChange({ ...value, category_ids })} anyLabel="Any dish or drink" />
          <label className="flex items-center gap-2 text-sm text-ink-soft">
            Worth up to
            <RupeeInput className="w-28" label="Worth up to" optional placeholder="Any" paise={value.max_value_paise} onChange={(max_value_paise) => onChange({ ...value, max_value_paise })} />
          </label>
        </>
      )}
      {value.kind === 'amount_off' && <RupeeInput className="w-32" label="Money off" paise={value.paise} onChange={(paise) => onChange({ ...value, paise: paise ?? 0 })} />}
      {value.kind === 'percent_off' && (
        <div className="flex flex-wrap items-center gap-2 text-sm text-ink-soft">
          <PercentInput className="w-24" label="Percentage off" bp={value.bp} onChange={(bp) => onChange({ ...value, bp })} />
          off, up to
          <RupeeInput className="w-28" label="Up to" optional placeholder="No cap" paise={value.max_paise} onChange={(max_paise) => onChange({ ...value, max_paise })} />
        </div>
      )}
    </div>
  );
}

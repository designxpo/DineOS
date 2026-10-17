'use client';

import { useState } from 'react';
import { cn } from '@/components/ui/cn';

const inr = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;

interface Field {
  key: 'bill' | 'dish' | 'upi' | 'free' | 'unpaid' | 'remakes';
  label: string;
  hint: string;
  min: number;
  max: number;
  step: number;
  money?: boolean;
}

const FIELDS: Field[] = [
  { key: 'bill', label: 'Average bill', hint: 'What a table usually pays', min: 200, max: 5000, step: 50, money: true },
  { key: 'dish', label: 'Average dish', hint: 'Menu price of a typical dish', min: 50, max: 1500, step: 10, money: true },
  { key: 'upi', label: 'UPI payments that never arrive', hint: 'A week: screenshots, wrong account, "it failed"', min: 0, max: 10, step: 1 },
  { key: 'free', label: 'Dishes given free with no record', hint: 'A day: for regulars, staff, a mistake', min: 0, max: 20, step: 1 },
  { key: 'remakes', label: 'Dishes remade from a wrong order', hint: 'A day: misread tickets, wrong table', min: 0, max: 15, step: 1 },
  { key: 'unpaid', label: 'Tables that leave without paying in full', hint: 'A month', min: 0, max: 15, step: 1 },
];

/**
 * What slips through in a month, from the owner's own guesses. Nothing here is our claim: the
 * defaults are modest examples and every number can be changed.
 */
export function LeakCalculator() {
  const [v, setV] = useState<Record<Field['key'], number>>({ bill: 1200, dish: 320, upi: 2, free: 2, remakes: 2, unpaid: 2 });
  const lines = [
    { label: 'UPI payments that never arrived', amount: v.upi * v.bill * 4.3 },
    { label: 'Free dishes nobody recorded (menu value)', amount: v.free * v.dish * 30 },
    { label: 'Remade dishes (food cost, about 35%)', amount: v.remakes * v.dish * 0.35 * 30 },
    { label: 'Tables that left without paying in full', amount: v.unpaid * v.bill },
  ];
  const total = lines.reduce((a, l) => a + l.amount, 0);
  const times = total / 1499;

  return (
    <div className="grid gap-6 rounded-3xl border border-line bg-surface p-5 shadow-[0_24px_60px_-30px_rgb(28_25_23/0.35)] sm:p-8 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
      <div className="space-y-5">
        {FIELDS.map((f) => (
          <label key={f.key} className="block">
            <span className="flex items-baseline justify-between gap-3">
              <span className="text-sm font-medium text-ink">{f.label}</span>
              <span className="font-semibold tabular text-ink">{f.money ? inr(v[f.key]) : v[f.key]}</span>
            </span>
            <input
              type="range"
              min={f.min}
              max={f.max}
              step={f.step}
              value={v[f.key]}
              onChange={(e) => setV({ ...v, [f.key]: Number(e.target.value) })}
              className="mt-2 h-6 w-full cursor-pointer accent-[var(--brand)]"
              aria-label={f.label}
            />
            <span className="text-xs text-ink-faint">{f.hint}</span>
          </label>
        ))}
      </div>
      <div className="flex flex-col gap-6 rounded-2xl bg-ink p-6 text-white">
        <div className="space-y-5">
          <p className="text-sm text-white/60">Slipping through every month</p>
          <p className="mt-1 font-display text-5xl font-semibold tracking-tight tabular" aria-live="polite">
            {inr(total)}
          </p>
          <ul className="mt-5 space-y-2.5 text-sm">
            {lines.map((l) => (
              <li key={l.label} className="flex items-baseline justify-between gap-3 border-b border-white/10 pb-2.5">
                <span className="text-white/75">{l.label}</span>
                <span className="font-medium tabular">{inr(l.amount)}</span>
              </li>
            ))}
          </ul>
          <p className={cn('rounded-xl px-4 py-3 text-sm', times >= 1 ? 'bg-accent/15 text-accent' : 'bg-white/10 text-white/80')}>
            {times >= 1
              ? `That is ${times >= 10 ? Math.round(times) : times.toFixed(1)} times what Mezmitra Table service costs (₹1,499 a month).`
              : 'Even small numbers add up: Mezmitra Table service is ₹1,499 a month.'}
          </p>
        </div>
        <p className="mt-auto text-xs text-white/50">Your numbers, not ours. Move the sliders to match your restaurant.</p>
      </div>
    </div>
  );
}

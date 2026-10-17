'use client';

import { Check } from 'lucide-react';
import { useState } from 'react';
import { cn } from '@/components/ui/cn';

const inr = (n: number) => `₹${n.toLocaleString('en-IN')}`;

interface Plan {
  id: string;
  name: string;
  monthly: number;
  unit: string;
  for: string;
  limits: string;
  items: string[];
  main?: boolean;
}

const PLANS: Plan[] = [
  {
    id: 'cafe',
    name: 'Café',
    monthly: 999,
    unit: 'a month',
    for: 'Counter service and small cafés',
    limits: '1 outlet · up to 15 tables',
    items: ['Billing, GST invoices and the UPI check', 'Kitchen screen and printed tickets', 'Pickup screen and order tracking', 'Stamp cards, wallet and every report', 'Your logo and colours on every screen'],
  },
  {
    id: 'table',
    name: 'Table service',
    monthly: 1499,
    unit: 'a month',
    for: 'Dine-in restaurants',
    limits: '1 outlet · up to 40 tables',
    items: ['Everything in Café', 'QR and waiter ordering with floor alerts', 'Kitchen, tandoor and bar stations, bar-ready alerts', 'Points, levels, memberships and reservations', 'Stock from recipes'],
    main: true,
  },
  {
    id: 'group',
    name: 'Group',
    monthly: 1249,
    unit: 'per outlet a month',
    for: 'Two to five outlets',
    limits: 'Table service at every outlet',
    items: ['Everything in Table service', 'Every outlet from one sign-in', "Each outlet's reports and month-end pack", 'Staff and roles per outlet'],
  },
];

/** Plans with monthly or annual prices (annual: ten months' price for twelve, go-live included). */
export function Pricing() {
  const [annual, setAnnual] = useState(true);
  return (
    <div className="space-y-8">
      <div className="flex flex-col items-center gap-3">
        <div className="inline-flex rounded-full border border-line bg-surface p-1 shadow-sm" role="radiogroup" aria-label="Billing">
          {[
            ['Monthly', false],
            ['Annual', true],
          ].map(([label, value]) => (
            <button
              key={String(label)}
              type="button"
              role="radio"
              aria-checked={annual === value}
              onClick={() => setAnnual(value as boolean)}
              className={cn('h-10 cursor-pointer rounded-full px-5 text-sm font-semibold transition', annual === value ? 'bg-ink text-white' : 'text-ink-soft hover:text-ink')}
            >
              {label as string}
            </button>
          ))}
        </div>
        <p className="text-sm text-ink-soft">{annual ? 'Annual: pay for ten months, get twelve. Go-live included.' : 'Monthly: switch to annual any time to get two months free.'}</p>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {PLANS.map((p) => {
          const yearly = p.monthly * 10;
          return (
            <div key={p.id} className={cn('relative flex flex-col rounded-3xl border bg-surface p-6', p.main ? 'border-[var(--brand)] shadow-[0_24px_60px_-28px_rgb(168_68_26/0.55)]' : 'border-line')}>
              {p.main && <span className="absolute -top-3 left-6 rounded-full bg-[var(--brand)] px-3 py-1 text-xs font-semibold text-white">Best for 10 to 40 tables</span>}
              <h3 className="font-display text-2xl font-semibold">{p.name}</h3>
              <p className="mt-1 text-sm text-ink-soft">{p.main ? p.limits : p.for}</p>
              <div className="mt-5">
                {annual ? (
                  <>
                    <p className="font-display text-4xl font-semibold tracking-tight tabular">
                      {inr(yearly)}
                      <span className="ml-1 font-sans text-base font-normal text-ink-faint">{p.unit.includes('outlet') ? 'per outlet a year' : 'a year'}</span>
                    </p>
                    <p className="mt-1 text-sm text-ink-soft">
                      {inr(Math.round(yearly / 12))} a month, billed yearly · <span className="text-ink-faint line-through">{inr(p.monthly * 12)}</span>
                    </p>
                  </>
                ) : (
                  <>
                    <p className="font-display text-4xl font-semibold tracking-tight tabular">
                      {inr(p.monthly)}
                      <span className="ml-1 font-sans text-base font-normal text-ink-faint">{p.unit}</span>
                    </p>
                    <p className="mt-1 text-sm text-ink-soft">About {inr(Math.round(p.monthly / 30))} a day</p>
                  </>
                )}
              </div>
              {!p.main && <p className="mt-4 text-xs font-medium tracking-wide text-ink-faint uppercase">{p.limits}</p>}
              <ul className="mt-4 flex-1 space-y-2.5 text-sm">
                {p.items.map((i) => (
                  <li key={i} className="flex gap-2.5">
                    <Check className="mt-0.5 size-4 shrink-0 text-emerald-700" />
                    {i}
                  </li>
                ))}
              </ul>
              <a
                href={`?plan=${p.id}#demo`}
                className={cn(
                  'mt-6 inline-flex h-12 items-center justify-center rounded-xl text-sm font-semibold transition active:scale-[0.98]',
                  p.main ? 'bg-[var(--brand)] text-white hover:brightness-110' : 'border border-line bg-surface text-ink hover:bg-stone-50',
                )}
              >
                Book a demo for {p.name}
              </a>
            </div>
          );
        })}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded-3xl border border-line bg-surface p-6">
          <p className="text-xs font-medium tracking-wide text-ink-faint uppercase">Add-on</p>
          <h3 className="mt-1 font-display text-xl font-semibold">Continuity · {annual ? `${inr(4990)} per outlet a year` : `${inr(499)} per outlet a month`}</h3>
          <p className="mt-2 text-sm text-ink-soft">The outlet hub that keeps orders, kitchen tickets, bills and printing going when the internet drops, an outage drill with your team every quarter, and priority support during service hours.</p>
        </div>
        <div className="rounded-3xl border border-line bg-surface p-6">
          <p className="text-xs font-medium tracking-wide text-ink-faint uppercase">Once, at the start</p>
          <h3 className="mt-1 font-display text-xl font-semibold">Go-live · {annual ? <span className="text-emerald-700">included with annual plans</span> : inr(4999)}</h3>
          <p className="mt-2 text-sm text-ink-soft">Your menu imported with photos, printers and the outlet hub set up, a full rehearsal of your busiest order on your own devices, and staff trained in English and Hindi.</p>
        </div>
      </div>
      <p className="text-center text-sm text-ink-faint">Prices exclude GST. No charge per user or per device: add every waiter, cook and cashier.</p>
    </div>
  );
}

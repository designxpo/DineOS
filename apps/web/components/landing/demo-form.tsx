'use client';

import { CheckCircle2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { DEMO_PAIN_LABELS, DEMO_PAINS, DEMO_TABLES, type DemoPain, type DemoTables } from '@dineos/shared/leads';
import { apiFetch, errorMessage } from '@/lib/api';
import { cn } from '@/components/ui/cn';

const PLAN_NAMES: Record<string, string> = { cafe: 'Café', table: 'Table service', group: 'Group' };
const input = 'h-12 w-full rounded-xl border border-line bg-surface px-3.5 text-[15px] text-ink placeholder:text-ink-faint focus:border-[var(--brand)] focus:ring-2 focus:ring-[var(--brand)]/20 focus:outline-none';

/** Asks for a demo: who, where, how big, and what hurts most. Mezmitra calls or WhatsApps back. */
export function DemoForm() {
  const [name, setName] = useState('');
  const [restaurant, setRestaurant] = useState('');
  const [city, setCity] = useState('');
  const [phone, setPhone] = useState('');
  const [tables, setTables] = useState<DemoTables | null>(null);
  const [pains, setPains] = useState<DemoPain[]>([]);
  const [note, setNote] = useState('');
  const [website, setWebsite] = useState('');
  const [plan, setPlan] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  // A plan picked on the pricing cards comes along.
  useEffect(() => {
    const p = new URLSearchParams(window.location.search).get('plan');
    if (p && PLAN_NAMES[p]) setPlan(PLAN_NAMES[p]);
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await apiFetch('/public/demo-requests', {
        method: 'POST',
        body: { name, restaurant, city: city || undefined, phone, tables: tables ?? undefined, plan: plan ?? undefined, pains, note: note || undefined, website: website || undefined },
      });
      setSent(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (sent) {
    return (
      <div className="rounded-3xl bg-surface p-8 text-center shadow-[0_24px_60px_-30px_rgb(28_25_23/0.4)]" role="status">
        <CheckCircle2 className="mx-auto size-12 text-emerald-600" />
        <p className="mt-4 font-display text-2xl font-semibold">Thank you, {name.split(' ')[0]}.</p>
        <p className="mt-2 text-ink-soft">We will call or WhatsApp you on {phone} to set up a 20-minute demo with your own dishes.</p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-5 rounded-3xl bg-surface p-5 text-ink shadow-[0_24px_60px_-30px_rgb(28_25_23/0.4)] sm:p-8">
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="space-y-1.5">
          <span className="text-sm font-medium">Your name</span>
          <input className={input} value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} autoComplete="name" />
        </label>
        <label className="space-y-1.5">
          <span className="text-sm font-medium">Restaurant or café</span>
          <input className={input} value={restaurant} onChange={(e) => setRestaurant(e.target.value)} required maxLength={120} autoComplete="organization" />
        </label>
        <label className="space-y-1.5">
          <span className="text-sm font-medium">Phone (WhatsApp)</span>
          <input className={input} value={phone} onChange={(e) => setPhone(e.target.value)} required inputMode="tel" autoComplete="tel" placeholder="98450 12345" maxLength={20} />
        </label>
        <label className="space-y-1.5">
          <span className="text-sm font-medium">City</span>
          <input className={input} value={city} onChange={(e) => setCity(e.target.value)} maxLength={60} autoComplete="address-level2" />
        </label>
      </div>

      <fieldset>
        <legend className="mb-2 text-sm font-medium">How many tables?</legend>
        <div className="flex flex-wrap gap-2">
          {DEMO_TABLES.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTables(tables === t ? null : t)}
              aria-pressed={tables === t}
              className={cn('h-10 cursor-pointer rounded-full border px-4 text-sm font-medium transition', tables === t ? 'border-[var(--brand)] bg-brand-50 text-brand-700' : 'border-line hover:bg-stone-50')}
            >
              {t}
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend className="mb-2 text-sm font-medium">What hurts most? Pick any.</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {DEMO_PAINS.map((p) => (
            <label key={p} className={cn('flex cursor-pointer items-start gap-2.5 rounded-xl border px-3 py-2.5 text-sm transition', pains.includes(p) ? 'border-[var(--brand)] bg-brand-50' : 'border-line hover:bg-stone-50')}>
              <input type="checkbox" className="mt-0.5 size-4 accent-[var(--brand)]" checked={pains.includes(p)} onChange={(e) => setPains(e.target.checked ? [...pains, p] : pains.filter((x) => x !== p))} />
              {DEMO_PAIN_LABELS[p]}
            </label>
          ))}
        </div>
      </fieldset>

      <label className="block space-y-1.5">
        <span className="text-sm font-medium">Anything else? (optional)</span>
        <textarea className={cn(input, 'h-24 py-2.5')} value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} placeholder="Opening a second outlet, a bar, a hotel restaurant…" />
      </label>

      {/* People never see this; form-filling bots do. */}
      <input type="text" name="website" value={website} onChange={(e) => setWebsite(e.target.value)} tabIndex={-1} autoComplete="off" aria-hidden className="absolute -left-[9999px] h-0 w-0 opacity-0" />

      {plan && <p className="text-sm text-ink-soft">Plan you are looking at: <span className="font-semibold text-ink">{plan}</span></p>}
      {error && (
        <p className="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-800" role="alert">
          {error}
        </p>
      )}
      <button type="submit" disabled={busy} className="inline-flex h-12 w-full cursor-pointer items-center justify-center rounded-xl bg-[var(--brand)] text-base font-semibold text-white transition hover:brightness-110 active:scale-[0.99] disabled:opacity-60">
        {busy ? 'Sending…' : 'Book my 20-minute demo'}
      </button>
      <p className="text-center text-xs text-ink-faint">We use your number only to set up the demo. No spam, no sharing.</p>
    </form>
  );
}

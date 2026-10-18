'use client';

import { getCountries, getCountryCallingCode, parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js/min';
import { Check, CheckCircle2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { CURRENT_SYSTEMS, DEMO_PAIN_LABELS, DEMO_PAINS, DEMO_TABLES, noContract, type DemoPain, type DemoTables } from '@mezmitra/shared/leads';
import { apiFetch, errorMessage } from '@/lib/api';
import { cn } from '@/components/ui/cn';

const countryNames = new Intl.DisplayNames(['en'], { type: 'region' });
const COUNTRIES = getCountries().sort((a, b) => (countryNames.of(a) ?? a).localeCompare(countryNames.of(b) ?? b, 'en'));

const PLAN_NAMES: Record<string, string> = { cafe: 'Café', table: 'Table service', group: 'Group', check: 'Money check' };

/** This month and the next twelve, for "when does it renew". */
function nextMonths(): { value: string; label: string }[] {
  const now = new Date();
  return Array.from({ length: 13 }, (_, i) => {
    const d = new Date(Date.UTC(now.getFullYear(), now.getMonth() + i, 1));
    return { value: d.toISOString().slice(0, 7), label: d.toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' }) };
  });
}
const input = 'h-12 w-full rounded-xl border border-line bg-surface px-3.5 text-[15px] text-ink placeholder:text-ink-faint focus:border-[var(--brand)] focus:ring-2 focus:ring-[var(--brand)]/20 focus:outline-none';

/** Asks for a demo: who, where, how big, and what hurts most. Mezmitra calls or WhatsApps back. */
export function DemoForm() {
  const [name, setName] = useState('');
  const [restaurant, setRestaurant] = useState('');
  const [city, setCity] = useState('');
  const [phone, setPhone] = useState('');
  const [country, setCountry] = useState<CountryCode>('IN');
  // Country names come from the browser: the server's own list words some differently, so the
  // full list is filled in after the page loads instead of in the server's HTML.
  const [countries, setCountries] = useState<CountryCode[]>([]);
  useEffect(() => setCountries(COUNTRIES), []);
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [submittedPhone, setSubmittedPhone] = useState('');
  const [tables, setTables] = useState<DemoTables | null>(null);
  const [pains, setPains] = useState<DemoPain[]>([]);
  const [note, setNote] = useState('');
  const [system, setSystem] = useState('');
  const [renews, setRenews] = useState('');
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
    const parsed = parsePhoneNumberFromString(phone, { defaultCountry: country, extract: false });
    if (!parsed?.isPossible() || parsed.ext) {
      setPhoneError('Enter a complete phone number for the selected country, without an extension.');
      return;
    }
    setPhoneError(null);
    setBusy(true);
    setError(null);
    try {
      await apiFetch('/public/demo-requests', {
        method: 'POST',
        body: {
          name,
          restaurant,
          city: city || undefined,
          phone: parsed.number,
          tables: tables ?? undefined,
          plan: plan ?? undefined,
          pains,
          note: note || undefined,
          current_system: system || undefined,
          renews: system && !noContract(system) && renews ? renews : undefined,
          website: website || undefined,
        },
      });
      setSubmittedPhone(parsed.formatInternational());
      setSent(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (sent) {
    return (
      <div className="rounded-3xl bg-surface p-8 text-ink text-center shadow-[0_24px_60px_-30px_rgb(28_25_23/0.4)]" role="status">
        <CheckCircle2 className="mx-auto size-12 text-emerald-600" />
        <p className="mt-4 font-display text-2xl font-semibold">Thank you, {name.split(' ')[0]}.</p>
        <p className="mt-2 text-ink-soft">We will call or WhatsApp you on {submittedPhone} to set up a 20-minute demo with your own dishes.</p>
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
        <fieldset className="min-w-0 space-y-1.5">
          <legend className="text-sm font-medium">Phone (WhatsApp)</legend>
          <div className="flex gap-2">
            <select
              aria-label="Country calling code"
              autoComplete="tel-country-code"
              value={country}
              onChange={(e) => { setCountry(e.target.value as CountryCode); setPhoneError(null); }}
              className={cn(input, 'w-20 shrink-0 px-2')}
            >
              {(countries.length ? countries : [country]).map((code) => (
                <option key={code} value={code} aria-label={`${countryNames.of(code)} +${getCountryCallingCode(code)}`}>
                  {country === code ? `+${getCountryCallingCode(code)}` : `${countryNames.of(code)} (+${getCountryCallingCode(code)})`}
                </option>
              ))}
            </select>
            <input
              className={cn(input, 'min-w-0 flex-1')}
              aria-label="Phone (WhatsApp)"
              aria-invalid={!!phoneError}
              aria-describedby={phoneError ? 'demo-phone-error' : undefined}
              value={phone}
              onChange={(e) => {
                const value = e.target.value;
                // Pasted international numbers select their country instead of adding a second prefix.
                const international = value.trim().startsWith('+') ? parsePhoneNumberFromString(value, { extract: false }) : undefined;
                if (international?.country) {
                  setCountry(international.country);
                  setPhone(international.nationalNumber);
                } else setPhone(value);
                setPhoneError(null);
              }}
              required type="tel" inputMode="tel" autoComplete="tel-national"
              placeholder={country === 'IN' ? '98450 12345' : 'Phone number'} maxLength={30}
            />
          </div>
          {phoneError && <p id="demo-phone-error" className="text-sm text-rose-800" role="alert">{phoneError}</p>}
        </fieldset>
        <label className="space-y-1.5">
          <span className="text-sm font-medium">City</span>
          <input className={input} value={city} onChange={(e) => setCity(e.target.value)} maxLength={60} autoComplete="address-level2" />
        </label>
        <label className="space-y-1.5">
          <span className="text-sm font-medium">What do you bill on today? (optional)</span>
          <select className={input} value={system} onChange={(e) => setSystem(e.target.value)}>
            <option value="">Choose…</option>
            {CURRENT_SYSTEMS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        {system && !noContract(system) && (
          <label className="space-y-1.5">
            <span className="text-sm font-medium">When does it renew?</span>
            <select className={input} value={renews} onChange={(e) => setRenews(e.target.value)}>
              <option value="">Not sure</option>
              {nextMonths().map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {system && !noContract(system) && (
        <p className="-mt-1 rounded-xl bg-stone-50 px-3 py-2 text-sm text-ink-soft">
          Keep it until then. Start with the money check on top of it, and move billing to Mezmitra when your year ends.
        </p>
      )}

      <fieldset>
        <legend className="mb-2 text-sm font-medium">How many tables? (optional)</legend>
        <div className="flex flex-wrap gap-2">
          {DEMO_TABLES.map((t) => (
            <label key={t} className="relative cursor-pointer">
              <input
                type="radio"
                name="tables"
                value={t}
                checked={tables === t}
                onChange={() => setTables(t)}
                className="peer sr-only"
              />
              <span className={cn(
                'inline-flex min-h-11 min-w-24 items-center justify-center gap-2 rounded-full border px-4 text-sm font-semibold transition-colors peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-[var(--brand)]',
                tables === t ? 'border-[var(--brand)] bg-[var(--brand)] text-white' : 'border-line bg-surface text-ink',
              )}>
                {tables === t && <Check aria-hidden="true" className="size-4" />}
                {t}
              </span>
            </label>
          ))}
        </div>
        <p className="mt-2 text-sm text-ink-soft" aria-live="polite" aria-atomic="true">
          {tables ? `Selected: ${tables} tables` : 'Choose the range that fits your restaurant.'}
        </p>
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

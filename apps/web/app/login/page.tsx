'use client';

import { ChefHat } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { BrandingDTO, LoginResponseDTO } from '@dineos/shared/dto';
import { apiFetch, errorMessage } from '@/lib/api';
import { useBrandTheme } from '@/lib/brand-theme';
import { saveStaffLogin } from '@/lib/staff';
import { readLocal, writeLocal } from '@/lib/storage';
import { BrandMark } from '@/components/brand-mark';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/primitives';

export default function LoginPage() {
  const router = useRouter();
  const [slug, setSlug] = useState('');
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [brand, setBrand] = useState<{ name: string; slug: string; branding: BrandingDTO } | null>(null);

  useEffect(() => {
    // The restaurant's sign-in link (?r=code) or subdomain ({slug}.dineos.in) prefills the code.
    const host = window.location.hostname.split('.');
    const fromHost = host.length > 2 && !/^\d+$/.test(host[0]!) && host[0] !== 'www' && host[0] !== 'app' ? host[0] : null;
    const fromLink = new URLSearchParams(window.location.search).get('r');
    const code = (fromLink ?? fromHost ?? readLocal<string>('dineos.slug', '')).trim().toLowerCase();
    setSlug(code);
    // A restaurant with its own look gets it here too, before anyone signs in.
    if (code) {
      apiFetch<{ name: string; slug: string; branding: BrandingDTO }>(`/public/brand/${encodeURIComponent(code)}`)
        .then((b) => Object.keys(b.branding).length > 0 && setBrand(b))
        .catch(() => undefined);
    }
  }, []);
  // Typing another restaurant's code drops the look.
  const own = brand && slug.trim().toLowerCase() === brand.slug ? brand : null;
  useBrandTheme(own?.branding, own?.name);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch<LoginResponseDTO>('/auth/login', { method: 'POST', body: { tenant_slug: slug.trim().toLowerCase(), login: login.trim(), password } });
      saveStaffLogin(res);
      writeLocal('dineos.slug', slug.trim().toLowerCase());
      router.replace('/app');
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <main className="grid min-h-dvh lg:grid-cols-[1.1fr_1fr]">
      <section className="relative hidden overflow-hidden bg-brand-900 p-12 text-white lg:flex lg:flex-col lg:justify-between">
        <div className="flex items-center gap-3">
          {own?.branding.logo_url ? (
            <BrandMark branding={own.branding} className="size-14 rounded-2xl" />
          ) : (
            <div className="grid size-11 place-items-center rounded-2xl bg-white/10">
              <ChefHat className="size-6" />
            </div>
          )}
          <span className="font-display text-2xl font-semibold">{own?.name ?? 'DineOS'}</span>
        </div>
        {own ? (
          <div className="max-w-md">
            <h1 className="font-display text-4xl leading-tight font-semibold">Welcome to {own.name}.</h1>
            <p className="mt-4 text-white/75">Sign in to take orders, run the kitchen and bill your guests.</p>
          </div>
        ) : (
          <div className="max-w-md">
            <h1 className="font-display text-4xl leading-tight font-semibold">Every order, from the table to the kitchen to the bill.</h1>
            <p className="mt-4 text-white/75">QR ordering, kitchen display, POS and GST billing for your restaurant, in one place.</p>
          </div>
        )}
        <p className="text-sm text-white/50">{own ? '' : 'Made for Indian restaurants, cafes and hotel dining.'}</p>
        <div className="pointer-events-none absolute -right-24 -bottom-24 size-96 rounded-full bg-brand-600/30 blur-3xl" />
      </section>

      <section className="flex items-center justify-center p-6">
        <form onSubmit={submit} className="w-full max-w-sm space-y-5">
          <div className="lg:hidden">
            <div className="mb-6 flex items-center gap-2.5">
              <BrandMark branding={own?.branding} className={own?.branding.logo_url ? 'size-12 rounded-xl border border-line' : 'size-10 rounded-xl'} />
              <span className="font-display text-xl font-semibold">{own?.name ?? 'DineOS'}</span>
            </div>
          </div>
          <div>
            <h2 className="text-2xl font-semibold text-ink">Sign in</h2>
            <p className="mt-1 text-sm text-ink-faint">Staff, managers and owners</p>
          </div>
          <Field label="Restaurant code" hint="Your manager can tell you this">
            {(id) => <Input id={id} value={slug} onChange={(e) => setSlug(e.target.value)} autoCapitalize="none" autoComplete="organization" required placeholder="e.g. aurum-courtyard" />}
          </Field>
          <Field label="Email or phone">
            {(id) => <Input id={id} value={login} onChange={(e) => setLogin(e.target.value)} autoCapitalize="none" autoComplete="username" required />}
          </Field>
          <Field label="Password">
            {(id) => <Input id={id} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />}
          </Field>
          {error && (
            <p role="alert" className="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-800">
              {error}
            </p>
          )}
          <Button type="submit" size="lg" block loading={busy}>
            Sign in
          </Button>
        </form>
      </section>
    </main>
  );
}

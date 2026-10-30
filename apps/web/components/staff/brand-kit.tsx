'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, ImagePlus, LayoutGrid, ShoppingBag, Trash2, UtensilsCrossed } from 'lucide-react';
import { useEffect, useState } from 'react';
import { brandShades, DEFAULT_BRAND_COLOR, HEX_COLOR, type HeadingStyle } from '@mezmitra/shared/branding';
import type { BrandingDTO, TenantBrandDTO } from '@mezmitra/shared/dto';
import { API_URL, errorMessage } from '@/lib/api';
import { brandStyle } from '@/lib/brand-theme';
import { useStaff } from '@/lib/staff';
import { BrandMark } from '@/components/brand-mark';
import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';
import { Card, Input, Segmented, Spinner } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/toast';

const PRESETS = ['#b9381e', '#b91c1c', '#be185d', '#7c3aed', '#1d4ed8', '#0f766e', '#15803d', '#a16207', '#1c1917'];

/**
 * The restaurant's own look: logo, cover photo, colour and heading style, with a preview of the QR
 * menu and the staff portal. It goes live on plans that include it; before that it can be set up
 * and previewed.
 */
export function BrandKit() {
  const { api, token } = useStaff();
  const toast = useToast();
  const qc = useQueryClient();
  const tenant = useQuery({ queryKey: ['tenant'], queryFn: () => api<TenantBrandDTO>('/tenant') });
  const saved = tenant.data?.branding;
  const [color, setColor] = useState(DEFAULT_BRAND_COLOR);
  const [hexText, setHexText] = useState(DEFAULT_BRAND_COLOR);
  const [heading, setHeading] = useState<HeadingStyle>('sans');
  const [busy, setBusy] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!saved) return;
    setColor(saved.primary_color ?? DEFAULT_BRAND_COLOR);
    setHexText(saved.primary_color ?? DEFAULT_BRAND_COLOR);
    setHeading(saved.heading_style ?? 'sans');
  }, [saved]);

  if (!tenant.data || !saved) return <Spinner />;
  const t = tenant.data;
  const draft: BrandingDTO = { ...saved, primary_color: color, heading_style: heading };
  const changed = color !== (saved.primary_color ?? DEFAULT_BRAND_COLOR) || heading !== (saved.heading_style ?? 'sans');
  const { adjusted } = brandShades(color);
  const signInLink = typeof window === 'undefined' ? '' : `${window.location.origin}/login?r=${t.slug}`;

  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ['tenant'] }), qc.invalidateQueries({ queryKey: ['me'] })]);
  const upload = async (kind: 'logo' | 'cover', file: File) => {
    setBusy(kind);
    try {
      const fd = new FormData();
      fd.append('file', file, file.name);
      const res = await fetch(`${API_URL}/v1/tenant/${kind}`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: fd });
      if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: { message?: string } } | null)?.error?.message ?? 'Upload failed');
      await refresh();
      toast(kind === 'logo' ? 'Logo updated' : 'Cover photo updated');
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy(null);
    }
  };
  const save = async (branding: Partial<BrandingDTO>, done: string) => {
    setBusy('save');
    try {
      await api('/tenant', { method: 'PATCH', body: { branding } });
      await refresh();
      toast(done);
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card className="space-y-5 p-5">
      <div className="space-y-2">
        <h2 className="font-semibold">Your brand</h2>
        {t.white_label ? (
          <p className="flex items-start gap-2 rounded-xl bg-emerald-50 px-3 py-2 text-sm text-emerald-950">
            <Check className="mt-0.5 size-4 shrink-0" />
            Live: your logo and colours are on your staff screens, the QR menu, order tracking and the pickup screen.
          </p>
        ) : (
          <p className="rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-950">
            Your plan ({t.plan_name}) shows the Mezvaan look.{' '}
            {t.white_label_plans.length > 0 ? `Your brand goes live on ${t.white_label_plans.join(' or ')}. ` : ''}
            Set it up now and see it in the preview.
          </p>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="space-y-5">
          <Picture
            label="Logo"
            hint="Square, at least 256 px. A PNG with a clear background looks best."
            url={saved.logo_url}
            square
            busy={busy === 'logo'}
            onPick={(f) => void upload('logo', f)}
            onRemove={() => void save({ logo_url: null }, 'Logo removed')}
          />
          <Picture
            label="Cover photo"
            hint="A wide photo of your food or place, across the top of the QR menu."
            url={saved.cover_url}
            busy={busy === 'cover'}
            onPick={(f) => void upload('cover', f)}
            onRemove={() => void save({ cover_url: null }, 'Cover photo removed')}
          />

          <div className="space-y-2">
            <p className="text-sm font-medium">Colour</p>
            <div className="flex flex-wrap gap-2">
              {PRESETS.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => {
                    setColor(p);
                    setHexText(p);
                  }}
                  aria-label={`Use ${p}`}
                  className={cn('size-9 cursor-pointer rounded-full ring-offset-2 transition active:scale-90', color.toLowerCase() === p && 'ring-2 ring-ink')}
                  style={{ background: p }}
                />
              ))}
            </div>
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={color}
                onChange={(e) => {
                  setColor(e.target.value);
                  setHexText(e.target.value);
                }}
                className="size-11 cursor-pointer rounded-xl border border-line"
                aria-label="Pick any colour"
              />
              <Input
                value={hexText}
                onChange={(e) => {
                  setHexText(e.target.value);
                  if (HEX_COLOR.test(e.target.value.trim())) setColor(e.target.value.trim().toLowerCase());
                }}
                className="h-11 w-32 font-mono"
                aria-label="Colour code"
                maxLength={7}
              />
            </div>
            {adjusted && <p className="text-xs text-ink-faint">Buttons use a slightly darker shade of this colour so white text on them stays readable.</p>}
          </div>

          <div className="space-y-2">
            <p className="text-sm font-medium">Headings</p>
            <Segmented
              value={heading}
              onChange={setHeading}
              options={[
                { value: 'sans', label: 'Modern' },
                { value: 'serif', label: 'Classic' },
              ]}
            />
          </div>

          <Button disabled={!changed} loading={busy === 'save'} onClick={() => void save({ primary_color: color, heading_style: heading }, 'Brand saved')}>
            Save colour and headings
          </Button>

          <div className="space-y-1.5 rounded-xl bg-stone-50 p-3 text-sm">
            <p className="font-medium">Staff sign-in link</p>
            <p className="text-xs text-ink-faint">Opens the sign-in page with your restaurant code filled in{t.white_label ? ' and your brand on it' : ''}.</p>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-lg bg-surface px-2 py-1.5 text-xs">{signInLink}</code>
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  void navigator.clipboard?.writeText(signInLink).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  })
                }
              >
                {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />} {copied ? 'Copied' : 'Copy'}
              </Button>
            </div>
          </div>
        </div>

        <Preview branding={draft} name={t.name} />
      </div>
    </Card>
  );
}

function Picture({ label, hint, url, square, busy, onPick, onRemove }: { label: string; hint: string; url?: string | null; square?: boolean; busy: boolean; onPick: (f: File) => void; onRemove: () => void }) {
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">{label}</p>
      <div className="flex flex-wrap items-center gap-3">
        {url ? (
          <img src={url} alt={label} className={cn('rounded-xl border border-line bg-white', square ? 'size-16 object-contain' : 'h-16 w-32 object-cover')} />
        ) : (
          <div className={cn('grid place-items-center rounded-xl border border-dashed border-line text-ink-faint', square ? 'size-16' : 'h-16 w-32')}>
            <ImagePlus className="size-5" />
          </div>
        )}
        <label className={cn('inline-flex h-10 cursor-pointer items-center gap-2 rounded-xl border border-line px-3.5 text-sm font-medium hover:bg-stone-50', busy && 'pointer-events-none opacity-60')}>
          {busy ? <Spinner className="size-4" /> : <ImagePlus className="size-4" />} {url ? 'Replace' : 'Upload'}
          <input type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" onChange={(e) => e.target.files?.[0] && onPick(e.target.files[0])} />
        </label>
        {url && (
          <Button size="sm" variant="ghost" onClick={onRemove}>
            <Trash2 className="size-3.5" /> Remove
          </Button>
        )}
      </div>
      <p className="text-xs text-ink-faint">{hint}</p>
    </div>
  );
}

/** The QR menu and the staff portal in this look, before it is saved. */
function Preview({ branding, name }: { branding: BrandingDTO; name: string }) {
  return (
    <div style={brandStyle(branding)} className="flex flex-col items-center gap-4 self-start rounded-2xl bg-stone-100 p-4">
      <p className="self-start text-xs font-medium text-ink-faint">Preview</p>
      <div className="w-60 overflow-hidden rounded-[28px] border-4 border-ink bg-surface shadow-[var(--shadow-pop)]" aria-label="QR menu preview">
        {branding.cover_url ? <img src={branding.cover_url} alt="" className="h-20 w-full object-cover" /> : <div className="h-3" />}
        <div className="px-3 pb-3">
          <div className="flex items-start gap-2">
            <BrandMark branding={branding} name={name} className={cn('rounded-xl', branding.cover_url ? '-mt-6 size-12 ring-4 ring-surface' : 'mt-1 size-10', branding.logo_url && !branding.cover_url && 'border border-line')} />
            <div className="min-w-0 pt-1.5">
              <p className="truncate font-display text-base leading-tight font-semibold">{name}</p>
              <span className="mt-0.5 inline-block rounded-md bg-brand-50 px-1.5 py-0.5 text-[10px] font-semibold text-[var(--brand)]">Table 4</span>
            </div>
          </div>
          <div className="mt-3 flex gap-1.5 text-[10px] font-semibold">
            <span className="rounded-full bg-[var(--brand)] px-2.5 py-1 text-white">Starters</span>
            <span className="rounded-full bg-stone-100 px-2.5 py-1 text-ink-soft">Mains</span>
            <span className="rounded-full bg-stone-100 px-2.5 py-1 text-ink-soft">Drinks</span>
          </div>
          {['Paneer Tikka', 'Masala Chai'].map((d, i) => (
            <div key={d} className="mt-2.5 flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-semibold">{d}</p>
                <p className="text-[10px] text-ink-faint">₹{i ? 120 : 340}</p>
              </div>
              <span className="rounded-lg border border-brand-200 px-2.5 py-1 text-[10px] font-bold text-[var(--brand)]">ADD</span>
            </div>
          ))}
          <div className="mt-3 flex items-center justify-between rounded-xl bg-[var(--brand)] px-3 py-2 text-[11px] font-semibold text-white">
            <span className="flex items-center gap-1.5">
              <ShoppingBag className="size-3.5" /> 2 items
            </span>
            <span>View cart</span>
          </div>
        </div>
      </div>

      <div className="w-full max-w-xs overflow-hidden rounded-xl border border-line bg-surface shadow-[var(--shadow-card)]" aria-label="Staff portal preview">
        <div className="flex items-center gap-2 border-b border-line px-3 py-2.5">
          <BrandMark branding={branding} className={cn('size-7 rounded-lg', branding.logo_url && 'border border-line')} />
          <p className="truncate font-display text-sm font-semibold">{name}</p>
        </div>
        <div className="space-y-0.5 p-2 text-xs">
          <p className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-ink-soft">
            <LayoutGrid className="size-3.5" /> Floor
          </p>
          <p className="flex items-center gap-2 rounded-lg bg-brand-50 px-2 py-1.5 font-medium text-brand-700">
            <UtensilsCrossed className="size-3.5" /> Orders
          </p>
        </div>
        <div className="border-t border-line p-3">
          <span className="block rounded-lg bg-[var(--brand)] py-2 text-center text-xs font-semibold text-white">Print bill · ₹798</span>
        </div>
      </div>
    </div>
  );
}

'use client';

import { QrCode, Utensils, WifiOff } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useBrandTheme } from '@/lib/brand-theme';
import { I18nProvider, useI18n } from '@/lib/i18n';
import { BrandMark } from '@/components/brand-mark';
import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';
import { CartSheet } from './cart-sheet';
import { MenuView } from './menu-view';
import { StatusView } from './status-view';
import { useGuest } from './use-guest';

export function GuestApp({ qr }: { qr: string }) {
  return (
    <I18nProvider>
      <GuestShell qr={qr} />
    </I18nProvider>
  );
}

function GuestShell({ qr }: { qr: string }) {
  const g = useGuest(qr);
  const { t, lang, setLang } = useI18n();
  const [tab, setTab] = useState<'menu' | 'status'>('menu');
  const [cartOpen, setCartOpen] = useState(false);

  // The restaurant's own look across the menu, cart and order status (when its plan includes it).
  useBrandTheme(g.context?.tenant.branding, g.context?.tenant.name);

  if (g.phase === 'invalid' || g.phase === 'unavailable') {
    return (
      <Centered icon={<QrCode className="size-7" />} title={t('guest.invalid_qr')} hint={g.phase === 'unavailable' ? 'Ordering is not available here right now.' : t('guest.invalid_qr_hint')} />
    );
  }
  if (g.phase === 'ended') {
    return (
      <Centered
        icon={<Utensils className="size-7" />}
        title={t('guest.session_ended')}
        hint={t('guest.session_ended_hint')}
        action={
          <Button size="lg" onClick={() => void g.startOver().then(() => setTab('menu'))}>
            {t('guest.scan_again')}
          </Button>
        }
      />
    );
  }

  const ctx = g.context;
  const cover = ctx?.tenant.branding.cover_url ?? null;
  const orders = g.session?.orders ?? [];
  const activeOrders = orders.filter((o) => !['served', 'billed', 'rejected', 'cancelled'].includes(o.status)).length;

  return (
    <div className="mx-auto min-h-dvh max-w-xl bg-surface pb-36 sm:border-x sm:border-line">
      {!g.online && g.phase === 'ready' && (
        <div className="sticky top-0 z-40 flex items-center gap-2 bg-amber-100 px-4 py-2 text-sm text-amber-900">
          <WifiOff className="size-4" /> {t('guest.offline')}
        </div>
      )}

      {cover && <img src={cover} alt="" className="h-36 w-full object-cover sm:h-44" />}
      <header className={cn('px-4 pb-3', cover ? 'pt-3' : 'pt-5')}>
        <div className="flex items-start gap-3">
          {/* On a cover photo only the logo overlaps it; the name stays on white. */}
          <BrandMark
            branding={ctx?.tenant.branding}
            className={cn('rounded-2xl', cover ? '-mt-10 size-16 shadow-[var(--shadow-pop)] ring-4 ring-surface' : 'size-12', ctx?.tenant.branding.logo_url && !cover && 'border border-line')}
          />
          <div className="min-w-0 flex-1">
            {ctx ? (
              <>
                <h1 className="truncate font-display text-[22px] leading-tight font-semibold text-ink">{ctx.outlet.name}</h1>
                <p className="mt-0.5 flex items-center gap-1.5 text-sm text-ink-soft">
                  <span className="rounded-md bg-brand-50 px-1.5 py-0.5 text-xs font-semibold text-[var(--brand)]">{t('guest.table', { label: ctx.table.label })}</span>
                  <span className="truncate">{ctx.tenant.name}</span>
                </p>
              </>
            ) : (
              <div className="space-y-2">
                <div className="h-6 w-40 animate-pulse rounded bg-stone-200" />
                <div className="h-4 w-24 animate-pulse rounded bg-stone-100" />
              </div>
            )}
          </div>
          <button
            onClick={() => setLang(lang === 'en' ? 'hi' : 'en')}
            className="h-9 shrink-0 cursor-pointer rounded-full border border-line px-3 text-sm font-medium text-ink-soft hover:bg-stone-50"
            aria-label="Change language"
          >
            {t('common.language')}
          </button>
        </div>
      </header>

      {orders.length > 0 && (
        <div className="sticky top-0 z-30 border-b border-line bg-surface/95 px-4 pb-2 backdrop-blur">
          <div className="grid grid-cols-2 rounded-xl bg-stone-100 p-1" role="tablist">
            {(['menu', 'status'] as const).map((k) => (
              <button
                key={k}
                role="tab"
                aria-selected={tab === k}
                onClick={() => {
                  setTab(k);
                  window.scrollTo({ top: 0 });
                }}
                className={cn('h-10 cursor-pointer rounded-lg text-sm font-semibold transition', tab === k ? 'bg-surface text-ink shadow-sm' : 'text-ink-soft')}
              >
                {k === 'menu' ? t('guest.menu') : t('guest.your_orders')}
                {k === 'status' && activeOrders > 0 && (
                  <span className="ml-1.5 inline-grid size-5 place-items-center rounded-full bg-[var(--brand)] text-[11px] text-white">{activeOrders}</span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}

      {tab === 'menu' || orders.length === 0 ? (
        <MenuView g={g} stickyOffset={orders.length > 0 ? 60 : 0} />
      ) : (
        <StatusView g={g} onAddMore={() => setTab('menu')} />
      )}

      <CartBar g={g} onOpen={() => setCartOpen(true)} />
      <CartSheet
        g={g}
        open={cartOpen}
        onClose={() => setCartOpen(false)}
        onOrdered={() => {
          setCartOpen(false);
          setTab('status');
          window.scrollTo({ top: 0 });
        }}
      />
    </div>
  );
}

function CartBar({ g, onOpen }: { g: ReturnType<typeof useGuest>; onOpen: () => void }) {
  const { t } = useI18n();
  const lines = g.session?.cart.lines ?? [];
  const count = lines.reduce((a, l) => a + l.qty, 0);
  const total = useMemo(() => {
    if (!g.menu) return 0;
    let sum = 0;
    for (const l of lines) {
      const item = g.menu.items.find((i) => i.id === l.item_id);
      if (!item) continue;
      const deltas = l.modifier_ids.reduce((a, id) => a + (g.menu!.modifier_groups.flatMap((gr) => gr.modifiers).find((m) => m.id === id)?.price_delta_paise ?? 0), 0);
      sum += (item.price_paise + deltas) * l.qty;
    }
    return sum;
  }, [lines, g.menu]);
  if (count === 0) return null;
  return (
    <div className="fixed inset-x-0 bottom-0 z-40 mx-auto max-w-xl px-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
      <button
        onClick={onOpen}
        className="flex h-14 w-full cursor-pointer items-center justify-between rounded-2xl bg-[var(--brand)] px-5 text-white shadow-[var(--shadow-pop)] transition active:scale-[0.99]"
      >
        <span className="text-left leading-tight">
          <span className="block text-xs font-medium opacity-90">{count === 1 ? t('guest.item_1') : t('guest.items_n', { n: count })}</span>
          <span className="block text-base font-semibold tabular">{formatRupee(total)}</span>
        </span>
        <span className="text-base font-semibold">{t('guest.view_cart')} →</span>
      </button>
    </div>
  );
}

const rupee = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2, minimumFractionDigits: 0 });
export const formatRupee = (paise: number) => rupee.format(paise / 100);

function Centered({ icon, title, hint, action }: { icon: React.ReactNode; title: string; hint: string; action?: React.ReactNode }) {
  return (
    <div className="grid min-h-dvh place-items-center bg-surface px-6">
      <div className="max-w-sm text-center">
        <div className="mx-auto mb-4 grid size-16 place-items-center rounded-3xl bg-brand-50 text-[var(--brand)]">{icon}</div>
        <h1 className="font-display text-2xl font-semibold text-ink">{title}</h1>
        <p className="mt-2 text-ink-soft">{hint}</p>
        {action && <div className="mt-6">{action}</div>}
      </div>
    </div>
  );
}

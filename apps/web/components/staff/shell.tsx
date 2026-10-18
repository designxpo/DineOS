'use client';

import {
  BarChart3,
  BookUser,
  CalendarClock,
  ChefHat,
  ClipboardList,
  Gift,
  House,
  Landmark,
  LayoutGrid,
  LifeBuoy,
  LogOut,
  MoreHorizontal,
  Package,
  QrCode,
  ReceiptIndianRupee,
  Settings,
  ShoppingCart,
  Sparkles,
  UtensilsCrossed,
  Users,
} from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import type { OrderDTO } from '@mezmitra/shared/dto';
import { PIN_LOCK_MINUTES, PIN_MAX_ATTEMPTS, type Action } from '@mezmitra/shared/permissions';
import { useOutletEvents } from '@/lib/realtime';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { useStaff } from '@/lib/staff';
import { useBrandTheme } from '@/lib/brand-theme';
import { useScreenCheckIn } from '@/lib/screen-check-in';
import { BrandMark } from '@/components/brand-mark';
import { IconButton } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';
import { Sheet } from '@/components/ui/overlay';
import { Select } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/toast';
import { HelpButton } from './help';
import { HubModeBanner, HubSwitchBanner } from './offline-hub';
import { SyncStatus } from './outbox-panel';
import { PrintProblems } from './print-problems';
import { useSignOut } from './sign-out';
import { SoundButton } from './sound-sheet';
import { WhatsNewPill, WhatsNewSheet } from './whats-new';

interface NavItem {
  href: string;
  label: I18nKey;
  icon: React.ComponentType<{ className?: string }>;
  action: Action;
}

export const NAV: NavItem[] = [
  { href: '/app', label: 'nav.dashboard', icon: House, action: 'report.view' },
  { href: '/app/inbox', label: 'nav.orders', icon: ClipboardList, action: 'order.view' },
  { href: '/app/kds', label: 'nav.kitchen', icon: ChefHat, action: 'order.view' },
  { href: '/app/floor', label: 'nav.floor', icon: LayoutGrid, action: 'table.operate' },
  { href: '/app/pos', label: 'nav.pos', icon: ShoppingCart, action: 'order.create' },
  { href: '/app/bills', label: 'nav.bills', icon: ReceiptIndianRupee, action: 'bill.manage' },
  { href: '/app/reservations', label: 'nav.reservations', icon: CalendarClock, action: 'reservation.manage' },
  { href: '/app/customers', label: 'nav.customers', icon: BookUser, action: 'customer.view' },
  { href: '/app/loyalty', label: 'nav.loyalty', icon: Gift, action: 'outlet.settings' },
  { href: '/app/menu', label: 'nav.menu', icon: UtensilsCrossed, action: 'menu.stock' },
  { href: '/app/inventory', label: 'nav.inventory', icon: Package, action: 'inventory.record' },
  { href: '/app/tables', label: 'nav.tables', icon: QrCode, action: 'table.manage' },
  { href: '/app/reports', label: 'nav.reports', icon: BarChart3, action: 'report.view' },
  { href: '/app/reconcile', label: 'nav.reconcile', icon: Landmark, action: 'payment.reconcile' },
  { href: '/app/staff', label: 'nav.staff', icon: Users, action: 'staff.manage' },
  { href: '/app/settings', label: 'nav.settings', icon: Settings, action: 'outlet.settings' },
];

/** Screens that take orders or make bills: not shown while the outlet bills on another system. */
const BILLING_SCREENS = ['/app/inbox', '/app/kds', '/app/pos', '/app/bills'];

/** Tells the kitchen and managers when an ingredient reaches its reorder level. */
function useLowStockAlerts(enabled: boolean) {
  const toast = useToast();
  useOutletEvents((e) => {
    if (!enabled || e.type !== 'inventory.low') return;
    const p = e.payload as { name: string; stock_qty: number; unit: string };
    toast(`${p.name} is running low: ${Number(p.stock_qty.toFixed(3))} ${p.unit} left`, 'error');
  });
}

/** The phone tab bar: the first four screens this person can open, in this order, then "More". */
const TAB_ORDER = ['/app', '/app/inbox', '/app/floor', '/app/pos', '/app/bills', '/app/kds'];

const isActive = (href: string, pathname: string) => (href === '/app' ? pathname === '/app' : pathname.startsWith(href));

/**
 * Bottom tab bar on phones, so staff move between their main screens with one thumb. The Orders
 * tab carries the count of guest orders waiting to be accepted.
 */
function TabBar({ items, onMore, moreOpen }: { items: NavItem[]; onMore: () => void; moreOpen: boolean }) {
  const { t } = useI18n();
  const { api, outletId, can } = useStaff();
  const pathname = usePathname();
  // The kitchen screen is a tab only for people who cook; others reach it from "More".
  const tabs = TAB_ORDER.filter((href) => href !== '/app/kds' || can('order.kitchen'))
    .flatMap((href) => items.filter((i) => i.href === href))
    .slice(0, 4);
  const { data: waiting = 0 } = useQuery({
    queryKey: ['orders', outletId, 'waiting-count'],
    queryFn: () => api<OrderDTO[]>(`/orders?outlet_id=${outletId}&status=placed&limit=99`).then((list) => list.length),
    enabled: can('order.accept'),
    refetchInterval: 60_000,
  });
  const onTab = tabs.some((tab) => isActive(tab.href, pathname));
  const cell = 'flex flex-col items-center justify-center gap-0.5 text-[11px] font-medium transition active:scale-90 active:duration-75';
  return (
    <nav data-tabbar aria-label={t('nav.more')} className="chrome fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface/90 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl lg:hidden no-print">
      <div className="mx-auto grid h-14 max-w-xl" style={{ gridTemplateColumns: `repeat(${tabs.length + 1}, minmax(0, 1fr))` }}>
        {tabs.map((tab) => {
          const active = isActive(tab.href, pathname);
          const Icon = tab.icon;
          const badge = tab.href === '/app/inbox' && waiting > 0 ? waiting : 0;
          return (
            <Link key={tab.href} href={tab.href} aria-current={active ? 'page' : undefined} className={cn(cell, active ? 'text-brand-700' : 'text-ink-faint')}>
              <span className="relative">
                <Icon className="size-[22px]" />
                {badge > 0 && (
                  <span className="absolute -top-1.5 -right-2.5 min-w-[18px] rounded-full bg-rose-600 px-1 text-center text-[10px] leading-[18px] font-semibold text-white tabular" aria-label={`${badge} waiting`}>
                    {badge > 9 ? '9+' : badge}
                  </span>
                )}
              </span>
              <span className="max-w-full truncate px-1">{t(tab.label)}</span>
            </Link>
          );
        })}
        <button type="button" onClick={onMore} aria-expanded={moreOpen} className={cn(cell, 'cursor-pointer', moreOpen || !onTab ? 'text-brand-700' : 'text-ink-faint')}>
          <MoreHorizontal className="size-[22px]" />
          <span>{t('nav.more')}</span>
        </button>
      </div>
    </nav>
  );
}

/** Tells owners and managers when a manager PIN was locked after repeated wrong guesses. */
function useSecurityAlerts(enabled: boolean) {
  const toast = useToast();
  useOutletEvents((e) => {
    if (!enabled || e.type !== 'staff.pin_locked') return;
    const p = e.payload as { user_name: string; requested_by_name: string | null };
    toast(`${p.user_name}'s manager PIN is locked for ${PIN_LOCK_MINUTES} minutes: ${p.requested_by_name ?? 'someone'} entered it wrong ${PIN_MAX_ATTEMPTS} times in a row.`, 'error');
  });
}

/**
 * The warning banners under the header (offline hub, print problems). Their height is shared as
 * --banners-h, so full-height screens like the POS keep their buttons on screen when one shows.
 */
function Banners() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const root = document.documentElement;
    const sync = () => root.style.setProperty('--banners-h', `${el.offsetHeight}px`);
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(el);
    return () => {
      observer.disconnect();
      root.style.removeProperty('--banners-h');
    };
  }, []);
  return (
    <div ref={ref}>
      <HubModeBanner />
      <HubSwitchBanner />
      <PrintProblems />
      <BillsElsewhereBanner />
    </div>
  );
}

/** Someone opened an ordering or billing screen by its address: say where that happens for now. */
function BillsElsewhereBanner() {
  const { outlet, can } = useStaff();
  const { t } = useI18n();
  const pathname = usePathname();
  const system = outlet?.billing_elsewhere;
  if (!system || !BILLING_SCREENS.some((h) => pathname.startsWith(h))) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 bg-sky-50 px-4 py-2 text-sm text-sky-950">
      <span>{t('elsewhere.banner', { system })}</span>
      {can('payment.reconcile') && (
        <Link href="/app/reconcile" className="font-semibold underline">
          {t('elsewhere.check')}
        </Link>
      )}
    </div>
  );
}

/** Where each role starts its day. */
export function homeFor(can: (a: Action) => boolean): string {
  if (can('report.view')) return '/app';
  if (can('bill.manage')) return '/app/pos';
  if (can('table.operate')) return '/app/floor';
  return '/app/kds';
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const { me, outletId, outlet, setOutletId, can } = useStaff();
  const { t, lang, setLang } = useI18n();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [news, setNews] = useState(false);
  useEffect(() => setOpen(false), [pathname]);
  useLowStockAlerts(can('inventory.record'));
  useSecurityAlerts(can('staff.manage'));
  useScreenCheckIn();
  // A paid plan shows the restaurant's own logo and colours instead of the Mezmitra look.
  useBrandTheme(me.tenant.branding, me.tenant.white_label ? me.tenant.name : null);
  const { signOut, dialog: unsyncedDialog } = useSignOut();

  // Billing on another system: no ordering or billing screens, and the UPI check is the money check.
  const items = NAV.filter((n) => can(n.action) && !(outlet?.billing_elsewhere && BILLING_SCREENS.includes(n.href))).map((n) =>
    outlet?.billing_elsewhere && n.href === '/app/reconcile' ? { ...n, label: 'nav.money_check' as const } : n,
  );
  // Kitchen display is a full-screen tool.
  const bare = pathname.startsWith('/app/kds');

  const nav = (
    <nav className="flex flex-col gap-0.5 p-3" aria-label="Main">
      {items.map((item) => {
        const active = isActive(item.href, pathname);
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              'flex h-11 items-center gap-3 rounded-xl px-3 text-sm font-medium transition',
              active ? 'bg-brand-50 text-brand-700' : 'text-ink-soft hover:bg-stone-100 hover:text-ink',
            )}
            aria-current={active ? 'page' : undefined}
          >
            <Icon className="size-[18px]" />
            {t(item.label)}
          </Link>
        );
      })}
    </nav>
  );

  const status = <SyncStatus />;

  if (bare) {
    return (
      <>
        <Banners />
        {children}
      </>
    );
  }


  return (
    <div className="flex min-h-dvh">
      <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col border-r border-line bg-surface lg:flex">
        <div className="flex h-16 items-center gap-2.5 border-b border-line px-5">
          <BrandMark branding={me.tenant.branding} className={cn('size-9 rounded-xl', me.tenant.branding.logo_url && 'border border-line')} />
          <div className="min-w-0 leading-tight">
            <p className="truncate font-display text-[17px] font-semibold">{me.tenant.name}</p>
            <p className="truncate text-xs text-ink-faint">{outlet?.name ?? ''}</p>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">{nav}</div>
        <div className="border-t border-line p-3">
          <div className="flex items-center gap-2 rounded-xl px-2 py-1.5">
            <Link href="/app/account" className="flex min-w-0 flex-1 items-center gap-2 rounded-lg hover:bg-stone-50" title="My account">
              <div className="grid size-9 shrink-0 place-items-center rounded-full bg-stone-200 text-sm font-semibold text-ink-soft">{me.user.name.slice(0, 1)}</div>
              <div className="min-w-0 flex-1 leading-tight">
                <p className="truncate text-sm font-medium">{me.user.name}</p>
                <p className="truncate text-xs text-ink-faint capitalize">{(me.outlets.find((o) => o.id === outletId)?.roles ?? []).join(', ')}</p>
              </div>
            </Link>
            <IconButton label={t('nav.signout')} onClick={() => void signOut()}>
              <LogOut className="size-4" />
            </IconButton>
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="chrome sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-line bg-surface/90 px-4 backdrop-blur lg:px-6">
          {me.tenant.white_label && me.tenant.branding.logo_url && <BrandMark branding={me.tenant.branding} className="size-9 rounded-lg border border-line lg:hidden" />}
          {me.outlets.length > 1 ? (
            <Select value={outletId} onChange={(e) => setOutletId(e.target.value)} className="h-10 max-w-56" aria-label="Outlet">
              {me.outlets.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </Select>
          ) : (
            <p className="min-w-0 truncate font-medium lg:hidden">{outlet?.name}</p>
          )}
          {me.impersonated_by && <span className="rounded-full bg-violet-100 px-2.5 py-1 text-xs font-semibold text-violet-800">Support session</span>}
          <div className="ml-auto flex items-center gap-1">
            <WhatsNewPill />
            <HelpButton />
            <SoundButton />
          </div>
          <button onClick={() => setLang(lang === 'en' ? 'hi' : 'en')} className="h-9 cursor-pointer rounded-full border border-line px-3 text-sm font-medium text-ink-soft hover:bg-stone-50" aria-label="Change language">
            {t('common.language')}
          </button>
          <div>{status}</div>
        </header>
        <Banners />
        <main className="flex-1 pb-[var(--tabbar-h)]">{children}</main>
      </div>
      <TabBar items={items} onMore={() => setOpen(true)} moreOpen={open} />
      {unsyncedDialog}
      <WhatsNewSheet open={news} onClose={() => setNews(false)} />

      {/* "More" on phones: every screen, rising from the tab bar it was opened from. */}
      <Sheet open={open} onClose={() => setOpen(false)} title={me.tenant.name}>
        <nav className="grid grid-cols-3 gap-2" aria-label="Main">
          {items.map((item) => {
            const active = isActive(item.href, pathname);
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex min-h-20 flex-col items-center justify-center gap-1.5 rounded-2xl px-1 text-center text-xs font-medium transition active:scale-95 active:duration-75',
                  active ? 'bg-brand-50 text-brand-700' : 'bg-stone-50 text-ink-soft',
                )}
              >
                <Icon className="size-5" />
                {t(item.label)}
              </Link>
            );
          })}
        </nav>
        <div className="mt-4 divide-y divide-line overflow-hidden rounded-2xl border border-line">
          <Link href="/app/account" className="flex h-12 items-center gap-3 px-4 text-sm text-ink">
            <span className="grid size-7 place-items-center rounded-full bg-stone-200 text-xs font-semibold text-ink-soft">{me.user.name.slice(0, 1)}</span>
            <span className="flex-1 truncate">
              {me.user.name} · {t('nav.account')}
            </span>
          </Link>
          <Link href="/app/help" className="flex h-12 items-center gap-3 px-4 text-sm text-ink">
            <LifeBuoy className="size-4 text-ink-faint" /> {t('help.title')}
          </Link>
          <button onClick={() => setNews(true)} className="flex h-12 w-full cursor-pointer items-center gap-3 px-4 text-sm text-ink">
            <Sparkles className="size-4 text-ink-faint" /> {t('whatsnew.title')}
          </button>
          <button onClick={() => void signOut()} className="flex h-12 w-full cursor-pointer items-center gap-3 px-4 text-sm text-rose-700">
            <LogOut className="size-4" /> {t('nav.signout')}
          </button>
        </div>
      </Sheet>
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3 px-4 pt-6 pb-4 lg:px-8">
      <div>
        <h1 className="font-display text-2xl leading-tight font-semibold tracking-tight text-ink">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-ink-faint">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Forbidden() {
  return <p className="px-8 py-16 text-center text-ink-faint">You do not have access to this page.</p>;
}

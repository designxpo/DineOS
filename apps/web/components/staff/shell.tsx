'use client';

import {
  BarChart3,
  ChefHat,
  ClipboardList,
  CloudOff,
  LayoutDashboard,
  LayoutGrid,
  LogOut,
  Menu as MenuIcon,
  QrCode,
  ReceiptIndianRupee,
  Settings,
  ShoppingCart,
  UtensilsCrossed,
  Users,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { Action } from '@dineos/shared/permissions';
import { onOutboxChange } from '@/lib/outbox';
import { useConnection } from '@/lib/realtime';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { useStaff } from '@/lib/staff';
import { IconButton } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';
import { Select } from '@/components/ui/primitives';

interface NavItem {
  href: string;
  label: I18nKey;
  icon: React.ComponentType<{ className?: string }>;
  action: Action;
}

export const NAV: NavItem[] = [
  { href: '/app', label: 'nav.dashboard', icon: LayoutDashboard, action: 'report.view' },
  { href: '/app/inbox', label: 'nav.orders', icon: ClipboardList, action: 'order.view' },
  { href: '/app/kds', label: 'nav.kitchen', icon: ChefHat, action: 'order.view' },
  { href: '/app/floor', label: 'nav.floor', icon: LayoutGrid, action: 'table.operate' },
  { href: '/app/pos', label: 'nav.pos', icon: ShoppingCart, action: 'order.create' },
  { href: '/app/bills', label: 'nav.bills', icon: ReceiptIndianRupee, action: 'bill.manage' },
  { href: '/app/menu', label: 'nav.menu', icon: UtensilsCrossed, action: 'menu.stock' },
  { href: '/app/tables', label: 'nav.tables', icon: QrCode, action: 'table.manage' },
  { href: '/app/reports', label: 'nav.reports', icon: BarChart3, action: 'report.view' },
  { href: '/app/staff', label: 'nav.staff', icon: Users, action: 'staff.manage' },
  { href: '/app/settings', label: 'nav.settings', icon: Settings, action: 'outlet.settings' },
];

/** Where each role starts its day. */
export function homeFor(can: (a: Action) => boolean): string {
  if (can('report.view')) return '/app';
  if (can('bill.manage')) return '/app/pos';
  if (can('table.operate')) return '/app/floor';
  return '/app/kds';
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const { me, outletId, outlet, setOutletId, can, logout } = useStaff();
  const { t, lang, setLang } = useI18n();
  const pathname = usePathname();
  const connection = useConnection();
  const [pending, setPending] = useState(0);
  const [open, setOpen] = useState(false);
  useEffect(() => onOutboxChange(setPending), []);
  useEffect(() => setOpen(false), [pathname]);

  const items = NAV.filter((n) => can(n.action));
  // Kitchen display is a full-screen tool.
  const bare = pathname.startsWith('/app/kds');

  const nav = (
    <nav className="flex flex-col gap-0.5 p-3" aria-label="Main">
      {items.map((item) => {
        const active = item.href === '/app' ? pathname === '/app' : pathname.startsWith(item.href);
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

  const status = (
    <div className="flex items-center gap-2 text-xs">
      {pending > 0 && (
        <span className="flex items-center gap-1 rounded-full bg-amber-100 px-2 py-1 font-medium text-amber-900" title="Saved on this device, will send when back online">
          <CloudOff className="size-3.5" /> {pending} waiting to sync
        </span>
      )}
      <span className="flex items-center gap-1.5 text-ink-faint" role="status">
        <span className={cn('size-2 rounded-full', connection === 'online' ? 'bg-emerald-500' : connection === 'connecting' ? 'bg-amber-400' : 'bg-rose-500')} />
        {connection === 'online' ? 'Live' : connection === 'connecting' ? 'Connecting' : 'Offline'}
      </span>
    </div>
  );

  if (bare) return <>{children}</>;

  return (
    <div className="flex min-h-dvh">
      <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col border-r border-line bg-surface lg:flex">
        <div className="flex h-16 items-center gap-2.5 border-b border-line px-5">
          <div className="grid size-9 place-items-center rounded-xl bg-[var(--brand)] text-white">
            <ChefHat className="size-5" />
          </div>
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
            <IconButton label={t('nav.signout')} onClick={() => void logout()}>
              <LogOut className="size-4" />
            </IconButton>
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-line bg-surface/90 px-4 backdrop-blur lg:px-6">
          <IconButton label="Open menu" className="lg:hidden" onClick={() => setOpen(true)}>
            <MenuIcon className="size-5" />
          </IconButton>
          {me.outlets.length > 1 ? (
            <Select value={outletId} onChange={(e) => setOutletId(e.target.value)} className="h-10 max-w-56" aria-label="Outlet">
              {me.outlets.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </Select>
          ) : (
            <p className="font-medium lg:hidden">{outlet?.name}</p>
          )}
          {me.impersonated_by && <span className="rounded-full bg-violet-100 px-2.5 py-1 text-xs font-semibold text-violet-800">Support session</span>}
          <button onClick={() => setLang(lang === 'en' ? 'hi' : 'en')} className="ml-auto h-9 cursor-pointer rounded-full border border-line px-3 text-sm font-medium text-ink-soft hover:bg-stone-50" aria-label="Change language">
            {t('common.language')}
          </button>
          <div>{status}</div>
        </header>
        <main className="flex-1">{children}</main>
      </div>

      {open && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 animate-fade-in bg-stone-950/40" onClick={() => setOpen(false)} />
          <div className="absolute inset-y-0 left-0 flex w-72 flex-col bg-surface shadow-[var(--shadow-pop)]">
            <div className="flex h-16 items-center justify-between border-b border-line px-4">
              <span className="font-display text-lg font-semibold">{me.tenant.name}</span>
              <IconButton label="Close menu" onClick={() => setOpen(false)}>
                <X className="size-5" />
              </IconButton>
            </div>
            <div className="flex-1 overflow-y-auto">{nav}</div>
            <Link href="/app/account" className="flex h-12 items-center gap-3 border-t border-line px-6 text-sm text-ink-soft">
              {me.user.name} · {t('nav.account')}
            </Link>
            <button onClick={() => void logout()} className="flex h-14 cursor-pointer items-center gap-3 border-t border-line px-6 text-sm text-ink-soft">
              <LogOut className="size-4" /> {t('nav.signout')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3 px-4 pt-6 pb-4 lg:px-8">
      <div>
        <h1 className="font-display text-2xl font-semibold text-ink">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-ink-faint">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Forbidden() {
  return <p className="px-8 py-16 text-center text-ink-faint">You do not have access to this page.</p>;
}

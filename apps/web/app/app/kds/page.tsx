'use client';

import { useQueryClient } from '@tanstack/react-query';
import { usePersistedQuery } from '@/lib/persisted-query';
import { ArrowLeft, Bell, BellOff, ChefHat, LogOut, Maximize, StickyNote } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { OrderDTO, OrderItemDTO } from '@dineos/shared/dto';
import type { ItemStatus } from '@dineos/shared/enums';
import { errorMessage } from '@/lib/api';
import { minutesSince } from '@/lib/format';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { orderTitle } from '@/components/staff/order-title';
import { send } from '@/lib/outbox';
import { useConnection, useOutletEvents } from '@/lib/realtime';
import { chime, soundReady, unlockSound } from '@/lib/sound';
import { useStaff } from '@/lib/staff';
import { readLocal, writeLocal } from '@/lib/storage';
import { cn } from '@/components/ui/cn';
import { VegMark } from '@/components/ui/primitives';
import { OutboxBadge } from '@/components/staff/outbox-panel';
import { StaleBanner } from '@/components/staff/stale-banner';
import { homeFor } from '@/components/staff/shell';
import { useSignOut } from '@/components/staff/sign-out';
import { ConfirmDialog } from '@/components/ui/overlay';
import { useToast } from '@/components/ui/toast';

const NEXT: Partial<Record<ItemStatus, ItemStatus>> = { accepted: 'preparing', preparing: 'ready' };

export default function KdsPage() {
  const { api, token, outletId, outlet, can, me } = useStaff();
  // A wall-mounted screen stops showing orders when signed out, so a stray tap asks first.
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const { signOut, dialog: unsyncedDialog } = useSignOut();
  const { t, lang, setLang } = useI18n();
  const qc = useQueryClient();
  const toast = useToast();
  const connection = useConnection();
  const [station, setStation] = useState<string>('');
  const [sound, setSound] = useState(false);
  const [, tick] = useState(0);

  useEffect(() => {
    setStation(readLocal('dineos.kds.station', ''));
    setSound(soundReady());
    const timer = setInterval(() => tick((n) => n + 1), 15_000);
    return () => clearInterval(timer);
  }, []);

  const kds = usePersistedQuery(['kds', outletId, station], () => api<OrderDTO[]>(`/kds?outlet_id=${outletId}${station ? `&station=${station}` : ''}`), {
    refetchInterval: 30_000,
  });
  const orders = kds.data ?? [];

  useOutletEvents((e) => {
    if (e.type === 'order.status_changed' && (e.payload as { status: string }).status === 'accepted') chime('order');
    if (e.type === 'order.placed' && (e.payload as { order: OrderDTO }).order.status === 'accepted') chime('order');
  });

  const advanceItem = async (order: OrderDTO, item: OrderItemDTO) => {
    const to = NEXT[item.status];
    if (!to) return;
    // Optimistic: the cook sees the change instantly even on a slow connection.
    qc.setQueryData<OrderDTO[]>(['kds', outletId, station], (list) =>
      list?.map((o) => (o.id === order.id ? { ...o, items: o.items.map((i) => (i.id === item.id ? { ...i, status: to } : i)) } : o)),
    );
    try {
      const res = await send(token, `/order-items/${item.id}/status`, { method: 'PATCH', body: { status: to }, label: `${item.name} → ${to}` });
      if (!res.queued) void qc.invalidateQueries({ queryKey: ['kds'] });
    } catch (err) {
      toast(errorMessage(err), 'error');
      void qc.invalidateQueries({ queryKey: ['kds'] });
    }
  };

  // One request for the ticket on screen (only this station's items when a station is picked), so
  // the floor hears "bar ready" once, not once per drink.
  const allReady = async (order: OrderDTO) => {
    const pending = order.items.filter((i) => i.status === 'accepted' || i.status === 'preparing');
    if (pending.length === 0) return;
    const ids = new Set(pending.map((i) => i.id));
    qc.setQueryData<OrderDTO[]>(['kds', outletId, station], (list) =>
      list?.map((o) => (o.id === order.id ? { ...o, items: o.items.map((i) => (ids.has(i.id) ? { ...i, status: 'ready' as const } : i)) } : o)),
    );
    try {
      await send(token, `/orders/${order.id}/items/status`, {
        method: 'PATCH',
        body: { item_ids: [...ids], status: 'ready' },
        label: `#${order.order_no} → ${t('kds.all_ready')}`,
      });
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
    void qc.invalidateQueries({ queryKey: ['kds'] });
  };

  const stations = outlet?.kitchen_stations ?? [];
  const sorted = [...orders].sort((a, b) => (a.accepted_at ?? a.placed_at).localeCompare(b.accepted_at ?? b.placed_at));

  return (
    <div className="min-h-dvh bg-stone-900 text-stone-100">
      <header className="sticky top-0 z-20 flex flex-wrap items-center gap-3 border-b border-stone-800 bg-stone-900/95 px-4 py-3 backdrop-blur">
        {/* Cooks stay on this screen; anyone with other work gets a way back to it. */}
        {can('report.view') || can('bill.manage') || can('table.operate') || can('order.create') ? (
          <Link href={homeFor(can)} aria-label="Back" className="grid size-11 shrink-0 place-items-center rounded-xl text-stone-300 hover:bg-stone-800">
            <ArrowLeft className="size-5" />
          </Link>
        ) : null}
        <ChefHat className="size-6 shrink-0 text-amber-400" />
        <h1 className="min-w-0 flex-1 truncate text-lg font-semibold sm:flex-none">{outlet?.name}</h1>
        {/* On a phone the stations get their own row and scroll sideways. */}
        <div className="no-scrollbar order-last flex w-full gap-1 overflow-x-auto rounded-xl bg-stone-800 p-1 sm:order-none sm:w-auto" role="tablist" aria-label="Station">
          {['', ...stations].map((s) => (
            <button
              key={s || 'all'}
              role="tab"
              aria-selected={station === s}
              onClick={() => {
                setStation(s);
                writeLocal('dineos.kds.station', s);
              }}
              className={cn('h-9 shrink-0 cursor-pointer rounded-lg px-3 text-sm font-semibold whitespace-nowrap capitalize', station === s ? 'bg-amber-400 text-stone-900' : 'text-stone-300 hover:text-white')}
            >
              {s || t('kds.all_stations')}
            </button>
          ))}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1 sm:gap-2">
          <OutboxBadge />
          <span className="flex items-center gap-1.5 text-sm text-stone-400">
            <span className={cn('size-2.5 rounded-full', connection === 'online' ? 'bg-emerald-400' : 'bg-rose-500')} />
            {orders.length}
          </span>
          <button onClick={() => setLang(lang === 'en' ? 'hi' : 'en')} className="h-10 cursor-pointer rounded-xl px-3 text-sm font-semibold text-stone-300 hover:bg-stone-800">
            {t('common.language')}
          </button>
          <button onClick={() => setSound(unlockSound())} aria-label={sound ? 'Sound on' : 'Turn on sound'} className="grid size-10 cursor-pointer place-items-center rounded-xl text-stone-300 hover:bg-stone-800">
            {sound ? <Bell className="size-5" /> : <BellOff className="size-5 text-rose-400" />}
          </button>
          <button onClick={() => void document.documentElement.requestFullscreen?.()} aria-label="Full screen" className="hidden size-10 cursor-pointer place-items-center rounded-xl text-stone-300 hover:bg-stone-800 sm:grid">
            <Maximize className="size-5" />
          </button>
          <button
            onClick={() => setConfirmSignOut(true)}
            aria-label={t('nav.signout')}
            title={`${t('nav.signout')} · ${me.user.name}`}
            className="grid size-10 cursor-pointer place-items-center rounded-xl text-stone-300 transition hover:bg-stone-800 active:scale-90"
          >
            <LogOut className="size-5" />
          </button>
        </div>
      </header>
      <ConfirmDialog
        open={confirmSignOut}
        onClose={() => setConfirmSignOut(false)}
        title={t('kds.signout_title')}
        description={t('kds.signout_hint', { name: me.user.name })}
        confirmLabel={t('nav.signout')}
        onConfirm={() => {
          setConfirmSignOut(false);
          void signOut();
        }}
      />
      {unsyncedDialog}

      <div className="pt-3">
        <StaleBanner show={kds.stale} dark />
      </div>
      {sorted.length === 0 ? (
        <div className="grid min-h-[70dvh] place-items-center text-center">
          <div>
            <ChefHat className="mx-auto size-12 text-stone-600" />
            <p className="mt-4 text-xl font-semibold">{t('kds.empty')}</p>
            <p className="mt-1 text-stone-400">{t('kds.empty_hint')}</p>
          </div>
        </div>
      ) : (
        <div className="grid gap-3 p-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
          {sorted.map((order) => {
            const mins = minutesSince(order.accepted_at ?? order.placed_at);
            const ready = order.items.filter((i) => i.status !== 'cancelled').every((i) => i.status === 'ready' || i.status === 'served');
            const tone = ready ? 'bg-emerald-600' : mins >= 20 ? 'bg-rose-600' : mins >= 10 ? 'bg-amber-500 text-stone-900' : 'bg-stone-700';
            return (
              <article key={order.id} className="flex flex-col overflow-hidden rounded-2xl bg-stone-800 shadow-lg">
                <header className={cn('flex items-center justify-between px-4 py-3', tone)}>
                  <div>
                    <p className="text-xl font-bold">{order.table_label ?? orderTitle(order, t)}</p>
                    <p className="text-sm font-medium opacity-90">#{order.order_no}</p>
                  </div>
                  <p className="text-3xl font-bold tabular">{mins < 60 ? `${mins}′` : `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}′`}</p>
                </header>
                <ul className="flex-1 divide-y divide-stone-700">
                  {order.items.map((item) => {
                    const done = item.status === 'ready' || item.status === 'served';
                    return (
                      <li key={item.id}>
                        <button
                          onClick={() => void advanceItem(order, item)}
                          disabled={!NEXT[item.status] || !can('order.kitchen')}
                          className={cn(
                            'flex w-full cursor-pointer items-start gap-3 px-4 py-3 text-left transition hover:bg-stone-700/60 disabled:cursor-default',
                            item.status === 'cancelled' && 'opacity-40 line-through',
                          )}
                        >
                          <span className={cn('text-2xl leading-none font-bold tabular', done ? 'text-emerald-400' : 'text-white')}>{item.qty}</span>
                          <span className="flex-1">
                            <span className={cn('flex items-center gap-2 text-lg leading-snug font-semibold', done && 'text-stone-400')}>
                              <VegMark veg={item.is_veg} className="bg-white" /> {item.name}
                            </span>
                            {item.modifiers.length > 0 && <span className="block text-sm text-amber-300">{item.modifiers.map((m) => m.name).join(' · ')}</span>}
                            {item.note && <span className="mt-0.5 block text-sm font-semibold text-rose-300">! {item.note}</span>}
                            {item.seat_no && <span className="block text-xs text-stone-400">seat {item.seat_no}</span>}
                          </span>
                          <span
                            className={cn(
                              'shrink-0 rounded-lg px-2 py-1 text-xs font-bold uppercase',
                              item.status === 'preparing' ? 'bg-violet-500 text-white' : done ? 'bg-emerald-500 text-white' : 'bg-stone-600 text-stone-200',
                            )}
                          >
                            {item.status === 'accepted' ? t('kds.start') : t(`item.${item.status}` as I18nKey)}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
                {order.note && (
                  <p className="flex items-start gap-2 bg-stone-700/50 px-4 py-2 text-sm text-amber-200">
                    <StickyNote className="mt-0.5 size-4 shrink-0" /> {order.note}
                  </p>
                )}
                {!ready && can('order.kitchen') && (
                  <button onClick={() => void allReady(order)} className="h-14 cursor-pointer bg-emerald-600 text-base font-bold text-white transition hover:bg-emerald-500">
                    {t('kds.all_ready')}
                  </button>
                )}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

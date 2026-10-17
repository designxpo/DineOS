'use client';

import { usePersistedQuery } from '@/lib/persisted-query';
import { Bell, BellOff, ClipboardList } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { OrderDTO } from '@dineos/shared/dto';
import type { OrderStatus } from '@dineos/shared/enums';
import { useOutletEvents } from '@/lib/realtime';
import { chime, soundReady, unlockSound } from '@/lib/sound';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { useStaff } from '@/lib/staff';
import { Button } from '@/components/ui/button';
import { EmptyState, Segmented, Spinner } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/toast';
import { OrderCard } from '@/components/staff/orders';
import { ServiceRequestStrip, useServiceRequestAlerts } from '@/components/staff/service-requests';
import { PageHeader } from '@/components/staff/shell';
import { StaleBanner } from '@/components/staff/stale-banner';

type Column = 'new' | 'kitchen' | 'ready' | 'served';
const COLUMNS: { key: Column; label: I18nKey; statuses: OrderStatus[] }[] = [
  { key: 'new', label: 'inbox.new', statuses: ['placed'] },
  { key: 'kitchen', label: 'inbox.kitchen', statuses: ['accepted', 'preparing'] },
  { key: 'ready', label: 'inbox.ready', statuses: ['ready'] },
  { key: 'served', label: 'inbox.served', statuses: ['served'] },
];

export default function InboxPage() {
  const { api, outletId } = useStaff();
  const { t } = useI18n();
  const toast = useToast();
  const [tab, setTab] = useState<Column>('new');
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const [sound, setSound] = useState(false);

  useEffect(() => setSound(soundReady()), []);

  // Orders someone still has to act on show however old they are (one placed before midnight, or
  // forgotten); served ones drop off after a few hours.
  const { data: orders, isLoading, stale } = usePersistedQuery(
    ['orders', outletId, 'inbox'],
    async () => {
      const since = new Date(Date.now() - 4 * 3600_000).toISOString();
      const [open, served] = await Promise.all([
        api<OrderDTO[]>(`/orders?outlet_id=${outletId}&status=placed,accepted,preparing,ready&limit=300`),
        api<OrderDTO[]>(`/orders?outlet_id=${outletId}&status=served&since=${encodeURIComponent(since)}&limit=200`),
      ]);
      return [...open, ...served];
    },
    { refetchInterval: 60_000 },
  );

  useServiceRequestAlerts();
  // New orders: chime, toast and a pulsing card for a few seconds (spec §7).
  useOutletEvents((e) => {
    if (e.type === 'order.placed') {
      const order = (e.payload as { order: OrderDTO }).order;
      chime('order');
      toast(`New order #${order.order_no}${order.table_label ? ` from ${order.table_label}` : ''}`, 'info');
      setFresh((s) => new Set(s).add(order.id));
      setTimeout(() => setFresh((s) => {
        const next = new Set(s);
        next.delete(order.id);
        return next;
      }), 15_000);
    }
  });

  const byColumn = (c: (typeof COLUMNS)[number]) =>
    (orders ?? [])
      .filter((o) => c.statuses.includes(o.status))
      .sort((a, b) => (c.key === 'served' ? b.placed_at.localeCompare(a.placed_at) : a.placed_at.localeCompare(b.placed_at)));

  return (
    <div>
      <PageHeader
        title={t('nav.orders')}
        subtitle={t('inbox.subtitle')}
        actions={
          <Button variant={sound ? 'secondary' : 'outline'} onClick={() => setSound(unlockSound())}>
            {sound ? <Bell className="size-4" /> : <BellOff className="size-4" />}
            {sound ? t('sound.on') : t('sound.off')}
          </Button>
        }
      />
      <StaleBanner show={stale} />
      <ServiceRequestStrip />

      {isLoading ? (
        <div className="grid place-items-center py-24">
          <Spinner />
        </div>
      ) : (
        <>
          <div className="px-4 pb-3 lg:hidden">
            <Segmented value={tab} onChange={setTab} options={COLUMNS.map((c) => ({ value: c.key, label: t(c.label), count: byColumn(c).length }))} className="w-full overflow-x-auto" />
          </div>
          <div className="grid gap-4 px-4 pb-10 lg:grid-cols-3 lg:px-8 xl:grid-cols-4">
            {COLUMNS.map((c) => {
              const list = byColumn(c);
              return (
                <section key={c.key} className={tab === c.key ? 'block' : 'hidden lg:block'} aria-label={t(c.label)}>
                  <h2 className="mb-3 hidden items-center gap-2 text-sm font-semibold text-ink-soft lg:flex">
                    {t(c.label)}
                    <span className="rounded-full bg-stone-200 px-2 text-xs tabular">{list.length}</span>
                  </h2>
                  <div className="space-y-3">
                    {list.length === 0 ? (
                      <div className="rounded-[var(--radius-card)] border border-dashed border-line">
                        <EmptyState icon={<ClipboardList className="size-5" />} title={t(`inbox.empty_${c.key}` as I18nKey)} />
                      </div>
                    ) : (
                      list.map((o) => <OrderCard key={o.id} order={o} highlight={fresh.has(o.id)} compact={c.key === 'served'} />)
                    )}
                  </div>
                </section>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

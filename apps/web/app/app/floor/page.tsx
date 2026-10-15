'use client';

import { usePersistedQuery } from '@/lib/persisted-query';
import { BellRing, Link2, ReceiptIndianRupee, Users } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { TableDTO } from '@dineos/shared/dto';
import { TABLE_STATES, type TableState } from '@dineos/shared/enums';
import { ago, formatPaise } from '@/lib/format';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { useStaff } from '@/lib/staff';
import { cn } from '@/components/ui/cn';
import { Segmented, Spinner } from '@/components/ui/primitives';
import { ServiceRequestStrip, useServiceRequestAlerts } from '@/components/staff/service-requests';
import { PageHeader } from '@/components/staff/shell';
import { StaleBanner } from '@/components/staff/stale-banner';
import { TablePanel } from '@/components/staff/table-panel';
import { TABLE_STATE } from '@/components/staff/table-state';

export default function FloorPage() {
  const { api, outletId } = useStaff();
  const { t } = useI18n();
  useServiceRequestAlerts();
  const [zone, setZone] = useState('all');
  const [selected, setSelected] = useState<string | null>(null);
  const { data: tables, isLoading, stale } = usePersistedQuery(['tables', outletId], () => api<TableDTO[]>(`/tables?outlet_id=${outletId}`), { refetchInterval: 60_000 });

  const zones = useMemo(() => [...new Set((tables ?? []).map((t) => t.zone ?? 'Tables'))], [tables]);
  const counts = useMemo(() => {
    const c = Object.fromEntries(TABLE_STATES.map((s) => [s, 0])) as Record<TableState, number>;
    for (const t of tables ?? []) c[t.state]++;
    return c;
  }, [tables]);
  const visible = (tables ?? []).filter((t) => zone === 'all' || (t.zone ?? 'Tables') === zone);
  const grouped = zones.filter((z) => zone === 'all' || z === zone).map((z) => ({ zone: z, tables: visible.filter((t) => (t.zone ?? 'Tables') === z) }));
  const current = tables?.find((t) => t.id === selected) ?? null;

  return (
    <div className="pb-10">
      <PageHeader
        title={t('nav.floor')}
        subtitle={
          <span className="flex flex-wrap gap-x-4 gap-y-1">
            {TABLE_STATES.map((s) => (
              <span key={s} className="inline-flex items-center gap-1.5">
                <span className={cn('size-2.5 rounded-full', TABLE_STATE[s].dot)} /> {t(`table.${s}` as I18nKey)} <span className="font-semibold text-ink-soft tabular">{counts[s]}</span>
              </span>
            ))}
          </span>
        }
        actions={zones.length > 1 ? <Segmented value={zone} onChange={setZone} options={[{ value: 'all', label: t('floor.all') }, ...zones.map((z) => ({ value: z, label: z }))]} /> : undefined}
      />
      <StaleBanner show={stale} />
      <ServiceRequestStrip />
      {isLoading ? (
        <div className="grid place-items-center py-24">
          <Spinner />
        </div>
      ) : (
        grouped.map((g) => (
          <section key={g.zone} className="px-4 pt-2 pb-4 lg:px-8">
            <h2 className="mb-3 text-sm font-semibold tracking-wide text-ink-faint uppercase">{g.zone}</h2>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3">
              {g.tables.map((t) => (
                <TableTile key={t.id} table={t} onOpen={() => setSelected(t.id)} />
              ))}
            </div>
          </section>
        ))
      )}
      <TablePanel table={current} tables={tables ?? []} onClose={() => setSelected(null)} />
    </div>
  );
}

function TableTile({ table, onOpen }: { table: TableDTO; onOpen: () => void }) {
  const { t } = useI18n();
  const style = TABLE_STATE[table.state];
  const calling = table.open_requests.some((r) => r.kind === 'call_waiter' && r.status === 'open');
  const billAsked = table.open_requests.some((r) => r.kind === 'bill');
  return (
    <button
      onClick={onOpen}
      className={cn(
        'relative flex min-h-32 cursor-pointer flex-col rounded-2xl border-2 p-3 text-left transition hover:-translate-y-0.5 hover:shadow-[var(--shadow-pop)]',
        style.tile,
        calling && 'animate-pulse-ring',
      )}
      aria-label={`Table ${table.label}, ${style.label}`}
    >
      <div className="flex items-start justify-between">
        <span className="font-display text-2xl font-semibold text-ink">{table.label}</span>
        <span className="flex items-center gap-1">
          {calling && <BellRing className="size-4 text-amber-700" />}
          {billAsked && <ReceiptIndianRupee className="size-4 text-violet-700" />}
          {table.merged_with.length > 0 && <Link2 className="size-4 text-ink-faint" />}
        </span>
      </div>
      <span className="mt-0.5 flex items-center gap-1.5 text-xs font-medium text-ink-soft">
        <span className={cn('size-2 rounded-full', style.dot)} /> {t(`table.${table.state}` as I18nKey)}
      </span>
      <div className="mt-auto pt-3 text-xs text-ink-faint">
        {table.session?.status === 'open' ? (
          <>
            <p className="text-sm font-semibold text-ink tabular">{formatPaise(table.running_total_paise)}</p>
            <p className="flex items-center gap-2">
              {table.session.opened_at && <span>{ago(table.session.opened_at)}</span>}
              {table.session.guest_count && (
                <span className="inline-flex items-center gap-0.5">
                  <Users className="size-3" /> {table.session.guest_count}
                </span>
              )}
            </p>
          </>
        ) : (
          <p className="inline-flex items-center gap-1">
            <Users className="size-3" /> {t('floor.seats', { n: table.seats })}
          </p>
        )}
        {table.assigned_waiter_name && <p className="truncate">{table.assigned_waiter_name}</p>}
      </div>
    </button>
  );
}

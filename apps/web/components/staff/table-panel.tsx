'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRightLeft, Brush, ExternalLink, Link2, LogOut, Minus, Plus, ReceiptIndianRupee, ShoppingCart, UserRound, Users } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { BillDTO, OrderDTO, TableDTO } from '@dineos/shared/dto';
import { errorMessage } from '@/lib/api';
import { ago, formatPaise } from '@/lib/format';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { useStaff } from '@/lib/staff';
import { Button } from '@/components/ui/button';
import { Sheet } from '@/components/ui/overlay';
import { cn } from '@/components/ui/cn';
import { Badge, Select } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/toast';
import { OrderCard } from './orders';

type Mode = null | 'transfer' | 'merge' | 'seat';

export function TablePanel({ table, tables, onClose }: { table: TableDTO | null; tables: TableDTO[]; onClose: () => void }) {
  const { api, outletId, can } = useStaff();
  const { t } = useI18n();
  const qc = useQueryClient();
  const toast = useToast();
  const router = useRouter();
  const [mode, setMode] = useState<Mode>(null);
  const [guests, setGuests] = useState(2);
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const sessionId = table?.session?.status === 'open' ? table.session.id : null;
  const orders = useQuery({
    queryKey: ['orders', outletId, 'session', sessionId],
    enabled: !!sessionId,
    queryFn: () => api<OrderDTO[]>(`/orders?outlet_id=${outletId}&table_session_id=${sessionId}`),
  });
  const staff = useQuery({
    queryKey: ['staff-names', outletId],
    enabled: !!table,
    queryFn: () => api<{ id: string; name: string; roles: { role: string }[] }[]>(`/staff?outlet_id=${outletId}`),
    staleTime: 5 * 60_000,
  });

  if (!table) return null;

  const run = async (label: string, fn: () => Promise<unknown>, done?: string): Promise<boolean> => {
    setBusy(label);
    try {
      await fn();
      await qc.invalidateQueries({ queryKey: ['tables'] });
      if (done) toast(done);
      setMode(null);
      setPicked([]);
      return true;
    } catch (err) {
      toast(errorMessage(err), 'error');
      return false;
    } finally {
      setBusy(null);
    }
  };

  const seat = async (n: number) => {
    if (await run('seat', () => api(`/tables/${table.id}/seat`, { method: 'POST', body: { guest_count: n } }), t('floor.seated', { label: table.label, n }))) onClose();
  };

  const openBill = () =>
    run('bill', async () => {
      const bill = await api<BillDTO>('/bills', { method: 'POST', body: { table_session_id: sessionId } });
      router.push(`/app/bills/${bill.id}`);
    });

  const openGuestView = async () => {
    try {
      const qr = await api<{ url: string }>(`/tables/${table.id}/qr`);
      window.open(qr.url, '_blank');
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  const live = table.session?.status === 'open';
  const freeTables = tables.filter((t) => t.id !== table.id && (!t.session || t.session.status !== 'open'));
  const others = tables.filter((t) => t.id !== table.id);
  const waiters = (staff.data ?? []).filter((s) => s.roles.some((r) => ['waiter', 'manager', 'owner', 'cashier'].includes(r.role)));

  return (
    <Sheet
      open
      wide
      onClose={() => {
        setMode(null);
        onClose();
      }}
      title={
        <span className="flex items-center gap-3">
          Table {table.label}
          <Badge tone={table.state === 'vacant' ? 'neutral' : table.state === 'needs_cleaning' ? 'rose' : table.state === 'bill_requested' ? 'violet' : table.state === 'served' ? 'green' : table.state === 'ordered' ? 'amber' : 'blue'}>{t(`table.${table.state}` as I18nKey)}</Badge>
        </span>
      }
    >
      <div className="flex flex-wrap gap-x-5 gap-y-1 text-sm text-ink-soft">
        <span className="inline-flex items-center gap-1.5">
          <Users className="size-4" /> {table.session?.guest_count ?? '–'} / {table.seats} seats
        </span>
        {live && table.session?.opened_at && <span>Seated {ago(table.session.opened_at)} ago</span>}
        {table.guests_since && <span className="font-medium text-sky-800">{t('floor.guests_here', { time: ago(table.guests_since) })}</span>}
        {table.merged_with.length > 0 && (
          <span className="inline-flex items-center gap-1">
            <Link2 className="size-4" /> with {table.merged_with.join(', ')}
          </span>
        )}
        {live && <span className="font-semibold text-ink tabular">{formatPaise(table.running_total_paise)}</span>}
      </div>

      {/* Guests just sat down: tap how many, and the table is theirs. */}
      {!live && can('table.operate') && (
        <div className="mt-4 rounded-2xl bg-stone-50 p-3">
          <p className="mb-2 text-sm font-medium">{t('floor.seat_how_many')}</p>
          <div className="grid grid-cols-7 gap-1.5">
            {[1, 2, 3, 4, 5, 6].map((n) => (
              <button
                key={n}
                type="button"
                disabled={!!busy}
                onClick={() => void seat(n)}
                aria-label={`${t('floor.seat')}: ${n}`}
                className="h-12 cursor-pointer rounded-xl bg-surface text-lg font-semibold tabular ring-1 ring-line transition hover:ring-[var(--brand)] active:scale-95 active:duration-75 disabled:opacity-50"
              >
                {n}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setMode(mode === 'seat' ? null : 'seat')}
              aria-expanded={mode === 'seat'}
              className={cn('h-12 cursor-pointer rounded-xl text-xs font-semibold ring-1 transition active:scale-95', mode === 'seat' ? 'bg-brand-50 text-brand-700 ring-[var(--brand)]' : 'bg-surface text-ink-soft ring-line')}
            >
              {t('floor.seat_more')}
            </button>
          </div>
        </div>
      )}

      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
        {can('order.create') && (
          <Button variant="outline" onClick={() => router.push(`/app/pos?table=${table.id}`)}>
            <ShoppingCart className="size-4" /> {t('floor.new_order')}
          </Button>
        )}
        {live && can('bill.manage') && (
          <Button onClick={() => void openBill()} loading={busy === 'bill'}>
            <ReceiptIndianRupee className="size-4" /> {t('floor.bill')}
          </Button>
        )}
        {live && can('table.operate') && (
          <Button variant="outline" onClick={() => setMode(mode === 'transfer' ? null : 'transfer')}>
            <ArrowRightLeft className="size-4" /> {t('floor.move')}
          </Button>
        )}
        {can('table.operate') && (
          <Button variant="outline" onClick={() => setMode(mode === 'merge' ? null : 'merge')}>
            <Link2 className="size-4" /> {t('floor.join')}
          </Button>
        )}
        {table.needs_cleaning && can('table.operate') && (
          <Button variant="success" loading={busy === 'clean'} onClick={() => void run('clean', () => api(`/tables/${table.id}/clean`, { method: 'POST' }), `${table.label} is ready for guests`)}>
            <Brush className="size-4" /> {t('floor.clean')}
          </Button>
        )}
        {table.session && can('table.operate') && (
          <Button variant="ghost" loading={busy === 'release'} onClick={() => void run('release', () => api(`/tables/${table.id}/release`, { method: 'POST' }), `${table.label} released`)}>
            <LogOut className="size-4" /> {t('floor.release')}
          </Button>
        )}
        <Button variant="ghost" onClick={() => void openGuestView()}>
          <ExternalLink className="size-4" /> {t('floor.guest_menu')}
        </Button>
      </div>

      {mode === 'seat' && (
        <div className="mt-4 flex items-center gap-3 rounded-2xl bg-stone-50 p-3">
          <span className="text-sm font-medium">{t('floor.guests')}</span>
          <div className="flex h-11 items-center rounded-xl border border-line bg-surface">
            <button className="grid h-full w-11 cursor-pointer place-items-center" aria-label="Fewer" onClick={() => setGuests((g) => Math.max(1, g - 1))}>
              <Minus className="size-4" />
            </button>
            <span className="w-8 text-center font-semibold tabular">{guests}</span>
            <button className="grid h-full w-11 cursor-pointer place-items-center" aria-label="More" onClick={() => setGuests((g) => g + 1)}>
              <Plus className="size-4" />
            </button>
          </div>
          <Button className="ml-auto" loading={busy === 'seat'} onClick={() => void seat(guests)}>
            {t('floor.seat')}
          </Button>
        </div>
      )}

      {mode === 'transfer' && (
        <Picker
          title="Move this party to"
          tables={freeTables}
          multi={false}
          picked={picked}
          setPicked={setPicked}
          confirm="Move"
          busy={busy === 'transfer'}
          onConfirm={() => void run('transfer', () => api(`/tables/${table.id}/transfer`, { method: 'POST', body: { to_table_id: picked[0] } }), 'Party moved')}
        />
      )}
      {mode === 'merge' && (
        <Picker
          title={`Join with ${table.label} (one bill)`}
          tables={others}
          multi
          picked={picked}
          setPicked={setPicked}
          confirm="Join tables"
          busy={busy === 'merge'}
          onConfirm={() => void run('merge', () => api('/tables/merge', { method: 'POST', body: { table_ids: [table.id, ...picked] } }), 'Tables joined')}
        />
      )}

      {can('table.operate') && (
        <label className="mt-4 flex items-center gap-3 text-sm">
          <UserRound className="size-4 text-ink-faint" />
          <span className="text-ink-soft">{t('floor.waiter')}</span>
          <Select
            value={table.assigned_waiter_id ?? ''}
            onChange={(e) => void run('waiter', () => api(`/tables/${table.id}/waiter`, { method: 'PATCH', body: { waiter_id: e.target.value || null } }))}
            className="h-10 max-w-56"
          >
            <option value="">{t('floor.unassigned')}</option>
            {waiters.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </Select>
        </label>
      )}

      {live && (
        <div className="mt-5 space-y-3">
          <h3 className="text-sm font-semibold text-ink-soft">{t('floor.orders')}</h3>
          {(orders.data ?? []).length === 0 && <p className="text-sm text-ink-faint">{t('floor.no_orders')}</p>}
          {[...(orders.data ?? [])].reverse().map((o) => (
            <OrderCard key={o.id} order={o} billable={false} />
          ))}
        </div>
      )}
    </Sheet>
  );
}

function Picker({
  title,
  tables,
  multi,
  picked,
  setPicked,
  confirm,
  onConfirm,
  busy,
}: {
  title: string;
  tables: TableDTO[];
  multi: boolean;
  picked: string[];
  setPicked: (p: string[]) => void;
  confirm: string;
  onConfirm: () => void;
  busy: boolean;
}) {
  return (
    <div className="mt-4 rounded-2xl bg-stone-50 p-3">
      <p className="mb-2 text-sm font-medium">{title}</p>
      <div className="flex flex-wrap gap-2">
        {tables.map((t) => {
          const on = picked.includes(t.id);
          return (
            <button
              key={t.id}
              onClick={() => setPicked(multi ? (on ? picked.filter((x) => x !== t.id) : [...picked, t.id]) : [t.id])}
              className={`h-10 min-w-12 cursor-pointer rounded-xl border px-3 text-sm font-semibold ${on ? 'border-[var(--brand)] bg-[var(--brand)] text-white' : 'border-line bg-surface'}`}
            >
              {t.label}
            </button>
          );
        })}
        {tables.length === 0 && <p className="text-sm text-ink-faint">No tables available.</p>}
      </div>
      <Button className="mt-3" disabled={picked.length === 0} loading={busy} onClick={onConfirm}>
        {confirm}
      </Button>
    </div>
  );
}

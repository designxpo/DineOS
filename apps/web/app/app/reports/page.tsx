'use client';

import { useQuery } from '@tanstack/react-query';
import { ArrowDownRight, ArrowUpRight, Download, Printer } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { CameraDTO } from '@dineos/shared/dto';
import { apiBlobUrl, errorMessage } from '@/lib/api';
import { dateTime, formatPaise, formatRate, todayIst } from '@/lib/format';
import { useStaff } from '@/lib/staff';
import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';
import { Badge, Card, Input, Segmented, Spinner, Stat } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/toast';
import { ColumnChart } from '@/components/staff/column-chart';
import { Forbidden, PageHeader } from '@/components/staff/shell';

type Tab = 'sales' | 'insights' | 'gst' | 'items' | 'day-end' | 'vision' | 'room-charges';
type Preset = 'today' | 'yesterday' | '7d' | 'month' | 'custom';

function shift(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function presetRange(p: Preset, today: string): { from: string; to: string } {
  switch (p) {
    case 'yesterday':
      return { from: shift(today, -1), to: shift(today, -1) };
    case '7d':
      return { from: shift(today, -6), to: today };
    case 'month':
      return { from: `${today.slice(0, 7)}-01`, to: today };
    default:
      return { from: today, to: today };
  }
}

export default function ReportsPage() {
  const { api, outletId, can, token, outlet } = useStaff();
  const toast = useToast();
  const today = todayIst();
  const [tab, setTab] = useState<Tab>('sales');
  const [preset, setPreset] = useState<Preset>('today');
  const [custom, setCustom] = useState({ from: today, to: today });
  const range = preset === 'custom' ? custom : presetRange(preset, today);
  const qs = `outlet_id=${outletId}&from=${range.from}&to=${range.to}`;

  const cameras = useQuery({ queryKey: ['cameras', outletId], enabled: can('table.manage'), queryFn: () => api<CameraDTO[]>(`/cameras?outlet_id=${outletId}`) });
  const hasCameras = (cameras.data?.length ?? 0) > 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const q = useQuery<any>({
    queryKey: ['report', outletId, tab, range.from, range.to],
    enabled: can('report.view'),
    queryFn: () => api(`/reports/${tab}?${qs}`),
  });

  const csv = async () => {
    try {
      const url = await apiBlobUrl(`/reports/${tab}?${qs}&format=csv`, token);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${tab}-${range.from}-${range.to}.csv`;
      a.click();
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  if (!can('report.view')) return <Forbidden />;

  return (
    <div className="pb-12">
      <PageHeader
        title="Reports"
        subtitle={range.from === range.to ? range.from : `${range.from} to ${range.to}`}
        actions={
          <>
            {tab === 'insights' || tab === 'vision' ? null : tab !== 'day-end' ? (
              <Button variant="outline" onClick={() => void csv()}>
                <Download className="size-4" /> CSV
              </Button>
            ) : (
              <Button variant="outline" onClick={() => window.print()}>
                <Printer className="size-4" /> Print
              </Button>
            )}
          </>
        }
      />
      <div className="no-print flex flex-wrap items-center gap-3 px-4 pb-4 lg:px-8">
        <Segmented className="max-w-full overflow-x-auto" value={tab} onChange={setTab} options={[
            { value: 'sales', label: 'Sales' },
            { value: 'insights', label: 'Insights' },
            { value: 'gst', label: 'GST' },
            { value: 'items', label: 'Dishes' },
            { value: 'day-end', label: 'Day end' },
            ...(outlet?.room_charge_enabled ? [{ value: 'room-charges' as Tab, label: 'Room charges' }] : []),
            ...(hasCameras ? [{ value: 'vision' as Tab, label: 'Camera' }] : []),
          ]}
        />
        <Segmented
          className="max-w-full overflow-x-auto"
          value={preset}
          onChange={setPreset}
          options={[
            { value: 'today', label: 'Today' },
            { value: 'yesterday', label: 'Yesterday' },
            { value: '7d', label: '7 days' },
            { value: 'month', label: 'This month' },
            { value: 'custom', label: 'Custom' },
          ]}
        />
        {preset === 'custom' && (
          <span className="flex items-center gap-2">
            <Input type="date" value={custom.from} max={custom.to} onChange={(e) => setCustom({ ...custom, from: e.target.value })} className="h-10 w-40" aria-label="From" />
            <span className="text-ink-faint">to</span>
            <Input type="date" value={custom.to} min={custom.from} max={today} onChange={(e) => setCustom({ ...custom, to: e.target.value })} className="h-10 w-40" aria-label="To" />
          </span>
        )}
      </div>
      <div className="px-4 lg:px-8">
        {q.isLoading || !q.data ? (
          <div className="grid place-items-center py-16">
            <Spinner />
          </div>
        ) : tab === 'sales' ? (
          <Sales data={q.data} />
        ) : tab === 'insights' ? (
          <Insights data={q.data} />
        ) : tab === 'vision' ? (
          <VisionAudit data={q.data} />
        ) : tab === 'room-charges' ? (
          <RoomCharges data={q.data} onChanged={() => void q.refetch()} />
        ) : tab === 'gst' ? (
          <Gst data={q.data} />
        ) : tab === 'items' ? (
          <Items data={q.data} />
        ) : (
          <DayEnd data={q.data} />
        )}
      </div>
    </div>
  );
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function Sales({ data }: { data: any }) {
  const t = data.totals;
  const days = useMemo(() => data.by_day.map((d: any) => ({ key: d.date, label: d.date.slice(5), value: d.net_paise / 100, display: formatPaise(d.net_paise) })), [data]);
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Net sales" value={formatPaise(t.net_paise)} sub={`${t.bills} bills`} />
        <Stat label="Average bill" value={formatPaise(t.average_bill_paise)} />
        <Stat label="Discounts" value={formatPaise(t.discount_paise)} sub={`${data.voids.count} voided bills (${formatPaise(data.voids.amount_paise)})`} />
        <Stat label="GST collected" value={formatPaise(t.tax_paise)} sub={`CGST ${formatPaise(t.cgst_paise)} · SGST ${formatPaise(t.sgst_paise)}`} />
      </div>
      {days.length > 1 && (
        <Card className="p-5">
          <ColumnChart title="Net sales by day" data={days} tickFormat={(v) => `₹${new Intl.NumberFormat('en-IN', { notation: 'compact' }).format(v)}`} />
        </Card>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        <Table title="By payment method" head={['Method', 'Payments', 'Received', 'Refunded', 'Net']} rows={data.payments.map((p: any) => [p.method.replace('_', ' '), p.count, formatPaise(p.received_paise), formatPaise(p.refunded_paise), formatPaise(p.net_paise)])} />
        <Table title="By order type" head={['Type', 'Bills', 'Net']} rows={data.by_order_type.map((r: any) => [r.type.replace('_', '-'), r.bills, formatPaise(r.net_paise)])} />
      </div>
      <Table
        title="Totals"
        head={['', 'Amount']}
        rows={[
          ['Gross (menu prices)', formatPaise(t.gross_paise)],
          ['Discounts', `− ${formatPaise(t.discount_paise)}`],
          ['Service charge', formatPaise(t.service_charge_paise)],
          ['Taxable value', formatPaise(t.taxable_paise)],
          ['GST', formatPaise(t.tax_paise)],
          ['Round off', formatPaise(t.round_off_paise)],
          ['Net sales', formatPaise(t.net_paise)],
          ['Still unpaid', formatPaise(t.outstanding_paise)],
        ]}
      />
    </div>
  );
}

function Change({ pct }: { pct: number | null }) {
  if (pct == null) return <span>no earlier data</span>;
  const up = pct >= 0;
  return (
    <span className={cn('inline-flex items-center gap-0.5 font-medium', up ? 'text-emerald-700' : 'text-rose-700')}>
      {up ? <ArrowUpRight className="size-3.5" /> : <ArrowDownRight className="size-3.5" />}
      {Math.abs(pct)}% vs previous period
    </span>
  );
}

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const hourLabel = (h: number) => (h === 0 ? '12a' : h < 12 ? `${h}a` : h === 12 ? '12p' : `${h - 12}p`);

function Heatmap({ cells }: { cells: { dow: number; hour: number; orders: number; revenue_paise: number }[] }) {
  if (!cells.length) return <p className="px-4 py-6 text-sm text-ink-faint">No orders in this period.</p>;
  const hours = cells.map((c) => c.hour);
  const from = Math.min(7, ...hours);
  const to = Math.max(23, ...hours);
  const max = Math.max(...cells.map((c) => c.orders));
  const at = (d: number, h: number) => cells.find((c) => c.dow === d && c.hour === h);
  const span = Array.from({ length: to - from + 1 }, (_, i) => from + i);
  return (
    <div className="overflow-x-auto px-4 pb-4">
      <table className="border-separate border-spacing-[3px] text-[11px]">
        <thead>
          <tr>
            <th />
            {span.map((h) => (
              <th key={h} className="w-7 font-normal text-ink-faint">
                {h % 2 === 0 ? hourLabel(h) : ''}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {DAYS.map((d, di) => (
            <tr key={d}>
              <th className="pr-2 text-left font-medium text-ink-soft">{d}</th>
              {span.map((h) => {
                const c = at(di, h);
                const level = c ? Math.max(0.12, c.orders / max) : 0;
                return (
                  <td
                    key={h}
                    title={c ? `${d} ${hourLabel(h)}: ${c.orders} orders, ${formatPaise(c.revenue_paise)}` : `${d} ${hourLabel(h)}: no orders`}
                    className="h-7 w-7 rounded-md"
                    style={{ background: c ? `color-mix(in oklab, var(--brand) ${Math.round(level * 100)}%, transparent)` : 'var(--color-stone-100, #f5f5f4)' }}
                  />
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Insights({ data }: { data: any }) {
  const h = data.headline;
  const p = data.pilot;
  const maxCat = Math.max(1, ...data.categories.map((c: any) => c.revenue_paise));
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Net sales" value={formatPaise(h.net_paise)} sub={<Change pct={h.change_pct.net} />} />
        <Stat label="Bills" value={h.bills} sub={<Change pct={h.change_pct.bills} />} />
        <Stat label="Average bill" value={formatPaise(h.average_bill_paise)} sub={<Change pct={h.change_pct.average_bill} />} />
        <Stat label="Guests" value={h.covers} sub={<Change pct={h.change_pct.covers} />} />
      </div>

      <Card>
        <div className="flex flex-wrap items-baseline justify-between gap-2 px-4 pt-4 pb-3">
          <h2 className="text-sm font-semibold">Pilot health</h2>
          <p className="text-xs text-ink-faint">{p.orders} orders in this period</p>
        </div>
        <div className="grid grid-cols-2 gap-px overflow-hidden border-t border-line bg-line sm:grid-cols-3 lg:grid-cols-6">
          {[
            ['Ordered by QR', `${p.qr_share_pct}%`],
            ['QR orders rejected', `${p.qr_rejected_pct}%`],
            ['Time to accept QR', p.qr_avg_accept_seconds == null ? '-' : p.qr_avg_accept_seconds < 90 ? `${p.qr_avg_accept_seconds}s` : `${Math.round(p.qr_avg_accept_seconds / 60)} min`],
            ['First orders checked', p.qr_flagged],
            ['Cancelled after kitchen', p.cancelled_after_accept],
            ['Voided bills', p.voided_bills],
          ].map(([label, value]) => (
            <div key={label as string} className="bg-surface px-4 py-3">
              <p className="text-xs text-ink-faint">{label}</p>
              <p className="mt-0.5 text-lg font-semibold tabular">{value}</p>
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <h2 className="px-4 pt-4 pb-3 text-sm font-semibold">When orders come in</h2>
        <Heatmap cells={data.heatmap} />
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="overflow-hidden">
          <h2 className="border-b border-line px-4 py-2.5 text-sm font-semibold">Sales by category</h2>
          {!data.categories.length ? (
            <p className="px-4 py-6 text-sm text-ink-faint">Nothing yet</p>
          ) : (
            <ul className="space-y-2.5 p-4">
              {data.categories.map((c: any) => (
                <li key={c.category} className="text-sm">
                  <div className="mb-1 flex justify-between gap-2">
                    <span>{c.category}</span>
                    <span className="tabular">
                      {formatPaise(c.revenue_paise)} <span className="text-ink-faint">· {c.qty}</span>
                    </span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-stone-100">
                    <div className="h-full rounded-full bg-[var(--brand)]" style={{ width: `${(c.revenue_paise / maxCat) * 100}%` }} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Table
          title="Team"
          head={['Name', 'Orders taken', 'Bills settled', 'Sales', 'Discounts']}
          rows={data.staff.map((s: any) => [s.name, s.orders, s.bills, formatPaise(s.net_paise), formatPaise(s.discount_paise)])}
        />
        <Card className="overflow-hidden">
          <h2 className="border-b border-line px-4 py-2.5 text-sm font-semibold">Tables</h2>
          <div className="grid grid-cols-3 divide-x divide-line border-b border-line text-center">
            {[
              ['Visits', data.tables.visits],
              ['Average stay', data.tables.avg_dwell_minutes == null ? '-' : `${data.tables.avg_dwell_minutes} min`],
              ['Turns / table / day', data.tables.turns_per_table_per_day],
            ].map(([label, value]) => (
              <div key={label as string} className="px-2 py-3">
                <p className="text-xs text-ink-faint">{label}</p>
                <p className="text-lg font-semibold tabular">{value}</p>
              </div>
            ))}
          </div>
          <div className="max-h-64 overflow-y-auto">
            <table className="w-full text-sm">
              <tbody className="divide-y divide-line">
                {data.tables.by_table.map((t: any) => (
                  <tr key={t.label}>
                    <td className="px-4 py-2 font-medium">{t.label}</td>
                    <td className="px-4 py-2 text-right tabular">{t.visits} visits</td>
                    <td className="px-4 py-2 text-right text-ink-faint tabular">{t.avg_dwell_minutes} min</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
        <div className="space-y-4">
          <Table
            title="Discounts by reason"
            head={['Reason', 'Bills', 'Amount']}
            rows={[
              ...data.discounts.by_reason.map((d: any) => [d.reason, d.bills, formatPaise(d.amount_paise)]),
              ...(data.discounts.loyalty.bills ? [['Loyalty points', data.discounts.loyalty.bills, formatPaise(data.discounts.loyalty.amount_paise)]] : []),
            ]}
            empty="No discounts"
          />
          <Table
            title="Customers"
            head={['', '']}
            rows={[
              ['Bills with a known customer', `${data.customers.identified_share_pct}%`],
              ['Customers who came back', `${data.customers.returning} of ${data.customers.distinct}`],
              ['New customers', data.customers.new],
              ['Points earned / used', `${data.customers.points_earned} / ${data.customers.points_redeemed}`],
            ]}
          />
        </div>
      </div>
    </div>
  );
}

function RoomCharges({ data, onChanged }: { data: any; onChanged: () => void }) {
  const { api, outletId, can } = useStaff();
  const toast = useToast();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const canPost = can('payment.reconcile');
  const mark = async (posted: boolean) => {
    setBusy(true);
    try {
      await api('/payments/room-posted', { method: 'POST', body: { outlet_id: outletId, payment_ids: [...picked], posted } });
      toast(posted ? 'Marked as posted to the folios' : 'Marked as not posted');
      setPicked(new Set());
      onChanged();
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  };
  const toggle = (id: string) =>
    setPicked((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const open = data.rows.filter((r: any) => !r.posted_at);
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="To post" value={formatPaise(data.totals.unposted_paise)} sub={`${data.totals.unposted} charge${data.totals.unposted === 1 ? '' : 's'}`} />
        <Stat label="All room charges" value={formatPaise(data.totals.amount_paise)} sub={`${data.totals.charges} in this period`} />
      </div>
      {data.by_room.length > 0 && (
        <Table title="Still to post, by room" head={['Room', 'Amount']} rows={data.by_room.map((r: any) => [r.room_no, formatPaise(r.amount_paise)])} />
      )}
      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
          <h2 className="flex-1 text-sm font-semibold">Room charges</h2>
          {canPost && (
            <>
              <Button size="sm" variant="ghost" onClick={() => setPicked(new Set(open.map((r: any) => r.payment_id)))} disabled={!open.length}>
                Select all not posted
              </Button>
              <Button size="sm" onClick={() => void mark(true)} disabled={!picked.size} loading={busy}>
                Mark posted ({picked.size})
              </Button>
            </>
          )}
        </div>
        {!data.rows.length ? (
          <p className="px-4 py-6 text-sm text-ink-faint">No room charges in this period.</p>
        ) : (
          <ul className="divide-y divide-line">
            {data.rows.map((r: any) => (
              <li key={r.payment_id} className="flex items-start gap-3 px-4 py-3 text-sm">
                {canPost && <input type="checkbox" checked={picked.has(r.payment_id)} onChange={() => toggle(r.payment_id)} className="mt-1.5 size-4 shrink-0 accent-[var(--brand)]" aria-label={`Select room ${r.room_no}`} />}
                <span className="w-14 shrink-0 font-display text-lg leading-7 font-semibold">{r.room_no}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">
                    {r.room_guest ?? 'Guest'} · {r.invoice_no}
                    {r.table_label ? ` · ${r.table_label}` : ''}
                  </span>
                  <span className="block text-xs text-ink-faint">
                    {new Date(r.at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}
                    {r.confirmed_by_name ? ` · ${r.confirmed_by_name}` : ''}
                  </span>
                </span>
                <span className="flex shrink-0 flex-col items-end gap-1">
                  <span className={cn('font-semibold tabular', r.amount_paise < 0 && 'text-rose-700')}>{formatPaise(r.amount_paise)}</span>
                  {r.posted_at ? <Badge tone="green">Posted</Badge> : <Badge tone="amber">Not posted</Badge>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <p className="text-xs text-ink-faint">Refunds appear as negative lines for the same room. Export as CSV for the front desk or the hotel system.</p>
    </div>
  );
}

function VisionAudit({ data }: { data: any }) {
  const pct = data.agreement_pct;
  const ok = pct !== null && pct >= data.target_pct;
  const c = data.confusion;
  const d = data.dwell;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label="Agrees with the till"
          value={pct === null ? '-' : `${pct}%`}
          sub={<span className={ok ? 'text-emerald-700' : 'text-amber-700'}>{pct === null ? 'No readings yet' : `Target ${data.target_pct}%, ${data.readings} readings`}</span>}
        />
        <Stat label="Time to attend" value={d.avg_wait_to_attend_seconds === null ? '-' : `${Math.round(d.avg_wait_to_attend_seconds / 60)} min`} sub="From guests sitting to the table being opened" />
        <Stat label="Average stay (camera)" value={d.avg_minutes === null ? '-' : `${d.avg_minutes} min`} sub={`${d.visits_seen} visits seen`} />
        <Stat label="Sat without an order" value={d.without_order} sub={`${d.without_order_minutes} table-minutes`} />
      </div>
      <Table
        title="Camera against open table visits"
        head={['', 'Visit open', 'No visit']}
        rows={[
          ['Camera saw people', c.occupied_and_open, c.occupied_no_visit],
          ['Camera saw no one', c.missed_open_visit, c.vacant_and_closed],
        ]}
      />
      <Table
        title="By table (weakest first)"
        head={['Table', 'Readings', 'Agreement', 'People, no visit', 'Missed visits']}
        rows={data.tables.map((t: any) => [t.label, t.readings, `${t.agreement_pct}%`, t.false_alarms, t.misses])}
        empty="No readings in this period"
      />
      <p className="text-xs text-ink-faint">
        “People, no visit” is either a camera mistake or guests who sat without ordering; a table with many of them needs its zone redrawn or the camera moved. Readings are sampled when the
        camera&apos;s view changes and every few minutes.
      </p>
    </div>
  );
}

function Gst({ data }: { data: any }) {
  return (
    <div className="space-y-4">
      <Card className="p-4 text-sm">
        Invoices <b>{data.invoices.first ?? '—'}</b> to <b>{data.invoices.last ?? '—'}</b> · {data.invoices.count} issued
        {data.invoices.cancelled.length > 0 && <span className="text-rose-700"> · cancelled: {data.invoices.cancelled.join(', ')}</span>}
      </Card>
      <Table
        title="Tax by rate"
        head={['Rate', 'Kind', 'Taxable', 'CGST', 'SGST', 'Total tax']}
        rows={data.by_rate.map((r: any) => [formatRate(r.tax_rate_bp), r.kind === 'service_charge' ? 'Service charge' : 'Food & beverage', formatPaise(r.taxable_paise), formatPaise(r.cgst_paise), formatPaise(r.sgst_paise), formatPaise(r.cgst_paise + r.sgst_paise)])}
      />
      <Table title="HSN / SAC summary" head={['HSN/SAC', 'Rate', 'Qty', 'Taxable', 'Tax']} rows={data.hsn_summary.map((h: any) => [h.hsn_sac ?? '—', formatRate(h.tax_rate_bp), h.qty, formatPaise(h.taxable_paise), formatPaise(h.tax_paise)])} />
      {data.b2b.length > 0 && (
        <Table title="Business (B2B) invoices" head={['Invoice', 'Date', 'Customer', 'GSTIN', 'Taxable', 'Tax', 'Total']} rows={data.b2b.map((b: any) => [b.invoice_no, b.invoice_date, b.customer_name ?? '', b.customer_gstin, formatPaise(b.taxable_paise), formatPaise(b.tax_paise), formatPaise(b.total_paise)])} />
      )}
      <p className="text-xs text-ink-faint">Check rates and filing with your accountant before submitting returns.</p>
    </div>
  );
}

function Items({ data }: { data: any[] }) {
  return <Table title="Dish sales" head={['Dish', 'Category', 'Qty', 'Orders', 'Revenue']} rows={data.map((i) => [i.name, i.category, i.qty, i.orders, formatPaise(i.revenue_paise)])} />;
}

function DayEnd({ data }: { data: any }) {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Net sales" value={formatPaise(data.sales.net_paise)} sub={`${data.sales.bills} bills`} />
        <Stat label="Cash expected in drawer" value={formatPaise(data.expected_cash_paise)} />
        <Stat label="Open bills" value={data.open_bills.count} sub={formatPaise(data.open_bills.balance_paise)} />
        <Stat label="Voids" value={data.voids.length} />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Table title="Payments" head={['Method', 'Net']} rows={data.payments.map((p: any) => [p.method.replace('_', ' '), formatPaise(p.net_paise)])} />
        <Table title="Tax" head={['Rate', 'Taxable', 'CGST', 'SGST']} rows={data.tax.map((r: any) => [`${formatRate(r.tax_rate_bp)}${r.kind === 'service_charge' ? ' (SC)' : ''}`, formatPaise(r.taxable_paise), formatPaise(r.cgst_paise), formatPaise(r.sgst_paise)])} />
        <Table title="Voided bills" head={['Invoice', 'Amount', 'Reason', 'By']} rows={data.voids.map((v: any) => [v.invoice_no, formatPaise(v.total_paise), v.reason ?? '', v.voided_by ?? ''])} empty="No voids" />
        <Table title="Discounts" head={['Invoice', 'Amount', 'Reason']} rows={data.discounts.map((d: any) => [d.invoice_no, formatPaise(d.discount_paise), d.reason ?? ''])} empty="No discounts" />
        <Table title="Refunds" head={['Invoice', 'Method', 'Amount', 'Reason']} rows={data.refunds.map((r: any) => [r.invoice_no, r.method, formatPaise(r.amount_paise), r.reason ?? ''])} empty="No refunds" />
        <Table title="Orders" head={['Status', 'Count']} rows={Object.entries(data.orders_by_status).map(([k, v]) => [k, String(v)])} />
        <Table
          title="Never billed"
          head={['Table', 'Ordered', 'Amount', 'Now']}
          rows={data.unbilled_orders.map((u: any) => [u.table_label ?? u.type, dateTime(u.placed_at), formatPaise(u.amount_paise), u.table_open ? 'Table still open' : 'Table cleared, no bill'])}
          empty="Everything served was billed"
        />
      </div>
      <p className="text-sm text-ink-faint">
        Invoices {data.invoices.first ?? '—'} to {data.invoices.last ?? '—'} ({data.invoices.count})
      </p>
    </div>
  );
}

function Table({ title, head, rows, empty = 'Nothing yet' }: { title: string; head: string[]; rows: (string | number)[][]; empty?: string }) {
  return (
    <Card className="overflow-hidden">
      <h2 className="border-b border-line px-4 py-2.5 text-sm font-semibold">{title}</h2>
      {rows.length === 0 ? (
        <p className="px-4 py-6 text-sm text-ink-faint">{empty}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-ink-faint">
              <tr>
                {head.map((h, i) => (
                  <th key={h + i} className={`px-4 py-2 font-medium ${i > 0 ? 'text-right' : ''}`}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((r, i) => (
                <tr key={i}>
                  {r.map((c, j) => (
                    <td key={j} className={`px-4 py-2 capitalize-first ${j > 0 ? 'text-right tabular' : ''}`}>
                      {c}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

'use client';

import { useQuery } from '@tanstack/react-query';
import { Banknote, Bike, CreditCard, Landmark, ShieldAlert, Smartphone, Wallet } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { date, dateTime, formatPaise } from '@/lib/format';
import { useStaff } from '@/lib/staff';
import { Card, Spinner, Stat } from '@/components/ui/primitives';
import { ColumnChart } from '@/components/staff/column-chart';
import { homeFor, PageHeader } from '@/components/staff/shell';
import { TABLE_STATE } from '@/components/staff/table-state';
import type { UpiCheckDTO } from '@dineos/shared/dto';
import type { TableState } from '@dineos/shared/enums';

interface Dashboard {
  date: string;
  net_sales_paise: number;
  bills: number;
  average_bill_paise: number;
  orders: number;
  qr_order_share: number;
  open_bills: number;
  active_orders: Record<string, number>;
  tables: Partial<Record<TableState, number>>;
  payments: { method: string; net_paise: number; count: number }[];
  timing: { avg_serve_minutes: number | null; avg_kitchen_minutes: number | null };
  top_items: { item_id: string; name: string; qty: number; revenue_paise: number }[];
  hourly: { hour: number; net_paise: number }[];
}

const METHOD = { cash: { label: 'Cash', icon: Banknote }, upi: { label: 'UPI', icon: Smartphone }, card_slip: { label: 'Card', icon: CreditCard }, other: { label: 'Other', icon: Wallet }, platform: { label: 'Delivery app', icon: Bike } } as const;

export default function DashboardPage() {
  const { api, outletId, outlet, can } = useStaff();
  const router = useRouter();
  const allowed = can('report.view');
  useEffect(() => {
    if (!allowed) router.replace(homeFor(can));
  }, [allowed, can, router]);

  const { data: d } = useQuery({
    queryKey: ['dashboard', outletId],
    enabled: allowed,
    queryFn: () => api<Dashboard>(`/reports/dashboard?outlet_id=${outletId}`),
    refetchInterval: 60_000,
  });

  if (!allowed) return null;
  if (!d) {
    return (
      <div className="grid place-items-center py-24">
        <Spinner />
      </div>
    );
  }

  const hours = Array.from({ length: 18 }, (_, i) => i + 7); // 7 am to midnight
  const active = Object.values(d.active_orders).reduce((a, b) => a + b, 0);
  const paymentsTotal = d.payments.reduce((a, p) => a + p.net_paise, 0);
  const occupied = (d.tables.occupied ?? 0) + (d.tables.ordered ?? 0) + (d.tables.served ?? 0) + (d.tables.bill_requested ?? 0);
  const totalTables = Object.values(d.tables).reduce((a, b) => a + (b ?? 0), 0);

  return (
    <div className="pb-12">
      <PageHeader title="Today" subtitle={`${outlet?.name ?? ''} · ${new Date(d.date).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })}`} />
      <div className="space-y-4 px-4 lg:px-8">
        <Card className="grid gap-6 p-5 lg:grid-cols-[minmax(240px,1fr)_2fr]">
          <div>
            <p className="text-sm font-medium text-ink-faint">Net sales</p>
            <p className="mt-1 text-5xl font-semibold tracking-tight text-ink">{formatPaise(d.net_sales_paise)}</p>
            <p className="mt-2 text-sm text-ink-soft">
              {d.bills} bills · average {formatPaise(d.average_bill_paise)}
            </p>
          </div>
          {d.hourly.some((x) => x.net_paise > 0) ? (
            <ColumnChart
              title="Sales by hour"
              data={hours.map((h) => {
                const v = d.hourly.find((x) => x.hour === h)?.net_paise ?? 0;
                const label = h === 12 ? '12p' : h > 12 ? `${h - 12}p` : h === 24 ? '12a' : `${h}a`;
                return { key: String(h), label, value: v / 100, display: formatPaise(v) };
              })}
              tickFormat={(v) => `₹${new Intl.NumberFormat('en-IN', { notation: 'compact' }).format(v)}`}
            />
          ) : (
            <div className="grid min-h-40 place-items-center rounded-xl border border-dashed border-line text-sm text-ink-faint">Sales by hour appear after the first bill is paid.</div>
          )}
        </Card>

        {can('payment.reconcile') && <UpiCheckCard />}

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Orders" value={d.orders} sub={`${Math.round(d.qr_order_share * 100)}% from guest phones (goal 60%)`} />
          <Stat label="In progress" value={active} sub={`${d.active_orders.placed ?? 0} waiting for approval`} />
          <Stat label="Tables in use" value={`${occupied}/${totalTables}`} sub={`${d.tables.needs_cleaning ?? 0} need cleaning`} />
          <Stat label="Avg time to serve" value={d.timing.avg_serve_minutes != null ? `${d.timing.avg_serve_minutes} min` : '—'} sub={`${d.open_bills} ${d.open_bills === 1 ? 'bill' : 'bills'} open`} />
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <Card className="p-5">
            <h2 className="mb-3 text-sm font-semibold">Payments</h2>
            {d.payments.length === 0 ? (
              <p className="text-sm text-ink-faint">No payments yet today.</p>
            ) : (
              <ul className="space-y-3">
                {d.payments.map((p) => {
                  const m = METHOD[p.method as keyof typeof METHOD] ?? METHOD.other;
                  return (
                    <li key={p.method}>
                      <div className="flex items-center justify-between text-sm">
                        <span className="flex items-center gap-2 text-ink-soft">
                          <m.icon className="size-4" /> {m.label} <span className="text-xs text-ink-faint">({p.count})</span>
                        </span>
                        <span className="font-semibold tabular">{formatPaise(p.net_paise)}</span>
                      </div>
                      <div className="mt-1.5 h-2 rounded-full bg-stone-100">
                        <div className="h-2 rounded-full bg-brand-500" style={{ width: `${paymentsTotal ? (p.net_paise / paymentsTotal) * 100 : 0}%` }} />
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
          <Card className="p-5">
            <h2 className="mb-3 text-sm font-semibold">Top dishes</h2>
            {d.top_items.length === 0 ? (
              <p className="text-sm text-ink-faint">No orders yet today.</p>
            ) : (
              <ol className="divide-y divide-line">
                {d.top_items.map((i, n) => (
                  <li key={i.item_id} className="flex items-center gap-3 py-2 text-sm">
                    <span className="w-5 text-ink-faint tabular">{n + 1}</span>
                    <span className="flex-1">{i.name}</span>
                    <span className="text-ink-faint tabular">{i.qty} sold</span>
                    <span className="w-24 text-right font-medium tabular">{formatPaise(i.revenue_paise)}</span>
                  </li>
                ))}
              </ol>
            )}
          </Card>
        </div>

        <Card className="p-5">
          <h2 className="mb-3 text-sm font-semibold">Floor right now</h2>
          <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
            {(Object.keys(TABLE_STATE) as TableState[]).map((s) => (
              <span key={s} className="flex items-center gap-2">
                <span className={`size-2.5 rounded-full ${TABLE_STATE[s].dot}`} />
                <span className="text-ink-soft">{TABLE_STATE[s].label}</span>
                <span className="font-semibold tabular">{d.tables[s] ?? 0}</span>
              </span>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}

/** UPI is confirmed by looking at the guest's phone, so the bank statement is the real check. */
function UpiCheckCard() {
  const { api, outletId } = useStaff();
  const { data: c } = useQuery({
    queryKey: ['upi-check', outletId],
    queryFn: () => api<UpiCheckDTO>(`/reconciliation/upi-check?outlet_id=${outletId}`),
    refetchInterval: 10 * 60_000,
  });
  if (!c || (c.not_received.count === 0 && c.unchecked.count === 0)) return null;
  return (
    <div className="space-y-3">
      {c.not_received.count > 0 && (
        <Card className="border-rose-200 bg-rose-50 p-5 text-rose-900">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="flex items-center gap-2 font-semibold">
              <ShieldAlert className="size-4" /> {c.not_received.count} UPI {c.not_received.count === 1 ? 'payment' : 'payments'} ({formatPaise(c.not_received.amount_paise)}) never reached your bank
            </p>
            <Link href="/app/reconcile" className="inline-flex items-center gap-1.5 text-sm font-medium underline underline-offset-2">
              <Landmark className="size-4" /> Open the UPI check
            </Link>
          </div>
          <ul className="mt-3 space-y-1 text-sm">
            {c.not_received.payments.slice(0, 5).map((p) => (
              <li key={p.id} className="flex flex-wrap justify-between gap-x-3">
                <span>
                  {p.invoice_no ?? 'Bill'}
                  {p.table_label && ` · ${p.table_label}`} · {dateTime(p.created_at)}
                  {p.confirmed_by_name && ` · confirmed by ${p.confirmed_by_name}`}
                </span>
                <span className="font-semibold tabular">{formatPaise(p.amount_paise)}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {c.unchecked.count > 0 && (
        <Card className="flex flex-wrap items-center justify-between gap-3 border-amber-200 bg-amber-50 p-5 text-amber-900">
          <p className="text-sm">
            <span className="font-semibold">
              {c.unchecked.count} UPI {c.unchecked.count === 1 ? 'payment' : 'payments'} ({formatPaise(c.unchecked.amount_paise)})
            </span>{' '}
            since {date(c.unchecked.oldest_day!)} {c.unchecked.count === 1 ? 'is' : 'are'} not checked against the bank yet.
          </p>
          <Link href="/app/reconcile" className="inline-flex h-10 items-center gap-1.5 rounded-xl bg-amber-900 px-3.5 text-sm font-medium text-white transition active:scale-[0.97]">
            <Landmark className="size-4" /> Import bank statement
          </Link>
        </Card>
      )}
    </div>
  );
}

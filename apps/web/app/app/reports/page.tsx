'use client';

import { useQuery } from '@tanstack/react-query';
import { Download, Printer } from 'lucide-react';
import { useMemo, useState } from 'react';
import { apiBlobUrl, errorMessage } from '@/lib/api';
import { formatPaise, formatRate, todayIst } from '@/lib/format';
import { useStaff } from '@/lib/staff';
import { Button } from '@/components/ui/button';
import { Card, Input, Segmented, Spinner, Stat } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/toast';
import { ColumnChart } from '@/components/staff/column-chart';
import { Forbidden, PageHeader } from '@/components/staff/shell';

type Tab = 'sales' | 'gst' | 'items' | 'day-end';
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
  const { api, outletId, can, token } = useStaff();
  const toast = useToast();
  const today = todayIst();
  const [tab, setTab] = useState<Tab>('sales');
  const [preset, setPreset] = useState<Preset>('today');
  const [custom, setCustom] = useState({ from: today, to: today });
  const range = preset === 'custom' ? custom : presetRange(preset, today);
  const qs = `outlet_id=${outletId}&from=${range.from}&to=${range.to}`;

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
            {tab !== 'day-end' ? (
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
        <Segmented value={tab} onChange={setTab} options={[{ value: 'sales', label: 'Sales' }, { value: 'gst', label: 'GST' }, { value: 'items', label: 'Dishes' }, { value: 'day-end', label: 'Day end' }]} />
        <Segmented
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

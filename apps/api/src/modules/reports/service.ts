// Reports (spec §7 dashboards, §8 day-end). Sales and GST follow invoice dates of finalised bills;
// payments follow the outlet-local date they were taken; item sales follow the order's business date.

import { DELIVERY_CHANNELS, type DeliveryChannel } from '@dineos/shared/enums';
import { sql } from 'kysely';
import type { Tx } from '../../context';

export interface Range {
  outletId: string;
  from: string;
  to: string;
  timezone: string;
}

const LIVE = ['finalised', 'paid'] as const;
const n = (v: unknown) => Number(v ?? 0);

export async function salesSummary(tx: Tx, r: Range) {
  const totals = await tx.db
    .selectFrom('bills')
    .select((eb) => [
      eb.fn.countAll<number>().as('bills'),
      eb.fn.sum<number>('subtotal_paise').as('gross_paise'),
      eb.fn.sum<number>('item_discount_paise').as('item_discount_paise'),
      eb.fn.sum<number>('bill_discount_paise').as('bill_discount_paise'),
      eb.fn.sum<number>('loyalty_discount_paise').as('loyalty_discount_paise'),
      eb.fn.sum<number>('service_charge_paise').as('service_charge_paise'),
      eb.fn.sum<number>('taxable_paise').as('taxable_paise'),
      eb.fn.sum<number>('cgst_paise').as('cgst_paise'),
      eb.fn.sum<number>('sgst_paise').as('sgst_paise'),
      eb.fn.sum<number>('tax_total_paise').as('tax_paise'),
      eb.fn.sum<number>('round_off_paise').as('round_off_paise'),
      eb.fn.sum<number>('total_paise').as('net_paise'),
      eb.fn.sum<number>(sql`total_paise - paid_paise`).as('outstanding_paise'),
    ])
    .where('outlet_id', '=', r.outletId)
    .where('status', 'in', LIVE)
    .where('invoice_date', '>=', r.from)
    .where('invoice_date', '<=', r.to)
    .executeTakeFirstOrThrow();

  // Free (complimentary) dishes are part of the item discounts; reported apart.
  const free = await tx.db
    .selectFrom('bill_lines')
    .innerJoin('bills', 'bills.id', 'bill_lines.bill_id')
    .select((eb) => eb.fn.sum<number>('bill_lines.comp_paise').as('comp_paise'))
    .where('bills.outlet_id', '=', r.outletId)
    .where('bills.status', 'in', LIVE)
    .where('bills.invoice_date', '>=', r.from)
    .where('bills.invoice_date', '<=', r.to)
    .executeTakeFirstOrThrow();

  const byDay = await tx.db
    .selectFrom('bills')
    .select((eb) => ['invoice_date', eb.fn.countAll<number>().as('bills'), eb.fn.sum<number>('total_paise').as('net_paise')])
    .where('outlet_id', '=', r.outletId)
    .where('status', 'in', LIVE)
    .where('invoice_date', '>=', r.from)
    .where('invoice_date', '<=', r.to)
    .groupBy('invoice_date')
    .orderBy('invoice_date')
    .execute();

  const byType = await tx.db
    .selectFrom('bills')
    .leftJoin('orders', 'orders.id', 'bills.order_id')
    .select((eb) => [
      sql<string>`case when bills.membership_id is not null then 'membership' when bills.table_session_id is not null then 'dine_in' else coalesce(orders.type, 'counter') end`.as('type'),
      eb.fn.countAll<number>().as('bills'),
      eb.fn.sum<number>('bills.total_paise').as('net_paise'),
    ])
    .where('bills.outlet_id', '=', r.outletId)
    .where('bills.status', 'in', LIVE)
    .where('bills.invoice_date', '>=', r.from)
    .where('bills.invoice_date', '<=', r.to)
    .groupBy(sql`1`)
    .execute();

  const payments = await paymentsByMethod(tx, r);
  const walletTopups = await paymentsByMethod(tx, r, 'wallet_topups');

  const voids = await tx.db
    .selectFrom('bills')
    .select((eb) => [eb.fn.countAll<number>().as('count'), eb.fn.sum<number>('total_paise').as('amount_paise')])
    .where('outlet_id', '=', r.outletId)
    .where('status', '=', 'void')
    .where(sql<string>`(voided_at at time zone ${r.timezone})::date`, '>=', r.from)
    .where(sql<string>`(voided_at at time zone ${r.timezone})::date`, '<=', r.to)
    .executeTakeFirstOrThrow();

  const timing = await tx.db
    .selectFrom('orders')
    .select([
      sql<number>`round(avg(extract(epoch from (served_at - placed_at)) / 60)::numeric, 1)`.as('avg_serve_minutes'),
      sql<number>`round(avg(extract(epoch from (ready_at - accepted_at)) / 60)::numeric, 1)`.as('avg_kitchen_minutes'),
    ])
    .where('outlet_id', '=', r.outletId)
    .where('business_date', '>=', r.from)
    .where('business_date', '<=', r.to)
    .where('served_at', 'is not', null)
    .executeTakeFirstOrThrow();

  const bills = n(totals.bills);
  return {
    from: r.from,
    to: r.to,
    totals: {
      bills,
      gross_paise: n(totals.gross_paise),
      // Loyalty, reward and member money off is a discount too (kept apart on the bill).
      discount_paise: n(totals.item_discount_paise) + n(totals.bill_discount_paise) + n(totals.loyalty_discount_paise) - n(free.comp_paise),
      loyalty_discount_paise: n(totals.loyalty_discount_paise),
      complimentary_paise: n(free.comp_paise),
      service_charge_paise: n(totals.service_charge_paise),
      taxable_paise: n(totals.taxable_paise),
      cgst_paise: n(totals.cgst_paise),
      sgst_paise: n(totals.sgst_paise),
      tax_paise: n(totals.tax_paise),
      round_off_paise: n(totals.round_off_paise),
      net_paise: n(totals.net_paise),
      outstanding_paise: n(totals.outstanding_paise),
      average_bill_paise: bills ? Math.round(n(totals.net_paise) / bills) : 0,
    },
    by_day: byDay.map((d) => ({ date: d.invoice_date!, bills: n(d.bills), net_paise: n(d.net_paise) })),
    by_order_type: byType.map((d) => ({ type: d.type, bills: n(d.bills), net_paise: n(d.net_paise) })),
    payments,
    /** Money paid into guests' wallets: not sales (no invoice), but in the drawer and the bank. */
    wallet_topups: walletTopups,
    voids: { count: n(voids.count), amount_paise: n(voids.amount_paise) },
    timing: {
      avg_serve_minutes: timing.avg_serve_minutes == null ? null : n(timing.avg_serve_minutes),
      avg_kitchen_minutes: timing.avg_kitchen_minutes == null ? null : n(timing.avg_kitchen_minutes),
    },
  };
}

/** Bill payments by method, or (with 'wallet_topups') money paid into wallets. */
export async function paymentsByMethod(tx: Tx, r: Range, of: 'bills' | 'wallet_topups' = 'bills') {
  const rows = await tx.db
    .selectFrom('payments')
    .select((eb) => [
      'method',
      eb.fn.sum<number>(sql`case when kind = 'payment' then amount_paise else 0 end`).as('received_paise'),
      eb.fn.sum<number>(sql`case when kind = 'refund' then amount_paise else 0 end`).as('refunded_paise'),
      eb.fn.countAll<number>().as('count'),
    ])
    .where('outlet_id', '=', r.outletId)
    .where(of === 'bills' ? 'bill_id' : 'wallet_topup_id', 'is not', null)
    .where(sql<string>`(created_at at time zone ${r.timezone})::date`, '>=', r.from)
    .where(sql<string>`(created_at at time zone ${r.timezone})::date`, '<=', r.to)
    .groupBy('method')
    .orderBy('method')
    .execute();
  return rows.map((p) => ({
    method: p.method,
    count: n(p.count),
    received_paise: n(p.received_paise),
    refunded_paise: n(p.refunded_paise),
    net_paise: n(p.received_paise) - n(p.refunded_paise),
  }));
}

export async function gstReport(tx: Tx, r: Range) {
  const byRate = await tx.db
    .selectFrom('bill_lines')
    .innerJoin('bills', 'bills.id', 'bill_lines.bill_id')
    .select((eb) => [
      'bill_lines.tax_rate_bp',
      eb.fn.sum<number>('bill_lines.taxable_paise').as('taxable_paise'),
      eb.fn.sum<number>('bill_lines.cgst_paise').as('cgst_paise'),
      eb.fn.sum<number>('bill_lines.sgst_paise').as('sgst_paise'),
    ])
    .where('bills.outlet_id', '=', r.outletId)
    .where('bills.status', 'in', LIVE)
    .where('bills.invoice_date', '>=', r.from)
    .where('bills.invoice_date', '<=', r.to)
    // Zomato and Swiggy pay the GST on their orders (s. 9(5)); those are listed apart below.
    .where('bills.tax_by_operator', '=', false)
    .groupBy('bill_lines.tax_rate_bp')
    .orderBy('bill_lines.tax_rate_bp')
    .execute();

  // Service charge is taxed separately; its tax is the bill total minus the lines' tax.
  const sc = await tx.db
    .selectFrom('bills')
    .select((eb) => [
      'service_charge_tax_rate_bp',
      eb.fn.sum<number>('service_charge_paise').as('taxable_paise'),
      eb.fn
        .sum<number>(sql`cgst_paise - (select coalesce(sum(cgst_paise), 0) from bill_lines where bill_lines.bill_id = bills.id)`)
        .as('cgst_paise'),
      eb.fn
        .sum<number>(sql`sgst_paise - (select coalesce(sum(sgst_paise), 0) from bill_lines where bill_lines.bill_id = bills.id)`)
        .as('sgst_paise'),
    ])
    .where('outlet_id', '=', r.outletId)
    .where('status', 'in', LIVE)
    .where('invoice_date', '>=', r.from)
    .where('invoice_date', '<=', r.to)
    .where('service_charge_paise', '>', 0)
    .groupBy('service_charge_tax_rate_bp')
    .execute();

  const hsn = await tx.db
    .selectFrom('bill_lines')
    .innerJoin('bills', 'bills.id', 'bill_lines.bill_id')
    .select((eb) => [
      sql<string>`coalesce(bill_lines.hsn_sac, '')`.as('hsn_sac'),
      'bill_lines.tax_rate_bp',
      eb.fn.sum<number>('bill_lines.qty').as('qty'),
      eb.fn.sum<number>('bill_lines.taxable_paise').as('taxable_paise'),
      eb.fn.sum<number>(sql`bill_lines.cgst_paise + bill_lines.sgst_paise`).as('tax_paise'),
    ])
    .where('bills.outlet_id', '=', r.outletId)
    .where('bills.status', 'in', LIVE)
    .where('bills.invoice_date', '>=', r.from)
    .where('bills.invoice_date', '<=', r.to)
    .where('bills.tax_by_operator', '=', false)
    .groupBy([sql`1`, 'bill_lines.tax_rate_bp'])
    .orderBy(sql`1`)
    .execute();

  const invoices = await tx.db
    .selectFrom('bills')
    .select(['invoice_no', 'invoice_seq', 'invoice_series', 'fy_code', 'status', 'invoice_date', 'total_paise', 'taxable_paise', 'tax_total_paise', 'customer_name', 'customer_gstin', 'tax_by_operator'])
    .where('outlet_id', '=', r.outletId)
    .where('invoice_no', 'is not', null)
    .where('invoice_date', '>=', r.from)
    .where('invoice_date', '<=', r.to)
    .orderBy('fy_code')
    .orderBy('invoice_seq')
    .execute();
  // Bills printed by the outlet hub during an outage have their own series (GST allows several).
  const series = (['main', 'hub'] as const)
    .map((name) => {
      const list = invoices.filter((i) => i.invoice_series === name);
      return { series: name, count: list.length, first: list[0]?.invoice_no ?? null, last: list.at(-1)?.invoice_no ?? null, cancelled: list.filter((i) => i.status === 'void').map((i) => i.invoice_no) };
    })
    .filter((x) => x.count > 0);
  const main = invoices.filter((i) => i.invoice_series === 'main');
  // Sales through Zomato and Swiggy, on which the platform pays the GST: reported apart in GSTR-1.
  const operator = await tx.db
    .selectFrom('bills')
    .innerJoin('orders', 'orders.id', 'bills.order_id')
    .select((eb) => ['orders.channel', eb.fn.countAll<number>().as('bills'), eb.fn.sum<number>('bills.taxable_paise').as('value_paise')])
    .where('bills.outlet_id', '=', r.outletId)
    .where('bills.status', 'in', LIVE)
    .where('bills.invoice_date', '>=', r.from)
    .where('bills.invoice_date', '<=', r.to)
    .where('bills.tax_by_operator', '=', true)
    .groupBy('orders.channel')
    .orderBy('orders.channel')
    .execute();

  return {
    from: r.from,
    to: r.to,
    operator_supplies: operator.map((o) => ({ channel: o.channel as DeliveryChannel, bills: n(o.bills), value_paise: n(o.value_paise) })),
    by_rate: [
      ...byRate.map((x) => ({ kind: 'items' as const, tax_rate_bp: x.tax_rate_bp, taxable_paise: n(x.taxable_paise), cgst_paise: n(x.cgst_paise), sgst_paise: n(x.sgst_paise) })),
      ...sc.map((x) => ({ kind: 'service_charge' as const, tax_rate_bp: x.service_charge_tax_rate_bp, taxable_paise: n(x.taxable_paise), cgst_paise: n(x.cgst_paise), sgst_paise: n(x.sgst_paise) })),
    ],
    hsn_summary: hsn.map((h) => ({ hsn_sac: h.hsn_sac || null, tax_rate_bp: h.tax_rate_bp, qty: n(h.qty), taxable_paise: n(h.taxable_paise), tax_paise: n(h.tax_paise) })),
    invoices: {
      count: main.length,
      first: main[0]?.invoice_no ?? null,
      last: main.at(-1)?.invoice_no ?? null,
      cancelled: main.filter((i) => i.status === 'void').map((i) => i.invoice_no),
      series,
    },
    b2b: invoices
      .filter((i) => i.customer_gstin && i.status !== 'void' && !i.tax_by_operator)
      .map((i) => ({
        invoice_no: i.invoice_no,
        invoice_date: i.invoice_date,
        customer_name: i.customer_name,
        customer_gstin: i.customer_gstin,
        taxable_paise: i.taxable_paise,
        tax_paise: i.tax_total_paise,
        total_paise: i.total_paise,
      })),
  };
}

export async function itemSales(tx: Tx, r: Range, limit = 500) {
  const rows = await tx.db
    .selectFrom('order_items')
    .innerJoin('orders', 'orders.id', 'order_items.order_id')
    .innerJoin('menu_items', 'menu_items.id', 'order_items.item_id')
    .innerJoin('menu_categories', 'menu_categories.id', 'menu_items.category_id')
    .select((eb) => [
      'order_items.item_id',
      'menu_items.name',
      'menu_categories.name as category',
      eb.fn.sum<number>('order_items.qty').as('qty'),
      eb.fn.sum<number>(eb('order_items.qty', '*', eb.ref('order_items.unit_price_paise'))).as('revenue_paise'),
      eb.fn.count<number>('orders.id').distinct().as('orders'),
    ])
    .where('orders.outlet_id', '=', r.outletId)
    .where('orders.business_date', '>=', r.from)
    .where('orders.business_date', '<=', r.to)
    .where('orders.status', 'not in', ['placed', 'rejected', 'cancelled'])
    .where('order_items.status', '<>', 'cancelled')
    .groupBy(['order_items.item_id', 'menu_items.name', 'menu_categories.name'])
    .orderBy('revenue_paise', 'desc')
    .limit(limit)
    .execute();
  return rows.map((x) => ({
    item_id: x.item_id,
    name: x.name,
    category: x.category,
    qty: n(x.qty),
    orders: n(x.orders),
    revenue_paise: n(x.revenue_paise),
  }));
}

export async function dayEnd(tx: Tx, r: Range) {
  const sales = await salesSummary(tx, r);
  const gst = await gstReport(tx, r);
  const voided = await tx.db
    .selectFrom('bills')
    .leftJoin('users', 'users.id', 'bills.voided_by')
    .select(['bills.invoice_no', 'bills.total_paise', 'bills.void_reason', 'users.name as voided_by'])
    .where('bills.outlet_id', '=', r.outletId)
    .where('bills.status', '=', 'void')
    .where(sql<string>`(bills.voided_at at time zone ${r.timezone})::date`, '>=', r.from)
    .where(sql<string>`(bills.voided_at at time zone ${r.timezone})::date`, '<=', r.to)
    .execute();
  const discounted = await tx.db
    .selectFrom('bills')
    .select(['invoice_no', 'discount_reason', 'loyalty_discount_paise', sql<number>`item_discount_paise + bill_discount_paise + loyalty_discount_paise`.as('discount_paise')])
    .where('outlet_id', '=', r.outletId)
    .where('status', 'in', LIVE)
    .where('invoice_date', '>=', r.from)
    .where('invoice_date', '<=', r.to)
    .where(sql<boolean>`item_discount_paise + bill_discount_paise + loyalty_discount_paise > 0`)
    .execute();
  const refunds = await tx.db
    .selectFrom('payments')
    .innerJoin('bills', 'bills.id', 'payments.bill_id')
    .select(['bills.invoice_no', 'payments.method', 'payments.amount_paise', 'payments.reason'])
    .where('payments.outlet_id', '=', r.outletId)
    .where('payments.kind', '=', 'refund')
    .where(sql<string>`(payments.created_at at time zone ${r.timezone})::date`, '>=', r.from)
    .where(sql<string>`(payments.created_at at time zone ${r.timezone})::date`, '<=', r.to)
    .execute();
  const orders = await tx.db
    .selectFrom('orders')
    .select((eb) => ['status', eb.fn.countAll<number>().as('count')])
    .where('outlet_id', '=', r.outletId)
    .where('business_date', '>=', r.from)
    .where('business_date', '<=', r.to)
    .groupBy('status')
    .execute();
  const openBills = await tx.db
    .selectFrom('bills')
    .select((eb) => [eb.fn.countAll<number>().as('count'), eb.fn.sum<number>(sql`total_paise - paid_paise`).as('balance_paise')])
    .where('outlet_id', '=', r.outletId)
    .where('status', '=', 'finalised')
    .executeTakeFirstOrThrow();
  // Food the kitchen accepted that never reached a bill: a table still eating, a forgotten bill,
  // or a walkout when the table has already been cleared.
  const unbilled = await tx.db
    .selectFrom('orders')
    .innerJoin('order_items', 'order_items.order_id', 'orders.id')
    .leftJoin('table_sessions', 'table_sessions.id', 'orders.table_session_id')
    .leftJoin('tables', 'tables.id', 'table_sessions.table_id')
    .select((eb) => [
      'orders.id',
      'orders.type',
      'orders.placed_at',
      'tables.label',
      'table_sessions.status as session_status',
      eb.fn.sum<number>(eb('order_items.qty', '*', eb.ref('order_items.unit_price_paise'))).as('amount_paise'),
    ])
    .where('orders.outlet_id', '=', r.outletId)
    .where('orders.business_date', '>=', r.from)
    .where('orders.business_date', '<=', r.to)
    .where('orders.status', 'in', ['accepted', 'preparing', 'ready', 'served'])
    .where('order_items.status', '<>', 'cancelled')
    .groupBy(['orders.id', 'orders.type', 'orders.placed_at', 'tables.label', 'table_sessions.status'])
    .orderBy('orders.placed_at')
    .execute();
  const cash = sales.payments.find((p) => p.method === 'cash');
  const topupCash = sales.wallet_topups.find((p) => p.method === 'cash');
  return {
    date: r.from === r.to ? r.from : null,
    from: r.from,
    to: r.to,
    sales: sales.totals,
    payments: sales.payments,
    wallet_topups: sales.wallet_topups,
    // The drawer holds bill cash and cash paid into wallets.
    expected_cash_paise: (cash?.net_paise ?? 0) + (topupCash?.net_paise ?? 0),
    tax: gst.by_rate,
    invoices: gst.invoices,
    voids: voided.map((v) => ({ invoice_no: v.invoice_no, total_paise: v.total_paise, reason: v.void_reason, voided_by: v.voided_by })),
    discounts: discounted.map((d) => ({ invoice_no: d.invoice_no, discount_paise: n(d.discount_paise), reason: d.discount_reason ?? (d.loyalty_discount_paise > 0 ? 'Loyalty or membership' : null) })),
    refunds: refunds.map((x) => ({ invoice_no: x.invoice_no, method: x.method, amount_paise: x.amount_paise, reason: x.reason })),
    orders_by_status: Object.fromEntries(orders.map((o) => [o.status, n(o.count)])),
    open_bills: { count: n(openBills.count), balance_paise: n(openBills.balance_paise) },
    unbilled_orders: unbilled.map((u) => ({
      order_id: u.id,
      type: u.type,
      placed_at: u.placed_at.toISOString(),
      table_label: u.label,
      table_open: u.session_status != null && u.session_status !== 'closed',
      amount_paise: n(u.amount_paise),
    })),
    top_items: (await itemSales(tx, r, 10)),
  };
}

export async function dashboard(tx: Tx, r: Range) {
  const sales = await salesSummary(tx, r);
  const active = await tx.db
    .selectFrom('orders')
    .select((eb) => ['status', eb.fn.countAll<number>().as('count')])
    .where('outlet_id', '=', r.outletId)
    .where('status', 'in', ['placed', 'accepted', 'preparing', 'ready'])
    .groupBy('status')
    .execute();
  const tables = await tx.db
    .selectFrom('tables')
    .select((eb) => ['state', eb.fn.countAll<number>().as('count')])
    .where('outlet_id', '=', r.outletId)
    .where('is_active', '=', true)
    .groupBy('state')
    .execute();
  const drafts = await tx.db
    .selectFrom('bills')
    .select((eb) => eb.fn.countAll<number>().as('count'))
    .where('outlet_id', '=', r.outletId)
    .where('status', 'in', ['draft', 'finalised'])
    .executeTakeFirstOrThrow();
  const orderCount = await tx.db
    .selectFrom('orders')
    .select((eb) => [eb.fn.countAll<number>().as('count'), eb.fn.sum<number>(sql`case when source = 'guest_qr' then 1 else 0 end`).as('qr')])
    .where('outlet_id', '=', r.outletId)
    .where('business_date', '>=', r.from)
    .where('business_date', '<=', r.to)
    .where('status', 'not in', ['rejected'])
    .executeTakeFirstOrThrow();
  const hourly = await tx.db
    .selectFrom('bills')
    .select((eb) => [
      sql<number>`extract(hour from finalised_at at time zone ${r.timezone})::int`.as('hour'),
      eb.fn.sum<number>('total_paise').as('net_paise'),
    ])
    .where('outlet_id', '=', r.outletId)
    .where('status', 'in', LIVE)
    .where('invoice_date', '>=', r.from)
    .where('invoice_date', '<=', r.to)
    .groupBy(sql`1`)
    .orderBy(sql`1`)
    .execute();
  const total = n(orderCount.count);
  return {
    date: r.from,
    net_sales_paise: sales.totals.net_paise,
    bills: sales.totals.bills,
    average_bill_paise: sales.totals.average_bill_paise,
    orders: total,
    // The PRD's success metric: share of orders placed from guest phones.
    qr_order_share: total ? Math.round((n(orderCount.qr) / total) * 1000) / 1000 : 0,
    open_bills: n(drafts.count),
    active_orders: Object.fromEntries(active.map((a) => [a.status, n(a.count)])),
    tables: Object.fromEntries(tables.map((x) => [x.state, n(x.count)])),
    payments: sales.payments,
    timing: sales.timing,
    top_items: await itemSales(tx, r, 5),
    hourly: hourly.map((h) => ({ hour: n(h.hour), net_paise: n(h.net_paise) })),
  };
}

export function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return '';
  const keys = Object.keys(rows[0]!);
  const esc = (v: unknown) => {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [keys.join(','), ...rows.map((r) => keys.map((k) => esc(r[k])).join(','))].join('\n');
}

/**
 * Delivery orders per channel: how many came in, what the outlet billed for them, and the
 * commission and payout to expect at the outlet's rates. Own deliveries pay no commission.
 */
export async function deliveryReport(tx: Tx, r: Range) {
  const outlet = await tx.db.selectFrom('outlets').select('delivery_commission_bp').where('id', '=', r.outletId).executeTakeFirstOrThrow();
  const rates = (outlet.delivery_commission_bp ?? {}) as Partial<Record<DeliveryChannel, number>>;
  const rows = await tx.db
    .selectFrom('orders')
    .leftJoin('bills', (j) => j.onRef('bills.order_id', '=', 'orders.id').on('bills.status', 'in', LIVE))
    .select((eb) => ['orders.channel', eb.fn.count<number>('orders.id').distinct().as('orders'), eb.fn.sum<number>('bills.total_paise').as('sales_paise')])
    .where('orders.outlet_id', '=', r.outletId)
    .where('orders.type', '=', 'delivery')
    .where('orders.status', 'not in', ['rejected', 'cancelled'])
    .where('orders.business_date', '>=', r.from)
    .where('orders.business_date', '<=', r.to)
    .groupBy('orders.channel')
    .execute();
  return {
    from: r.from,
    to: r.to,
    channels: DELIVERY_CHANNELS.map((channel) => {
      const row = rows.find((x) => x.channel === channel);
      const sales = n(row?.sales_paise);
      const bp = channel === 'own' ? 0 : (rates[channel] ?? 0);
      const commission = Math.round((sales * bp) / 10_000);
      return { channel, orders: n(row?.orders), sales_paise: sales, commission_bp: bp, commission_paise: commission, payout_paise: sales - commission };
    }),
  };
}

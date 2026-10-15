// Owner insights (spec Phase 2 "richer reports"): where sales come from, when the rush is, how
// the team and tables perform, and the pilot health numbers the rollout is judged on.

import { sql } from 'kysely';
import type { Tx } from '../../context';
import type { Range } from './service';

const LIVE = ['finalised', 'paid'] as const;
const SOLD = ['accepted', 'preparing', 'ready', 'served', 'billed'] as const;
const n = (v: unknown) => Number(v ?? 0);
const DAY = 86_400_000;

/** The same number of days immediately before the range. */
export function previousRange(r: Range): Range {
  const days = Math.round((Date.parse(r.to) - Date.parse(r.from)) / DAY) + 1;
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return { ...r, from: iso(Date.parse(r.from) - days * DAY), to: iso(Date.parse(r.from) - DAY) };
}

async function headline(tx: Tx, r: Range) {
  const bills = await tx.db
    .selectFrom('bills')
    .select((eb) => [eb.fn.countAll<number>().as('bills'), eb.fn.sum<number>('total_paise').as('net')])
    .where('outlet_id', '=', r.outletId)
    .where('status', 'in', LIVE)
    .where('invoice_date', '>=', r.from)
    .where('invoice_date', '<=', r.to)
    .executeTakeFirstOrThrow();
  const local = sql<string>`(opened_at at time zone ${r.timezone})::date`;
  const covers = await tx.db
    .selectFrom('table_sessions')
    .select((eb) => [eb.fn.sum<number>('guest_count').as('guests'), eb.fn.countAll<number>().as('visits')])
    .where('outlet_id', '=', r.outletId)
    .where('opened_at', 'is not', null)
    .where(local, '>=', r.from)
    .where(local, '<=', r.to)
    .executeTakeFirstOrThrow();
  const count = n(bills.bills);
  const net = n(bills.net);
  return { net_paise: net, bills: count, average_bill_paise: count ? Math.round(net / count) : 0, covers: n(covers.guests), table_visits: n(covers.visits) };
}

export async function insights(tx: Tx, r: Range) {
  const days = Math.round((Date.parse(r.to) - Date.parse(r.from)) / DAY) + 1;
  const [current, previous] = [await headline(tx, r), await headline(tx, previousRange(r))];

  const soldItems = () =>
    tx.db
      .selectFrom('order_items')
      .innerJoin('orders', 'orders.id', 'order_items.order_id')
      .where('orders.outlet_id', '=', r.outletId)
      .where('orders.business_date', '>=', r.from)
      .where('orders.business_date', '<=', r.to)
      .where('orders.status', 'in', SOLD)
      .where('order_items.status', '<>', 'cancelled');

  const categories = await soldItems()
    .innerJoin('menu_items', 'menu_items.id', 'order_items.item_id')
    .innerJoin('menu_categories', 'menu_categories.id', 'menu_items.category_id')
    .select((eb) => [
      'menu_categories.name as category',
      eb.fn.sum<number>('order_items.qty').as('qty'),
      eb.fn.sum<number>(eb('order_items.qty', '*', eb.ref('order_items.unit_price_paise'))).as('revenue'),
    ])
    .groupBy('menu_categories.name')
    .orderBy('revenue', 'desc')
    .execute();

  // Weekday (0 = Monday) by hour, in the outlet's local time.
  const placed = sql`orders.placed_at at time zone ${r.timezone}`;
  const heat = await soldItems()
    .select((eb) => [
      sql<number>`(extract(isodow from ${placed})::int - 1)`.as('dow'),
      sql<number>`extract(hour from ${placed})::int`.as('hour'),
      eb.fn.count<number>('orders.id').distinct().as('orders'),
      eb.fn.sum<number>(eb('order_items.qty', '*', eb.ref('order_items.unit_price_paise'))).as('revenue'),
    ])
    .groupBy([sql`1`, sql`2`])
    .execute();

  const staffOrders = await tx.db
    .selectFrom('orders')
    .innerJoin('users', 'users.id', 'orders.created_by')
    .select((eb) => ['users.id', 'users.name', eb.fn.countAll<number>().as('orders')])
    .where('orders.outlet_id', '=', r.outletId)
    .where('orders.business_date', '>=', r.from)
    .where('orders.business_date', '<=', r.to)
    .where('orders.status', 'in', SOLD)
    .groupBy(['users.id', 'users.name'])
    .execute();
  const staffBills = await tx.db
    .selectFrom('bills')
    .innerJoin('users', 'users.id', 'bills.finalised_by')
    .select((eb) => [
      'users.id',
      'users.name',
      eb.fn.countAll<number>().as('bills'),
      eb.fn.sum<number>('bills.total_paise').as('net'),
      eb.fn.sum<number>(sql`bills.item_discount_paise + bills.bill_discount_paise`).as('discount'),
    ])
    .where('bills.outlet_id', '=', r.outletId)
    .where('bills.status', 'in', LIVE)
    .where('bills.invoice_date', '>=', r.from)
    .where('bills.invoice_date', '<=', r.to)
    .groupBy(['users.id', 'users.name'])
    .execute();
  const staff = new Map<string, { user_id: string; name: string; orders: number; bills: number; net_paise: number; discount_paise: number }>();
  const person = (id: string, name: string) => staff.get(id) ?? staff.set(id, { user_id: id, name, orders: 0, bills: 0, net_paise: 0, discount_paise: 0 }).get(id)!;
  for (const s of staffOrders) person(s.id, s.name).orders = n(s.orders);
  for (const s of staffBills) Object.assign(person(s.id, s.name), { bills: n(s.bills), net_paise: n(s.net), discount_paise: n(s.discount) });

  const discountRows = await tx.db
    .selectFrom('bills')
    .select((eb) => [
      sql<string>`coalesce(nullif(trim(discount_reason), ''), 'No reason given')`.as('reason'),
      eb.fn.countAll<number>().as('bills'),
      eb.fn.sum<number>(sql`item_discount_paise + bill_discount_paise`).as('amount'),
    ])
    .where('outlet_id', '=', r.outletId)
    .where('status', 'in', LIVE)
    .where('invoice_date', '>=', r.from)
    .where('invoice_date', '<=', r.to)
    .where(sql<boolean>`item_discount_paise + bill_discount_paise > 0`)
    .groupBy(sql`1`)
    .orderBy('amount', 'desc')
    .execute();
  const loyalty = await tx.db
    .selectFrom('bills')
    .select((eb) => [eb.fn.countAll<number>().as('bills'), eb.fn.sum<number>('loyalty_discount_paise').as('amount')])
    .where('outlet_id', '=', r.outletId)
    .where('status', 'in', LIVE)
    .where('invoice_date', '>=', r.from)
    .where('invoice_date', '<=', r.to)
    .where('loyalty_discount_paise', '>', 0)
    .executeTakeFirstOrThrow();

  // Table visits that ended in the range: how long guests stay and how often a table turns.
  const closedLocal = sql<string>`(table_sessions.closed_at at time zone ${r.timezone})::date`;
  const visits = await tx.db
    .selectFrom('table_sessions')
    .innerJoin('tables', 'tables.id', 'table_sessions.table_id')
    .select((eb) => [
      'tables.label',
      'tables.seats',
      eb.fn.countAll<number>().as('visits'),
      sql<number>`round(avg(extract(epoch from (table_sessions.closed_at - table_sessions.opened_at)) / 60))`.as('dwell'),
      eb.fn.sum<number>('table_sessions.guest_count').as('guests'),
    ])
    .where('table_sessions.outlet_id', '=', r.outletId)
    .where('table_sessions.status', '=', 'closed')
    .where('table_sessions.opened_at', 'is not', null)
    .where(closedLocal, '>=', r.from)
    .where(closedLocal, '<=', r.to)
    .groupBy(['tables.label', 'tables.seats'])
    .orderBy('visits', 'desc')
    .execute();
  const tableCount = n(
    (await tx.db.selectFrom('tables').select((eb) => eb.fn.countAll<number>().as('c')).where('outlet_id', '=', r.outletId).where('is_active', '=', true).executeTakeFirstOrThrow()).c,
  );
  const totalVisits = visits.reduce((a, v) => a + n(v.visits), 0);
  const avgDwell = totalVisits ? Math.round(visits.reduce((a, v) => a + n(v.dwell) * n(v.visits), 0) / totalVisits) : null;

  const known = await tx.db
    .selectFrom('bills')
    .leftJoin('customers', 'customers.id', 'bills.customer_id')
    .select((eb) => [
      eb.fn.countAll<number>().as('bills'),
      eb.fn.count<number>('bills.customer_id').as('with_customer'),
      eb.fn.count<number>('bills.customer_id').distinct().as('customers'),
      sql<number>`count(distinct bills.customer_id) filter (where customers.visits > 1)`.as('returning'),
    ])
    .where('bills.outlet_id', '=', r.outletId)
    .where('bills.status', 'in', LIVE)
    .where('bills.invoice_date', '>=', r.from)
    .where('bills.invoice_date', '<=', r.to)
    .executeTakeFirstOrThrow();
  const created = sql<string>`(created_at at time zone ${r.timezone})::date`;
  const newCustomers = await tx.db
    .selectFrom('customers')
    .select((eb) => eb.fn.countAll<number>().as('c'))
    .where('erased_at', 'is', null)
    .where(created, '>=', r.from)
    .where(created, '<=', r.to)
    .executeTakeFirstOrThrow();
  const points = await tx.db
    .selectFrom('loyalty_ledger')
    .select([
      sql<number>`coalesce(sum(points) filter (where kind = 'earn'), 0)`.as('earned'),
      sql<number>`coalesce(-sum(points) filter (where kind = 'redeem'), 0) - coalesce(sum(points) filter (where kind = 'reverse'), 0)`.as('redeemed'),
    ])
    .where('outlet_id', '=', r.outletId)
    .where(sql<string>`(created_at at time zone ${r.timezone})::date`, '>=', r.from)
    .where(sql<string>`(created_at at time zone ${r.timezone})::date`, '<=', r.to)
    .executeTakeFirstOrThrow();

  // Pilot health: how much ordering moved to QR and how smoothly guest orders are handled.
  const sources = await tx.db
    .selectFrom('orders')
    .select((eb) => [
      'source',
      eb.fn.countAll<number>().as('total'),
      sql<number>`count(*) filter (where status = 'rejected')`.as('rejected'),
      sql<number>`count(*) filter (where status = 'cancelled' and accepted_at is not null)`.as('cancelled_after_accept'),
      sql<number>`round(avg(extract(epoch from (accepted_at - placed_at))) filter (where accepted_at is not null))`.as('accept_seconds'),
      sql<number>`count(*) filter (where flagged)`.as('flagged'),
    ])
    .where('outlet_id', '=', r.outletId)
    .where('business_date', '>=', r.from)
    .where('business_date', '<=', r.to)
    .groupBy('source')
    .execute();
  const all = sources.reduce((a, s) => a + n(s.total), 0);
  const qr = sources.find((s) => s.source === 'guest_qr');
  const voids = await tx.db
    .selectFrom('bills')
    .select((eb) => eb.fn.countAll<number>().as('c'))
    .where('outlet_id', '=', r.outletId)
    .where('status', '=', 'void')
    .where(sql<string>`(voided_at at time zone ${r.timezone})::date`, '>=', r.from)
    .where(sql<string>`(voided_at at time zone ${r.timezone})::date`, '<=', r.to)
    .executeTakeFirstOrThrow();

  const change = (now: number, before: number) => (before ? Math.round(((now - before) / before) * 1000) / 10 : null);
  return {
    from: r.from,
    to: r.to,
    days,
    headline: {
      ...current,
      previous,
      change_pct: {
        net: change(current.net_paise, previous.net_paise),
        bills: change(current.bills, previous.bills),
        average_bill: change(current.average_bill_paise, previous.average_bill_paise),
        covers: change(current.covers, previous.covers),
      },
    },
    categories: categories.map((c) => ({ category: c.category, qty: n(c.qty), revenue_paise: n(c.revenue) })),
    heatmap: heat.map((h) => ({ dow: n(h.dow), hour: n(h.hour), orders: n(h.orders), revenue_paise: n(h.revenue) })),
    staff: [...staff.values()].sort((a, b) => b.net_paise - a.net_paise || b.orders - a.orders),
    discounts: {
      by_reason: discountRows.map((d) => ({ reason: d.reason, bills: n(d.bills), amount_paise: n(d.amount) })),
      loyalty: { bills: n(loyalty.bills), amount_paise: n(loyalty.amount) },
    },
    tables: {
      visits: totalVisits,
      avg_dwell_minutes: avgDwell,
      turns_per_table_per_day: tableCount ? Math.round((totalVisits / tableCount / days) * 100) / 100 : 0,
      by_table: visits.map((v) => ({ label: v.label, seats: v.seats, visits: n(v.visits), avg_dwell_minutes: n(v.dwell), guests: n(v.guests) })),
    },
    customers: {
      bills_with_customer: n(known.with_customer),
      identified_share_pct: n(known.bills) ? Math.round((n(known.with_customer) / n(known.bills)) * 1000) / 10 : 0,
      distinct: n(known.customers),
      returning: n(known.returning),
      new: n(newCustomers.c),
      points_earned: n(points.earned),
      points_redeemed: n(points.redeemed),
    },
    pilot: {
      orders: all,
      by_source: sources.map((s) => ({ source: s.source, orders: n(s.total) })).sort((a, b) => b.orders - a.orders),
      qr_share_pct: all ? Math.round((n(qr?.total) / all) * 1000) / 10 : 0,
      qr_rejected_pct: n(qr?.total) ? Math.round((n(qr?.rejected) / n(qr?.total)) * 1000) / 10 : 0,
      qr_flagged: n(qr?.flagged),
      qr_avg_accept_seconds: qr?.accept_seconds == null ? null : n(qr.accept_seconds),
      cancelled_after_accept: sources.reduce((a, s) => a + n(s.cancelled_after_accept), 0),
      voided_bills: n(voids.c),
    },
  };
}

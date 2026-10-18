// Everything still open at close, in one list the owner works through before signing the day off.
// "must" items are money that is not settled (unpaid bills, drafts, food never billed, UPI the bank
// never received); "check" items are for the owner's eyes (free dishes, large discounts, voids,
// refunds, stock differences, UPI not checked against a statement yet).

import { sql } from 'kysely';
import { formatPaise } from '@mezmitra/shared/money';
import { CASHIER_DISCOUNT_LIMIT_BP } from '@mezmitra/shared/permissions';
import type { DayCloseDTO, DayCloseItemDTO } from '@mezmitra/shared/dto';
import type { Tx } from '../../context';
import { dayEnd } from '../reports/service';
import { upiCheck } from '../reconciliation/service';

const fmtTime = (d: Date, timeZone: string) => new Intl.DateTimeFormat('en-IN', { timeStyle: 'short', timeZone }).format(d);
const qty = (n: number) => Number(n.toFixed(3));

export async function openItems(tx: Tx, outlet: { id: string; timezone: string }, date: string): Promise<{ items: DayCloseItemDTO[]; expected_cash_paise: number; net_sales_paise: number; bills: number }> {
  const r = { outletId: outlet.id, from: date, to: date, timezone: outlet.timezone };
  const day = await dayEnd(tx, r);
  const items: DayCloseItemDTO[] = [];

  // Unpaid bills from any day: a bill left open last night is still open tonight.
  const unpaid = await tx.db
    .selectFrom('bills')
    .leftJoin('table_sessions', 'table_sessions.id', 'bills.table_session_id')
    .leftJoin('tables', 'tables.id', 'table_sessions.table_id')
    .select(['bills.id', 'bills.invoice_no', 'bills.status', 'bills.total_paise', 'bills.paid_paise', 'bills.created_at', 'tables.label'])
    .where('bills.outlet_id', '=', outlet.id)
    .where('bills.status', 'in', ['draft', 'finalised'])
    .orderBy('bills.created_at')
    .execute();
  for (const b of unpaid) {
    const where = b.label ? `Table ${b.label}` : 'Counter';
    if (b.status === 'finalised') {
      items.push({ kind: 'unpaid_bill', severity: 'must', title: `Bill ${b.invoice_no} not fully paid`, detail: `${where} · ${formatPaise(b.paid_paise)} of ${formatPaise(b.total_paise)} paid`, amount_paise: b.total_paise - b.paid_paise, href: `/app/bills/${b.id}` });
    } else {
      items.push({ kind: 'draft_bill', severity: 'must', title: `Draft bill not finished`, detail: `${where} · started ${fmtTime(b.created_at, outlet.timezone)}`, amount_paise: b.total_paise, href: `/app/bills/${b.id}` });
    }
  }

  for (const u of day.unbilled_orders) {
    items.push({
      kind: 'unbilled_order',
      severity: 'must',
      title: `Food served but never billed`,
      detail: `${u.table_label ? `Table ${u.table_label}` : u.type} · ordered ${fmtTime(new Date(u.placed_at), outlet.timezone)} · ${u.table_open ? 'table still open' : 'table cleared with no bill'}`,
      amount_paise: u.amount_paise,
      href: u.table_label ? '/app/floor' : '/app/inbox',
    });
  }

  // UPI against the bank: missing from a statement over the past week, or not checked yet today.
  const upi = await upiCheck(tx, outlet.id, date, 7);
  for (const p of upi.not_received.payments) {
    items.push({ kind: 'upi_missing', severity: 'must', title: `UPI payment the bank never received`, detail: `${p.invoice_no ?? (p.outside_bill_no ? `Bill ${p.outside_bill_no}` : p.receipt_no ?? 'Payment')}${p.confirmed_by_name ? ` · confirmed by ${p.confirmed_by_name}` : ''}`, amount_paise: p.amount_paise, href: '/app/reconcile' });
  }
  const todayUnchecked = await tx.db
    .selectFrom('payments')
    .select((eb) => [eb.fn.countAll<number>().as('n'), eb.fn.sum<number>('payments.amount_paise').as('paise')])
    .where('payments.outlet_id', '=', outlet.id)
    .where('payments.method', '=', 'upi')
    .where('payments.kind', '=', 'payment')
    .where(sql<string>`(payments.created_at at time zone ${outlet.timezone})::date::text`, '=', date)
    .where(({ not, exists, selectFrom }) => not(exists(selectFrom('bank_credits').select('bank_credits.id').whereRef('bank_credits.payment_id', '=', 'payments.id'))))
    .executeTakeFirstOrThrow();
  if (Number(todayUnchecked.n)) {
    items.push({ kind: 'upi_unchecked', severity: 'check', title: `${Number(todayUnchecked.n)} UPI payment${Number(todayUnchecked.n) === 1 ? '' : 's'} today not yet checked against the bank`, detail: 'Staff confirmed them by eye. Import tomorrow’s bank statement to check.', amount_paise: Number(todayUnchecked.paise ?? 0), href: '/app/reconcile' });
  }

  const comps = await tx.db
    .selectFrom('comps')
    .innerJoin('order_items', 'order_items.id', 'comps.order_item_id')
    .innerJoin('orders', 'orders.id', 'order_items.order_id')
    .leftJoin('users as giver', 'giver.id', 'comps.given_by')
    .leftJoin('users as approver', 'approver.id', 'comps.approved_by')
    .select(['comps.qty', 'comps.value_paise', 'comps.reason', 'comps.whole_bill', 'order_items.name_snapshot', 'giver.name as giver', 'approver.name as approver'])
    .where('comps.outlet_id', '=', outlet.id)
    .where('orders.business_date', '=', date)
    .where('comps.removed_at', 'is', null)
    .orderBy('comps.created_at')
    .execute();
  for (const c of comps) {
    items.push({
      kind: 'free_item',
      severity: 'check',
      title: c.whole_bill ? 'Whole bill on the house' : `${c.qty} × ${c.name_snapshot} free`,
      detail: [c.reason.replaceAll('_', ' '), c.giver && `given by ${c.giver}`, c.approver && `approved by ${c.approver}`].filter(Boolean).join(' · '),
      amount_paise: c.value_paise,
      href: '/app/reports?tab=comps',
    });
  }

  // Discounts above what a cashier may give alone, counted as billing does: free dishes apart.
  const discount = sql<number>`item_discount_paise + bill_discount_paise - coalesce((select sum(comp_paise) from bill_lines where bill_lines.bill_id = bills.id), 0)`;
  const large = await tx.db
    .selectFrom('bills')
    .select(['id', 'invoice_no', 'discount_reason', discount.as('discount_paise')])
    .where('outlet_id', '=', outlet.id)
    .where('status', 'in', ['finalised', 'paid'])
    .where('invoice_date', '=', date)
    .where(sql<boolean>`(${discount}) * 10000 > subtotal_paise * ${CASHIER_DISCOUNT_LIMIT_BP}`)
    .execute();
  for (const d of large) {
    items.push({ kind: 'large_discount', severity: 'check', title: `Large discount on ${d.invoice_no}`, detail: d.discount_reason ?? 'No reason given', amount_paise: Number(d.discount_paise), href: `/app/bills/${d.id}` });
  }

  for (const v of day.voids) {
    items.push({ kind: 'void', severity: 'check', title: `Bill ${v.invoice_no} voided`, detail: [v.reason, v.voided_by && `by ${v.voided_by}`].filter(Boolean).join(' · ') || null, amount_paise: v.total_paise, href: '/app/reports?tab=day-end' });
  }
  for (const x of day.refunds) {
    items.push({ kind: 'refund', severity: 'check', title: `Refund on ${x.invoice_no}`, detail: [x.method.replace('_', ' '), x.reason].filter(Boolean).join(' · '), amount_paise: x.amount_paise, href: '/app/reports?tab=day-end' });
  }

  // Stock counted different from what the system expected, and other hand corrections.
  const stock = await tx.db
    .selectFrom('stock_movements')
    .innerJoin('ingredients', 'ingredients.id', 'stock_movements.ingredient_id')
    .leftJoin('users', 'users.id', 'stock_movements.created_by')
    .select(['ingredients.name', 'ingredients.unit', 'stock_movements.type', 'stock_movements.qty', 'stock_movements.note', 'users.name as by'])
    .where('stock_movements.outlet_id', '=', outlet.id)
    .where('stock_movements.type', 'in', ['count', 'adjust'])
    .where(sql<string>`(stock_movements.created_at at time zone ${outlet.timezone})::date::text`, '=', date)
    .where((eb) => eb.or([eb('stock_movements.note', 'is', null), eb('stock_movements.note', '<>', 'Opening stock')]))
    .where('stock_movements.qty', '<>', 0)
    .orderBy('stock_movements.created_at')
    .execute();
  for (const m of stock) {
    const n = Number(m.qty);
    items.push({
      kind: 'stock_difference',
      severity: 'check',
      title: `${m.name}: ${n < 0 ? `${qty(-n)} ${m.unit} less` : `${qty(n)} ${m.unit} more`} than expected`,
      detail: [m.type === 'count' ? 'stock count' : 'correction', m.note, m.by && `by ${m.by}`].filter(Boolean).join(' · '),
      amount_paise: null,
      href: '/app/inventory',
    });
  }

  return { items, expected_cash_paise: day.expected_cash_paise, net_sales_paise: day.sales.net_paise, bills: day.sales.bills };
}

export async function dayCloseView(tx: Tx, outlet: { id: string; timezone: string }, date: string): Promise<DayCloseDTO> {
  const signed = await tx.db
    .selectFrom('day_closes')
    .leftJoin('users', 'users.id', 'day_closes.signed_by')
    .select(['day_closes.signed_at', 'day_closes.note', 'day_closes.counted_cash_paise', 'day_closes.expected_cash_paise', 'day_closes.net_sales_paise', 'day_closes.items', 'users.name as signed_by_name'])
    .where('day_closes.outlet_id', '=', outlet.id)
    .where('day_closes.business_date', '=', date)
    .executeTakeFirst();
  if (signed) {
    const live = await openItems(tx, outlet, date);
    return {
      outlet_id: outlet.id,
      date,
      net_sales_paise: signed.net_sales_paise,
      bills: live.bills,
      expected_cash_paise: signed.expected_cash_paise,
      items: signed.items as unknown as DayCloseItemDTO[],
      signed: { signed_at: signed.signed_at.toISOString(), signed_by_name: signed.signed_by_name, note: signed.note, counted_cash_paise: signed.counted_cash_paise },
    };
  }
  const live = await openItems(tx, outlet, date);
  return { outlet_id: outlet.id, date, ...live, signed: null };
}

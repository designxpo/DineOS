// Free food and drinks (complimentary): a dish, part of a line, or a whole bill given on the house
// to make a mishap right, for a special or owner's guest, a celebration, a staff meal or marketing.
// Owners, managers and cashiers give them; anyone else needs a manager's PIN. Every one is kept
// with why, for whom, who gave and approved it, its menu value and its ingredient cost.

import { sql } from 'kysely';
import type { CompDTO, CompReportDTO } from '@dineos/shared/dto';
import type { CompReason } from '@dineos/shared/enums';
import type { Tx } from '../../context';
import { requireApproval } from '../../lib/approvals';
import { audit } from '../../lib/audit';
import { can, type StaffAuth } from '../../lib/auth';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors';
import { announceBill, billableItems, compQtyByItem, syncDraft } from '../billing/service';
import { loadBill } from '../billing/serialize';
import { announceOrder } from '../orders/service';
import { loadOrder } from '../orders/serialize';
import type { Range } from '../reports/service';

export interface CompInput {
  qty?: number;
  reason: CompReason;
  note?: string | null;
  customerId?: string | null;
}

function cleanInput(input: CompInput): { note: string | null } {
  const note = input.note?.trim() || null;
  if (input.reason === 'other' && !note) throw badRequest('note_required', 'Say why it was given free');
  return { note };
}

/** Ingredient cost of one portion from its recipe (and its add-ons), or null with no recipe. */
async function portionCost(tx: Tx, itemId: string, modifierIds: readonly string[]): Promise<number | null> {
  const base = await tx.db
    .selectFrom('recipes')
    .innerJoin('ingredients', 'ingredients.id', 'recipes.ingredient_id')
    .select([sql<number>`sum(recipes.qty * ingredients.cost_per_unit_paise)`.as('cost'), sql<number>`count(*)`.as('n')])
    .where('recipes.item_id', '=', itemId)
    .executeTakeFirst();
  if (!base || Number(base.n) === 0) return null;
  let cost = Number(base.cost ?? 0);
  if (modifierIds.length) {
    const mods = await tx.db
      .selectFrom('modifier_recipes')
      .innerJoin('ingredients', 'ingredients.id', 'modifier_recipes.ingredient_id')
      .select(sql<number>`sum(modifier_recipes.qty * ingredients.cost_per_unit_paise)`.as('cost'))
      .where('modifier_recipes.modifier_id', 'in', [...modifierIds])
      .executeTakeFirst();
    cost += Number(mods?.cost ?? 0);
  }
  return Math.round(cost);
}

async function assertCustomer(tx: Tx, customerId: string | null | undefined): Promise<void> {
  if (!customerId) return;
  const c = await tx.db.selectFrom('customers').select('id').where('id', '=', customerId).where('erased_at', 'is', null).executeTakeFirst();
  if (!c) throw notFound('Customer');
}

/** Whether the dish is already on a printed bill (then only voiding that bill changes it). */
async function onPrintedBill(tx: Tx, orderItemId: string): Promise<boolean> {
  const row = await tx.db
    .selectFrom('bill_lines')
    .innerJoin('bills', 'bills.id', 'bill_lines.bill_id')
    .select('bills.id')
    .where('bill_lines.order_item_id', '=', orderItemId)
    .where('bills.status', 'in', ['finalised', 'paid'])
    .executeTakeFirst();
  return !!row;
}

/** Brings unprinted bills of the order's table (or the order) up to date and tells screens. */
async function refreshAfter(tx: Tx, orderId: string): Promise<void> {
  const order = (await loadOrder(tx, orderId))!;
  await announceOrder(tx, order, 'order.updated');
  const drafts = await tx.db
    .selectFrom('bills')
    .select('id')
    .where('status', '=', 'draft')
    .where((eb) => (order.table_session_id ? eb('table_session_id', '=', order.table_session_id) : eb('order_id', '=', orderId)))
    .execute();
  for (const d of drafts) {
    await syncDraft(tx, d.id);
    const dto = await loadBill(tx, d.id);
    if (dto) await announceBill(tx, dto);
  }
}

/** Tells the outlet (and the owner's phone, above the outlet's amount) that something went free. */
async function announceComp(tx: Tx, outletId: string, comp: { value_paise: number; items: string; reason: CompReason; given_by: string; where: string | null }) {
  const outlet = await tx.db.selectFrom('outlets').select('comp_alert_paise').where('id', '=', outletId).executeTakeFirstOrThrow();
  const alert = outlet.comp_alert_paise !== null && comp.value_paise >= outlet.comp_alert_paise;
  await tx.emit({ outletId, type: 'comp.given', channels: ['outlet'], payload: { ...comp, alert } });
}

async function insertComp(
  tx: Tx,
  row: { outletId: string; orderItemId: string; qty: number; valuePaise: number; costPaise: number | null; reason: CompReason; note: string | null; wholeBill: boolean; customerId: string | null; givenBy: string; approvedBy: string | null },
): Promise<string> {
  const r = await tx.db
    .insertInto('comps')
    .values({
      tenant_id: tx.tenantId,
      outlet_id: row.outletId,
      order_item_id: row.orderItemId,
      qty: row.qty,
      value_paise: row.valuePaise,
      cost_paise: row.costPaise,
      reason: row.reason,
      note: row.note,
      whole_bill: row.wholeBill,
      customer_id: row.customerId,
      given_by: row.givenBy,
      approved_by: row.approvedBy,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return r.id;
}

const modifierIds = (snapshot: unknown) => (Array.isArray(snapshot) ? (snapshot as { modifier_id?: string }[]).map((m) => m.modifier_id).filter((x): x is string => !!x) : []);

/** Gives some (by default all) of one dish free. */
export async function compItem(tx: Tx, auth: StaffAuth, orderItemId: string, input: CompInput, approvalToken: string | null | undefined): Promise<CompDTO> {
  const item = await tx.db
    .selectFrom('order_items')
    .innerJoin('orders', 'orders.id', 'order_items.order_id')
    .select([
      'order_items.id',
      'order_items.item_id',
      'order_items.name_snapshot',
      'order_items.qty',
      'order_items.unit_price_paise',
      'order_items.status',
      'order_items.modifiers_snapshot',
      'orders.id as order_id',
      'orders.outlet_id',
      'orders.status as order_status',
      'orders.order_no',
    ])
    .where('order_items.id', '=', orderItemId)
    .forUpdate()
    .executeTakeFirst();
  if (!item) throw notFound('Order item');
  const { note } = cleanInput(input);
  if (item.status === 'cancelled' || ['placed', 'rejected', 'cancelled'].includes(item.order_status)) {
    throw conflict('not_compable', 'Only dishes the kitchen has taken can be given free');
  }
  if (await onPrintedBill(tx, item.id)) throw conflict('already_billed', 'This dish is on a printed bill. Void that bill to change it.');
  const given = (await compQtyByItem(tx, [item.id])).get(item.id) ?? 0;
  const left = item.qty - given;
  if (left <= 0) throw conflict('already_free', `${item.name_snapshot} is already free`);
  const qty = input.qty ?? left;
  if (qty < 1 || qty > left) throw badRequest('invalid_qty', `Up to ${left} can be given free`);
  await assertCustomer(tx, input.customerId);
  const approver = await requireApproval(tx, auth, item.outlet_id, 'bill.comp', approvalToken);
  const unitCost = await portionCost(tx, item.item_id, modifierIds(item.modifiers_snapshot));

  const value = qty * item.unit_price_paise;
  const id = await insertComp(tx, {
    outletId: item.outlet_id,
    orderItemId: item.id,
    qty,
    valuePaise: value,
    costPaise: unitCost === null ? null : unitCost * qty,
    reason: input.reason,
    note,
    wholeBill: false,
    customerId: input.customerId ?? null,
    givenBy: auth.userId,
    approvedBy: approver === auth.userId ? null : approver,
  });
  await audit(tx, auth, {
    outletId: item.outlet_id,
    action: 'comp.give',
    entity: 'order_item',
    entityId: item.id,
    after: { qty, value_paise: value, reason: input.reason, note },
    approvedBy: approver === auth.userId ? null : approver,
  });
  await refreshAfter(tx, item.order_id);
  const order = await loadOrder(tx, item.order_id);
  await announceComp(tx, item.outlet_id, { value_paise: value, items: `${qty}× ${item.name_snapshot}`, reason: input.reason, given_by: auth.userId, where: order?.table_label ?? `#${item.order_no}` });
  return (await loadComps(tx, [id]))[0]!;
}

/**
 * One of a dish free as a guest's loyalty reward (reason 'loyalty'). The guest earned it, so no
 * manager approves it and the owner is not alerted; the reward keeps the link.
 */
export async function compForReward(tx: Tx, auth: StaffAuth, orderItemId: string, label: string, customerId: string): Promise<string> {
  const item = await tx.db
    .selectFrom('order_items')
    .innerJoin('orders', 'orders.id', 'order_items.order_id')
    .select(['order_items.id', 'order_items.item_id', 'order_items.qty', 'order_items.unit_price_paise', 'order_items.modifiers_snapshot', 'orders.id as order_id', 'orders.outlet_id'])
    .where('order_items.id', '=', orderItemId)
    .forUpdate()
    .executeTakeFirstOrThrow();
  const unitCost = await portionCost(tx, item.item_id, modifierIds(item.modifiers_snapshot));
  const id = await insertComp(tx, {
    outletId: item.outlet_id,
    orderItemId: item.id,
    qty: 1,
    valuePaise: item.unit_price_paise,
    costPaise: unitCost,
    reason: 'loyalty',
    note: label,
    wholeBill: false,
    customerId,
    givenBy: auth.userId,
    approvedBy: null,
  });
  await audit(tx, auth, { outletId: item.outlet_id, action: 'comp.give', entity: 'order_item', entityId: item.id, after: { qty: 1, value_paise: item.unit_price_paise, reason: 'loyalty', note: label } });
  await refreshAfter(tx, item.order_id);
  return id;
}

/** Puts everything still charged on an unprinted bill on the house. */
export async function compBill(tx: Tx, auth: StaffAuth, billId: string, input: CompInput, approvalToken: string | null | undefined): Promise<CompDTO[]> {
  const bill = await tx.db.selectFrom('bills').selectAll().where('id', '=', billId).forUpdate().executeTakeFirst();
  if (!bill) throw notFound('Bill');
  if (bill.status !== 'draft') throw conflict('bill_finalised', 'This bill is already printed. Void it to change it.');
  const { note } = cleanInput(input);
  await assertCustomer(tx, input.customerId);
  const items = await billableItems(tx, bill);
  const given = await compQtyByItem(tx, items.map((i) => i.id));
  const open = items.filter((i) => i.qty - (given.get(i.id) ?? 0) > 0);
  if (open.length === 0) throw conflict('already_free', 'Everything on this bill is already free');
  const approver = await requireApproval(tx, auth, bill.outlet_id, 'bill.comp', approvalToken);

  const ids: string[] = [];
  let total = 0;
  for (const i of open) {
    const qty = i.qty - (given.get(i.id) ?? 0);
    const unitCost = await portionCost(tx, i.item_id, modifierIds(i.modifiers_snapshot));
    total += qty * i.unit_price_paise;
    ids.push(
      await insertComp(tx, {
        outletId: bill.outlet_id,
        orderItemId: i.id,
        qty,
        valuePaise: qty * i.unit_price_paise,
        costPaise: unitCost === null ? null : unitCost * qty,
        reason: input.reason,
        note,
        wholeBill: true,
        customerId: input.customerId ?? bill.customer_id ?? null,
        givenBy: auth.userId,
        approvedBy: approver === auth.userId ? null : approver,
      }),
    );
  }
  await audit(tx, auth, {
    outletId: bill.outlet_id,
    action: 'comp.give_bill',
    entity: 'bill',
    entityId: billId,
    after: { items: ids.length, value_paise: total, reason: input.reason, note },
    approvedBy: approver === auth.userId ? null : approver,
  });
  for (const orderId of new Set(open.map((i) => i.order_id))) await refreshAfter(tx, orderId);
  const dto = await loadBill(tx, billId);
  await announceComp(tx, bill.outlet_id, { value_paise: total, items: 'whole bill', reason: input.reason, given_by: auth.userId, where: dto?.table_label ?? null });
  return loadComps(tx, ids);
}

/** Undoes a free dish before its bill is printed. The record stays, marked undone. */
export async function removeComp(tx: Tx, auth: StaffAuth, compId: string): Promise<void> {
  const comp = await tx.db
    .selectFrom('comps')
    .innerJoin('order_items', 'order_items.id', 'comps.order_item_id')
    .select(['comps.id', 'comps.outlet_id', 'comps.order_item_id', 'comps.given_by', 'comps.removed_at', 'comps.qty', 'comps.value_paise', 'order_items.order_id'])
    .where('comps.id', '=', compId)
    .forUpdate()
    .executeTakeFirst();
  if (!comp || comp.removed_at) throw notFound('Free item');
  // Whoever gave it, or anyone who runs bills, may take it back (the guest then pays for it).
  if (comp.given_by !== auth.userId && !can(auth, comp.outlet_id, 'bill.manage')) throw forbidden();
  if (await onPrintedBill(tx, comp.order_item_id)) throw conflict('already_billed', 'This dish is on a printed bill. Void that bill to change it.');
  await tx.db.updateTable('comps').set({ removed_at: new Date(), removed_by: auth.userId }).where('id', '=', compId).execute();
  // A free dish that was a loyalty reward gives the guest the reward back.
  await tx.db.updateTable('customer_rewards').set({ status: 'available', bill_id: null, comp_id: null, used_at: null }).where('comp_id', '=', compId).execute();
  await audit(tx, auth, { outletId: comp.outlet_id, action: 'comp.remove', entity: 'order_item', entityId: comp.order_item_id, before: { qty: comp.qty, value_paise: comp.value_paise } });
  await refreshAfter(tx, comp.order_id);
}

const last4 = (phone: string | null) => (phone ? phone.slice(-4) : '');

export async function loadComps(tx: Tx, ids: readonly string[]): Promise<CompDTO[]> {
  if (ids.length === 0) return [];
  const rows = await compQuery(tx).where('comps.id', 'in', [...ids]).execute();
  const byId = new Map(rows.map((r) => [r.id, toDto(r)]));
  return ids.map((id) => byId.get(id)!).filter(Boolean);
}

function compQuery(tx: Tx) {
  return tx.db
    .selectFrom('comps')
    .innerJoin('order_items', 'order_items.id', 'comps.order_item_id')
    .innerJoin('orders', 'orders.id', 'order_items.order_id')
    .innerJoin('users as giver', 'giver.id', 'comps.given_by')
    .leftJoin('users as approver', 'approver.id', 'comps.approved_by')
    .leftJoin('customers', 'customers.id', 'comps.customer_id')
    .leftJoin('tables', 'tables.id', 'orders.table_id')
    .select([
      'comps.id',
      'comps.order_item_id',
      'order_items.name_snapshot as item_name',
      'comps.qty',
      'comps.value_paise',
      'comps.cost_paise',
      'comps.reason',
      'comps.note',
      'comps.whole_bill',
      'comps.customer_id',
      'customers.name as customer_name',
      'customers.phone as customer_phone',
      'giver.id as given_by_id',
      'giver.name as given_by',
      'approver.id as approved_by_id',
      'approver.name as approved_by',
      'comps.created_at',
      'comps.removed_at',
      'orders.order_no',
      'tables.label as table_label',
      (eb) =>
        eb
          .selectFrom('bill_lines')
          .innerJoin('bills', 'bills.id', 'bill_lines.bill_id')
          .select('bills.invoice_no')
          .whereRef('bill_lines.order_item_id', '=', 'comps.order_item_id')
          .where('bills.status', 'in', ['finalised', 'paid'])
          .limit(1)
          .as('invoice_no'),
    ]);
}

type CompRow = Awaited<ReturnType<ReturnType<typeof compQuery>['execute']>>[number];

function toDto(r: CompRow): CompDTO {
  return {
    id: r.id,
    order_item_id: r.order_item_id,
    item_name: r.item_name,
    qty: r.qty,
    value_paise: r.value_paise,
    cost_paise: r.cost_paise,
    reason: r.reason as CompReason,
    note: r.note,
    whole_bill: r.whole_bill,
    customer: r.customer_id ? { id: r.customer_id, name: r.customer_name, phone_last4: last4(r.customer_phone) } : null,
    given_by: r.given_by,
    approved_by: r.approved_by,
    created_at: r.created_at.toISOString(),
    removed_at: r.removed_at?.toISOString() ?? null,
  };
}

/**
 * What was given free in a period (by the order's business date): totals, by reason, by who gave
 * it, by who approved it, by guest, and every record (undone ones too, marked, for review).
 */
export async function compReport(tx: Tx, r: Range): Promise<CompReportDTO> {
  const rows = await compQuery(tx)
    .where('comps.outlet_id', '=', r.outletId)
    .where('orders.business_date', '>=', r.from)
    .where('orders.business_date', '<=', r.to)
    .orderBy('comps.created_at', 'desc')
    .limit(2000)
    .execute();
  const sales = await tx.db
    .selectFrom('bills')
    .select((eb) => eb.fn.sum<number>('total_paise').as('net'))
    .where('outlet_id', '=', r.outletId)
    .where('status', 'in', ['finalised', 'paid'])
    .where('invoice_date', '>=', r.from)
    .where('invoice_date', '<=', r.to)
    .executeTakeFirst();

  const live = rows.filter((x) => !x.removed_at);
  const group = <K extends string>(key: (x: CompRow) => K | null) => {
    const m = new Map<K, { count: number; value_paise: number; cost_paise: number; sample: CompRow }>();
    for (const x of live) {
      const k = key(x);
      if (k === null) continue;
      const g = m.get(k) ?? { count: 0, value_paise: 0, cost_paise: 0, sample: x };
      g.count += x.qty;
      g.value_paise += x.value_paise;
      g.cost_paise += x.cost_paise ?? 0;
      m.set(k, g);
    }
    return [...m.entries()].sort((a, b) => b[1].value_paise - a[1].value_paise);
  };

  return {
    from: r.from,
    to: r.to,
    totals: {
      count: live.length,
      items: live.reduce((a, x) => a + x.qty, 0),
      value_paise: live.reduce((a, x) => a + x.value_paise, 0),
      cost_paise: live.reduce((a, x) => a + (x.cost_paise ?? 0), 0),
      net_sales_paise: Number(sales?.net ?? 0),
    },
    by_reason: group((x) => x.reason as CompReason).map(([reason, g]) => ({ reason, count: g.count, value_paise: g.value_paise, cost_paise: g.cost_paise })),
    by_staff: group((x) => x.given_by_id).map(([user_id, g]) => ({ user_id, name: g.sample.given_by, count: g.count, value_paise: g.value_paise })),
    by_approver: group((x) => x.approved_by_id).map(([user_id, g]) => ({ user_id, name: g.sample.approved_by ?? '', count: g.count, value_paise: g.value_paise })),
    by_guest: group((x) => x.customer_id).map(([customer_id, g]) => ({
      customer_id,
      name: g.sample.customer_name,
      phone_last4: last4(g.sample.customer_phone),
      count: g.count,
      value_paise: g.value_paise,
    })),
    rows: rows.map((x) => ({ ...toDto(x), order_no: x.order_no, table_label: x.table_label, invoice_no: x.invoice_no })),
  };
}

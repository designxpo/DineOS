// Bills, splits, GST invoices and payments (spec §8). Drafts are recomputed from orders on every
// read and change; finalising freezes the lines and takes the next gap-free invoice number.

import { computeBill, type BillDiscount } from '@dineos/shared/billing';
import { describeDuration } from '@dineos/shared/loyalty';
import { businessDate, financialYear, formatInvoiceNo } from '@dineos/shared/dates';
import type { BillDTO } from '@dineos/shared/dto';
import { OPERATOR_CHANNELS, type DeliveryChannel, type PaymentMethod } from '@dineos/shared/enums';
import { CASHIER_DISCOUNT_LIMIT_BP } from '@dineos/shared/permissions';
import type { BillDoc } from '@dineos/shared/print';
import { sql } from 'kysely';
import type { Tx } from '../../context';
import { json } from '../../db';
import { requireApproval } from '../../lib/approvals';
import { audit } from '../../lib/audit';
import { assertCan, type StaffAuth } from '../../lib/auth';
import { nextCounter } from '../../lib/counters';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { createOrder, markOrdersBilled } from '../orders/service';
import { canPrint, openCashDrawer, queuePrintJob } from '../print/jobs';
import { closeSession } from '../tables/sessions';
import { activateMembership, cancelMembership, detachRewards, memberDiscount, membershipLine, releaseRewards, rewardMoneyOff, rewardsOnPrint, rewardsOnVoid } from '../loyalty/bill-hooks';
import { logWalletSpend, refundToWallet, spendFromWallet } from '../loyalty/wallet';
import { earnOnPaid, lockCustomer, refreshCustomer } from '../loyalty/engine';
import { pointsRule } from '../loyalty/program';
import { redeemOnFinalise, reverseOnVoid, validateRedemption } from './loyalty';
import { paymentAdapterFor } from './payment-adapter';
import { loadBill, loadBills, loadInvoice, shares, upiUri, type AmountSplit } from './serialize';

type BillRow = Awaited<ReturnType<typeof lockBill>>;

async function lockBill(tx: Tx, billId: string) {
  const bill = await tx.db.selectFrom('bills').selectAll().where('id', '=', billId).forUpdate().executeTakeFirst();
  if (!bill) throw notFound('Bill');
  return bill;
}

async function outletFor(tx: Tx, outletId: string) {
  return tx.db.selectFrom('outlets').selectAll().where('id', '=', outletId).executeTakeFirstOrThrow();
}

/**
 * Order items this bill can charge for: in its scope (table session or single order), from orders
 * the outlet accepted, not cancelled, and not already on another live bill.
 */
export async function billableItems(tx: Tx, bill: Pick<BillRow, 'id' | 'table_session_id' | 'order_id' | 'item_scope'>) {
  let q = tx.db
    .selectFrom('order_items')
    .innerJoin('orders', 'orders.id', 'order_items.order_id')
    .select([
      'order_items.id',
      'order_items.order_id',
      'order_items.item_id',
      'order_items.name_snapshot',
      'order_items.qty',
      'order_items.unit_price_paise',
      'order_items.tax_rate_bp',
      'order_items.hsn_sac',
      'order_items.seat_no',
      'order_items.modifiers_snapshot',
    ])
    .where('order_items.status', '<>', 'cancelled')
    .where('orders.status', 'not in', ['placed', 'rejected', 'cancelled'])
    .where(({ not, exists, selectFrom }) =>
      not(
        exists(
          selectFrom('bill_lines')
            .innerJoin('bills', 'bills.id', 'bill_lines.bill_id')
            .select('bill_lines.id')
            .whereRef('bill_lines.order_item_id', '=', 'order_items.id')
            .where('bills.status', '<>', 'void')
            .where('bills.id', '<>', bill.id),
        ),
      ),
    );
  q = bill.table_session_id
    ? q.where('orders.table_session_id', '=', bill.table_session_id)
    : q.where('orders.id', '=', bill.order_id!);
  const scope = bill.item_scope as string[] | null;
  if (scope) {
    if (scope.length === 0) return [];
    q = q.where('order_items.id', 'in', scope);
  }
  return q.orderBy('orders.placed_at').orderBy('order_items.position').execute();
}

/** How many of each order item were given free (complimentary), not counting undone ones. */
export async function compQtyByItem(tx: Tx, orderItemIds: readonly string[]): Promise<Map<string, number>> {
  if (orderItemIds.length === 0) return new Map();
  const rows = await tx.db
    .selectFrom('comps')
    .select((eb) => ['order_item_id', eb.fn.sum<number>('qty').as('qty')])
    .where('order_item_id', 'in', [...orderItemIds])
    .where('removed_at', 'is', null)
    .groupBy('order_item_id')
    .execute();
  return new Map(rows.map((r) => [r.order_item_id, Number(r.qty)]));
}

function lineName(name: string, modifiers: unknown): string {
  const mods = Array.isArray(modifiers) ? (modifiers as { name: string }[]).map((m) => m.name) : [];
  return mods.length ? `${name} (${mods.join(', ')})` : name;
}

/** Recomputes a draft from its orders and stores lines and totals. No-op for finalised bills. */
export async function syncDraft(tx: Tx, billId: string): Promise<void> {
  const bill = await lockBill(tx, billId);
  if (bill.status !== 'draft') return;
  const outlet = await outletFor(tx, bill.outlet_id);
  if (bill.membership_id) return syncMembershipDraft(tx, bill, outlet);
  const items = await billableItems(tx, bill);
  const discounts = (bill.item_discounts ?? {}) as Record<string, number>;
  // Free (complimentary) dishes are charged nothing: their value is part of the item discount, so
  // no tax falls on them, and the line remembers how much of it was free.
  const freeQty = await compQtyByItem(tx, items.map((i) => i.id));
  const freePaise = (i: (typeof items)[number]) => Math.min(i.qty, freeQty.get(i.id) ?? 0) * i.unit_price_paise;
  const input = {
    lines: items.map((i) => ({
      key: i.id,
      qty: i.qty,
      unit_price_paise: i.unit_price_paise,
      // Zomato and Swiggy pay the GST on their orders (s. 9(5)); the outlet charges none.
      tax_rate_bp: bill.tax_by_operator ? 0 : i.tax_rate_bp,
      item_discount_paise: Math.min(i.qty * i.unit_price_paise, (discounts[i.id] ?? 0) + freePaise(i)),
    })),
    bill_discount: (bill.bill_discount ?? null) as BillDiscount | null,
    service_charge_bp: bill.service_charge_waived ? 0 : bill.service_charge_bp,
    service_charge_tax_rate_bp: outlet.service_charge_tax_rate_bp,
    prices_include_tax: outlet.prices_include_tax,
  };
  // Loyalty comes off what is left after other discounts: the guest's membership first, then
  // rewards, then points in whole points.
  const pre = computeBill(input);
  const room = pre.subtotal_paise - pre.item_discount_paise - pre.bill_discount_paise;
  const memberOff = bill.customer_id
    ? await memberDiscount(tx, bill.customer_id, pre.lines.map((l, i) => ({ item_id: items[i]!.item_id, value_paise: l.gross_paise - l.item_discount_paise })), room)
    : 0;
  const rewardOff = bill.customer_id ? await rewardMoneyOff(tx, billId, room - memberOff) : 0;
  const rule = bill.loyalty_points_redeemed > 0 ? await pointsRule(tx) : null;
  const points = rule ? Math.min(bill.loyalty_points_redeemed, Math.floor((room - memberOff - rewardOff) / rule.point_value_paise)) : 0;
  const totals = computeBill({ ...input, loyalty_paise: memberOff + rewardOff + points * (rule?.point_value_paise ?? 0) });

  await tx.db.deleteFrom('bill_lines').where('bill_id', '=', billId).execute();
  if (items.length) {
    await tx.db
      .insertInto('bill_lines')
      .values(
        totals.lines.map((l, idx) => {
          const item = items[idx]!;
          return {
            tenant_id: tx.tenantId,
            bill_id: billId,
            order_item_id: item.id,
            name: lineName(item.name_snapshot, item.modifiers_snapshot),
            qty: l.qty,
            unit_price_paise: l.unit_price_paise,
            gross_paise: l.gross_paise,
            item_discount_paise: l.item_discount_paise,
            bill_discount_paise: l.bill_discount_paise,
            taxable_paise: l.taxable_paise,
            tax_rate_bp: l.tax_rate_bp,
            cgst_paise: l.cgst_paise,
            sgst_paise: l.sgst_paise,
            amount_paise: l.amount_paise,
            hsn_sac: item.hsn_sac,
            seat_no: item.seat_no,
            comp_qty: Math.min(item.qty, freeQty.get(item.id) ?? 0),
            comp_paise: Math.min(l.gross_paise, freePaise(item)),
            // Keep the display order stable within one recompute.
            created_at: new Date(Date.now() + idx),
          };
        }),
      )
      .execute();
  }
  await tx.db
    .updateTable('bills')
    .set({
      subtotal_paise: totals.subtotal_paise,
      item_discount_paise: totals.item_discount_paise,
      bill_discount_paise: totals.bill_discount_paise,
      service_charge_paise: totals.service_charge_paise,
      service_charge_tax_rate_bp: outlet.service_charge_tax_rate_bp,
      taxable_paise: totals.taxable_paise,
      cgst_paise: totals.cgst_paise,
      sgst_paise: totals.sgst_paise,
      tax_total_paise: totals.tax_total_paise,
      round_off_paise: totals.round_off_paise,
      total_paise: totals.total_paise,
      loyalty_points_redeemed: points,
      loyalty_discount_paise: totals.loyalty_discount_paise,
      reward_discount_paise: rewardOff,
      member_discount_paise: memberOff,
    })
    .where('id', '=', billId)
    .execute();
}

/** A membership sale: one line, the plan as sold, taxed at its own rate. */
async function syncMembershipDraft(tx: Tx, bill: BillRow, outlet: Awaited<ReturnType<typeof outletFor>>): Promise<void> {
  const plan = await membershipLine(tx, bill.membership_id!);
  const totals = computeBill({
    lines: [{ key: 'membership', qty: 1, unit_price_paise: plan.price_paise, tax_rate_bp: plan.tax_rate_bp }],
    bill_discount: (bill.bill_discount ?? null) as BillDiscount | null,
    service_charge_bp: 0,
    service_charge_tax_rate_bp: outlet.service_charge_tax_rate_bp,
    prices_include_tax: outlet.prices_include_tax,
  });
  const l = totals.lines[0]!;
  await tx.db.deleteFrom('bill_lines').where('bill_id', '=', bill.id).execute();
  await tx.db
    .insertInto('bill_lines')
    .values({
      tenant_id: tx.tenantId,
      bill_id: bill.id,
      order_item_id: null,
      name: `${plan.name} membership (${describeDuration(plan.duration_days)})`,
      qty: 1,
      unit_price_paise: l.unit_price_paise,
      gross_paise: l.gross_paise,
      item_discount_paise: 0,
      bill_discount_paise: l.bill_discount_paise,
      taxable_paise: l.taxable_paise,
      tax_rate_bp: l.tax_rate_bp,
      cgst_paise: l.cgst_paise,
      sgst_paise: l.sgst_paise,
      amount_paise: l.amount_paise,
      hsn_sac: plan.hsn_sac,
      seat_no: null,
    })
    .execute();
  await tx.db
    .updateTable('bills')
    .set({
      subtotal_paise: totals.subtotal_paise,
      item_discount_paise: 0,
      bill_discount_paise: totals.bill_discount_paise,
      service_charge_paise: 0,
      taxable_paise: totals.taxable_paise,
      cgst_paise: totals.cgst_paise,
      sgst_paise: totals.sgst_paise,
      tax_total_paise: totals.tax_total_paise,
      round_off_paise: totals.round_off_paise,
      total_paise: totals.total_paise,
      loyalty_points_redeemed: 0,
      loyalty_discount_paise: 0,
      reward_discount_paise: 0,
      member_discount_paise: 0,
    })
    .where('id', '=', bill.id)
    .execute();
}

export async function getBill(tx: Tx, billId: string): Promise<BillDTO> {
  await syncDraft(tx, billId);
  const bill = await loadBill(tx, billId);
  if (!bill) throw notFound('Bill');
  return bill;
}

export async function announceBill(tx: Tx, bill: BillDTO): Promise<void> {
  await tx.emit({ outletId: bill.outlet_id, type: 'bill.updated', channels: ['outlet'], payload: { bill_id: bill.id, status: bill.status, table_session_id: bill.table_session_id } });
  if (bill.table_session_id) {
    await tx.emit({
      outletId: bill.outlet_id,
      type: 'bill.updated',
      channels: [`session:${bill.table_session_id}`],
      payload: { status: bill.status, total_paise: bill.total_paise, paid_paise: bill.paid_paise },
    });
  }
}

/**
 * Opens (or returns) the draft for a table session or a takeaway/counter order. A session can
 * have several bills: split bills, or a second bill for dishes ordered after the first was printed.
 */
export async function createBill(
  tx: Tx,
  auth: StaffAuth,
  input: { table_session_id?: string | null; order_id?: string | null },
): Promise<BillDTO> {
  let outletId: string;
  let delivery = false;
  let taxByOperator = false;
  if (input.table_session_id) {
    const s = await tx.db
      .selectFrom('table_sessions')
      .select(['outlet_id', 'status'])
      .where('id', '=', input.table_session_id)
      .forUpdate()
      .executeTakeFirst();
    if (!s) throw notFound('Table session');
    if (s.status === 'closed') throw conflict('session_closed', 'This table visit has already been settled');
    outletId = s.outlet_id;
  } else if (input.order_id) {
    const o = await tx.db.selectFrom('orders').select(['outlet_id', 'table_session_id', 'type', 'channel']).where('id', '=', input.order_id).forUpdate().executeTakeFirst();
    if (!o) throw notFound('Order');
    if (o.table_session_id) throw badRequest('use_table_bill', 'Dine-in orders are billed by table');
    outletId = o.outlet_id;
    delivery = o.type === 'delivery';
    taxByOperator = OPERATOR_CHANNELS.includes(o.channel as DeliveryChannel);
  } else {
    throw badRequest('scope_required', 'Give a table session or an order');
  }
  assertCan(auth, outletId, 'bill.manage');

  let existing = tx.db
    .selectFrom('bills')
    .select('id')
    .where('status', '=', 'draft')
    .where('item_scope', 'is', null);
  existing = input.table_session_id
    ? existing.where('table_session_id', '=', input.table_session_id)
    : existing.where('order_id', '=', input.order_id!);
  const draft = await existing.executeTakeFirst();
  if (draft) return getBill(tx, draft.id);

  const outlet = await outletFor(tx, outletId);
  const pending = await billableItems(tx, {
    id: '00000000-0000-0000-0000-000000000000',
    table_session_id: input.table_session_id ?? null,
    order_id: input.order_id ?? null,
    item_scope: null,
  });
  if (pending.length === 0) throw conflict('nothing_to_bill', 'There are no unbilled items. Accepted orders appear here.');

  // A guest who shared their phone at the table (or a takeaway customer) is carried onto the bill.
  const customerId = input.table_session_id
    ? ((await tx.db.selectFrom('table_sessions').select('customer_id').where('id', '=', input.table_session_id).executeTakeFirst())?.customer_id ?? null)
    : ((await tx.db.selectFrom('orders').select('customer_id').where('id', '=', input.order_id!).executeTakeFirst())?.customer_id ?? null);

  const bill = await tx.db
    .insertInto('bills')
    .values({
      tenant_id: tx.tenantId,
      outlet_id: outletId,
      table_session_id: input.table_session_id ?? null,
      order_id: input.order_id ?? null,
      customer_id: customerId,
      // Service charge is for guests served at the outlet, not for deliveries.
      service_charge_bp: delivery ? 0 : outlet.service_charge_bp,
      service_charge_tax_rate_bp: outlet.service_charge_tax_rate_bp,
      tax_by_operator: taxByOperator,
      created_by: auth.userId,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  // Birthday, comeback and this month's perk are found when the guest turns up.
  if (customerId) await refreshCustomer(tx, customerId, outletId);
  const dto = await getBill(tx, bill.id);
  await announceBill(tx, dto);
  return dto;
}

export interface UpdateBillInput {
  bill_discount?: BillDiscount | null;
  discount_reason?: string | null;
  service_charge_waived?: boolean;
  item_discounts?: Record<string, number>;
  customer_name?: string | null;
  customer_gstin?: string | null;
  customer_id?: string | null;
  redeem_points?: number;
}

export async function updateBill(
  tx: Tx,
  auth: StaffAuth,
  billId: string,
  input: UpdateBillInput,
  approvalToken?: string | null,
): Promise<BillDTO> {
  const bill = await lockBill(tx, billId);
  assertCan(auth, bill.outlet_id, 'bill.manage');
  if (bill.status !== 'draft') throw conflict('bill_finalised', 'This bill is already printed. Void it to make changes.');

  if (input.customer_id !== undefined || input.redeem_points !== undefined) {
    assertCan(auth, bill.outlet_id, 'customer.manage');
    const customerId = input.customer_id !== undefined ? input.customer_id : bill.customer_id;
    if (customerId !== bill.customer_id) {
      // Another guest (or none): the last guest's rewards leave the bill, free dishes included.
      await releaseRewards(tx, billId, auth.userId, { freeDishes: true });
      if (customerId) await refreshCustomer(tx, customerId, bill.outlet_id);
    }
    if (input.customer_id) await lockCustomer(tx, input.customer_id);
    const points = input.customer_id === null ? 0 : (input.redeem_points ?? (input.customer_id !== undefined ? 0 : bill.loyalty_points_redeemed));
    await validateRedemption(tx, customerId, points);
    await tx.db.updateTable('bills').set({ customer_id: customerId, loyalty_points_redeemed: points }).where('id', '=', billId).execute();
  }

  const touchesDiscount = input.bill_discount !== undefined || input.item_discounts !== undefined;
  if (touchesDiscount) {
    const anyDiscount =
      (input.bill_discount ?? bill.bill_discount) !== null ||
      Object.values(input.item_discounts ?? (bill.item_discounts as Record<string, number>) ?? {}).some((v) => v > 0);
    const reason = (input.discount_reason ?? bill.discount_reason ?? '').trim();
    if (anyDiscount && !reason) throw badRequest('reason_required', 'Give a reason for the discount');
  }

  const changes = {
    ...(input.bill_discount !== undefined ? { bill_discount: input.bill_discount ? json(input.bill_discount) : null } : {}),
    ...(input.discount_reason !== undefined ? { discount_reason: input.discount_reason?.trim() || null } : {}),
    ...(input.service_charge_waived !== undefined ? { service_charge_waived: input.service_charge_waived } : {}),
    ...(input.item_discounts !== undefined ? { item_discounts: json(input.item_discounts) } : {}),
    ...(input.customer_name !== undefined ? { customer_name: input.customer_name?.trim() || null } : {}),
    ...(input.customer_gstin !== undefined ? { customer_gstin: input.customer_gstin?.trim().toUpperCase() || null } : {}),
  };
  if (Object.keys(changes).length) await tx.db.updateTable('bills').set(changes).where('id', '=', billId).execute();
  await syncDraft(tx, billId);

  if (touchesDiscount) {
    const after = await lockBill(tx, billId);
    // Free dishes have their own permission and record; they do not count towards the limit.
    const free = await tx.db.selectFrom('bill_lines').select((eb) => eb.fn.sum<number>('comp_paise').as('paise')).where('bill_id', '=', billId).executeTakeFirst();
    const discount = after.item_discount_paise + after.bill_discount_paise - Number(free?.paise ?? 0);
    // Cashiers may give up to 10% without a manager.
    const limit = Math.round((after.subtotal_paise * CASHIER_DISCOUNT_LIMIT_BP) / 10000);
    let approvedBy: string | null = null;
    if (discount > limit) approvedBy = await requireApproval(tx, auth, bill.outlet_id, 'bill.discount_large', approvalToken);
    await audit(tx, auth, {
      outletId: bill.outlet_id,
      action: 'bill.discount',
      entity: 'bill',
      entityId: billId,
      before: { item_discount_paise: bill.item_discount_paise, bill_discount_paise: bill.bill_discount_paise },
      after: { item_discount_paise: after.item_discount_paise, bill_discount_paise: after.bill_discount_paise },
      reason: after.discount_reason,
      approvedBy,
    });
  }
  const dto = (await loadBill(tx, billId))!;
  await announceBill(tx, dto);
  return dto;
}

export type SplitInput =
  | { mode: 'items'; groups: string[][] }
  | { mode: 'seats' }
  | { mode: 'amount'; count?: number; amounts?: number[] };

/**
 * Splits a draft. By items or seats it becomes several bills (each with its own invoice); by
 * amount it stays one bill and one invoice, paid in shares.
 */
export async function splitBill(tx: Tx, auth: StaffAuth, billId: string, input: SplitInput): Promise<BillDTO[]> {
  const sale = await tx.db.selectFrom('bills').select('membership_id').where('id', '=', billId).executeTakeFirst();
  if (sale?.membership_id) throw badRequest('membership_bill', 'A membership bill cannot be split');
  await syncDraft(tx, billId);
  const bill = await lockBill(tx, billId);
  assertCan(auth, bill.outlet_id, 'bill.manage');
  if (bill.status !== 'draft') throw conflict('bill_finalised', 'Only an unprinted bill can be split');

  if (input.mode === 'amount') {
    let split: AmountSplit | null;
    if (input.amounts) {
      if (input.amounts.length < 2) throw badRequest('invalid_split', 'Split into at least two amounts');
      if (input.amounts.reduce((a, b) => a + b, 0) !== bill.total_paise) {
        throw badRequest('amounts_mismatch', 'The amounts must add up to the bill total', { total_paise: bill.total_paise });
      }
      split = { amounts: input.amounts };
    } else if (input.count && input.count >= 2) {
      split = { count: input.count };
    } else if (input.count === 1) {
      split = null;
    } else {
      throw badRequest('invalid_split', 'Give a number of people or the amounts');
    }
    await tx.db.updateTable('bills').set({ amount_shares: split ? json(split) : null }).where('id', '=', billId).execute();
    const dto = (await loadBill(tx, billId))!;
    await announceBill(tx, dto);
    return [dto];
  }

  const lines = await tx.db.selectFrom('bill_lines').select(['order_item_id', 'seat_no']).where('bill_id', '=', billId).execute();
  const itemIds = lines.map((l) => l.order_item_id!).filter(Boolean);
  let groups: string[][];
  if (input.mode === 'items') {
    groups = input.groups.filter((g) => g.length > 0);
    const flat = groups.flat();
    if (groups.length < 2) throw badRequest('invalid_split', 'Split into at least two bills');
    if (new Set(flat).size !== flat.length || flat.length !== itemIds.length || !flat.every((id) => itemIds.includes(id))) {
      throw badRequest('invalid_split', 'Every item on the bill must be in exactly one group');
    }
  } else {
    const bySeat = new Map<string, string[]>();
    for (const l of lines) {
      const key = l.seat_no == null ? 'shared' : String(l.seat_no);
      bySeat.set(key, [...(bySeat.get(key) ?? []), l.order_item_id!]);
    }
    if (bySeat.size < 2) throw badRequest('invalid_split', 'Assign items to at least two seats first');
    groups = [...bySeat.entries()].sort(([a], [b]) => (a === 'shared' ? 1 : b === 'shared' ? -1 : Number(a) - Number(b))).map(([, ids]) => ids);
  }

  const discounts = (bill.item_discounts ?? {}) as Record<string, number>;
  const created: string[] = [];
  for (const [index, group] of groups.entries()) {
    const row = await tx.db
      .insertInto('bills')
      .values({
        tenant_id: tx.tenantId,
        outlet_id: bill.outlet_id,
        table_session_id: bill.table_session_id,
        order_id: bill.order_id,
        split_label: `Split ${index + 1}/${groups.length}`,
        item_scope: json(group),
        item_discounts: json(Object.fromEntries(Object.entries(discounts).filter(([id]) => group.includes(id)))),
        bill_discount: bill.bill_discount ? json(bill.bill_discount) : null,
        discount_reason: bill.discount_reason,
        service_charge_bp: bill.service_charge_bp,
        service_charge_waived: bill.service_charge_waived,
        service_charge_tax_rate_bp: bill.service_charge_tax_rate_bp,
        customer_name: bill.customer_name,
        customer_gstin: bill.customer_gstin,
        customer_id: bill.customer_id,
        created_by: auth.userId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    created.push(row.id);
  }
  // The unsplit draft never had an invoice number, so it can simply go. Money-off rewards on it go
  // back to the guest, to use on one of the parts.
  await detachRewards(tx, billId);
  await tx.db.deleteFrom('bills').where('id', '=', billId).execute();
  for (const id of created) await syncDraft(tx, id);
  const dtos = await loadBills(tx, created);
  for (const dto of dtos) await announceBill(tx, dto);
  return dtos;
}

/**
 * How many bottles of the water left on the table the guests opened. The count goes on the bill
 * as a served order of the outlet's water item (no kitchen ticket); changing it before printing
 * changes that order. Asked once per visit, for every bill of the table.
 */
export async function setWaterBottles(tx: Tx, auth: StaffAuth, billId: string, count: number): Promise<BillDTO> {
  const bill = await lockBill(tx, billId);
  assertCan(auth, bill.outlet_id, 'bill.manage');
  if (bill.status !== 'draft') throw conflict('bill_finalised', 'This bill is already printed');
  if (!bill.table_session_id) throw badRequest('not_a_table_bill', 'Water bottles are counted on table bills');
  const outlet = await outletFor(tx, bill.outlet_id);
  if (!outlet.table_water_item_id) throw badRequest('water_check_off', 'Choose the bottled water item in Settings first');
  const session = await tx.db
    .selectFrom('table_sessions')
    .select(['id', 'water_order_id'])
    .where('id', '=', bill.table_session_id)
    .forUpdate()
    .executeTakeFirstOrThrow();

  let orderId = session.water_order_id;
  const item = orderId ? await tx.db.selectFrom('order_items').select(['id', 'qty', 'status']).where('order_id', '=', orderId).executeTakeFirst() : undefined;
  const live = item && item.status !== 'cancelled' ? item : undefined;
  if (live && live.qty !== count) {
    const printed = await tx.db
      .selectFrom('bill_lines')
      .innerJoin('bills', 'bills.id', 'bill_lines.bill_id')
      .select('bills.id')
      .where('bill_lines.order_item_id', '=', live.id)
      .where('bills.status', 'in', ['finalised', 'paid'])
      .executeTakeFirst();
    if (printed) throw conflict('water_billed', 'The water is already on a printed bill');
  }
  if (live && count === 0) {
    const reason = 'Bottled water not opened';
    await tx.db.updateTable('order_items').set({ status: 'cancelled', cancelled_reason: reason }).where('id', '=', live.id).execute();
    await tx.db.updateTable('orders').set({ status: 'cancelled', cancelled_reason: reason }).where('id', '=', orderId!).execute();
  } else if (live && count !== live.qty) {
    await tx.db.updateTable('order_items').set({ qty: count }).where('id', '=', live.id).execute();
  } else if (!live && count > 0) {
    const order = await createOrder(tx, {
      outletId: bill.outlet_id,
      type: 'dine_in',
      source: 'pos',
      sessionId: bill.table_session_id,
      lines: [{ item_id: outlet.table_water_item_id, qty: count, modifier_ids: [] }],
      note: 'Bottled water opened at the table',
      createdBy: auth.userId,
      alreadyServed: true,
    });
    orderId = order.id;
  }
  await tx.db.updateTable('table_sessions').set({ water_bottles: count, water_order_id: orderId }).where('id', '=', session.id).execute();
  await syncDraft(tx, billId);
  const dto = (await loadBill(tx, billId))!;
  await announceBill(tx, dto);
  return dto;
}

/** Discards an unprinted draft (no invoice number was used). */
export async function discardDraft(tx: Tx, auth: StaffAuth, billId: string): Promise<void> {
  const bill = await lockBill(tx, billId);
  assertCan(auth, bill.outlet_id, 'bill.manage');
  if (bill.status !== 'draft') throw conflict('bill_finalised', 'A printed bill must be voided, not discarded');
  await detachRewards(tx, billId);
  await cancelMembership(tx, billId);
  await tx.db.deleteFrom('bills').where('id', '=', billId).execute();
  await tx.emit({ outletId: bill.outlet_id, type: 'bill.updated', channels: ['outlet'], payload: { bill_id: billId, status: 'discarded', table_session_id: bill.table_session_id } });
}

/**
 * Freezes the bill and assigns the next invoice number for the outlet and financial year. The
 * counter row lock serialises concurrent finalisations, and a rollback returns the number, so the
 * sequence never has gaps or duplicates.
 */
export async function finaliseBill(tx: Tx, auth: StaffAuth, billId: string): Promise<BillDTO> {
  await syncDraft(tx, billId);
  const bill = await lockBill(tx, billId);
  assertCan(auth, bill.outlet_id, 'bill.manage');
  if (bill.status !== 'draft') throw conflict('bill_finalised', 'This bill is already printed');
  const lineCount = await tx.db.selectFrom('bill_lines').select(sql<number>`count(*)`.as('n')).where('bill_id', '=', billId).executeTakeFirstOrThrow();
  if (Number(lineCount.n) === 0) throw conflict('nothing_to_bill', 'This bill has no items');
  const split = shares(bill.amount_shares, bill.total_paise);
  if (split && split.reduce((a, b) => a + b, 0) !== bill.total_paise) {
    throw conflict('amounts_mismatch', 'The split amounts no longer add up to the total; split again');
  }
  if (bill.customer_gstin && !/^[0-9]{2}[A-Z0-9]{13}$/.test(bill.customer_gstin)) {
    throw badRequest('invalid_gstin', 'Customer GSTIN must be 15 characters');
  }

  const outlet = await outletFor(tx, bill.outlet_id);
  // Bottled water left on the table is billed only if opened, so someone has to look first.
  if (bill.table_session_id && outlet.table_water_item_id) {
    const session = await tx.db.selectFrom('table_sessions').select('water_bottles').where('id', '=', bill.table_session_id).executeTakeFirst();
    if (session && session.water_bottles === null) throw conflict('water_check', 'Count the opened water bottles at the table before printing the bill');
  }
  const now = new Date();
  const day = businessDate(now, outlet.timezone);
  const fy = financialYear(day);
  const seq = await nextCounter(tx, outlet.id, 'invoice', fy.code);
  await tx.db
    .updateTable('bills')
    .set({
      status: bill.total_paise === 0 ? 'paid' : 'finalised',
      fy_code: fy.code,
      invoice_seq: seq,
      invoice_no: formatInvoiceNo(outlet.invoice_prefix, fy.code, seq),
      invoice_date: day,
      outlet_snapshot: json({
        name: outlet.name,
        legal_name: outlet.legal_name,
        address: [outlet.address, outlet.city].filter(Boolean).join(', ') || null,
        gstin: outlet.gstin,
        fssai_no: outlet.fssai_no,
        phone: outlet.phone,
        state_code: outlet.state_code,
      }),
      finalised_at: now,
      finalised_by: auth.userId,
      ...(bill.total_paise === 0 ? { paid_at: now } : {}),
    })
    .where('id', '=', billId)
    .execute();

  await redeemOnFinalise(tx, bill, auth.userId);
  await rewardsOnPrint(tx, billId);
  await markFullyBilledOrders(tx, billId);
  if (await canPrint(tx, outlet.id, 'bill')) await printBill(tx, billId, false);
  if (bill.total_paise === 0) {
    await earnOnPaid(tx, billId, auth.userId);
    await activateMembership(tx, billId);
    await settleSessionIfDone(tx, billId);
  }
  const dto = (await loadBill(tx, billId))!;
  await announceBill(tx, dto);
  return dto;
}

export async function markFullyBilledOrders(tx: Tx, billId: string): Promise<void> {
  const orderIds = await tx.db
    .selectFrom('bill_lines')
    .innerJoin('order_items', 'order_items.id', 'bill_lines.order_item_id')
    .select('order_items.order_id')
    .distinct()
    .where('bill_lines.bill_id', '=', billId)
    .execute();
  const done: string[] = [];
  for (const { order_id } of orderIds) {
    const unbilled = await tx.db
      .selectFrom('order_items')
      .select('order_items.id')
      .where('order_items.order_id', '=', order_id)
      .where('order_items.status', '<>', 'cancelled')
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom('bill_lines')
              .innerJoin('bills', 'bills.id', 'bill_lines.bill_id')
              .select('bill_lines.id')
              .whereRef('bill_lines.order_item_id', '=', 'order_items.id')
              .where('bills.status', 'in', ['finalised', 'paid']),
          ),
        ),
      )
      .executeTakeFirst();
    if (!unbilled) done.push(order_id);
  }
  await markOrdersBilled(tx, done);
}

export async function printBill(tx: Tx, billId: string, duplicate: boolean) {
  const invoice = await loadInvoice(tx, billId);
  if (!invoice || invoice.bill.status === 'draft') throw conflict('bill_not_finalised', 'Finalise the bill before printing');
  const outlet = await outletFor(tx, invoice.bill.outlet_id);
  // Counter and takeaway: the number to collect with, and a link to follow the order.
  const order = invoice.bill.order_id
    ? await tx.db.selectFrom('orders').select(['type', 'order_no', 'track_code']).where('id', '=', invoice.bill.order_id).executeTakeFirst()
    : undefined;
  const pickup = order && (order.type === 'takeaway' || order.type === 'counter');
  const doc: BillDoc = {
    kind: 'bill',
    invoice,
    upi_uri: upiUri(outlet.upi_vpa, outlet.upi_payee_name ?? outlet.name, invoice.bill.balance_paise || invoice.bill.total_paise, invoice.bill.invoice_no ?? ''),
    duplicate,
    pickup_no: pickup ? order.order_no : null,
    track_code: pickup ? order.track_code : null,
  };
  return queuePrintJob(tx, outlet.id, { target: 'bill', refId: billId, doc });
}

/**
 * Closes the table session once every bill is paid, nothing is left unbilled and the kitchen has
 * nothing open. The guests' QR session dies with it (spec §5).
 */
async function settleSessionIfDone(tx: Tx, billId: string): Promise<boolean> {
  const bill = await tx.db.selectFrom('bills').select(['table_session_id']).where('id', '=', billId).executeTakeFirstOrThrow();
  const sessionId = bill.table_session_id;
  if (!sessionId) return false;
  const unpaid = await tx.db
    .selectFrom('bills')
    .select('id')
    .where('table_session_id', '=', sessionId)
    .where('status', 'in', ['draft', 'finalised'])
    .executeTakeFirst();
  if (unpaid) return false;
  const leftover = await billableItems(tx, { id: '00000000-0000-0000-0000-000000000000', table_session_id: sessionId, order_id: null, item_scope: null });
  if (leftover.length) return false;
  const waiting = await tx.db
    .selectFrom('orders')
    .select('id')
    .where('table_session_id', '=', sessionId)
    .where('status', '=', 'placed')
    .executeTakeFirst();
  if (waiting) return false;
  await closeSession(tx, sessionId, 'order');
  return true;
}

export interface PaymentInput {
  method: PaymentMethod;
  amount_paise: number;
  tendered_paise?: number | null;
  reference?: string | null;
  /** Charge to room: the room, and the guest's name if known. */
  room_no?: string | null;
  room_guest?: string | null;
  /** From a code the guest read out (wallet payments). */
  wallet_proof?: string | null;
}

/** Room charges need the outlet to allow them and a room number; returns the cleaned fields. */
export async function roomFields(tx: Tx, outletId: string, input: PaymentInput): Promise<{ room_no: string | null; room_guest: string | null }> {
  if (input.method !== 'room') return { room_no: null, room_guest: null };
  const outlet = await tx.db.selectFrom('outlets').select('room_charge_enabled').where('id', '=', outletId).executeTakeFirstOrThrow();
  if (!outlet.room_charge_enabled) throw badRequest('room_charge_disabled', 'This outlet does not charge bills to rooms');
  const room = input.room_no?.trim().toUpperCase() ?? '';
  if (!/^[A-Z0-9][A-Z0-9 -]{0,9}$/.test(room)) throw badRequest('room_required', 'Enter the room number');
  return { room_no: room, room_guest: input.room_guest?.trim().slice(0, 80) || null };
}

/**
 * Records cash, UPI (to the outlet's own QR, confirmed by staff), card slip, other, room, platform,
 * or the guest's wallet (with proof the guest is there; see spendFromWallet).
 */
export async function recordPayment(
  tx: Tx,
  auth: StaffAuth,
  billId: string,
  input: PaymentInput,
  wallet: { approvalToken?: string | null; secret: string; smsReady: boolean } = { secret: '', smsReady: false },
): Promise<BillDTO> {
  const bill = await lockBill(tx, billId);
  assertCan(auth, bill.outlet_id, 'payment.record');
  if (bill.status === 'draft') throw conflict('bill_not_finalised', 'Print (finalise) the bill before taking payment');
  if (bill.status !== 'finalised') throw conflict('bill_closed', `This bill is ${bill.status}`);
  const balance = bill.total_paise - bill.paid_paise;
  if (input.amount_paise > balance) {
    throw badRequest('overpayment', 'Payment is more than the balance due', { balance_paise: balance });
  }
  // The guest paid Zomato or Swiggy, which pays the outlet in its payout; nothing else settles it.
  if (bill.tax_by_operator && input.method !== 'platform') throw badRequest('paid_by_platform', 'This order was paid on the delivery app. Record it as paid by the platform.');
  if (!bill.tax_by_operator && input.method === 'platform') throw badRequest('not_a_platform_order', 'Only Zomato and Swiggy orders are paid by the platform');
  const confirmation = await paymentAdapterFor(input.method).confirm({
    billId,
    invoiceNo: bill.invoice_no,
    method: input.method,
    amountPaise: input.amount_paise,
    reference: input.reference ?? null,
  });
  if (confirmation.status !== 'confirmed') {
    throw conflict('payment_not_confirmed', confirmation.status === 'failed' ? confirmation.reason : 'Payment is still pending');
  }
  const room = await roomFields(tx, bill.outlet_id, input);
  const fromWallet = input.method === 'wallet' ? await spendFromWallet(tx, auth, bill, input.amount_paise, { walletProof: input.wallet_proof, approvalToken: wallet.approvalToken }, wallet) : null;
  let change: number | null = null;
  if (input.method === 'cash' && input.tendered_paise != null) {
    if (input.tendered_paise < input.amount_paise) throw badRequest('tendered_short', 'Cash tendered is less than the amount');
    change = input.tendered_paise - input.amount_paise;
  }
  const payment = await tx.db
    .insertInto('payments')
    .values({
      tenant_id: tx.tenantId,
      outlet_id: bill.outlet_id,
      bill_id: billId,
      method: input.method,
      amount_paise: input.amount_paise,
      tendered_paise: input.method === 'cash' ? (input.tendered_paise ?? null) : null,
      change_paise: change,
      reference: confirmation.reference,
      confirmed_by: auth.userId,
      ...room,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  if (fromWallet) await logWalletSpend(tx, { id: bill.id, outlet_id: bill.outlet_id, customer_id: bill.customer_id! }, payment.id, fromWallet, auth.userId);
  const paid = bill.paid_paise + input.amount_paise;
  const fullyPaid = paid >= bill.total_paise;
  await tx.db
    .updateTable('bills')
    .set({ paid_paise: paid, ...(fullyPaid ? { status: 'paid', paid_at: new Date() } : {}) })
    .where('id', '=', billId)
    .execute();
  if (fullyPaid) {
    await earnOnPaid(tx, billId, auth.userId);
    await activateMembership(tx, billId);
    await settleSessionIfDone(tx, billId);
  }
  if (input.method === 'cash') await openCashDrawer(tx, bill.outlet_id);
  const dto = (await loadBill(tx, billId))!;
  await announceBill(tx, dto);
  return dto;
}

/** Cancels a printed bill. Its invoice number stays used and shows as cancelled (spec §8). */
export async function voidBill(tx: Tx, auth: StaffAuth, billId: string, reason: string, approvalToken?: string | null): Promise<BillDTO> {
  const bill = await lockBill(tx, billId);
  if (!reason.trim()) throw badRequest('reason_required', 'Give a reason for voiding');
  if (bill.status === 'draft') throw conflict('bill_not_finalised', 'Discard the draft instead');
  if (bill.status === 'void') throw conflict('bill_void', 'This bill is already void');
  if (bill.paid_paise > 0) throw conflict('bill_has_payments', 'Refund the payments before voiding');
  const approvedBy = await requireApproval(tx, auth, bill.outlet_id, 'bill.void', approvalToken);
  await tx.db
    .updateTable('bills')
    .set({ status: 'void', voided_at: new Date(), voided_by: auth.userId, void_reason: reason.trim() })
    .where('id', '=', billId)
    .execute();
  await reverseOnVoid(tx, bill, auth.userId);
  await rewardsOnVoid(tx, billId);
  await cancelMembership(tx, billId);
  // Orders marked billed by this bill go back to served so their items can be billed again.
  const orderIds = await tx.db
    .selectFrom('bill_lines')
    .innerJoin('order_items', 'order_items.id', 'bill_lines.order_item_id')
    .select('order_items.order_id')
    .distinct()
    .where('bill_lines.bill_id', '=', billId)
    .execute();
  if (orderIds.length) {
    await tx.db
      .updateTable('orders')
      .set({ status: 'served' })
      .where('id', 'in', orderIds.map((o) => o.order_id))
      .where('status', '=', 'billed')
      .execute();
  }
  await audit(tx, auth, {
    outletId: bill.outlet_id,
    action: 'bill.void',
    entity: 'bill',
    entityId: billId,
    before: { status: bill.status, invoice_no: bill.invoice_no, total_paise: bill.total_paise },
    after: { status: 'void' },
    reason,
    approvedBy,
  });
  const dto = (await loadBill(tx, billId))!;
  await announceBill(tx, dto);
  return dto;
}

export async function refundPayment(
  tx: Tx,
  auth: StaffAuth,
  paymentId: string,
  input: { amount_paise: number; reason: string },
  approvalToken?: string | null,
): Promise<BillDTO> {
  const payment = await tx.db.selectFrom('payments').selectAll().where('id', '=', paymentId).executeTakeFirst();
  // Wallet top-ups are given back from the guest's wallet (cash-out), not here.
  if (!payment || payment.kind !== 'payment' || !payment.bill_id) throw notFound('Payment');
  const bill = await lockBill(tx, payment.bill_id);
  if (!input.reason.trim()) throw badRequest('reason_required', 'Give a reason for the refund');
  const refunded = await tx.db
    .selectFrom('payments')
    .select(sql<number>`coalesce(sum(amount_paise), 0)`.as('total'))
    .where('bill_id', '=', bill.id)
    .where('kind', '=', 'refund')
    .where('reference', '=', paymentId)
    .executeTakeFirstOrThrow();
  if (input.amount_paise > payment.amount_paise - Number(refunded.total)) {
    throw badRequest('refund_too_large', 'Refund is more than what is left of this payment');
  }
  const approvedBy = await requireApproval(tx, auth, bill.outlet_id, 'payment.refund', approvalToken);
  await tx.db
    .insertInto('payments')
    .values({
      tenant_id: tx.tenantId,
      outlet_id: bill.outlet_id,
      bill_id: bill.id,
      kind: 'refund',
      method: payment.method,
      amount_paise: input.amount_paise,
      reference: paymentId,
      confirmed_by: auth.userId,
      approved_by: approvedBy,
      reason: input.reason.trim(),
      // A refunded room charge comes off the same folio.
      room_no: payment.room_no,
      room_guest: payment.room_guest,
    })
    .execute();
  // Paid from the wallet: it goes back into the wallet.
  if (payment.method === 'wallet') await refundToWallet(tx, { id: payment.id, bill_id: bill.id, outlet_id: bill.outlet_id, amount_paise: payment.amount_paise }, input.amount_paise, auth.userId);
  const paid = bill.paid_paise - input.amount_paise;
  await tx.db
    .updateTable('bills')
    .set({ paid_paise: paid, ...(bill.status === 'paid' && paid < bill.total_paise ? { status: 'finalised', paid_at: null } : {}) })
    .where('id', '=', bill.id)
    .execute();
  await audit(tx, auth, {
    outletId: bill.outlet_id,
    action: 'payment.refund',
    entity: 'payment',
    entityId: paymentId,
    before: { paid_paise: bill.paid_paise },
    after: { paid_paise: paid, refund_paise: input.amount_paise },
    reason: input.reason,
    approvedBy,
  });
  const dto = (await loadBill(tx, bill.id))!;
  await announceBill(tx, dto);
  return dto;
}

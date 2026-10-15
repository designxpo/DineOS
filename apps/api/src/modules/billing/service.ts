// Bills, splits, GST invoices and payments (spec §8). Drafts are recomputed from orders on every
// read and change; finalising freezes the lines and takes the next gap-free invoice number.

import { computeBill, type BillDiscount } from '@dineos/shared/billing';
import { businessDate, financialYear, formatInvoiceNo } from '@dineos/shared/dates';
import type { BillDTO } from '@dineos/shared/dto';
import type { PaymentMethod } from '@dineos/shared/enums';
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
import { markOrdersBilled } from '../orders/service';
import { hasPrintAgent, queuePrintJob } from '../print/jobs';
import { closeSession } from '../tables/sessions';
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
async function billableItems(tx: Tx, bill: Pick<BillRow, 'id' | 'table_session_id' | 'order_id' | 'item_scope'>) {
  let q = tx.db
    .selectFrom('order_items')
    .innerJoin('orders', 'orders.id', 'order_items.order_id')
    .select([
      'order_items.id',
      'order_items.order_id',
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

function lineName(name: string, modifiers: unknown): string {
  const mods = Array.isArray(modifiers) ? (modifiers as { name: string }[]).map((m) => m.name) : [];
  return mods.length ? `${name} (${mods.join(', ')})` : name;
}

/** Recomputes a draft from its orders and stores lines and totals. No-op for finalised bills. */
export async function syncDraft(tx: Tx, billId: string): Promise<void> {
  const bill = await lockBill(tx, billId);
  if (bill.status !== 'draft') return;
  const outlet = await outletFor(tx, bill.outlet_id);
  const items = await billableItems(tx, bill);
  const discounts = (bill.item_discounts ?? {}) as Record<string, number>;
  const totals = computeBill({
    lines: items.map((i) => ({
      key: i.id,
      qty: i.qty,
      unit_price_paise: i.unit_price_paise,
      tax_rate_bp: i.tax_rate_bp,
      item_discount_paise: discounts[i.id] ?? 0,
    })),
    bill_discount: (bill.bill_discount ?? null) as BillDiscount | null,
    service_charge_bp: bill.service_charge_waived ? 0 : bill.service_charge_bp,
    service_charge_tax_rate_bp: outlet.service_charge_tax_rate_bp,
    prices_include_tax: outlet.prices_include_tax,
  });

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
    })
    .where('id', '=', billId)
    .execute();
}

export async function getBill(tx: Tx, billId: string): Promise<BillDTO> {
  await syncDraft(tx, billId);
  const bill = await loadBill(tx, billId);
  if (!bill) throw notFound('Bill');
  return bill;
}

async function announceBill(tx: Tx, bill: BillDTO): Promise<void> {
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
    const o = await tx.db.selectFrom('orders').select(['outlet_id', 'table_session_id']).where('id', '=', input.order_id).forUpdate().executeTakeFirst();
    if (!o) throw notFound('Order');
    if (o.table_session_id) throw badRequest('use_table_bill', 'Dine-in orders are billed by table');
    outletId = o.outlet_id;
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

  const bill = await tx.db
    .insertInto('bills')
    .values({
      tenant_id: tx.tenantId,
      outlet_id: outletId,
      table_session_id: input.table_session_id ?? null,
      order_id: input.order_id ?? null,
      service_charge_bp: outlet.service_charge_bp,
      service_charge_tax_rate_bp: outlet.service_charge_tax_rate_bp,
      created_by: auth.userId,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
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

  const touchesDiscount = input.bill_discount !== undefined || input.item_discounts !== undefined;
  if (touchesDiscount) {
    const anyDiscount =
      (input.bill_discount ?? bill.bill_discount) !== null ||
      Object.values(input.item_discounts ?? (bill.item_discounts as Record<string, number>) ?? {}).some((v) => v > 0);
    const reason = (input.discount_reason ?? bill.discount_reason ?? '').trim();
    if (anyDiscount && !reason) throw badRequest('reason_required', 'Give a reason for the discount');
  }

  await tx.db
    .updateTable('bills')
    .set({
      ...(input.bill_discount !== undefined ? { bill_discount: input.bill_discount ? json(input.bill_discount) : null } : {}),
      ...(input.discount_reason !== undefined ? { discount_reason: input.discount_reason?.trim() || null } : {}),
      ...(input.service_charge_waived !== undefined ? { service_charge_waived: input.service_charge_waived } : {}),
      ...(input.item_discounts !== undefined ? { item_discounts: json(input.item_discounts) } : {}),
      ...(input.customer_name !== undefined ? { customer_name: input.customer_name?.trim() || null } : {}),
      ...(input.customer_gstin !== undefined ? { customer_gstin: input.customer_gstin?.trim().toUpperCase() || null } : {}),
    })
    .where('id', '=', billId)
    .execute();
  await syncDraft(tx, billId);

  if (touchesDiscount) {
    const after = await lockBill(tx, billId);
    const discount = after.item_discount_paise + after.bill_discount_paise;
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
        created_by: auth.userId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    created.push(row.id);
  }
  // The unsplit draft never had an invoice number, so it can simply go.
  await tx.db.deleteFrom('bills').where('id', '=', billId).execute();
  for (const id of created) await syncDraft(tx, id);
  const dtos = await loadBills(tx, created);
  for (const dto of dtos) await announceBill(tx, dto);
  return dtos;
}

/** Discards an unprinted draft (no invoice number was used). */
export async function discardDraft(tx: Tx, auth: StaffAuth, billId: string): Promise<void> {
  const bill = await lockBill(tx, billId);
  assertCan(auth, bill.outlet_id, 'bill.manage');
  if (bill.status !== 'draft') throw conflict('bill_finalised', 'A printed bill must be voided, not discarded');
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

  await markFullyBilledOrders(tx, billId);
  if (await hasPrintAgent(tx, outlet.id)) await printBill(tx, billId, false);
  if (bill.total_paise === 0) await settleSessionIfDone(tx, billId);
  const dto = (await loadBill(tx, billId))!;
  await announceBill(tx, dto);
  return dto;
}

async function markFullyBilledOrders(tx: Tx, billId: string): Promise<void> {
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
  const doc: BillDoc = {
    kind: 'bill',
    invoice,
    upi_uri: upiUri(outlet.upi_vpa, outlet.upi_payee_name ?? outlet.name, invoice.bill.balance_paise || invoice.bill.total_paise, invoice.bill.invoice_no ?? ''),
    duplicate,
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
}

/** Records cash, UPI (to the outlet's own QR, confirmed by staff), card slip or other payment. */
export async function recordPayment(tx: Tx, auth: StaffAuth, billId: string, input: PaymentInput): Promise<BillDTO> {
  const bill = await lockBill(tx, billId);
  assertCan(auth, bill.outlet_id, 'payment.record');
  if (bill.status === 'draft') throw conflict('bill_not_finalised', 'Print (finalise) the bill before taking payment');
  if (bill.status !== 'finalised') throw conflict('bill_closed', `This bill is ${bill.status}`);
  const balance = bill.total_paise - bill.paid_paise;
  if (input.amount_paise > balance) {
    throw badRequest('overpayment', 'Payment is more than the balance due', { balance_paise: balance });
  }
  let change: number | null = null;
  if (input.method === 'cash' && input.tendered_paise != null) {
    if (input.tendered_paise < input.amount_paise) throw badRequest('tendered_short', 'Cash tendered is less than the amount');
    change = input.tendered_paise - input.amount_paise;
  }
  await tx.db
    .insertInto('payments')
    .values({
      tenant_id: tx.tenantId,
      outlet_id: bill.outlet_id,
      bill_id: billId,
      method: input.method,
      amount_paise: input.amount_paise,
      tendered_paise: input.method === 'cash' ? (input.tendered_paise ?? null) : null,
      change_paise: change,
      reference: input.reference?.trim() || null,
      confirmed_by: auth.userId,
    })
    .execute();
  const paid = bill.paid_paise + input.amount_paise;
  const fullyPaid = paid >= bill.total_paise;
  await tx.db
    .updateTable('bills')
    .set({ paid_paise: paid, ...(fullyPaid ? { status: 'paid', paid_at: new Date() } : {}) })
    .where('id', '=', billId)
    .execute();
  if (fullyPaid) await settleSessionIfDone(tx, billId);
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
  if (!payment || payment.kind !== 'payment') throw notFound('Payment');
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
    })
    .execute();
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

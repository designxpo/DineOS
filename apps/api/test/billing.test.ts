import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BillDTO, InvoiceDTO, OrderDTO, TableDTO } from '@dineos/shared/dto';
import { nextCounter } from '../src/lib/counters';
import { closeSession } from '../src/modules/tables/sessions';
import {
  addStaff,
  api,
  createMenu,
  createTable,
  createTenant,
  setOutlet,
  startApp,
  type TestApp,
  type TestMenu,
  type TestTenant,
} from './helpers';

let t: TestApp;
let tenant: TestTenant;
let menu: TestMenu;
let owner: ReturnType<typeof api>;
let cashier: ReturnType<typeof api>;
let manager: { login: string };

beforeAll(async () => {
  t = await startApp();
  tenant = await createTenant(t, { invoicePrefix: 'AURM' });
  menu = await createMenu(t, tenant);
  owner = api(t, tenant.ownerToken);
  cashier = api(t, (await addStaff(t, tenant, 'cashier')).token);
  manager = await addStaff(t, tenant, 'manager', { pin: '1357' });
  // Some cases need a guest order that staff have not accepted yet.
  await setOutlet(t, tenant.outletId, { auto_accept: false });
});
afterAll(() => t.close());

type Line = { item_id: string; qty: number; modifier_ids?: string[]; seat_no?: number };

async function dineIn(label: string, lines: Line[]): Promise<{ order: OrderDTO; tableId: string; sessionId: string }> {
  const tableId = await createTable(t, tenant, label);
  const res = await cashier({ method: 'POST', url: '/v1/orders', payload: { outlet_id: tenant.outletId, type: 'dine_in', table_id: tableId, lines } });
  expect(res.statusCode).toBe(201);
  const order: OrderDTO = res.json();
  return { order, tableId, sessionId: order.table_session_id! };
}

async function openBill(sessionId: string): Promise<BillDTO> {
  const res = await cashier({ method: 'POST', url: '/v1/bills', payload: { table_session_id: sessionId } });
  expect(res.statusCode).toBe(201);
  return res.json();
}

async function approval(action: string): Promise<string> {
  const res = await cashier({ method: 'POST', url: '/v1/approvals', payload: { outlet_id: tenant.outletId, action, login: manager.login, pin: '1357' } });
  return res.json().approval_token;
}

const standard: Line[] = [
  { item_id: '', qty: 2 }, // paneer, filled in below
  { item_id: '', qty: 1 }, // chicken (18%)
];
const lines = () => [
  { ...standard[0]!, item_id: menu.paneerTikka },
  { ...standard[1]!, item_id: menu.chickenTikka },
];

describe('bills', () => {
  it('computes GST per rate and excludes orders the outlet has not accepted', async () => {
    const { sessionId } = await dineIn('B1', lines());
    // A guest order still waiting for approval must not be billed.
    const { createOrder } = await import('../src/modules/orders/service');
    await t.ctx.tx(tenant.tenantId, (tx) =>
      createOrder(tx, { outletId: tenant.outletId, type: 'dine_in', source: 'guest_qr', sessionId, lines: [{ item_id: menu.paneerTikka, qty: 5, modifier_ids: [] }] }),
    );
    const bill = await openBill(sessionId);
    expect(bill.status).toBe('draft');
    expect(bill.lines).toHaveLength(2);
    expect(bill.subtotal_paise).toBe(82000);
    // 50000 @5% = 2500, 32000 @18% = 5760
    expect(bill.tax_total_paise).toBe(2500 + 5760);
    expect(bill.cgst_paise).toBe(bill.sgst_paise);
    expect(bill.total_paise).toBe(90300);
    expect(bill.round_off_paise).toBe(40);

    // Opening the bill again returns the same draft.
    expect((await openBill(sessionId)).id).toBe(bill.id);
  });

  it('applies service charge, and staff can remove it', async () => {
    await setOutlet(t, tenant.outletId, { service_charge_bp: 1000 });
    const { sessionId } = await dineIn('B2', lines());
    const bill = await openBill(sessionId);
    expect(bill.service_charge_paise).toBe(8200);
    const waived = await cashier({ method: 'PATCH', url: `/v1/bills/${bill.id}`, payload: { service_charge_waived: true } });
    expect(waived.json().service_charge_paise).toBe(0);
    await setOutlet(t, tenant.outletId, { service_charge_bp: 0 });
  });

  it('lets a cashier give up to 10% and needs a manager beyond that', async () => {
    const { sessionId } = await dineIn('B3', lines());
    const bill = await openBill(sessionId);
    const noReason = await cashier({ method: 'PATCH', url: `/v1/bills/${bill.id}`, payload: { bill_discount: { kind: 'percent', bp: 500 } } });
    expect(noReason.json().error.code).toBe('reason_required');
    const small = await cashier({ method: 'PATCH', url: `/v1/bills/${bill.id}`, payload: { bill_discount: { kind: 'percent', bp: 1000 }, discount_reason: 'Regular guest' } });
    expect(small.statusCode).toBe(200);
    expect(small.json().bill_discount_paise).toBe(8200);

    const big = { bill_discount: { kind: 'percent', bp: 2500 }, discount_reason: 'Complaint about wait' };
    const denied = await cashier({ method: 'PATCH', url: `/v1/bills/${bill.id}`, payload: big });
    expect(denied.json().error.code).toBe('approval_required');
    expect((await cashier({ method: 'GET', url: `/v1/bills/${bill.id}` })).json().bill_discount_paise).toBe(8200); // rolled back
    const ok = await cashier({ method: 'PATCH', url: `/v1/bills/${bill.id}`, payload: big, headers: { 'x-approval-token': await approval('bill.discount_large') } });
    expect(ok.json().bill_discount_paise).toBe(20500);
    const log = await t.ctx.adminDb.selectFrom('audit_log').select(['approved_by', 'reason']).where('entity_id', '=', bill.id).orderBy('created_at', 'desc').executeTakeFirstOrThrow();
    expect(log.reason).toBe('Complaint about wait');
    expect(log.approved_by).not.toBeNull();
  });

  it('acceptance: split three ways, paid with mixed cash and UPI, GST invoice with a gap-free number', async () => {
    const { sessionId, tableId } = await dineIn('B4', lines());
    const bill = await openBill(sessionId);
    const split = await cashier({ method: 'POST', url: `/v1/bills/${bill.id}/split`, payload: { mode: 'amount', count: 3 } });
    expect(split.statusCode).toBe(200);
    const shares: number[] = split.json()[0].amount_shares;
    expect(shares).toEqual([30100, 30100, 30100]);

    const finalised = await cashier({ method: 'POST', url: `/v1/bills/${bill.id}/finalise` });
    expect(finalised.statusCode).toBe(200);
    const fb: BillDTO = finalised.json();
    expect(fb.status).toBe('finalised');
    expect(fb.invoice_no).toMatch(/^AURM\/\d{4}\/\d{6}$/);
    expect(fb.invoice_no!.length).toBeLessThanOrEqual(16);

    const pay = (payload: object) => cashier({ method: 'POST', url: `/v1/bills/${bill.id}/payments`, payload });
    expect((await pay({ method: 'cash', amount_paise: shares[0], tendered_paise: 50000 })).json().payments[0].change_paise).toBe(19900);
    await pay({ method: 'upi', amount_paise: shares[1], reference: 'UTR 4021 9988' });
    expect((await pay({ method: 'cash', amount_paise: shares[2]! + 1 })).json().error.code).toBe('overpayment');
    const done = await pay({ method: 'cash', amount_paise: shares[2] });
    const paid: BillDTO = done.json();
    expect(paid.status).toBe('paid');
    expect(paid.balance_paise).toBe(0);
    expect(paid.payments.map((p) => p.method)).toEqual(['cash', 'upi', 'cash']);

    // Paying in full closes the table visit and flags the table for cleaning.
    const session = await t.ctx.adminDb.selectFrom('table_sessions').select('status').where('id', '=', sessionId).executeTakeFirstOrThrow();
    expect(session.status).toBe('closed');
    expect((await owner({ method: 'GET', url: `/v1/tables/${tableId}` })).json().state).toBe('needs_cleaning');

    const invoice: InvoiceDTO = (await cashier({ method: 'GET', url: `/v1/bills/${bill.id}/invoice` })).json();
    expect(invoice.outlet.gstin).toBe('29ABCDE1234F1Z5');
    expect(invoice.tax_summary.map((r) => r.tax_rate_bp)).toEqual([500, 1800]);
    expect(invoice.tax_summary.reduce((a, r) => a + r.cgst_paise + r.sgst_paise, 0)).toBe(invoice.bill.tax_total_paise);
  });

  it('numbers invoices without gaps or duplicates under concurrent finalising', async () => {
    const drafts: string[] = [];
    for (let i = 0; i < 8; i++) drafts.push((await openBill((await dineIn(`C${i}`, lines())).sessionId)).id);
    const results = await Promise.all(drafts.map((id) => cashier({ method: 'POST', url: `/v1/bills/${id}/finalise` })));
    expect(results.every((r) => r.statusCode === 200)).toBe(true);
    const seqs = (
      await t.ctx.adminDb.selectFrom('bills').select('invoice_seq').where('outlet_id', '=', tenant.outletId).where('invoice_seq', 'is not', null).orderBy('invoice_seq').execute()
    ).map((r) => r.invoice_seq!);
    expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => i + 1));
  });

  it('gives back an invoice number when the transaction rolls back', async () => {
    const fy = (await t.ctx.adminDb.selectFrom('bills').select('fy_code').where('outlet_id', '=', tenant.outletId).where('fy_code', 'is not', null).executeTakeFirstOrThrow()).fy_code!;
    const peek = async () =>
      (await t.ctx.adminDb.selectFrom('counters').select('value').where('outlet_id', '=', tenant.outletId).where('name', '=', 'invoice').where('period', '=', fy).executeTakeFirstOrThrow()).value;
    const before = await peek();
    await expect(
      t.ctx.tx(tenant.tenantId, async (tx) => {
        await nextCounter(tx, tenant.outletId, 'invoice', fy);
        throw new Error('printer on fire');
      }),
    ).rejects.toThrow('printer on fire');
    expect(await peek()).toBe(before);
  });

  it('splits by items into separate invoices, and later dishes go on a new bill', async () => {
    const { sessionId, order } = await dineIn('B5', lines());
    const bill = await openBill(sessionId);
    const [a, b] = order.items;
    const res = await cashier({ method: 'POST', url: `/v1/bills/${bill.id}/split`, payload: { mode: 'items', groups: [[a!.id], [b!.id]] } });
    const parts: BillDTO[] = res.json();
    expect(parts.map((p) => p.split_label)).toEqual(['Split 1/2', 'Split 2/2']);
    expect(parts[0]!.lines[0]!.order_item_id).toBe(a!.id);
    expect(parts[0]!.total_paise + parts[1]!.total_paise).toBeGreaterThan(0);
    expect((await cashier({ method: 'GET', url: `/v1/bills/${bill.id}` })).statusCode).toBe(404);

    // Bad groups are refused.
    const again = await cashier({ method: 'POST', url: `/v1/bills/${parts[0]!.id}/split`, payload: { mode: 'items', groups: [[a!.id], [a!.id]] } });
    expect(again.statusCode).toBe(400);

    // A dessert ordered after splitting gets its own new draft.
    await cashier({ method: 'POST', url: '/v1/orders', payload: { outlet_id: tenant.outletId, type: 'dine_in', table_id: order.table_id, lines: [{ item_id: menu.paneerTikka, qty: 1 }] } });
    const extra = await openBill(sessionId);
    expect(extra.id).not.toBe(parts[0]!.id);
    expect(extra.lines).toHaveLength(1);
  });

  it('splits by seat with unseated dishes on a shared bill', async () => {
    const { sessionId } = await dineIn('B6', [
      { item_id: menu.paneerTikka, qty: 1, seat_no: 1 },
      { item_id: menu.chickenTikka, qty: 1, seat_no: 2 },
      { item_id: menu.paneerTikka, qty: 1 },
    ]);
    const bill = await openBill(sessionId);
    const parts: BillDTO[] = (await cashier({ method: 'POST', url: `/v1/bills/${bill.id}/split`, payload: { mode: 'seats' } })).json();
    expect(parts.map((p) => p.lines.map((l) => l.seat_no))).toEqual([[1], [2], [null]]);
  });

  it('voids a printed bill with manager approval, keeping its number, so the items can be rebilled', async () => {
    const { sessionId } = await dineIn('B7', lines());
    const bill = await openBill(sessionId);
    const fin: BillDTO = (await cashier({ method: 'POST', url: `/v1/bills/${bill.id}/finalise` })).json();
    expect((await cashier({ method: 'PATCH', url: `/v1/bills/${bill.id}`, payload: { customer_name: 'x' } })).statusCode).toBe(409);

    const denied = await cashier({ method: 'POST', url: `/v1/bills/${bill.id}/void`, payload: { reason: 'Wrong table' } });
    expect(denied.json().error.code).toBe('approval_required');
    const voided = await cashier({ method: 'POST', url: `/v1/bills/${bill.id}/void`, payload: { reason: 'Wrong table' }, headers: { 'x-approval-token': await approval('bill.void') } });
    expect(voided.json()).toMatchObject({ status: 'void', invoice_no: fin.invoice_no, void_reason: 'Wrong table' });

    const rebill = await openBill(sessionId);
    expect(rebill.lines).toHaveLength(2);
    const audit = await t.ctx.adminDb.selectFrom('audit_log').select('action').where('entity_id', '=', bill.id).where('action', '=', 'bill.void').execute();
    expect(audit).toHaveLength(1);
  });

  it('refunds part of a payment with approval and reopens the balance', async () => {
    const { sessionId } = await dineIn('B8', lines());
    const bill = await openBill(sessionId);
    await cashier({ method: 'POST', url: `/v1/bills/${bill.id}/finalise` });
    const paid: BillDTO = (await cashier({ method: 'POST', url: `/v1/bills/${bill.id}/payments`, payload: { method: 'upi', amount_paise: bill.total_paise, reference: 'UTR1' } })).json();
    const paymentId = paid.payments[0]!.id;
    const denied = await cashier({ method: 'POST', url: `/v1/payments/${paymentId}/refund`, payload: { amount_paise: 1000, reason: 'Cold soup' } });
    expect(denied.statusCode).toBe(403);
    const ok = await cashier({
      method: 'POST',
      url: `/v1/payments/${paymentId}/refund`,
      payload: { amount_paise: 1000, reason: 'Cold soup' },
      headers: { 'x-approval-token': await approval('payment.refund') },
    });
    const after: BillDTO = ok.json();
    expect(after.paid_paise).toBe(bill.total_paise - 1000);
    expect(after.payments.map((p) => p.kind)).toEqual(['payment', 'refund']);
  });

  it('bills a counter order on its own', async () => {
    const order = (await cashier({ method: 'POST', url: '/v1/orders', payload: { outlet_id: tenant.outletId, type: 'takeaway', lines: [{ item_id: menu.paneerTikka, qty: 1 }] } })).json();
    const bill = await cashier({ method: 'POST', url: '/v1/bills', payload: { order_id: order.id } });
    expect(bill.statusCode).toBe(201);
    const id = bill.json().id;
    await cashier({ method: 'POST', url: `/v1/bills/${id}/finalise` });
    const paid = await cashier({ method: 'POST', url: `/v1/bills/${id}/payments`, payload: { method: 'card_slip', amount_paise: bill.json().total_paise, reference: 'slip 0042' } });
    expect(paid.json().status).toBe('paid');
  });

  it('keeps waiters out of billing', async () => {
    const waiter = api(t, (await addStaff(t, tenant, 'waiter')).token);
    const { sessionId } = await dineIn('B9', lines());
    expect((await waiter({ method: 'POST', url: '/v1/bills', payload: { table_session_id: sessionId } })).statusCode).toBe(403);
  });
});

describe('walkout watch', () => {
  async function floorTable(tableId: string): Promise<TableDTO> {
    const res = await cashier({ method: 'GET', url: `/v1/tables?outlet_id=${tenant.outletId}` });
    return res.json().find((x: TableDTO) => x.id === tableId);
  }

  it('tells the floor when served food has no bill, and since when a printed bill is unpaid', async () => {
    const { order, tableId, sessionId } = await dineIn('W1', [{ item_id: menu.paneerTikka, qty: 1 }]);
    expect(await floorTable(tableId)).toMatchObject({ last_served_at: null, unpaid_bill_since: null });

    expect((await cashier({ method: 'PATCH', url: `/v1/orders/${order.id}/status`, payload: { status: 'served' } })).statusCode).toBe(200);
    const served = await floorTable(tableId);
    expect(served.last_served_at).not.toBeNull();
    expect(served.unpaid_bill_since).toBeNull();

    const bill = await openBill(sessionId);
    expect((await cashier({ method: 'POST', url: `/v1/bills/${bill.id}/finalise` })).statusCode).toBe(200);
    const printed = await floorTable(tableId);
    expect(printed.last_served_at).toBeNull(); // everything served is on the bill now
    expect(printed.unpaid_bill_since).not.toBeNull();
  });

  it('lists orders that were never billed at day end', async () => {
    const { order, sessionId } = await dineIn('W2', [{ item_id: menu.paneerTikka, qty: 2 }]);
    await cashier({ method: 'PATCH', url: `/v1/orders/${order.id}/status`, payload: { status: 'served' } });
    // The table is cleared without a bill: a walkout, or a bill someone forgot.
    await t.ctx.tx(tenant.tenantId, (tx) => closeSession(tx, sessionId, 'staff'));
    const { order: stillEating } = await dineIn('W3', [{ item_id: menu.paneerTikka, qty: 1 }]);

    const d = (await owner({ method: 'GET', url: `/v1/reports/day-end?outlet_id=${tenant.outletId}` })).json();
    expect(d.unbilled_orders.find((u: { order_id: string }) => u.order_id === order.id)).toMatchObject({
      table_label: 'W2',
      table_open: false,
      amount_paise: order.subtotal_paise,
    });
    expect(d.unbilled_orders.find((u: { order_id: string }) => u.order_id === stillEating.id)).toMatchObject({ table_label: 'W3', table_open: true });
  });
});

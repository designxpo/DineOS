// Free food and drinks (complimentary): who may give them, how they show on bills and receipts,
// and the record and report the owner reads.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BillDTO, CompDTO, CompReportDTO, OrderDTO } from '@mezmitra/shared/dto';
import { addStaff, api, createMenu, createTable, createTenant, startApp, type TestApp, type TestMenu, type TestTenant } from './helpers';

let t: TestApp;
let tenant: TestTenant;
let menu: TestMenu;
let owner: ReturnType<typeof api>;
let cashier: ReturnType<typeof api>;
let cashierId: string;
let waiter: ReturnType<typeof api>;
let manager: Awaited<ReturnType<typeof addStaff>>;
let tables = 0;

beforeAll(async () => {
  t = await startApp();
  tenant = await createTenant(t);
  menu = await createMenu(t, tenant);
  owner = api(t, tenant.ownerToken);
  const c = await addStaff(t, tenant, 'cashier');
  cashier = api(t, c.token);
  cashierId = c.userId;
  waiter = api(t, (await addStaff(t, tenant, 'waiter')).token);
  manager = await addStaff(t, tenant, 'manager', { pin: '4321' });
});
afterAll(() => t.close());

/** A seated table with 2 paneer tikka (₹250 each, 5% GST) and one chicken tikka (₹320, 18%). */
async function tableOrder() {
  const tableId = await createTable(t, tenant, `F${++tables}`);
  await owner({ method: 'POST', url: `/v1/tables/${tableId}/seat`, payload: { guest_count: 2 } });
  const order: OrderDTO = (
    await owner({ method: 'POST', url: '/v1/orders', payload: { outlet_id: tenant.outletId, type: 'dine_in', table_id: tableId, lines: [{ item_id: menu.paneerTikka, qty: 2 }, { item_id: menu.chickenTikka, qty: 1 }] } })
  ).json();
  const paneer = order.items.find((i) => i.name === 'Paneer Tikka')!;
  const chicken = order.items.find((i) => i.name === 'Chicken Tikka')!;
  const bill: BillDTO = (await owner({ method: 'POST', url: '/v1/bills', payload: { table_session_id: order.table_session_id } })).json();
  return { order, paneer, chicken, bill };
}

const getBill = async (id: string) => (await owner({ method: 'GET', url: `/v1/bills/${id}` })).json() as BillDTO;
const comp = (as: ReturnType<typeof api>, itemId: string, body: Record<string, unknown>, approvalToken?: string) =>
  as({ method: 'POST', url: `/v1/order-items/${itemId}/comp`, payload: body, headers: approvalToken ? { 'x-approval-token': approvalToken } : {} });

describe('giving dishes free', () => {
  it('lets a cashier give one dish free; the bill charges nothing (and no GST) for it', async () => {
    const { paneer, bill, order } = await tableOrder();
    const before = await getBill(bill.id);
    const res = await comp(cashier, paneer.id, { qty: 1, reason: 'mishap', note: 'Served cold, replaced' });
    expect(res.statusCode).toBe(201);
    const given: CompDTO = res.json();
    expect(given).toMatchObject({ qty: 1, value_paise: 25000, reason: 'mishap', note: 'Served cold, replaced', approved_by: null, removed_at: null });

    const after = await getBill(bill.id);
    const line = after.lines.find((l) => l.order_item_id === paneer.id)!;
    expect(line).toMatchObject({ qty: 2, comp_qty: 1, comp_paise: 25000, taxable_paise: 25000 });
    expect(line.comps).toEqual([{ id: given.id, qty: 1, reason: 'mishap' }]);
    expect(after.comp_paise).toBe(25000);
    expect(after.subtotal_paise).toBe(before.subtotal_paise);
    expect(after.taxable_paise).toBe(before.taxable_paise - 25000);
    expect(after.tax_total_paise).toBe(before.tax_total_paise - 1250);
    // The order shows it too.
    const o: OrderDTO = (await owner({ method: 'GET', url: `/v1/orders/${order.id}` })).json();
    expect(o.items.find((i) => i.id === paneer.id)!.comp_qty).toBe(1);
  });

  it('asks a waiter for a manager PIN, and records who approved', async () => {
    const { chicken } = await tableOrder();
    const asked = await comp(waiter, chicken.id, { reason: 'special_guest' });
    expect(asked.statusCode).toBe(403);
    expect(asked.json().error.code).toBe('approval_required');
    const approval = await waiter({ method: 'POST', url: '/v1/approvals', payload: { outlet_id: tenant.outletId, action: 'bill.comp', login: manager.login, pin: '4321' } });
    expect(approval.statusCode).toBe(200);
    const res = await comp(waiter, chicken.id, { reason: 'special_guest' }, approval.json().approval_token);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ qty: 1, approved_by: expect.any(String) });
  });

  it('puts a whole bill on the house for a guest, and the bill closes at nothing', async () => {
    const { bill } = await tableOrder();
    const guest = (await owner({ method: 'POST', url: '/v1/customers', payload: { outlet_id: tenant.outletId, phone: '9876500011', name: 'Ritu Sharma', consent: true } })).json();
    const res = await owner({ method: 'POST', url: `/v1/bills/${bill.id}/comp`, payload: { reason: 'owners_guest', customer_id: guest.id } });
    expect(res.statusCode).toBe(201);
    const comps: CompDTO[] = res.json();
    expect(comps).toHaveLength(2);
    expect(comps.every((c) => c.whole_bill && c.customer?.id === guest.id)).toBe(true);
    const free = await getBill(bill.id);
    expect(free.total_paise).toBe(0);
    const printed: BillDTO = (await owner({ method: 'POST', url: `/v1/bills/${bill.id}/finalise` })).json();
    expect(printed.status).toBe('paid');
    expect(printed.comp_paise).toBe(2 * 25000 + 32000);
  });

  it('can be taken back before the bill prints, and not after', async () => {
    const { paneer, chicken, bill } = await tableOrder();
    const given: CompDTO = (await comp(cashier, paneer.id, { reason: 'celebration' })).json();
    expect((await getBill(bill.id)).comp_paise).toBe(50000);
    expect((await cashier({ method: 'DELETE', url: `/v1/comps/${given.id}` })).statusCode).toBe(204);
    expect((await getBill(bill.id)).comp_paise).toBe(0);
    const row = await t.ctx.adminDb.selectFrom('comps').select(['removed_at', 'removed_by']).where('id', '=', given.id).executeTakeFirstOrThrow();
    expect(row.removed_by).toBe(cashierId);

    await comp(cashier, chicken.id, { reason: 'staff_meal' });
    await owner({ method: 'POST', url: `/v1/bills/${bill.id}/finalise` });
    const late = await comp(cashier, paneer.id, { reason: 'mishap' });
    expect(late.statusCode).toBe(409);
    expect(late.json().error.code).toBe('already_billed');
  });

  it('checks the details', async () => {
    const { paneer } = await tableOrder();
    expect((await comp(cashier, paneer.id, { qty: 3, reason: 'mishap' })).statusCode).toBe(400);
    expect((await comp(cashier, paneer.id, { reason: 'other' })).json().error.code).toBe('note_required');
    expect((await comp(cashier, paneer.id, { reason: 'free_for_all' })).statusCode).toBe(400);
    await comp(cashier, paneer.id, { reason: 'mishap' });
    expect((await comp(cashier, paneer.id, { reason: 'mishap' })).json().error.code).toBe('already_free');
  });

  it('does not count free dishes towards the cashier discount limit', async () => {
    const { chicken, bill } = await tableOrder();
    await comp(cashier, chicken.id, { reason: 'mishap' });
    // A 5% discount on top is within the cashier's own limit.
    const res = await cashier({ method: 'PATCH', url: `/v1/bills/${bill.id}`, payload: { bill_discount: { kind: 'percent', bp: 500 }, discount_reason: 'Regular guest' } });
    expect(res.statusCode).toBe(200);
  });
});

describe('the record', () => {
  it('reports what was given free, why, by whom, for whom and what it cost', async () => {
    const ing = (await owner({ method: 'POST', url: '/v1/inventory/ingredients', payload: { outlet_id: tenant.outletId, name: 'Paneer', unit: 'g', opening_qty: 1000, cost_per_unit_paise: 40 } })).json();
    expect((await owner({ method: 'PUT', url: `/v1/inventory/recipes/items/${menu.paneerTikka}`, payload: { lines: [{ ingredient_id: ing.id, qty: 150 }] } })).statusCode).toBe(200);
    const { paneer } = await tableOrder();
    const given: CompDTO = (await comp(cashier, paneer.id, { qty: 1, reason: 'marketing', note: 'Food blogger tasting' })).json();
    expect(given.cost_paise).toBe(6000);

    const report: CompReportDTO = (await owner({ method: 'GET', url: `/v1/reports/comps?outlet_id=${tenant.outletId}` })).json();
    expect(report.totals.value_paise).toBeGreaterThan(0);
    expect(report.by_reason.map((r) => r.reason)).toEqual(expect.arrayContaining(['mishap', 'marketing', 'owners_guest', 'special_guest']));
    expect(report.by_staff.some((s) => s.user_id === cashierId)).toBe(true);
    expect(report.by_approver.length).toBeGreaterThan(0);
    expect(report.by_guest.some((g) => g.name === 'Ritu Sharma')).toBe(true);
    // Undone ones stay in the list, marked, but are not counted.
    expect(report.rows.some((r) => r.removed_at)).toBe(true);
    expect(report.totals.count).toBe(report.rows.filter((r) => !r.removed_at).length);

    const csv = await owner({ method: 'GET', url: `/v1/reports/comps?outlet_id=${tenant.outletId}&format=csv` });
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.body).toContain('Food blogger tasting');
    expect(csv.body).toContain('value_inr');

    const sales = (await owner({ method: 'GET', url: `/v1/reports/sales?outlet_id=${tenant.outletId}` })).json();
    expect(sales.totals.complimentary_paise).toBeGreaterThan(0);
    const audit = await t.ctx.adminDb.selectFrom('audit_log').select('action').where('tenant_id', '=', tenant.tenantId).where('action', 'like', 'comp.%').execute();
    expect(new Set(audit.map((a) => a.action))).toEqual(new Set(['comp.give', 'comp.give_bill', 'comp.remove']));
  });

  it("tells the owner's phone about large freebies", async () => {
    await owner({ method: 'PATCH', url: `/v1/outlets/${tenant.outletId}`, payload: { comp_alert_paise: 50000 } });
    const { bill } = await tableOrder();
    await owner({ method: 'POST', url: `/v1/bills/${bill.id}/comp`, payload: { reason: 'mishap', note: 'Long wait' } });
    const events = await t.ctx.adminDb.selectFrom('outlet_events').select('payload').where('outlet_id', '=', tenant.outletId).where('type', '=', 'comp.given').orderBy('seq', 'desc').limit(1).execute();
    expect(events[0]!.payload).toMatchObject({ alert: true, items: 'whole bill' });
  });
});

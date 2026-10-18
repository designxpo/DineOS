// The go-live rehearsal: scenarios run on the outlet's own devices, what Mezmitra saw of each, and
// the acceptance sheet only the owner signs, frozen as signed. Full payment starts after it.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GOLIVE_SCENARIOS, type GoliveScenario } from '@mezmitra/shared/golive';
import type { BillDTO, GoliveRehearsalDTO, OrderDTO } from '@mezmitra/shared/dto';
import { hashSecret } from '../src/lib/crypto';
import { addStaff, api, createMenu, createTenant, startApp, type TestApp, type TestMenu, type TestTenant } from './helpers';

let t: TestApp;
let tenant: TestTenant;
let menu: TestMenu;
let owner: ReturnType<typeof api>;
let manager: ReturnType<typeof api>;
let rehearsal: GoliveRehearsalDTO;

beforeAll(async () => {
  t = await startApp();
  tenant = await createTenant(t);
  menu = await createMenu(t, tenant);
  owner = api(t, tenant.ownerToken);
  manager = api(t, (await addStaff(t, tenant, 'manager')).token);
});
afterAll(() => t.close());

const current = async (): Promise<GoliveRehearsalDTO | null> => (await owner({ method: 'GET', url: `/v1/golive?outlet_id=${tenant.outletId}` })).json();
const check = (r: GoliveRehearsalDTO, s: GoliveScenario) => r.checks.find((c) => c.scenario === s)!;
const mark = (scenario: GoliveScenario, result: string, note?: string, as = manager) =>
  as({ method: 'PUT', url: `/v1/golive/${rehearsal.id}/checks/${scenario}`, payload: { result, note } });

describe('go-live rehearsal', () => {
  it('starts once per outlet; before anything happens, only the menu is there to see', async () => {
    expect(await current()).toBeNull();
    const res = await manager({ method: 'POST', url: '/v1/golive', payload: { outlet_id: tenant.outletId } });
    expect(res.statusCode).toBe(201);
    rehearsal = res.json();
    expect((await manager({ method: 'POST', url: '/v1/golive', payload: { outlet_id: tenant.outletId } })).json().error.code).toBe('rehearsal_open');
    const waiter = api(t, (await addStaff(t, tenant, 'waiter')).token);
    expect((await waiter({ method: 'GET', url: `/v1/golive?outlet_id=${tenant.outletId}` })).statusCode).toBe(403);

    expect(rehearsal.checks.map((c) => c.scenario)).toEqual([...GOLIVE_SCENARIOS]);
    expect(rehearsal.checks.every((c) => c.result === null)).toBe(true);
    expect(check(rehearsal, 'menu').evidence).toEqual({ seen: true, lines: ['3 dishes in 1 category, sent to bar and kitchen.', '3 without a photo.'] });
    expect(check(rehearsal, 'mixed_order').evidence.seen).toBe(false);
    expect(check(rehearsal, 'printers').evidence.lines).toEqual(['No print computer is connected to this outlet yet.']);
    expect(rehearsal.ready).toBe(false);
  });

  it('shows what happened since it started: the mixed order, the split, the free dish, the cooked cancellation, the failed ticket, the pack', async () => {
    await owner({ method: 'POST', url: '/v1/screens/heartbeat', payload: { outlet_id: tenant.outletId, screen_id: randomUUID(), kind: 'till', applied_version: null } });
    const order: OrderDTO = (
      await owner({ method: 'POST', url: '/v1/orders', payload: { outlet_id: tenant.outletId, type: 'takeaway', lines: [{ item_id: menu.paneerTikka, qty: 2 }, { item_id: menu.coldCoffee, qty: 1, modifier_ids: [menu.regular] }] } })
    ).json();
    const paneer = order.items.find((i) => i.item_id === menu.paneerTikka)!;
    expect((await owner({ method: 'POST', url: `/v1/order-items/${paneer.id}/comp`, payload: { qty: 1, reason: 'mishap', note: 'Rehearsal' } })).statusCode).toBe(201);

    const draft: BillDTO = (await owner({ method: 'POST', url: '/v1/bills', payload: { order_id: order.id } })).json();
    const bill: BillDTO = (await owner({ method: 'POST', url: `/v1/bills/${draft.id}/finalise` })).json();
    await owner({ method: 'POST', url: `/v1/bills/${bill.id}/payments`, payload: { method: 'cash', amount_paise: 10000 } });
    await owner({ method: 'POST', url: `/v1/bills/${bill.id}/payments`, payload: { method: 'upi', amount_paise: bill.total_paise - 10000, reference: '1234' } });

    // A dish cancelled after it was made (the approval flow has its own tests).
    const second: OrderDTO = (await owner({ method: 'POST', url: '/v1/orders', payload: { outlet_id: tenant.outletId, type: 'takeaway', lines: [{ item_id: menu.paneerTikka, qty: 1 }] } })).json();
    await t.ctx.adminDb.updateTable('order_items').set({ status: 'cancelled', cancelled_made: true, cancelled_reason: 'Rehearsal', updated_at: new Date() }).where('id', '=', second.items[0]!.id).execute();
    // A kitchen ticket that failed (paper out), then printed when reprinted.
    const job = { tenant_id: tenant.tenantId, outlet_id: tenant.outletId, kind: 'kot', target: 'kitchen', ref_id: randomUUID(), doc: JSON.stringify({ kind: 'kot' }) };
    await t.ctx.adminDb.insertInto('print_jobs').values({ ...job, status: 'failed', attempts: 5, last_error: 'Out of paper' }).execute();
    await t.ctx.adminDb.insertInto('print_jobs').values({ ...job, status: 'printed', attempts: 1, printed_at: new Date(), created_at: new Date(Date.now() + 1000) }).execute();
    await t.ctx.adminDb.updateTable('orders').set({ offline_ref: 'H1' }).where('id', '=', second.id).execute();
    const month = new Date().toISOString().slice(0, 7);
    expect((await owner({ method: 'GET', url: `/v1/reports/month-pack?outlet_id=${tenant.outletId}&month=${month}` })).statusCode).toBe(200);

    const r = (await current())!;
    expect(check(r, 'mixed_order').evidence).toEqual({ seen: true, lines: [`Order #${order.order_no} went to bar and kitchen, each with only its dishes.`] });
    expect(check(r, 'split_bill').evidence.lines[0]).toMatch(new RegExp(`^Bill ${bill.invoice_no!.replaceAll('/', '\\/')} paid cash ₹100.00 and UPI ₹`));
    expect(check(r, 'free_dish').evidence).toMatchObject({ seen: true, lines: ['Paneer Tikka on the house (mishap).'] });
    expect(check(r, 'cooked_cancel').evidence).toMatchObject({ seen: true, lines: [`Paneer Tikka on order #${second.order_no} cancelled after it was made: counted as waste.`] });
    expect(check(r, 'printer_out').evidence).toMatchObject({ seen: true, lines: [expect.stringMatching(/^A kitchen ticket did not print at .+, then printed once fixed\.$/)] });
    expect(check(r, 'internet_off').evidence).toMatchObject({ seen: true, lines: ['1 order came in through the outlet hub while the internet was off.'] });
    expect(check(r, 'day_end').evidence).toMatchObject({ seen: true, lines: [expect.stringMatching(/^Month-end pack downloaded at .+ by Owner\.$/)] });
    expect(r.devices).toEqual([{ kind: 'screen', name: 'Till screen', detail: 'signed in as Owner' }]);
  });

  it('needs a note to fail a scenario or leave it out, and remembers it failed before passing', async () => {
    expect((await mark('printer_out', 'failed')).json().error.code).toBe('note_needed');
    expect((await mark('printers', 'out_of_scope')).json().error.code).toBe('note_needed');
    expect(check((await mark('printer_out', 'failed', 'Bar screen did not show the failed ticket')).json(), 'printer_out')).toMatchObject({ result: 'failed', failures: 1 });
    const again: GoliveRehearsalDTO = (await mark('printer_out', 'passed')).json();
    expect(check(again, 'printer_out')).toMatchObject({ result: 'passed', failures: 1, note: null, checked_by_name: expect.stringMatching(/^Manager/) });
  });

  it('only the owner signs, and only once every scenario passed or was agreed out of scope', async () => {
    const sign = (as = owner, body: object = { signer_name: 'Meera Rao', confirm: true }) => as({ method: 'POST', url: `/v1/golive/${rehearsal.id}/sign`, payload: body });
    expect((await sign(manager)).statusCode).toBe(403);
    const early = await sign();
    expect(early.json().error).toMatchObject({ code: 'not_ready', details: { unmarked: expect.arrayContaining(['menu', 'day_end']) } });

    for (const s of GOLIVE_SCENARIOS) if (s !== 'printer_out') await mark(s, s === 'printers' ? 'out_of_scope' : 'passed', s === 'printers' ? 'Bar printer arrives next week' : undefined);
    await mark('internet_off', 'failed', 'Second phone lost an order');
    expect((await sign()).json().error).toMatchObject({ code: 'not_ready', details: { failed: ['internet_off'] } });
    await mark('internet_off', 'passed');
    expect((await sign(owner, { signer_name: 'Meera Rao' })).statusCode).toBe(400);

    const signed: GoliveRehearsalDTO = (await sign()).json();
    expect(signed).toMatchObject({ signer_name: 'Meera Rao', signed_at: expect.any(String), ready: true });
    expect(check(signed, 'printers')).toMatchObject({ result: 'out_of_scope', note: 'Bar printer arrives next week' });
    expect(check(signed, 'internet_off')).toMatchObject({ result: 'passed', failures: 1 });

    // The sheet stays as signed, whatever happens later.
    expect((await mark('menu', 'failed', 'Too late')).json().error.code).toBe('already_signed');
    await owner({ method: 'POST', url: '/v1/orders', payload: { outlet_id: tenant.outletId, type: 'takeaway', lines: [{ item_id: menu.paneerTikka, qty: 1 }, { item_id: menu.coldCoffee, qty: 1, modifier_ids: [menu.regular] }] } });
    expect(check((await current())!, 'mixed_order').evidence).toEqual(check(signed, 'mixed_order').evidence);
  });

  it('shows Mezmitra who has signed, and a new rehearsal can start after', async () => {
    const email = `golive-${randomUUID().slice(0, 6)}@mezmitra.test`;
    await t.ctx.adminDb.insertInto('platform_admins').values({ name: 'Ops', email, password_hash: await hashSecret('admin-password-1') }).execute();
    const admin = api(t, (await t.app.inject({ method: 'POST', url: '/v1/admin/auth/login', payload: { email, password: 'admin-password-1' } })).json().token);
    const row = ((await admin({ method: 'GET', url: `/v1/admin/tenants?q=${tenant.slug}` })).json() as { id: string; golive_signed_at: string | null; golive_open: boolean }[]).find((x) => x.id === tenant.tenantId)!;
    expect(row).toMatchObject({ golive_signed_at: expect.any(String), golive_open: false });

    const next = await owner({ method: 'POST', url: '/v1/golive', payload: { outlet_id: tenant.outletId } });
    expect(next.statusCode).toBe(201);
    expect((await current())!.id).toBe(next.json().id);
  });
});

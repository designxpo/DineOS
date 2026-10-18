import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrderDTO, PassItemDTO } from '@mezmitra/shared/dto';
import { passLevel } from '@mezmitra/shared/pass';
import { addStaff, api, createMenu, createTable, createTenant, startApp, type TestApp, type TestMenu, type TestTenant } from './helpers';

let t: TestApp;
let tenant: TestTenant;
let menu: TestMenu;
let owner: ReturnType<typeof api>;
let kitchen: ReturnType<typeof api>;
let waiterA: ReturnType<typeof api>;
let waiterB: ReturnType<typeof api>;
let idA = '';
let idB = '';

beforeAll(async () => {
  t = await startApp();
  tenant = await createTenant(t);
  menu = await createMenu(t, tenant);
  owner = api(t, tenant.ownerToken);
  kitchen = api(t, (await addStaff(t, tenant, 'kitchen')).token);
  const a = await addStaff(t, tenant, 'waiter');
  const b = await addStaff(t, tenant, 'waiter');
  waiterA = api(t, a.token);
  waiterB = api(t, b.token);
  idA = a.userId;
  idB = b.userId;
});
afterAll(() => t.close());

const pass = async (as = owner): Promise<PassItemDTO[]> => (await as({ method: 'GET', url: `/v1/pass?outlet_id=${tenant.outletId}` })).json();

async function readyDish(): Promise<{ order: OrderDTO; itemId: string }> {
  const tableId = await createTable(t, tenant, `P${Math.random().toString(36).slice(2, 6)}`);
  const res = await waiterA({ method: 'POST', url: '/v1/orders', payload: { outlet_id: tenant.outletId, type: 'dine_in', table_id: tableId, lines: [{ item_id: menu.paneerTikka, qty: 1 }] } });
  const order: OrderDTO = res.json();
  const itemId = order.items[0]!.id;
  for (const status of ['preparing', 'ready']) {
    expect((await kitchen({ method: 'PATCH', url: `/v1/order-items/${itemId}/status`, payload: { status } })).statusCode).toBe(200);
  }
  return { order, itemId };
}

describe('passLevel', () => {
  const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  it('warns when unheld food waits, and restarts the clock when someone takes it', () => {
    expect(passLevel({ ready_at: ago(1), claimed_at: null })).toBe('waiting');
    expect(passLevel({ ready_at: ago(4), claimed_at: null })).toBe('overdue');
    expect(passLevel({ ready_at: ago(7), claimed_at: null })).toBe('escalated');
    expect(passLevel({ ready_at: ago(7), claimed_at: ago(1) })).toBe('waiting');
    expect(passLevel({ ready_at: ago(12), claimed_at: ago(6) })).toBe('overdue');
    expect(passLevel({ ready_at: ago(20), claimed_at: ago(11) })).toBe('escalated');
  });
});

describe('the pass', () => {
  it('lists ready dishes from the moment they are ready, and drops them when served', async () => {
    const { itemId } = await readyDish();
    const listed = (await pass()).find((p) => p.order_item_id === itemId)!;
    expect(listed).toMatchObject({ claimed_by: null, level: 'waiting', name: 'Paneer Tikka' });
    expect((await waiterA({ method: 'PATCH', url: `/v1/order-items/${itemId}/status`, payload: { status: 'served' } })).statusCode).toBe(200);
    expect((await pass()).some((p) => p.order_item_id === itemId)).toBe(false);
  });

  it('a waiter takes a dish, another waiter takes it over, and only the holder can let go', async () => {
    const { itemId } = await readyDish();
    const body = (claimed: boolean) => ({ outlet_id: tenant.outletId, order_item_ids: [itemId], claimed });
    expect((await kitchen({ method: 'POST', url: '/v1/pass/claim', payload: body(true) })).statusCode).toBe(403);

    expect((await waiterA({ method: 'POST', url: '/v1/pass/claim', payload: body(true) })).json().updated).toBe(1);
    expect((await pass()).find((p) => p.order_item_id === itemId)).toMatchObject({ claimed_by: idA });

    // A waiter on a break: the other takes it, and the handover is on record.
    expect((await waiterB({ method: 'POST', url: '/v1/pass/claim', payload: body(true) })).json().updated).toBe(1);
    expect((await pass()).find((p) => p.order_item_id === itemId)).toMatchObject({ claimed_by: idB });
    const handover = await t.ctx.adminDb.selectFrom('audit_log').select('after').where('tenant_id', '=', tenant.tenantId).where('action', '=', 'pass.handover').executeTakeFirstOrThrow();
    expect(JSON.stringify(handover.after)).toContain(idA);

    expect((await waiterA({ method: 'POST', url: '/v1/pass/claim', payload: body(false) })).json().updated).toBe(0);
    expect((await waiterB({ method: 'POST', url: '/v1/pass/claim', payload: body(false) })).json().updated).toBe(1);
    expect((await pass()).find((p) => p.order_item_id === itemId)!.claimed_by).toBeNull();
  });

  it('shows the manager what has waited too long, and a claim restarts the clock', async () => {
    const { itemId } = await readyDish();
    await t.ctx.adminDb.updateTable('order_items').set({ ready_at: new Date(Date.now() - 8 * 60_000) }).where('id', '=', itemId).execute();
    expect((await pass()).find((p) => p.order_item_id === itemId)!.level).toBe('escalated');
    await waiterB({ method: 'POST', url: '/v1/pass/claim', payload: { outlet_id: tenant.outletId, order_item_ids: [itemId], claimed: true } });
    expect((await pass()).find((p) => p.order_item_id === itemId)!.level).toBe('waiting');
  });

  it('a dish sent back and ready again starts with nobody holding it', async () => {
    const { itemId } = await readyDish();
    await waiterA({ method: 'POST', url: '/v1/pass/claim', payload: { outlet_id: tenant.outletId, order_item_ids: [itemId], claimed: true } });
    // The kitchen takes it back (a remake) and sends it out again.
    const set = (status: string) => t.ctx.adminDb.updateTable('order_items').set({ status }).where('id', '=', itemId).execute();
    await set('preparing');
    await set('ready');
    expect((await pass()).find((p) => p.order_item_id === itemId)!.claimed_by).toBeNull();
  });
});

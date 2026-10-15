import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrderDTO } from '@dineos/shared/dto';
import { addStaff, api, createMenu, createTable, createTenant, startApp, type TestApp, type TestMenu, type TestTenant } from './helpers';

let t: TestApp;
let tenant: TestTenant;
let menu: TestMenu;
let owner: ReturnType<typeof api>;
let waiter: ReturnType<typeof api>;
let cook: ReturnType<typeof api>;
let manager: { login: string };

beforeAll(async () => {
  t = await startApp();
  tenant = await createTenant(t);
  menu = await createMenu(t, tenant);
  owner = api(t, tenant.ownerToken);
  waiter = api(t, (await addStaff(t, tenant, 'waiter')).token);
  cook = api(t, (await addStaff(t, tenant, 'kitchen')).token);
  manager = await addStaff(t, tenant, 'manager', { pin: '2468' });
});
afterAll(() => t.close());

async function waiterOrder(label: string, lines = [{ item_id: menu.paneerTikka, qty: 2, modifier_ids: [] as string[] }]): Promise<OrderDTO> {
  const tableId = await createTable(t, tenant, label);
  const res = await waiter({
    method: 'POST',
    url: '/v1/orders',
    payload: { outlet_id: tenant.outletId, type: 'dine_in', source: 'waiter', table_id: tableId, lines, guest_count: 3 },
  });
  expect(res.statusCode).toBe(201);
  return res.json();
}

describe('staff orders', () => {
  it('waiter orders skip approval, go to the kitchen and seat the table', async () => {
    const order = await waiterOrder('W1');
    expect(order.status).toBe('accepted');
    expect(order.source).toBe('waiter');
    expect(order.created_by_name).toMatch(/^Waiter/);
    const kots = await t.ctx.adminDb.selectFrom('kots').select('kot_no').where('order_id', '=', order.id).execute();
    expect(kots).toHaveLength(1);
    const table = (await owner({ method: 'GET', url: `/v1/tables/${order.table_id}` })).json();
    expect(table.state).toBe('ordered');
    expect(table.session.guest_count).toBe(3);
  });

  it('creates counter orders without a table', async () => {
    const res = await owner({
      method: 'POST',
      url: '/v1/orders',
      payload: { outlet_id: tenant.outletId, type: 'counter', lines: [{ item_id: menu.paneerTikka, qty: 1 }], customer_name: 'Asha' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ type: 'counter', table_id: null, customer_name: 'Asha' });
  });

  it('lists the inbox by status and shows the KDS view per station', async () => {
    const order = await waiterOrder('W2', [
      { item_id: menu.paneerTikka, qty: 1, modifier_ids: [] },
      { item_id: menu.coldCoffee, qty: 1, modifier_ids: [menu.regular] },
    ]);
    const inbox = await owner({ method: 'GET', url: `/v1/orders?outlet_id=${tenant.outletId}&status=accepted,preparing` });
    expect(inbox.json().some((o: OrderDTO) => o.id === order.id)).toBe(true);
    const bar = (await cook({ method: 'GET', url: `/v1/kds?outlet_id=${tenant.outletId}&station=bar` })).json() as OrderDTO[];
    const mine = bar.find((o) => o.id === order.id)!;
    expect(mine.items.map((i) => i.name)).toEqual(['Cold Coffee']);
  });

  it('lets the kitchen progress items but not serve', async () => {
    const order = await waiterOrder('W3');
    const itemId = order.items[0]!.id;
    expect((await cook({ method: 'PATCH', url: `/v1/order-items/${itemId}/status`, payload: { status: 'preparing' } })).json().status).toBe('preparing');
    expect((await cook({ method: 'PATCH', url: `/v1/order-items/${itemId}/status`, payload: { status: 'ready' } })).json().status).toBe('ready');
    expect((await cook({ method: 'PATCH', url: `/v1/orders/${order.id}/status`, payload: { status: 'served' } })).statusCode).toBe(403);
    expect((await waiter({ method: 'PATCH', url: `/v1/orders/${order.id}/status`, payload: { status: 'served' } })).json().status).toBe('served');
    // Going backwards is refused.
    const back = await owner({ method: 'PATCH', url: `/v1/orders/${order.id}/status`, payload: { status: 'preparing' } });
    expect(back.statusCode).toBe(409);
  });

  it('edits a placed order freely: quantity change, add, cancel', async () => {
    const tableId = await createTable(t, tenant, 'W4');
    const session = await t.ctx.tx(tenant.tenantId, async (tx) => (await import('../src/modules/tables/sessions')).getOrCreateSession(tx, tableId));
    const { createOrder } = await import('../src/modules/orders/service');
    const placed = await t.ctx.tx(tenant.tenantId, (tx) =>
      createOrder(tx, {
        outletId: tenant.outletId,
        type: 'dine_in',
        source: 'guest_qr',
        sessionId: session.id,
        lines: [
          { item_id: menu.paneerTikka, qty: 1, modifier_ids: [] },
          { item_id: menu.chickenTikka, qty: 1, modifier_ids: [] },
        ],
      }),
    );
    const [paneer, chicken] = placed.items;
    const res = await waiter({
      method: 'PATCH',
      url: `/v1/orders/${placed.id}/items`,
      payload: {
        set_qty: [{ order_item_id: paneer!.id, qty: 3 }],
        cancel: [{ order_item_id: chicken!.id, reason: 'Guest changed mind' }],
        add: [{ item_id: menu.coldCoffee, qty: 1, modifier_ids: [menu.regular] }],
      },
    });
    expect(res.statusCode).toBe(200);
    const o: OrderDTO = res.json();
    expect(o.items.find((i) => i.id === paneer!.id)?.qty).toBe(3);
    expect(o.items.find((i) => i.id === chicken!.id)?.status).toBe('cancelled');
    expect(o.items).toHaveLength(3);
    expect(o.subtotal_paise).toBe(3 * 25000 + 18000);
  });

  it('needs a manager PIN to cancel a dish the kitchen already has', async () => {
    const order = await waiterOrder('W5', [
      { item_id: menu.paneerTikka, qty: 1, modifier_ids: [] },
      { item_id: menu.chickenTikka, qty: 1, modifier_ids: [] },
    ]);
    const chicken = order.items.find((i) => i.name === 'Chicken Tikka')!;
    const payload = { cancel: [{ order_item_id: chicken.id, reason: 'Burnt' }] };
    const denied = await waiter({ method: 'PATCH', url: `/v1/orders/${order.id}/items`, payload });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe('approval_required');

    const approval = await waiter({
      method: 'POST',
      url: '/v1/approvals',
      payload: { outlet_id: tenant.outletId, action: 'order.cancel_after_accept', login: manager.login, pin: '2468' },
    });
    const token = approval.json().approval_token;
    const ok = await waiter({ method: 'PATCH', url: `/v1/orders/${order.id}/items`, payload, headers: { 'x-approval-token': token } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().items.find((i: { id: string }) => i.id === chicken.id).status).toBe('cancelled');
    // The approval is single use.
    const reuse = await waiter({
      method: 'PATCH',
      url: `/v1/orders/${order.id}/status`,
      payload: { status: 'cancelled', reason: 'x' },
      headers: { 'x-approval-token': token },
    });
    expect(reuse.json().error.code).toBe('approval_invalid');
    const cancelTicket = await t.ctx.adminDb.selectFrom('kots').select('items').where('order_id', '=', order.id).execute();
    expect(cancelTicket.some((k) => (k.items as { cancelled: boolean }).cancelled)).toBe(true);
    const log = await t.ctx.adminDb.selectFrom('audit_log').select(['action', 'approved_by']).where('entity_id', '=', chicken.id).executeTakeFirstOrThrow();
    expect(log.action).toBe('order_item.cancel');
    expect(log.approved_by).not.toBeNull();
  });

  it('replays an idempotent POST instead of creating a duplicate order', async () => {
    const tableId = await createTable(t, tenant, 'W6');
    const payload = { outlet_id: tenant.outletId, type: 'dine_in', table_id: tableId, lines: [{ item_id: menu.paneerTikka, qty: 1 }] };
    const headers = { 'idempotency-key': 'pos-offline-0001' };
    const a = await waiter({ method: 'POST', url: '/v1/orders', payload, headers });
    const b = await waiter({ method: 'POST', url: '/v1/orders', payload, headers });
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect(b.json().id).toBe(a.json().id);
    const count = await t.ctx.adminDb.selectFrom('orders').select('id').where('table_id', '=', tableId).execute();
    expect(count).toHaveLength(1);
    const different = await waiter({ method: 'POST', url: '/v1/orders', payload: { ...payload, note: 'x' }, headers });
    expect(different.statusCode).toBe(422);
  });

  it('replays missed events after a reconnect', async () => {
    const since = (await t.ctx.adminDb.selectFrom('outlets').select('event_seq').where('id', '=', tenant.outletId).executeTakeFirstOrThrow()).event_seq;
    const order = await waiterOrder('W7');
    const res = await cook({ method: 'GET', url: `/v1/events?outlet_id=${tenant.outletId}&since=${since}` });
    const body = res.json();
    expect(body.truncated).toBe(false);
    expect(body.events.map((e: { type: string }) => e.type)).toContain('order.placed');
    expect(body.events.find((e: { type: string }) => e.type === 'order.placed').payload.order.id).toBe(order.id);
    expect(body.events.every((e: { channels: string[] }) => e.channels.includes('outlet'))).toBe(true);
    const seqs = body.events.map((e: { seq: number }) => e.seq);
    expect(seqs).toEqual([...seqs].sort((x: number, y: number) => x - y));
  });
});

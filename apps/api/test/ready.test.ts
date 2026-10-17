// Drinks and food from one order: the bar and the kitchen each finish their part, the floor hears
// when something is waiting at the pass, and waiters can serve the drinks while the food cooks.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ItemsReadyDTO, OrderDTO, TableDTO } from '@dineos/shared/dto';
import type { PushMessage } from '../src/lib/push';
import { addStaff, api, createMenu, createTable, createTenant, startApp, type TestApp, type TestMenu, type TestTenant } from './helpers';

let t: TestApp;
let tenant: TestTenant;
let menu: TestMenu;
let owner: ReturnType<typeof api>;
let waiter: ReturnType<typeof api>;
let otherWaiter: ReturnType<typeof api>;
let waiterId: string;
let cook: ReturnType<typeof api>;
const delivered: { endpoint: string; message: PushMessage }[] = [];
let tables = 0;

beforeAll(async () => {
  t = await startApp();
  tenant = await createTenant(t);
  menu = await createMenu(t, tenant);
  owner = api(t, tenant.ownerToken);
  const w = await addStaff(t, tenant, 'waiter');
  waiter = api(t, w.token);
  waiterId = w.userId;
  otherWaiter = api(t, (await addStaff(t, tenant, 'waiter')).token);
  cook = api(t, (await addStaff(t, tenant, 'kitchen')).token);
  t.ctx.push = {
    publicKey: 'BTestPublicKey',
    send: async (device, message) => {
      delivered.push({ endpoint: device.endpoint, message });
      return 'ok';
    },
  };
  const subscribe = (as: ReturnType<typeof api>, name: string) =>
    as({ method: 'POST', url: '/v1/push/subscriptions', payload: { outlet_id: tenant.outletId, endpoint: `https://push.example.com/ready-${name}`, keys: { p256dh: 'BKey', auth: 'secret' } } });
  await subscribe(owner, 'owner');
  await subscribe(waiter, 'waiter');
  await subscribe(otherWaiter, 'other');
});
afterAll(() => t.close());

const to = (name: string) => delivered.filter((d) => d.endpoint === `https://push.example.com/ready-${name}`).map((d) => d.message);

/** A table order with a cold coffee from the bar and a paneer tikka from the kitchen. */
async function mixedOrder(opts: { assignTo?: string } = {}) {
  const label = `R${++tables}`;
  const tableId = await createTable(t, tenant, label);
  if (opts.assignTo) await owner({ method: 'PATCH', url: `/v1/tables/${tableId}/waiter`, payload: { waiter_id: opts.assignTo } });
  const res = await waiter({
    method: 'POST',
    url: '/v1/orders',
    payload: {
      outlet_id: tenant.outletId,
      type: 'dine_in',
      table_id: tableId,
      lines: [
        { item_id: menu.coldCoffee, qty: 2, modifier_ids: [menu.regular] },
        { item_id: menu.paneerTikka, qty: 1 },
      ],
    },
  });
  expect(res.statusCode).toBe(201);
  const order: OrderDTO = res.json();
  const drinks = order.items.filter((i) => i.station === 'bar').map((i) => i.id);
  const food = order.items.filter((i) => i.station === 'kitchen').map((i) => i.id);
  return { label, tableId, order, drinks, food };
}

const setItems = (as: ReturnType<typeof api>, orderId: string, ids: string[], status: string) =>
  as({ method: 'PATCH', url: `/v1/orders/${orderId}/items/status`, payload: { item_ids: ids, status } });

async function readyEvents(orderId: string): Promise<ItemsReadyDTO[]> {
  const rows = await t.ctx.adminDb.selectFrom('outlet_events').select(['payload']).where('type', '=', 'order.items_ready').orderBy('seq').execute();
  return rows.map((r) => r.payload as unknown as ItemsReadyDTO).filter((p) => p.order_id === orderId);
}

describe('bar and kitchen in one order', () => {
  it('tells the floor when the drinks are ready while the food still cooks', async () => {
    const { label, tableId, order, drinks } = await mixedOrder();
    const res = await setItems(cook, order.id, drinks, 'ready');
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('accepted');

    const [news] = await readyEvents(order.id);
    expect(news).toMatchObject({ table_label: label, stations: ['bar'], complete: false, items: [{ name: 'Cold Coffee', qty: 2, station: 'bar' }] });

    // Waiters' phones buzz, the owner's does not (they did not ask to run plates).
    await vi.waitFor(() => expect(to('waiter').some((m) => m.title === `Table ${label} · Bar ready`)).toBe(true));
    expect(to('waiter').find((m) => m.title === `Table ${label} · Bar ready`)).toMatchObject({ body: '2× Cold Coffee', url: '/app/inbox', tag: `ready-${order.id}` });
    expect(to('owner').filter((m) => m.tag === `ready-${order.id}`)).toHaveLength(0);

    const floor: TableDTO[] = (await waiter({ method: 'GET', url: `/v1/tables?outlet_id=${tenant.outletId}` })).json();
    expect(floor.find((x) => x.id === tableId)!.ready_items).toBe(2);
  });

  it('lets the waiter serve the drinks first, and takes them off the bar screen', async () => {
    const { tableId, order, drinks, food } = await mixedOrder();
    await setItems(cook, order.id, drinks, 'ready');
    const served = await setItems(waiter, order.id, drinks, 'served');
    expect(served.statusCode).toBe(200);
    const after: OrderDTO = served.json();
    expect(after.status).toBe('accepted');
    expect(after.items.filter((i) => drinks.includes(i.id)).every((i) => i.status === 'served')).toBe(true);
    expect(after.items.filter((i) => food.includes(i.id)).every((i) => i.status === 'accepted')).toBe(true);

    const bar: OrderDTO[] = (await cook({ method: 'GET', url: `/v1/kds?outlet_id=${tenant.outletId}&station=bar` })).json();
    expect(bar.some((o) => o.id === order.id)).toBe(false);
    const kitchen: OrderDTO[] = (await cook({ method: 'GET', url: `/v1/kds?outlet_id=${tenant.outletId}&station=kitchen` })).json();
    expect(kitchen.some((o) => o.id === order.id)).toBe(true);
    const floor: TableDTO[] = (await waiter({ method: 'GET', url: `/v1/tables?outlet_id=${tenant.outletId}` })).json();
    expect(floor.find((x) => x.id === tableId)!.ready_items).toBe(0);

    // Then the food: the whole order is ready, and the note lists only what is still waiting.
    const ready = await setItems(cook, order.id, food, 'ready');
    expect(ready.json().status).toBe('ready');
    const events = await readyEvents(order.id);
    expect(events.at(-1)).toMatchObject({ stations: ['kitchen'], complete: true, items: [{ name: 'Paneer Tikka', qty: 1, station: 'kitchen' }] });
    const done = await setItems(waiter, order.id, food, 'served');
    expect(done.json().status).toBe('served');
  });

  it('stays quiet until a station has finished its whole part', async () => {
    const { order } = await mixedOrder();
    await cook({ method: 'PATCH', url: `/v1/order-items/${order.items.find((i) => i.station === 'kitchen')!.id}/status`, payload: { status: 'preparing' } });
    expect(await readyEvents(order.id)).toHaveLength(0);
    // Marking the whole order ready from the inbox counts too.
    await cook({ method: 'PATCH', url: `/v1/orders/${order.id}/status`, payload: { status: 'ready' } });
    const events = await readyEvents(order.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ complete: true });
    expect(events[0]!.items).toHaveLength(2);
  });

  it('only buzzes the assigned waiter for their table', async () => {
    const { label, order, drinks } = await mixedOrder({ assignTo: waiterId });
    await setItems(cook, order.id, drinks, 'ready');
    await vi.waitFor(() => expect(to('waiter').some((m) => m.title === `Table ${label} · Bar ready`)).toBe(true));
    expect(to('other').some((m) => m.title.startsWith(`Table ${label} `))).toBe(false);
  });

  it('checks who may move items and which items', async () => {
    const { order, drinks, food } = await mixedOrder();
    expect((await setItems(waiter, order.id, drinks, 'ready')).statusCode).toBe(403);
    expect((await setItems(cook, order.id, drinks, 'served')).statusCode).toBe(403);
    const other = await mixedOrder();
    expect((await setItems(cook, order.id, [...drinks, other.food[0]!], 'ready')).statusCode).toBe(404);
    await setItems(cook, order.id, [...drinks, ...food], 'ready');
    const again = await setItems(cook, order.id, [...drinks, ...food], 'ready');
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('invalid_transition');
  });
});

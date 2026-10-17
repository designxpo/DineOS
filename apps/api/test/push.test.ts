// Push alerts on staff phones while the portal is closed: a guest order to accept, a waiter call,
// a bill request. Only staff who can act on it, at that outlet, on devices they turned it on for.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PushMessage } from '../src/lib/push';
import { addStaff, api, createMenu, createTable, createTenant, startApp, type TestApp, type TestMenu, type TestTenant } from './helpers';

let t: TestApp;
let tenant: TestTenant;
let menu: TestMenu;
let owner: ReturnType<typeof api>;
let waiter: ReturnType<typeof api>;
let kitchen: ReturnType<typeof api>;
const delivered: { endpoint: string; message: PushMessage }[] = [];
const gone = new Set<string>();
let tables = 0;

beforeAll(async () => {
  t = await startApp();
  tenant = await createTenant(t);
  menu = await createMenu(t, tenant);
  owner = api(t, tenant.ownerToken);
  waiter = api(t, (await addStaff(t, tenant, 'waiter')).token);
  kitchen = api(t, (await addStaff(t, tenant, 'kitchen')).token);
  t.ctx.push = {
    publicKey: 'BTestPublicKey',
    send: async (device, message) => {
      if (gone.has(device.endpoint)) return 'gone';
      delivered.push({ endpoint: device.endpoint, message });
      return 'ok';
    },
  };
});
afterAll(() => t.close());

const endpoint = (name: string) => `https://push.example.com/${name}`;
const subscribe = (as: ReturnType<typeof api>, name: string) =>
  as({ method: 'POST', url: '/v1/push/subscriptions', payload: { outlet_id: tenant.outletId, endpoint: endpoint(name), keys: { p256dh: 'BKey', auth: 'secret' } } });

async function guestAt() {
  const label = `P${++tables}`;
  const tableId = await createTable(t, tenant, label);
  const qr = new URL((await owner({ method: 'GET', url: `/v1/tables/${tableId}/qr` })).json().url).pathname.split('/').pop()!;
  const guest = api(t, (await t.app.inject({ method: 'POST', url: '/v1/guest/join', payload: { qr_token: qr } })).json().guest_token);
  return { label, guest };
}

async function guestOrder(guest: ReturnType<typeof api>) {
  await guest({ method: 'POST', url: '/v1/guest/cart/lines', payload: { item_id: menu.paneerTikka, qty: 2, modifier_ids: [] } });
  expect((await guest({ method: 'POST', url: '/v1/guest/orders', payload: {} })).statusCode).toBe(201);
}

const to = (name: string) => delivered.filter((d) => d.endpoint === endpoint(name));

describe('push alerts', () => {
  it('gives the browser the public key and stores each device once', async () => {
    expect((await waiter({ method: 'GET', url: '/v1/push/config' })).json()).toEqual({ public_key: 'BTestPublicKey' });
    expect((await subscribe(owner, 'owner')).statusCode).toBe(201);
    expect((await subscribe(owner, 'owner')).statusCode).toBe(201);
    const rows = await t.ctx.adminDb.selectFrom('push_subscriptions').select('id').where('endpoint', '=', endpoint('owner')).execute();
    expect(rows).toHaveLength(1);
    const insecure = await owner({ method: 'POST', url: '/v1/push/subscriptions', payload: { outlet_id: tenant.outletId, endpoint: 'http://push.example.com/x', keys: { p256dh: 'k', auth: 'a' } } });
    expect(insecure.statusCode).toBe(400);
  });

  it('alerts staff who can act when a guest orders, but not the kitchen, and not for orders staff enter', async () => {
    await subscribe(waiter, 'waiter');
    await subscribe(kitchen, 'kitchen');
    const { label, guest } = await guestAt();
    await guestOrder(guest);
    await vi.waitFor(() => expect(to('waiter').length + to('owner').length).toBe(2));
    expect(to('waiter')[0]!.message).toMatchObject({ title: 'New order to accept', url: '/app/inbox' });
    expect(to('waiter')[0]!.message.body).toContain(`Table ${label}`);
    expect(to('kitchen')).toHaveLength(0);

    // A waiter's own order needs nobody's attention; the next guest request still arrives.
    const tableId = await createTable(t, tenant, 'P-STAFF');
    await waiter({ method: 'POST', url: '/v1/orders', payload: { outlet_id: tenant.outletId, type: 'dine_in', table_id: tableId, lines: [{ item_id: menu.paneerTikka, qty: 1 }] } });
    const next = await guestAt();
    await next.guest({ method: 'POST', url: '/v1/guest/call-waiter' });
    await vi.waitFor(() => expect(to('waiter').some((d) => d.message.title.includes('calling a waiter'))).toBe(true));
    expect(to('waiter').filter((d) => d.message.title.startsWith('New order'))).toHaveLength(1);
  });

  it('alerts when a guest calls a waiter or asks for the bill', async () => {
    const { label, guest } = await guestAt();
    await guestOrder(guest);
    await guest({ method: 'POST', url: '/v1/guest/request-bill' });
    await vi.waitFor(() => expect(to('waiter').some((d) => d.message.title === `Table ${label} asked for the bill`)).toBe(true));
    expect(to('waiter').find((d) => d.message.title === `Table ${label} asked for the bill`)!.message.url).toBe('/app/floor');
  });

  it('forgets a device the push service no longer knows', async () => {
    gone.add(endpoint('waiter'));
    const { guest } = await guestAt();
    await guestOrder(guest);
    await vi.waitFor(async () => {
      const rows = await t.ctx.adminDb.selectFrom('push_subscriptions').select('id').where('endpoint', '=', endpoint('waiter')).execute();
      expect(rows).toHaveLength(0);
    });
  });

  it('lets staff turn alerts off on a device, but not anyone else’s', async () => {
    expect((await waiter({ method: 'DELETE', url: '/v1/push/subscriptions', payload: { endpoint: endpoint('owner') } })).statusCode).toBe(204);
    expect(await t.ctx.adminDb.selectFrom('push_subscriptions').select('id').where('endpoint', '=', endpoint('owner')).execute()).toHaveLength(1);
    expect((await owner({ method: 'DELETE', url: '/v1/push/subscriptions', payload: { endpoint: endpoint('owner') } })).statusCode).toBe(204);
    expect(await t.ctx.adminDb.selectFrom('push_subscriptions').select('id').where('endpoint', '=', endpoint('owner')).execute()).toHaveLength(0);
  });
});

// Guest QR flow, including spec §14 acceptance criteria:
//  - scan, add 3 items with a modifier, order: visible to owner portal and KDS in < 2 s
//  - out-of-stock reaches every open guest menu in < 2 s
//  - rejecting an order notifies the guest with the reason
//  - a closed table's old QR session cannot place an order

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CartDTO, GuestJoinResponseDTO, GuestSessionDTO, OrderDTO } from '@dineos/shared/dto';
import { closeSession } from '../src/modules/tables/sessions';
import {
  addStaff,
  api,
  connectSocket,
  createMenu,
  createTable,
  createTenant,
  nextEvent,
  startApp,
  type TestApp,
  type TestMenu,
  type TestTenant,
} from './helpers';

let t: TestApp;
let tenant: TestTenant;
let menu: TestMenu;
let owner: ReturnType<typeof api>;

beforeAll(async () => {
  t = await startApp();
  tenant = await createTenant(t);
  menu = await createMenu(t, tenant);
  owner = api(t, tenant.ownerToken);
});
afterAll(() => t.close());

async function qrFor(tableId: string): Promise<string> {
  const res = await owner({ method: 'GET', url: `/v1/tables/${tableId}/qr` });
  expect(res.statusCode).toBe(200);
  return new URL(res.json().url).pathname.split('/').pop()!;
}

async function join(qr: string, deviceId?: string): Promise<GuestJoinResponseDTO> {
  const res = await t.app.inject({ method: 'POST', url: '/v1/guest/join', payload: { qr_token: qr, device_id: deviceId } });
  expect(res.statusCode).toBe(200);
  return res.json();
}

const threeItems = (m: TestMenu) => [
  { item_id: m.paneerTikka, qty: 1, modifier_ids: [] },
  { item_id: m.coldCoffee, qty: 2, modifier_ids: [m.large], note: 'no sugar' },
  { item_id: m.chickenTikka, qty: 1, modifier_ids: [] },
];

async function fillCartAndOrder(guest: ReturnType<typeof api>) {
  for (const line of threeItems(menu)) {
    const res = await guest({ method: 'POST', url: '/v1/guest/cart/lines', payload: line });
    expect(res.statusCode).toBe(200);
  }
  return guest({ method: 'POST', url: '/v1/guest/orders', payload: {} });
}

describe('guest ordering', () => {
  it('resolves a QR to outlet and table without creating a session', async () => {
    const tableId = await createTable(t, tenant, 'G1');
    const qr = await qrFor(tableId);
    const res = await t.app.inject({ method: 'GET', url: `/v1/guest/resolve?qr=${qr}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ table: { label: 'G1' }, outlet: { name: 'Main Outlet' } });
    const table = await t.ctx.adminDb.selectFrom('tables').select('current_session_id').where('id', '=', tableId).executeTakeFirstOrThrow();
    expect(table.current_session_id).toBeNull();
  });

  it('acceptance: QR order with a modifier reaches the owner portal and KDS in under 2 seconds', async () => {
    const tableId = await createTable(t, tenant, 'G2');
    const { guest_token } = await join(await qrFor(tableId));
    const guest = api(t, guest_token);

    const ownerSocket = await connectSocket(t, '/staff', tenant.ownerToken);
    const kds = await connectSocket(t, '/staff', (await addStaff(t, tenant, 'kitchen')).token);

    for (const line of threeItems(menu)) {
      expect((await guest({ method: 'POST', url: '/v1/guest/cart/lines', payload: line })).statusCode).toBe(200);
    }
    const started = Date.now();
    const atOwner = nextEvent<{ order: OrderDTO }>(ownerSocket, 'order.placed');
    const atKds = nextEvent<{ order: OrderDTO }>(kds, 'order.placed');
    const res = await guest({ method: 'POST', url: '/v1/guest/orders', payload: { note: 'Birthday' } });
    expect(res.statusCode).toBe(201);
    const [o1, o2] = await Promise.all([atOwner, atKds]);
    const elapsed = Date.now() - started;
    ownerSocket.close();
    kds.close();

    expect(elapsed).toBeLessThan(2000);
    expect(o1.payload.order.id).toBe(res.json().order.id);
    expect(o2.payload.order.items).toHaveLength(3);
    expect(o1.payload.order.table_label).toBe('G2');
    expect(res.json().cart.lines).toHaveLength(0); // ordered lines leave the shared cart
    const coffee = o1.payload.order.items.find((i) => i.name === 'Cold Coffee')!;
    expect(coffee.modifiers[0]!.name).toBe('Large');
    expect(coffee.note).toBe('no sugar');
  });

  it('shares one cart between phones at the same table, live', async () => {
    const tableId = await createTable(t, tenant, 'G3');
    const qr = await qrFor(tableId);
    const a = await join(qr);
    const b = await join(qr);
    expect(b.session_id).toBe(a.session_id);

    const phoneB = await connectSocket(t, '/guest', b.guest_token);
    const pushed = nextEvent<CartDTO>(phoneB, 'cart.updated');
    await api(t, a.guest_token)({ method: 'POST', url: '/v1/guest/cart/lines', payload: threeItems(menu)[0] });
    const event = await pushed;
    phoneB.close();
    expect(event.payload.lines).toHaveLength(1);

    // Adding the same choice again bumps the quantity instead of a new line.
    await api(t, b.guest_token)({ method: 'POST', url: '/v1/guest/cart/lines', payload: threeItems(menu)[0] });
    const session: GuestSessionDTO = (await api(t, a.guest_token)({ method: 'GET', url: '/v1/guest/session' })).json();
    expect(session.cart.lines).toHaveLength(1);
    expect(session.cart.lines[0]!.qty).toBe(2);

    const lineId = session.cart.lines[0]!.line_id;
    const updated = await api(t, b.guest_token)({ method: 'PATCH', url: `/v1/guest/cart/lines/${lineId}`, payload: { qty: 0 } });
    expect(updated.json().lines).toHaveLength(0);
  });

  it('refuses an item with a missing required choice when it is added', async () => {
    const tableId = await createTable(t, tenant, 'G4');
    const { guest_token } = await join(await qrFor(tableId));
    const res = await api(t, guest_token)({
      method: 'POST',
      url: '/v1/guest/cart/lines',
      payload: { item_id: menu.coldCoffee, qty: 1, modifier_ids: [] },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ code: 'items_unavailable', message: 'Choose at least 1 in Size' });
  });

  it('acceptance: out of stock reaches every open guest menu in under 2 seconds', async () => {
    const phones = [];
    for (const label of ['G5', 'G6']) {
      const { guest_token } = await join(await qrFor(await createTable(t, tenant, label)));
      phones.push(await connectSocket(t, '/guest', guest_token));
    }
    const started = Date.now();
    const received = phones.map((p) => nextEvent<{ item_id: string; in_stock: boolean }>(p, 'item.stock_changed'));
    const res = await owner({ method: 'PATCH', url: `/v1/menu/items/${menu.chickenTikka}/stock`, payload: { in_stock: false } });
    expect(res.statusCode).toBe(200);
    const events = await Promise.all(received);
    expect(Date.now() - started).toBeLessThan(2000);
    for (const p of phones) p.close();
    for (const e of events) expect(e.payload).toEqual({ item_id: menu.chickenTikka, in_stock: false });

    const publicMenu = await t.app.inject({ method: 'GET', url: `/v1/public/menu/${tenant.tenantId}/${tenant.outletId}` });
    expect(publicMenu.json().items.find((i: { id: string }) => i.id === menu.chickenTikka).in_stock).toBe(false);
    await owner({ method: 'PATCH', url: `/v1/menu/items/${menu.chickenTikka}/stock`, payload: { in_stock: true } });
  });

  it('acceptance: rejecting an order notifies the guest with the reason', async () => {
    const { guest_token } = await join(await qrFor(await createTable(t, tenant, 'G7')));
    const guest = api(t, guest_token);
    const phone = await connectSocket(t, '/guest', guest_token);
    const placed = await fillCartAndOrder(guest);
    const orderId = placed.json().order.id;
    const notified = nextEvent<{ status: string; reason: string }>(phone, 'order.status_changed');
    const res = await owner({ method: 'PATCH', url: `/v1/orders/${orderId}/status`, payload: { status: 'rejected', reason: 'Kitchen is closing' } });
    expect(res.statusCode).toBe(200);
    const event = await notified;
    phone.close();
    expect(event.payload).toMatchObject({ status: 'rejected', reason: 'Kitchen is closing' });
    // The guest payload never carries staff-only fields.
    expect(JSON.stringify(event.payload)).not.toContain('created_by_name');
  });

  it("acceptance: a closed table's old QR session cannot place an order", async () => {
    const tableId = await createTable(t, tenant, 'G8');
    const qr = await qrFor(tableId);
    const first = await join(qr);
    const guest = api(t, first.guest_token);
    expect((await fillCartAndOrder(guest)).statusCode).toBe(201);
    await t.ctx.tx(tenant.tenantId, (tx) => closeSession(tx, first.session_id, 'staff'));

    const cart = await guest({ method: 'POST', url: '/v1/guest/cart/lines', payload: threeItems(menu)[0] });
    expect(cart.statusCode).toBe(410);
    const order = await guest({ method: 'POST', url: '/v1/guest/orders', payload: {} });
    expect(order.statusCode).toBe(410);
    expect(order.json().error.code).toBe('session_closed');

    // Scanning again starts a fresh visit with an empty cart.
    const second = await join(qr);
    expect(second.session_id).not.toBe(first.session_id);
    const fresh: GuestSessionDTO = (await api(t, second.guest_token)({ method: 'GET', url: '/v1/guest/session' })).json();
    expect(fresh.cart.lines).toHaveLength(0);
    expect(fresh.orders).toHaveLength(0);
  });

  it('kills every printed copy when the QR is rotated', async () => {
    const tableId = await createTable(t, tenant, 'G9');
    const oldQr = await qrFor(tableId);
    expect((await owner({ method: 'POST', url: `/v1/tables/${tableId}/rotate-qr` })).statusCode).toBe(200);
    const res = await t.app.inject({ method: 'POST', url: '/v1/guest/join', payload: { qr_token: oldQr } });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('invalid_qr');
    expect((await t.app.inject({ method: 'POST', url: '/v1/guest/join', payload: { qr_token: await qrFor(tableId) } })).statusCode).toBe(200);
  });

  it('rejects forged QR tokens', async () => {
    const qr = await qrFor(await createTable(t, tenant, 'G10'));
    const forged = qr.slice(0, -2) + (qr.endsWith('AA') ? 'BB' : 'AA');
    expect((await t.app.inject({ method: 'GET', url: `/v1/guest/resolve?qr=${forged}` })).statusCode).toBe(404);
  });

  it('rate-limits rapid orders from one phone', async () => {
    const { guest_token } = await join(await qrFor(await createTable(t, tenant, 'G11')));
    const guest = api(t, guest_token);
    const codes = [];
    for (let i = 0; i < 4; i++) {
      await guest({ method: 'POST', url: '/v1/guest/cart/lines', payload: threeItems(menu)[0] });
      codes.push((await guest({ method: 'POST', url: '/v1/guest/orders', payload: {} })).statusCode);
    }
    expect(codes).toEqual([201, 201, 201, 429]);
  });

  async function ordersFromPhones(qr: string, phones: number, perPhone: number): Promise<number[]> {
    const codes: number[] = [];
    for (let p = 0; p < phones; p++) {
      const guest = api(t, (await join(qr)).guest_token);
      for (let i = 0; i < perPhone; i++) {
        await guest({ method: 'POST', url: '/v1/guest/cart/lines', payload: threeItems(menu)[0] });
        codes.push((await guest({ method: 'POST', url: '/v1/guest/orders', payload: {} })).statusCode);
      }
    }
    return codes;
  }

  it('caps how many orders one small table can send in ten minutes', async () => {
    const codes = await ordersFromPhones(await qrFor(await createTable(t, tenant, 'G20')), 5, 2);
    expect(codes.filter((c) => c === 201)).toHaveLength(8);
    expect(codes.slice(8)).toEqual([429, 429]);
  });

  it('lets a big party at joined tables order more', async () => {
    const tableIds = [await createTable(t, tenant, 'G21'), await createTable(t, tenant, 'G22'), await createTable(t, tenant, 'G23')];
    expect((await owner({ method: 'POST', url: '/v1/tables/merge', payload: { table_ids: tableIds } })).statusCode).toBe(200);
    // Twelve seats: room for 24 orders in ten minutes, not 8.
    const codes = await ordersFromPhones(await qrFor(tableIds[0]!), 6, 2);
    expect(codes.every((c) => c === 201)).toBe(true);
  });

  it('calls a waiter and requests the bill, which shows on the floor map', async () => {
    const tableId = await createTable(t, tenant, 'G12');
    const { guest_token } = await join(await qrFor(tableId));
    const guest = api(t, guest_token);
    const staff = await connectSocket(t, '/staff', tenant.ownerToken);

    const called = nextEvent(staff, 'waiter.called');
    expect((await guest({ method: 'POST', url: '/v1/guest/call-waiter' })).statusCode).toBe(200);
    await called;
    // Pressing again does not create a second request.
    await guest({ method: 'POST', url: '/v1/guest/call-waiter' });

    expect((await guest({ method: 'POST', url: '/v1/guest/request-bill' })).statusCode).toBe(409); // nothing ordered yet
    await fillCartAndOrder(guest);
    const billRequested = nextEvent(staff, 'bill.requested');
    expect((await guest({ method: 'POST', url: '/v1/guest/request-bill' })).statusCode).toBe(200);
    await billRequested;
    staff.close();

    const floor = (await owner({ method: 'GET', url: `/v1/tables?outlet_id=${tenant.outletId}` })).json();
    const row = floor.find((x: { id: string }) => x.id === tableId);
    expect(row.state).toBe('bill_requested');
    expect(row.open_requests.map((r: { kind: string }) => r.kind).sort()).toEqual(['bill', 'call_waiter']);
    expect(row.running_total_paise).toBe(25000 + 2 * 24000 + 32000);
  });

  it('serves a cacheable public menu', async () => {
    const res = await t.app.inject({ method: 'GET', url: `/v1/public/menu/${tenant.tenantId}/${tenant.outletId}` });
    expect(res.statusCode).toBe(200);
    const version = res.json().menu_version;
    const pinned = await t.app.inject({ method: 'GET', url: `/v1/public/menu/${tenant.tenantId}/${tenant.outletId}?v=${version}` });
    expect(pinned.headers['cache-control']).toContain('public');
    const other = await createTenant(t);
    const cross = await t.app.inject({ method: 'GET', url: `/v1/public/menu/${other.tenantId}/${tenant.outletId}` });
    expect(cross.statusCode).toBe(404);
  });
});

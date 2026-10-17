// Core order loop at the service level: guest order -> staff socket in < 2 s, approval flow,
// kitchen progress, table state. Endpoint-level tests live with each module.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrderDTO } from '@mezmitra/shared/dto';
import { authenticate, type StaffAuth } from '../src/lib/auth';
import { createOrder, setItemStatus, transitionOrder } from '../src/modules/orders/service';
import { seatTable } from '../src/modules/tables/floor';
import { closeSession, getOrCreateSession } from '../src/modules/tables/sessions';
import {
  addStaff,
  connectSocket,
  createMenu,
  createTable,
  createTenant,
  nextEvent,
  setOutlet,
  startApp,
  type TestApp,
  type TestMenu,
  type TestTenant,
} from './helpers';

let t: TestApp;
let tenant: TestTenant;
let menu: TestMenu;
let owner: StaffAuth;

beforeAll(async () => {
  t = await startApp();
  tenant = await createTenant(t);
  menu = await createMenu(t, tenant);
  owner = (await authenticate(t.ctx, tenant.ownerToken)) as StaffAuth;
});
afterAll(() => t.close());

async function seatGuests(label: string) {
  const tableId = await createTable(t, tenant, label);
  const session = await t.ctx.tx(tenant.tenantId, (tx) => getOrCreateSession(tx, tableId));
  return { tableId, sessionId: session.id };
}

function guestOrder(sessionId: string, deviceId = randomUUID()) {
  return t.ctx.tx(tenant.tenantId, (tx) =>
    createOrder(tx, {
      outletId: tenant.outletId,
      type: 'dine_in',
      source: 'guest_qr',
      sessionId,
      deviceId,
      lines: [
        { item_id: menu.paneerTikka, qty: 1, modifier_ids: [] },
        { item_id: menu.coldCoffee, qty: 2, modifier_ids: [menu.large, menu.extraShot], note: 'less ice' },
        { item_id: menu.chickenTikka, qty: 1, modifier_ids: [] },
      ],
    }),
  );
}

async function tableState(tableId: string) {
  const row = await t.ctx.adminDb.selectFrom('tables').select('state').where('id', '=', tableId).executeTakeFirstOrThrow();
  return row.state;
}

describe('guest order to staff', () => {
  it('reaches a staff socket in under 2 seconds with snapshots and modifiers priced', async () => {
    const kitchen = await addStaff(t, tenant, 'kitchen');
    const socket = await connectSocket(t, '/staff', kitchen.token);
    const { sessionId } = await seatGuests('A1');
    const started = Date.now();
    const received = nextEvent<{ order: OrderDTO }>(socket, 'order.placed');
    const order = await guestOrder(sessionId);
    const event = await received;
    expect(Date.now() - started).toBeLessThan(2000);
    socket.close();

    expect(event.payload.order.id).toBe(order.id);
    expect(order.status).toBe('placed'); // manager approval is the default
    expect(order.flagged).toBe(true);
    const coffee = order.items.find((i) => i.name === 'Cold Coffee')!;
    expect(coffee.unit_price_paise).toBe(18000 + 6000 + 4000);
    expect(coffee.modifiers.map((m) => m.name)).toEqual(['Large', 'Extra shot']);
    expect(coffee.station).toBe('bar');
    expect(order.subtotal_paise).toBe(25000 + 2 * 28000 + 32000);
  });

  it('rejects missing required modifiers and out-of-stock items with details', async () => {
    const { sessionId } = await seatGuests('A2');
    await t.ctx.adminDb.updateTable('menu_items').set({ in_stock: false }).where('id', '=', menu.paneerTikka).execute();
    const err = await t.ctx
      .tx(tenant.tenantId, (tx) =>
        createOrder(tx, {
          outletId: tenant.outletId,
          type: 'dine_in',
          source: 'guest_qr',
          sessionId,
          lines: [
            { item_id: menu.paneerTikka, qty: 1, modifier_ids: [] },
            { item_id: menu.coldCoffee, qty: 1, modifier_ids: [] },
          ],
        }),
      )
      .catch((e) => e);
    await t.ctx.adminDb.updateTable('menu_items').set({ in_stock: true }).where('id', '=', menu.paneerTikka).execute();
    expect(err.code).toBe('items_unavailable');
    expect(err.details.items.map((i: { reason: string }) => i.reason).sort()).toEqual(['out_of_stock', 'too_few']);
  });

  it('auto-accepts repeat orders from a known device when the outlet allows it', async () => {
    await setOutlet(t, tenant.outletId, { auto_accept: true });
    const { sessionId } = await seatGuests('A3');
    const device = randomUUID();
    const first = await guestOrder(sessionId, device);
    expect(first.status).toBe('placed'); // first order from a new device is flagged and waits
    await t.ctx.tx(tenant.tenantId, (tx) => transitionOrder(tx, owner, first.id, 'accepted'));
    const second = await guestOrder(sessionId, device);
    expect(second.status).toBe('accepted');
    expect(second.flagged).toBe(false);
    await setOutlet(t, tenant.outletId, { auto_accept: false });
  });

  it('holds an order from a phone that was at the table in an earlier visit, even when everything is automatic', async () => {
    await setOutlet(t, tenant.outletId, { auto_accept: true, approve_flagged_orders: false });
    const { tableId, sessionId: earlierVisit } = await seatGuests('A4');
    const leftPhone = randomUUID();
    expect((await guestOrder(earlierVisit, leftPhone)).status).toBe('accepted');
    await t.ctx.tx(tenant.tenantId, (tx) => closeSession(tx, earlierVisit, 'staff'));

    const nextVisit = await t.ctx.tx(tenant.tenantId, (tx) => getOrCreateSession(tx, tableId));
    const newGuests = await guestOrder(nextVisit.id);
    expect(newGuests.status).toBe('accepted');
    const prank = await guestOrder(nextVisit.id, leftPhone);
    expect(prank).toMatchObject({ status: 'placed', flagged: true, flag_reason: 'returning_device' });

    // Once staff accept it (a guest who really came back), that phone orders normally again.
    await t.ctx.tx(tenant.tenantId, (tx) => transitionOrder(tx, owner, prank.id, 'accepted'));
    expect((await guestOrder(nextVisit.id, leftPhone)).status).toBe('accepted');
    await setOutlet(t, tenant.outletId, { auto_accept: false, approve_flagged_orders: true });
  });

  it('checks the first order at a table once: after staff accept it, the other phones at that table go straight through', async () => {
    await setOutlet(t, tenant.outletId, { auto_accept: true, approve_flagged_orders: true });
    const { sessionId } = await seatGuests('A6');
    const first = await guestOrder(sessionId);
    expect(first).toMatchObject({ status: 'placed', flagged: true, flag_reason: 'first_order_from_device' });
    await t.ctx.tx(tenant.tenantId, (tx) => transitionOrder(tx, owner, first.id, 'accepted'));
    // A big party: everyone else orders from their own phone without staff tapping approve again.
    for (let i = 0; i < 3; i++) expect(await guestOrder(sessionId)).toMatchObject({ status: 'accepted', flagged: false });
    await setOutlet(t, tenant.outletId, { auto_accept: false });
  });

  it('skips the first-order check at a table a waiter seated', async () => {
    await setOutlet(t, tenant.outletId, { auto_accept: true, approve_flagged_orders: true });
    const tableId = await createTable(t, tenant, 'A7');
    const sessionId = await t.ctx.tx(tenant.tenantId, (tx) => seatTable(tx, tableId, { guestCount: 6, waiterId: null }));
    expect(await guestOrder(sessionId)).toMatchObject({ status: 'accepted', flagged: false });
    await setOutlet(t, tenant.outletId, { auto_accept: false });
  });

  it('treats a phone from a visit that ended over 12 hours ago like any new phone', async () => {
    await setOutlet(t, tenant.outletId, { auto_accept: true, approve_flagged_orders: false });
    const { tableId, sessionId: yesterday } = await seatGuests('A5');
    const phone = randomUUID();
    await guestOrder(yesterday, phone);
    await t.ctx.tx(tenant.tenantId, (tx) => closeSession(tx, yesterday, 'staff'));
    await t.ctx.adminDb.updateTable('table_sessions').set({ closed_at: new Date(Date.now() - 13 * 3_600_000) }).where('id', '=', yesterday).execute();

    const today = await t.ctx.tx(tenant.tenantId, (tx) => getOrCreateSession(tx, tableId));
    expect(await guestOrder(today.id, phone)).toMatchObject({ status: 'accepted', flag_reason: 'first_order_from_device' });
    await setOutlet(t, tenant.outletId, { auto_accept: false, approve_flagged_orders: true });
  });
});

describe('order lifecycle and table state', () => {
  it('walks vacant -> ordered -> served -> needs_cleaning', async () => {
    const { tableId, sessionId } = await seatGuests('B1');
    expect(await tableState(tableId)).toBe('vacant'); // a cart-only session does not occupy the table

    const order = await guestOrder(sessionId);
    expect(await tableState(tableId)).toBe('ordered');

    const accepted = await t.ctx.tx(tenant.tenantId, (tx) => transitionOrder(tx, owner, order.id, 'accepted'));
    expect(accepted.items.every((i) => i.status === 'accepted')).toBe(true);
    const kots = await t.ctx.adminDb.selectFrom('kots').select(['station', 'kot_no']).where('order_id', '=', order.id).execute();
    expect(kots.map((k) => k.station).sort()).toEqual(['bar', 'kitchen']);

    // One dish ready early: the order stays preparing until every item is ready.
    const cook = (await authenticate(t.ctx, (await addStaff(t, tenant, 'kitchen')).token)) as StaffAuth;
    const [a, b, c] = accepted.items;
    let o = await t.ctx.tx(tenant.tenantId, (tx) => setItemStatus(tx, cook, a!.id, 'ready'));
    expect(o.status).toBe('accepted');
    await t.ctx.tx(tenant.tenantId, (tx) => setItemStatus(tx, cook, b!.id, 'ready'));
    o = await t.ctx.tx(tenant.tenantId, (tx) => setItemStatus(tx, cook, c!.id, 'ready'));
    expect(o.status).toBe('ready');
    expect(o.ready_at).not.toBeNull();

    await expect(t.ctx.tx(tenant.tenantId, (tx) => transitionOrder(tx, cook, order.id, 'served'))).rejects.toMatchObject({
      status: 403,
    });
    await t.ctx.tx(tenant.tenantId, (tx) => transitionOrder(tx, owner, order.id, 'served'));
    expect(await tableState(tableId)).toBe('served');

    await t.ctx.tx(tenant.tenantId, (tx) => closeSession(tx, sessionId, 'order'));
    expect(await tableState(tableId)).toBe('needs_cleaning');
  });

  it('requires a reason to reject and tells the guest', async () => {
    const { sessionId } = await seatGuests('B2');
    const order = await guestOrder(sessionId);
    await expect(t.ctx.tx(tenant.tenantId, (tx) => transitionOrder(tx, owner, order.id, 'rejected'))).rejects.toMatchObject({
      code: 'reason_required',
    });
    const rejected = await t.ctx.tx(tenant.tenantId, (tx) =>
      transitionOrder(tx, owner, order.id, 'rejected', { reason: 'Kitchen closing' }),
    );
    expect(rejected.status).toBe('rejected');
    expect(rejected.items.every((i) => i.status === 'cancelled')).toBe(true);
    const guestEvent = t.events.find(
      (e) => e.event.type === 'order.status_changed' && e.event.channels.includes(`session:${sessionId}`),
    );
    expect(guestEvent?.event.payload).toMatchObject({ status: 'rejected', reason: 'Kitchen closing' });
  });

  it('needs manager approval to cancel after acceptance', async () => {
    const { sessionId } = await seatGuests('B3');
    const order = await guestOrder(sessionId);
    await t.ctx.tx(tenant.tenantId, (tx) => transitionOrder(tx, owner, order.id, 'accepted'));
    const waiter = (await authenticate(t.ctx, (await addStaff(t, tenant, 'waiter')).token)) as StaffAuth;
    await expect(
      t.ctx.tx(tenant.tenantId, (tx) => transitionOrder(tx, waiter, order.id, 'cancelled', { reason: 'Guest left' })),
    ).rejects.toMatchObject({ code: 'approval_required' });
    const cancelled = await t.ctx.tx(tenant.tenantId, (tx) =>
      transitionOrder(tx, owner, order.id, 'cancelled', { reason: 'Guest left' }),
    );
    expect(cancelled.status).toBe('cancelled');
    const log = await t.ctx.adminDb.selectFrom('audit_log').selectAll().where('entity_id', '=', order.id).execute();
    expect(log).toHaveLength(1);
    expect(log[0]!.action).toBe('order.cancel');
  });

  it('refuses orders on a closed session', async () => {
    const { sessionId } = await seatGuests('B4');
    await guestOrder(sessionId);
    await t.ctx.tx(tenant.tenantId, (tx) => closeSession(tx, sessionId, 'staff'));
    await expect(guestOrder(sessionId)).rejects.toMatchObject({ status: 410, code: 'session_closed' });
  });

  it('numbers orders per outlet per day without gaps', async () => {
    const { sessionId } = await seatGuests('B5');
    const a = await guestOrder(sessionId);
    const b = await guestOrder(sessionId);
    expect(b.order_no).toBe(a.order_no + 1);
  });
});

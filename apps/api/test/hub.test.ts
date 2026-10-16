// The hybrid offline tier end to end: a real API, a real outlet hub, and a network that can be cut.
// Staff keep ordering, cooking, billing and taking payment on the hub during the outage; when the
// connection returns, the cloud ends up with the same orders, GST invoices and payments.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { io as ioClient } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { businessDate, financialYear } from '@dineos/shared/dates';
import type { BillDTO, OrderDTO, TableDTO } from '@dineos/shared/dto';
import { formatHubInvoiceNo, type HubSyncPayload } from '@dineos/shared/hub';
import { OutletHub } from '../../print-agent/src/hub/hub';
import { addStaff, api, connectSocket, createMenu, createTable, createTenant, startApp, type TestApp, type TestMenu, type TestTenant } from './helpers';

let t: TestApp;
let tenant: TestTenant;
let menu: TestMenu;
let owner: ReturnType<typeof api>;
let waiterToken: string;
let cashierToken: string;
let kitchenToken: string;
let deviceToken: string;
let deviceId: string;
let hub: OutletHub;
let hubUrl: string;
let cut = false;
const printed: string[] = [];
const tables: Record<string, string> = {};
let cloudOrder: OrderDTO;
let takeawayBill: BillDTO;
const dataFile = join(mkdtempSync(join(tmpdir(), 'dineos-hub-')), 'hub.json');
const fy = financialYear(businessDate(new Date())).code;

/** fetch that fails like a dead line while `cut` is on. */
const netFetch: typeof fetch = (input, init) => (cut ? Promise.reject(new TypeError('fetch failed')) : fetch(input, init));

function hubApi(token: string | null) {
  return async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`${hubUrl}/v1${path}`, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : undefined };
  };
}

beforeAll(async () => {
  t = await startApp();
  tenant = await createTenant(t);
  menu = await createMenu(t, tenant);
  owner = api(t, tenant.ownerToken);
  waiterToken = (await addStaff(t, tenant, 'waiter')).token;
  cashierToken = (await addStaff(t, tenant, 'cashier')).token;
  kitchenToken = (await addStaff(t, tenant, 'kitchen')).token;
  for (const label of ['H1', 'H2', 'H3']) tables[label] = await createTable(t, tenant, label);

  const created = (await owner({ method: 'POST', url: '/v1/devices', payload: { outlet_id: tenant.outletId, name: 'Back office PC' } })).json();
  deviceToken = created.token;
  deviceId = created.device.id;
  const set = await owner({ method: 'PATCH', url: `/v1/outlets/${tenant.outletId}`, payload: { hub_device_id: deviceId, hub_url: 'http://192.168.1.20:4100/', room_charge_enabled: true } });
  expect(set.statusCode).toBe(200);
  expect(set.json().hub_url).toBe('http://192.168.1.20:4100');

  // Before the outage: a table eating in the cloud, and a takeaway with a printed, unpaid bill.
  const waiter = api(t, waiterToken);
  cloudOrder = (await waiter({ method: 'POST', url: '/v1/orders', payload: { outlet_id: tenant.outletId, type: 'dine_in', table_id: tables.H1, lines: [{ item_id: menu.paneerTikka, qty: 2 }] } })).json();
  const takeaway: OrderDTO = (await owner({ method: 'POST', url: '/v1/orders', payload: { outlet_id: tenant.outletId, type: 'takeaway', lines: [{ item_id: menu.chickenTikka, qty: 1 }] } })).json();
  const draft: BillDTO = (await owner({ method: 'POST', url: '/v1/bills', payload: { order_id: takeaway.id } })).json();
  takeawayBill = (await owner({ method: 'POST', url: `/v1/bills/${draft.id}/finalise` })).json();

  hub = new OutletHub({
    apiUrl: t.url,
    token: deviceToken,
    port: 0,
    host: '127.0.0.1',
    dataFile,
    webUpstream: null,
    fetch: netFetch,
    transport: async (address) => {
      printed.push(address);
    },
    printers: { default: { address: 'test-printer:9100', width: 48 } },
    healthMs: 3_600_000,
    snapshotMs: 3_600_000,
    log: () => {},
  });
  await hub.start();
  hubUrl = `http://127.0.0.1:${hub.port}`;
});
afterAll(async () => {
  await hub?.stop();
  await t.close();
});

describe('outlet hub', () => {
  it('only the chosen hub device gets the snapshot, with token hashes and no secrets', async () => {
    const other = (await owner({ method: 'POST', url: '/v1/devices', payload: { outlet_id: tenant.outletId, name: 'Kitchen printer' } })).json();
    const denied = await t.app.inject({ method: 'GET', url: '/v1/device/hub/snapshot', headers: { authorization: `Bearer ${other.token}` } });
    expect(denied.statusCode).toBe(403);

    const snap = hub.engine.state.snapshot!;
    expect(snap.outlet.id).toBe(tenant.outletId);
    expect(snap.tables.map((x) => x.label).sort()).toEqual(['H1', 'H2', 'H3']);
    expect(snap.live.orders.map((o) => o.id)).toContain(cloudOrder.id);
    expect(snap.live.bills.map((b) => b.id)).toEqual([takeawayBill.id]);
    const raw = JSON.stringify(snap);
    expect(raw).not.toContain('password');
    expect(raw).not.toContain(waiterToken);
    expect(snap.staff.flatMap((s) => s.sessions).length).toBeGreaterThanOrEqual(3);
  });

  it('refuses changes while the cloud is reachable, so nobody works in two places', async () => {
    expect(hub.status().online).toBe(true);
    const res = await hubApi(waiterToken)('POST', '/orders', { outlet_id: tenant.outletId, type: 'dine_in', table_id: tables.H2, lines: [{ item_id: menu.paneerTikka, qty: 1 }] });
    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe('cloud_available');
  });

  it('keeps the outlet running through an outage: orders, kitchen, bills, payments, live events', async () => {
    cut = true;
    await hub.tick();
    expect(hub.status().online).toBe(false);
    const waiter = hubApi(waiterToken);
    const cashier = hubApi(cashierToken);

    expect((await hubApi('st_not-a-real-session')('GET', '/auth/me')).status).toBe(401);
    expect((await waiter('GET', '/auth/me')).json.outlets[0].id).toBe(tenant.outletId);

    const socket = ioClient(`${hubUrl}/staff`, { auth: { token: waiterToken }, transports: ['websocket'], forceNew: true });
    await new Promise<void>((r) => socket.once('ready', () => r()));
    const placedEvent = new Promise<{ type: string; seq: number }>((r) => socket.on('event', (e) => e.type === 'order.placed' && r(e)));

    // New table, ordered on the hub. Same Idempotency-Key twice gives one order.
    const body = { outlet_id: tenant.outletId, type: 'dine_in', table_id: tables.H2, lines: [{ item_id: menu.coldCoffee, qty: 2, modifier_ids: [menu.large] }] };
    const first = await waiter('POST', '/orders', body, { 'idempotency-key': 'k-1' });
    expect(first.status).toBe(201);
    const again = await waiter('POST', '/orders', body, { 'idempotency-key': 'k-1' });
    expect(again.json.id).toBe(first.json.id);
    const order: OrderDTO = first.json;
    expect(order.order_no).toBe(9001);
    expect(order.status).toBe('accepted');
    expect(order.subtotal_paise).toBe(2 * (18000 + 6000));
    expect((await placedEvent).seq).toBeGreaterThan(0);
    socket.close();

    // Menu rules still apply offline.
    const bad = await waiter('POST', '/orders', { ...body, lines: [{ item_id: menu.coldCoffee, qty: 1, modifier_ids: [] }] });
    expect(bad.json.error.code).toBe('items_unavailable');

    // Kitchen: both the cloud order and the hub order are on the KDS; tickets printed locally.
    const kds: OrderDTO[] = (await waiter('GET', `/kds?outlet_id=${tenant.outletId}`)).json;
    expect(kds.map((o) => o.id).sort()).toEqual([cloudOrder.id, order.id, takeawayBill.order_id!].sort());
    await hub.agent.idle();
    expect(printed.length).toBeGreaterThanOrEqual(1);
    const kitchen = hubApi(kitchenToken);
    expect((await waiter('PATCH', `/order-items/${order.items[0]!.id}/status`, { status: 'ready' })).status).toBe(403);
    for (const item of order.items) expect((await kitchen('PATCH', `/order-items/${item.id}/status`, { status: 'ready' })).status).toBe(200);
    expect((await waiter('PATCH', `/orders/${order.id}/status`, { status: 'served' })).json.status).toBe('served');
    expect((await waiter('PATCH', `/orders/${cloudOrder.id}/status`, { status: 'served' })).json.status).toBe('served');

    const floor: TableDTO[] = (await waiter('GET', `/tables?outlet_id=${tenant.outletId}`)).json;
    expect(floor.find((x) => x.id === tables.H2)?.state).toBe('served');

    // Bills get the hub's own invoice series; payments close the visit.
    const bill1: BillDTO = (await cashier('POST', '/bills', { table_session_id: cloudOrder.table_session_id })).json;
    expect(bill1.subtotal_paise).toBe(50000);
    const fin1: BillDTO = (await cashier('POST', `/bills/${bill1.id}/finalise`)).json;
    expect(fin1.invoice_no).toBe(formatHubInvoiceNo('TST', fy, 1));
    expect(fin1.invoice_no!.length).toBeLessThanOrEqual(16);
    expect((await cashier('POST', `/bills/${bill1.id}/payments`, { method: 'cash', amount_paise: fin1.total_paise, tendered_paise: 60000 })).json.status).toBe('paid');

    const bill2: BillDTO = (await cashier('POST', '/bills', { table_session_id: order.table_session_id })).json;
    const fin2: BillDTO = (await cashier('POST', `/bills/${bill2.id}/finalise`)).json;
    expect(fin2.invoice_no).toBe(formatHubInvoiceNo('TST', fy, 2));
    await cashier('POST', `/bills/${bill2.id}/payments`, { method: 'upi', amount_paise: 20000, reference: 'UTR 9988' });
    expect((await cashier('POST', `/bills/${bill2.id}/payments`, { method: 'cash', amount_paise: fin2.total_paise - 20000 })).json.status).toBe('paid');
    const invoice = (await cashier('GET', `/bills/${bill2.id}/invoice`)).json;
    expect(invoice.tax_summary[0].cgst_paise).toBe(fin2.cgst_paise);

    // The takeaway bill printed before the outage is charged to a hotel room during it.
    expect((await cashier('POST', `/bills/${takeawayBill.id}/payments`, { method: 'room', amount_paise: takeawayBill.total_paise })).json.error.code).toBe('room_required');
    expect((await cashier('POST', `/bills/${takeawayBill.id}/payments`, { method: 'room', amount_paise: takeawayBill.total_paise, room_no: '412', room_guest: 'Ms. Iyer' })).json.status).toBe('paid');

    // Manager PINs cannot be checked offline: only a manager cancels what the kitchen has.
    const extra: OrderDTO = (await waiter('POST', '/orders', { outlet_id: tenant.outletId, type: 'takeaway', lines: [{ item_id: menu.paneerTikka, qty: 1 }] })).json;
    expect((await waiter('PATCH', `/orders/${extra.id}/status`, { status: 'cancelled', reason: 'Guest left' })).status).toBe(403);
    expect((await hubApi(tenant.ownerToken)('PATCH', `/orders/${extra.id}/status`, { status: 'cancelled', reason: 'Guest left' })).json.status).toBe('cancelled');

    // What cannot be checked offline is refused clearly.
    const voided = await cashier('POST', `/bills/${bill1.id}/void`, { reason: 'x' });
    expect(voided.status).toBe(503);
    expect(voided.json.error.code).toBe('offline_unsupported');

    const after: TableDTO[] = (await waiter('GET', `/tables?outlet_id=${tenant.outletId}`)).json;
    expect(after.find((x) => x.id === tables.H1)?.state).toBe('needs_cleaning');
    expect(after.find((x) => x.id === tables.H2)?.state).toBe('needs_cleaning');
    expect(hub.status().pending_sync).toBe(true);
  });

  it('survives a restart while offline: nothing printed is forgotten', async () => {
    const reloaded = new OutletHub({ apiUrl: t.url, token: deviceToken, port: 0, host: '127.0.0.1', dataFile, webUpstream: null, fetch: netFetch, log: () => {} });
    expect(reloaded.engine.hasPendingSync()).toBe(true);
    const bills = Object.values(reloaded.engine.state.bills).filter((b) => b.invoice_series === 'hub' && b.status === 'paid');
    expect(bills.map((b) => b.invoice_no).sort()).toEqual([formatHubInvoiceNo('TST', fy, 1), formatHubInvoiceNo('TST', fy, 2)]);
    expect(reloaded.engine.state.counters[`invoice:${fy}`]).toBe(2);
  });

  it('sends everything to the cloud when the connection returns, exactly once', async () => {
    cut = false;
    await hub.tick();
    expect(hub.status()).toMatchObject({ online: true, pending_sync: false, last_sync: { error: null, failed: [] } });

    const db = t.ctx.adminDb;
    const synced = await db.selectFrom('orders').selectAll().where('outlet_id', '=', tenant.outletId).where('offline_ref', '=', 'H1').execute();
    expect(synced).toHaveLength(1);
    expect(synced[0]!.status).toBe('billed');
    expect(synced[0]!.order_no).toBeLessThan(9000);
    expect((await db.selectFrom('orders').select('status').where('id', '=', cloudOrder.id).executeTakeFirstOrThrow()).status).toBe('billed');

    const bills = await db.selectFrom('bills').selectAll().where('outlet_id', '=', tenant.outletId).where('invoice_series', '=', 'hub').orderBy('invoice_seq').execute();
    expect(bills.map((b) => [b.invoice_no, b.status])).toEqual([
      [formatHubInvoiceNo('TST', fy, 1), 'paid'],
      [formatHubInvoiceNo('TST', fy, 2), 'paid'],
    ]);
    const payments = await db.selectFrom('payments').select(['method', 'amount_paise']).where('bill_id', 'in', bills.map((b) => b.id)).execute();
    expect(payments.map((p) => p.method).sort()).toEqual(['cash', 'cash', 'upi']);
    expect((await db.selectFrom('bills').select('status').where('id', '=', takeawayBill.id).executeTakeFirstOrThrow()).status).toBe('paid');
    const roomPay = await db.selectFrom('payments').select(['method', 'room_no', 'room_guest']).where('bill_id', '=', takeawayBill.id).executeTakeFirstOrThrow();
    expect(roomPay).toEqual({ method: 'room', room_no: '412', room_guest: 'Ms. Iyer' });

    const sessions = await db.selectFrom('table_sessions').select(['status', 'table_id']).where('table_id', 'in', [tables.H1!, tables.H2!]).execute();
    expect(sessions.every((s) => s.status === 'closed')).toBe(true);
    const cloudTables: TableDTO[] = (await owner({ method: 'GET', url: `/v1/tables?outlet_id=${tenant.outletId}` })).json();
    expect(cloudTables.find((x) => x.id === tables.H2)?.state).toBe('needs_cleaning');

    // GST: the offline series shows up next to the main one.
    const gst = (await owner({ method: 'GET', url: `/v1/reports/gst?outlet_id=${tenant.outletId}` })).json();
    expect(gst.invoices.series.map((s: { series: string; count: number }) => [s.series, s.count])).toEqual([
      ['main', 1],
      ['hub', 2],
    ]);

    // Sending the same changes again (a lost response) changes nothing.
    const payload = hub.engine.state;
    const resend: HubSyncPayload = {
      sessions: Object.values(payload.sessions).map(({ rev: _r, synced: _s, origin: _o, ...x }) => x),
      orders: Object.values(payload.orders).map(({ rev: _r, synced: _s, origin: _o, ...x }) => x),
      bills: Object.values(payload.bills).filter((b) => b.status !== 'draft').map(({ rev: _r, synced: _s, origin: _o, ...x }) => x),
      tables: [],
    };
    const again = await t.app.inject({ method: 'POST', url: '/v1/device/hub/sync', headers: { authorization: `Bearer ${deviceToken}` }, payload: resend });
    expect(again.json().failed).toEqual([]);
    expect(await db.selectFrom('payments').select('id').where('bill_id', 'in', bills.map((b) => b.id)).execute()).toHaveLength(3);
    expect(await db.selectFrom('orders').select('id').where('offline_ref', '=', 'H1').execute()).toHaveLength(1);

    // Back to normal: the hub follows the cloud again and refuses local changes.
    await hub.tick(true);
    const refused = await hubApi(waiterToken)('POST', '/orders', { outlet_id: tenant.outletId, type: 'dine_in', table_id: tables.H3, lines: [{ item_id: menu.paneerTikka, qty: 1 }] });
    expect(refused.json.error.code).toBe('cloud_available');
  });

  it('refuses a bill that does not match its orders, and reports it without blocking the rest', async () => {
    const order: OrderDTO = (await owner({ method: 'POST', url: '/v1/orders', payload: { outlet_id: tenant.outletId, type: 'takeaway', lines: [{ item_id: menu.paneerTikka, qty: 1 }] } })).json();
    const now = new Date().toISOString();
    const forged: HubSyncPayload = {
      sessions: [],
      orders: [],
      tables: [],
      bills: [
        {
          id: crypto.randomUUID(),
          table_session_id: null,
          order_id: order.id,
          status: 'paid',
          invoice_series: 'hub',
          fy_code: fy,
          invoice_seq: 50,
          invoice_no: formatHubInvoiceNo('TST', fy, 50),
          invoice_date: businessDate(new Date()),
          service_charge_bp: 0,
          service_charge_waived: false,
          service_charge_tax_rate_bp: 500,
          subtotal_paise: 100,
          item_discount_paise: 0,
          bill_discount_paise: 0,
          loyalty_discount_paise: 0,
          service_charge_paise: 0,
          taxable_paise: 100,
          cgst_paise: 3,
          sgst_paise: 2,
          tax_total_paise: 5,
          round_off_paise: -5,
          total_paise: 100,
          paid_paise: 100,
          customer_name: null,
          customer_gstin: null,
          outlet_snapshot: null,
          finalised_at: now,
          finalised_by: null,
          paid_at: now,
          created_at: now,
          lines: [
            {
              order_item_id: order.items[0]!.id,
              name: 'Paneer Tikka',
              qty: 1,
              unit_price_paise: 100,
              gross_paise: 100,
              item_discount_paise: 0,
              bill_discount_paise: 0,
              taxable_paise: 100,
              tax_rate_bp: 500,
              cgst_paise: 3,
              sgst_paise: 2,
              amount_paise: 105,
              hsn_sac: null,
              seat_no: null,
            },
          ],
          payments: [],
        },
      ],
    };
    const res = await t.app.inject({ method: 'POST', url: '/v1/device/hub/sync', headers: { authorization: `Bearer ${deviceToken}` }, payload: forged });
    expect(res.statusCode).toBe(200);
    expect(res.json().failed).toEqual([expect.objectContaining({ kind: 'bill', message: expect.stringContaining('does not match its orders') })]);
    expect(await t.ctx.adminDb.selectFrom('bills').select('id').where('invoice_seq', '=', 50).execute()).toEqual([]);
  });

  it('pauses QR ordering only when the outlet is cut off (no hub check-in and no staff screen)', async () => {
    const tableId = tables.H3!;
    const qr = new URL((await owner({ method: 'GET', url: `/v1/tables/${tableId}/qr` })).json().url).pathname.split('/').pop()!;
    const guest = api(t, (await t.app.inject({ method: 'POST', url: '/v1/guest/join', payload: { qr_token: qr } })).json().guest_token);
    const add = () => guest({ method: 'POST', url: '/v1/guest/cart/lines', payload: { item_id: menu.paneerTikka, qty: 1, modifier_ids: [] } });
    const place = () => guest({ method: 'POST', url: '/v1/guest/orders', payload: {} });

    await t.ctx.adminDb.updateTable('devices').set({ last_seen_at: new Date(Date.now() - 10 * 60_000) }).where('id', '=', deviceId).execute();
    await add();
    const paused = await place();
    expect(paused.statusCode).toBe(503);
    expect(paused.json().error.code).toBe('outlet_offline');

    // A staff screen is still connected: the outlet is reachable, so QR goes on.
    const screen = await connectSocket(t, '/staff', tenant.ownerToken);
    expect((await place()).statusCode).toBe(201);
    screen.close();
  });
});

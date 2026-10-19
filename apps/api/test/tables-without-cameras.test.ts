// Cafés without cameras: a QR scan says guests sat down, tables free up by themselves after
// cleaning time, bottled water is billed only if opened, and counter guests follow their order on
// their phone or a screen by the counter.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BillDTO, OrderDTO, PickupBoardDTO, TableDTO, TrackedOrderDTO } from '@mezmitra/shared/dto';
import type { BillDoc } from '@mezmitra/shared/print';
import { runMaintenance } from '../src/lib/maintenance';
import { api, createMenu, createTable, createTenant, setOutlet, startApp, type TestApp, type TestMenu, type TestTenant } from './helpers';

let t: TestApp;
let tenant: TestTenant;
let menu: TestMenu;
let owner: ReturnType<typeof api>;
let tables = 0;

beforeAll(async () => {
  t = await startApp();
  tenant = await createTenant(t);
  menu = await createMenu(t, tenant);
  owner = api(t, tenant.ownerToken);
});
afterAll(() => t.close());

const floor = async () => (await owner({ method: 'GET', url: `/v1/tables?outlet_id=${tenant.outletId}` })).json() as TableDTO[];
const tableNow = async (id: string) => (await floor()).find((x) => x.id === id)!;
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

async function newTable() {
  const label = `W${++tables}`;
  return { label, id: await createTable(t, tenant, label) };
}

async function scan(tableId: string) {
  const qr = new URL((await owner({ method: 'GET', url: `/v1/tables/${tableId}/qr` })).json().url).pathname.split('/').pop()!;
  const res = await t.app.inject({ method: 'POST', url: '/v1/guest/join', payload: { qr_token: qr } });
  expect(res.statusCode).toBe(200);
  return res.json() as { guest_token: string; session_id: string };
}

/** Seats a table, orders, bills and pays it in cash: the guests have left. */
async function fullVisit(tableId: string) {
  await owner({ method: 'POST', url: `/v1/tables/${tableId}/seat`, payload: { guest_count: 2 } });
  await owner({ method: 'POST', url: '/v1/orders', payload: { outlet_id: tenant.outletId, type: 'dine_in', table_id: tableId, lines: [{ item_id: menu.paneerTikka, qty: 1 }] } });
  const session = (await tableNow(tableId)).session!.id;
  const draft: BillDTO = (await owner({ method: 'POST', url: '/v1/bills', payload: { table_session_id: session } })).json();
  const bill: BillDTO = (await owner({ method: 'POST', url: `/v1/bills/${draft.id}/finalise` })).json();
  expect((await owner({ method: 'POST', url: `/v1/bills/${bill.id}/payments`, payload: { method: 'cash', amount_paise: bill.total_paise } })).statusCode).toBe(201);
}

describe('guests at a table without a camera', () => {
  it('shows a table as taken as soon as a guest scans its QR, until the phones go quiet', async () => {
    const { id } = await newTable();
    expect((await tableNow(id)).state).toBe('vacant');
    const { session_id } = await scan(id);
    const here = await tableNow(id);
    expect(here.state).toBe('occupied');
    expect(here.guests_since).not.toBeNull();
    const events = await t.ctx.adminDb.selectFrom('table_state_events').select(['state', 'source']).where('table_id', '=', id).execute();
    expect(events).toContainEqual({ state: 'occupied', source: 'guest' });

    // Twenty quiet minutes later nobody is assumed to be there any more.
    await t.ctx.adminDb.updateTable('table_sessions').set({ guest_seen_at: minutesAgo(25), guests_since: minutesAgo(30) }).where('id', '=', session_id).execute();
    const later = await tableNow(id);
    expect(later.state).toBe('vacant');
    expect(later.guests_since).toBeNull();

    // A new scan is a new group: their waiting time starts again.
    await scan(id);
    const again = await tableNow(id);
    expect(again.state).toBe('occupied');
    expect(Date.now() - Date.parse(again.guests_since!)).toBeLessThan(60_000);
  });

  it('seats guests with one tap, which ends the waiting', async () => {
    const { id } = await newTable();
    await scan(id);
    expect((await owner({ method: 'POST', url: `/v1/tables/${id}/seat`, payload: { guest_count: 4 } })).statusCode).toBe(200);
    const seated = await tableNow(id);
    expect(seated.session).toMatchObject({ status: 'open', guest_count: 4 });
    expect(seated.guests_since).toBeNull();
  });
});

describe('cleaning without anyone remembering', () => {
  it('turns a table free by itself after the clearing time', async () => {
    const { id } = await newTable();
    await fullVisit(id);
    const left = await tableNow(id);
    expect(left).toMatchObject({ state: 'needs_cleaning', needs_cleaning: true });
    expect(left.needs_cleaning_since).not.toBeNull();

    await t.ctx.adminDb.updateTable('tables').set({ needs_cleaning_since: minutesAgo(11) }).where('id', '=', id).execute();
    expect(await tableNow(id)).toMatchObject({ state: 'vacant', needs_cleaning: false, needs_cleaning_since: null });
    // The nightly tidy-up stores it.
    await runMaintenance(t.ctx.adminDb);
    expect((await t.ctx.adminDb.selectFrom('tables').select('needs_cleaning').where('id', '=', id).executeTakeFirstOrThrow()).needs_cleaning).toBe(false);
  });

  it('waits for staff when the outlet clears tables by hand, and seating new guests clears it', async () => {
    await setOutlet(t, tenant.outletId, { auto_clean_minutes: 0 });
    const { id } = await newTable();
    await fullVisit(id);
    await t.ctx.adminDb.updateTable('tables').set({ needs_cleaning_since: minutesAgo(45) }).where('id', '=', id).execute();
    expect((await tableNow(id)).state).toBe('needs_cleaning');
    await owner({ method: 'POST', url: `/v1/tables/${id}/seat`, payload: { guest_count: 2 } });
    expect(await tableNow(id)).toMatchObject({ needs_cleaning: false, needs_cleaning_since: null });
    await setOutlet(t, tenant.outletId, { auto_clean_minutes: 10 });
  });
});

describe('bottled water on the table', () => {
  it('asks how many were opened before the bill prints, and bills only those', async () => {
    expect((await owner({ method: 'PATCH', url: `/v1/outlets/${tenant.outletId}`, payload: { table_water_item_id: menu.chickenTikka } })).statusCode).toBe(200);
    const { id } = await newTable();
    await owner({ method: 'POST', url: `/v1/tables/${id}/seat`, payload: { guest_count: 2 } });
    await owner({ method: 'POST', url: '/v1/orders', payload: { outlet_id: tenant.outletId, type: 'dine_in', table_id: id, lines: [{ item_id: menu.paneerTikka, qty: 1 }] } });
    const session = (await tableNow(id)).session!.id;
    const draft: BillDTO = (await owner({ method: 'POST', url: '/v1/bills', payload: { table_session_id: session } })).json();
    expect(draft.water_bottles).toBeNull();

    const blocked = await owner({ method: 'POST', url: `/v1/bills/${draft.id}/finalise` });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.code).toBe('water_check');

    const kotsBefore = (await t.ctx.adminDb.selectFrom('kots').select('id').where('outlet_id', '=', tenant.outletId).execute()).length;
    const two: BillDTO = (await owner({ method: 'POST', url: `/v1/bills/${draft.id}/water`, payload: { count: 2 } })).json();
    expect(two.water_bottles).toBe(2);
    expect(two.lines.find((l) => l.name.startsWith('Chicken Tikka'))).toMatchObject({ qty: 2 });
    // Already on the table: no kitchen ticket.
    expect((await t.ctx.adminDb.selectFrom('kots').select('id').where('outlet_id', '=', tenant.outletId).execute()).length).toBe(kotsBefore);

    const one: BillDTO = (await owner({ method: 'POST', url: `/v1/bills/${draft.id}/water`, payload: { count: 1 } })).json();
    expect(one.lines.find((l) => l.name.startsWith('Chicken Tikka'))).toMatchObject({ qty: 1 });
    const none: BillDTO = (await owner({ method: 'POST', url: `/v1/bills/${draft.id}/water`, payload: { count: 0 } })).json();
    expect(none.lines.some((l) => l.name.startsWith('Chicken Tikka'))).toBe(false);
    expect(none.water_bottles).toBe(0);

    await owner({ method: 'POST', url: `/v1/bills/${draft.id}/water`, payload: { count: 1 } });
    const printed: BillDTO = (await owner({ method: 'POST', url: `/v1/bills/${draft.id}/finalise` })).json();
    expect(printed.status).toBe('finalised');
    expect(printed.lines.map((l) => l.name)).toContain('Chicken Tikka');
    // Takeaway bills are not asked.
    const takeaway: OrderDTO = (await owner({ method: 'POST', url: '/v1/orders', payload: { outlet_id: tenant.outletId, type: 'takeaway', lines: [{ item_id: menu.paneerTikka, qty: 1 }] } })).json();
    const tb: BillDTO = (await owner({ method: 'POST', url: '/v1/bills', payload: { order_id: takeaway.id } })).json();
    expect((await owner({ method: 'POST', url: `/v1/bills/${tb.id}/finalise` })).statusCode).toBe(200);
    await owner({ method: 'PATCH', url: `/v1/outlets/${tenant.outletId}`, payload: { table_water_item_id: null } });
  });
});

describe('counter orders', () => {
  it('lets the guest follow their order from the receipt link', async () => {
    const order: OrderDTO = (await owner({ method: 'POST', url: '/v1/orders', payload: { outlet_id: tenant.outletId, type: 'takeaway', lines: [{ item_id: menu.paneerTikka, qty: 2 }] } })).json();
    expect(order.track_code).toMatch(/^[\w-]{20,}$/);
    const track = async () => (await t.app.inject({ method: 'GET', url: `/v1/public/track/${order.track_code}` })).json() as TrackedOrderDTO;
    expect(await track()).toMatchObject({ order_no: order.order_no, status: 'accepted', items: [{ name: 'Paneer Tikka', qty: 2 }] });
    await owner({ method: 'PATCH', url: `/v1/orders/${order.id}/status`, payload: { status: 'ready' } });
    expect((await track()).status).toBe('ready');
    expect((await t.app.inject({ method: 'GET', url: '/v1/public/track/not-a-real-code-at-all' })).statusCode).toBe(404);

    // Table orders are followed on the guest menu, not by link.
    const { id } = await newTable();
    await owner({ method: 'POST', url: `/v1/tables/${id}/seat`, payload: { guest_count: 1 } });
    const dineIn: OrderDTO = (await owner({ method: 'POST', url: '/v1/orders', payload: { outlet_id: tenant.outletId, type: 'dine_in', table_id: id, lines: [{ item_id: menu.paneerTikka, qty: 1 }] } })).json();
    expect(dineIn.track_code).toBeNull();
  });

  it('prints the order number and the link on the receipt', async () => {
    await owner({ method: 'POST', url: '/v1/devices', payload: { outlet_id: tenant.outletId, name: 'Counter PC', config: { printers: { bill: { address: '10.0.0.7:9100', width: 48 } } } } });
    const order: OrderDTO = (await owner({ method: 'POST', url: '/v1/orders', payload: { outlet_id: tenant.outletId, type: 'counter', lines: [{ item_id: menu.paneerTikka, qty: 1 }] } })).json();
    const draft: BillDTO = (await owner({ method: 'POST', url: '/v1/bills', payload: { order_id: order.id } })).json();
    expect(draft).toMatchObject({ pickup_no: order.order_no, track_code: order.track_code });
    await owner({ method: 'POST', url: `/v1/bills/${draft.id}/finalise` });
    const job = await t.ctx.adminDb.selectFrom('print_jobs').select('doc').where('ref_id', '=', draft.id).executeTakeFirstOrThrow();
    expect(job.doc as unknown as BillDoc).toMatchObject({ pickup_no: order.order_no, track_code: order.track_code });
    const receiptsPath = `/v1/public/track/${order.track_code}/receipts`;
    const receipts = await t.app.inject({ method: 'GET', url: receiptsPath });
    expect(receipts.statusCode).toBe(200);
    expect(receipts.json()[0].bill.id).toBe(draft.id);
    const pdf = await t.app.inject({ method: 'GET', url: `${receiptsPath}?format=pdf&bill_id=${draft.id}` });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    expect((await t.app.inject({ method: 'GET', url: `${receiptsPath}?format=pdf&bill_id=00000000-0000-4000-8000-000000000001` })).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'GET', url: '/v1/public/track/not-a-real-code-at-all/receipts' })).statusCode).toBe(404);

  });

  it('shows counter orders being made and ready on the pickup screen, until the link is replaced', async () => {
    const link = (await owner({ method: 'GET', url: `/v1/outlets/${tenant.outletId}/pickup-link` })).json().url as string;
    expect(link).toMatch(/\/pickup\/[\w-]+$/);
    const path = `/v1/public/pickup/${link.split('/').pop()}`;
    const making: OrderDTO = (await owner({ method: 'POST', url: '/v1/orders', payload: { outlet_id: tenant.outletId, type: 'takeaway', lines: [{ item_id: menu.paneerTikka, qty: 1 }] } })).json();
    const done: OrderDTO = (await owner({ method: 'POST', url: '/v1/orders', payload: { outlet_id: tenant.outletId, type: 'counter', lines: [{ item_id: menu.paneerTikka, qty: 1 }] } })).json();
    await owner({ method: 'PATCH', url: `/v1/orders/${done.id}/status`, payload: { status: 'ready' } });

    const board = (await t.app.inject({ method: 'GET', url: path })).json() as PickupBoardDTO;
    expect(board.preparing.map((o) => o.order_no)).toContain(making.order_no);
    expect(board.ready.map((o) => o.order_no)).toContain(done.order_no);
    expect(board.preparing.map((o) => o.order_no)).not.toContain(done.order_no);
    expect(JSON.stringify(board)).not.toContain('Paneer');

    // Collected: off the screen.
    await owner({ method: 'PATCH', url: `/v1/orders/${done.id}/status`, payload: { status: 'served' } });
    expect(((await t.app.inject({ method: 'GET', url: path })).json() as PickupBoardDTO).ready.map((o) => o.order_no)).not.toContain(done.order_no);

    const fresh = (await owner({ method: 'POST', url: `/v1/outlets/${tenant.outletId}/pickup-link/rotate` })).json().url as string;
    expect(fresh).not.toBe(link);
    expect((await t.app.inject({ method: 'GET', url: path })).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'GET', url: `/v1/public/pickup/${fresh.split('/').pop()}` })).statusCode).toBe(200);
  });
});

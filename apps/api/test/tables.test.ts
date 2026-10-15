import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TableDTO } from '@dineos/shared/dto';
import { addStaff, api, createMenu, createTenant, startApp, type TestApp, type TestMenu, type TestTenant } from './helpers';

let t: TestApp;
let tenant: TestTenant;
let menu: TestMenu;
let owner: ReturnType<typeof api>;
let waiter: ReturnType<typeof api>;

beforeAll(async () => {
  t = await startApp();
  tenant = await createTenant(t);
  menu = await createMenu(t, tenant);
  owner = api(t, tenant.ownerToken);
  waiter = api(t, (await addStaff(t, tenant, 'waiter')).token);
});
afterAll(() => t.close());

async function newTable(label: string, zone = 'Courtyard'): Promise<TableDTO> {
  const res = await owner({ method: 'POST', url: '/v1/tables', payload: { outlet_id: tenant.outletId, label, seats: 4, zone } });
  expect(res.statusCode).toBe(201);
  return res.json();
}

async function order(tableId: string) {
  const res = await waiter({
    method: 'POST',
    url: '/v1/orders',
    payload: { outlet_id: tenant.outletId, type: 'dine_in', table_id: tableId, lines: [{ item_id: menu.paneerTikka, qty: 1 }] },
  });
  expect(res.statusCode).toBe(201);
  return res.json();
}

async function getTable(id: string): Promise<TableDTO> {
  return (await owner({ method: 'GET', url: `/v1/tables/${id}` })).json();
}

describe('table setup', () => {
  it('bulk-creates tables and skips labels that exist', async () => {
    await newTable('P3', 'Poolside');
    const res = await owner({ method: 'POST', url: '/v1/tables/bulk', payload: { outlet_id: tenant.outletId, prefix: 'P', from: 1, to: 5, zone: 'Poolside' } });
    expect(res.statusCode).toBe(201);
    expect(res.json().map((x: TableDTO) => x.label)).toEqual(['P1', 'P2', 'P4', 'P5']);
  });

  it('only managers and owners can set tables up', async () => {
    const res = await waiter({ method: 'POST', url: '/v1/tables', payload: { outlet_id: tenant.outletId, label: 'Z1' } });
    expect(res.statusCode).toBe(403);
  });

  it('prints a PDF sheet of QR cards', async () => {
    const res = await owner({ method: 'GET', url: `/v1/tables/qr-sheet.pdf?outlet_id=${tenant.outletId}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('refuses to retire a table with seated guests', async () => {
    const table = await newTable('R1');
    await order(table.id);
    expect((await owner({ method: 'DELETE', url: `/v1/tables/${table.id}` })).statusCode).toBe(409);
  });
});

describe('floor operations', () => {
  it('seats a party and frees a table that never ordered without needing cleaning', async () => {
    const table = await newTable('F1');
    const seated = await waiter({ method: 'POST', url: `/v1/tables/${table.id}/seat`, payload: { guest_count: 2 } });
    expect(seated.json()).toMatchObject({ state: 'occupied', session: { status: 'open', guest_count: 2 } });
    const released = await waiter({ method: 'POST', url: `/v1/tables/${table.id}/release` });
    expect(released.json().state).toBe('needs_cleaning');
    const cleaned = await waiter({ method: 'POST', url: `/v1/tables/${table.id}/clean` });
    expect(cleaned.json().state).toBe('vacant');
  });

  it('refuses to release a table with unbilled orders', async () => {
    const table = await newTable('F2');
    await order(table.id);
    const res = await waiter({ method: 'POST', url: `/v1/tables/${table.id}/release` });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('session_has_orders');
  });

  it('transfers a party with its orders to a free table', async () => {
    const from = await newTable('F3');
    const to = await newTable('F4');
    const o = await order(from.id);
    const res = await waiter({ method: 'POST', url: `/v1/tables/${from.id}/transfer`, payload: { to_table_id: to.id } });
    expect(res.statusCode).toBe(200);
    expect((await getTable(to.id)).state).toBe('ordered');
    expect((await getTable(from.id)).state).toBe('needs_cleaning');
    const moved = (await owner({ method: 'GET', url: `/v1/orders/${o.id}` })).json();
    expect(moved.table_label).toBe('F4');
    // An occupied table cannot receive a transfer.
    const third = await newTable('F5');
    await order(third.id);
    expect((await waiter({ method: 'POST', url: `/v1/tables/${to.id}/transfer`, payload: { to_table_id: third.id } })).statusCode).toBe(409);
  });

  it('merges tables into one party and one running total, then unmerges', async () => {
    const a = await newTable('M1');
    const b = await newTable('M2');
    await order(a.id);
    await order(b.id);
    const res = await waiter({ method: 'POST', url: '/v1/tables/merge', payload: { table_ids: [a.id, b.id] } });
    expect(res.statusCode).toBe(200);
    const [ma, mb] = res.json() as TableDTO[];
    expect(ma!.session!.id).toBe(mb!.session!.id);
    expect(ma!.merged_with).toEqual(['M2']);
    expect(ma!.running_total_paise).toBe(50000);

    // New orders from the merged table land in the shared session.
    const extra = await order(b.id);
    expect(extra.table_session_id).toBe(ma!.session!.id);

    expect((await waiter({ method: 'POST', url: `/v1/tables/${a.id}/unmerge` })).statusCode).toBe(409);
    const un = await waiter({ method: 'POST', url: `/v1/tables/${b.id}/unmerge` });
    expect(un.json().session).toBeNull();
  });

  it('assigns a waiter who works at the outlet', async () => {
    const table = await newTable('F6');
    const w = await addStaff(t, tenant, 'waiter');
    const res = await owner({ method: 'PATCH', url: `/v1/tables/${table.id}/waiter`, payload: { waiter_id: w.userId } });
    expect(res.json().assigned_waiter_name).toMatch(/^Waiter/);
    const stranger = await createTenant(t);
    const bad = await owner({ method: 'PATCH', url: `/v1/tables/${table.id}/waiter`, payload: { waiter_id: stranger.ownerId } });
    expect(bad.statusCode).toBe(400);
  });

  it('acknowledges and closes waiter calls', async () => {
    const table = await newTable('F7');
    const { getOrCreateSession } = await import('../src/modules/tables/sessions');
    const { createServiceRequest } = await import('../src/modules/tables/floor');
    const request = await t.ctx.tx(tenant.tenantId, async (tx) => {
      const s = await getOrCreateSession(tx, table.id);
      return createServiceRequest(tx, { outletId: tenant.outletId, tableId: table.id, sessionId: s.id }, 'call_waiter');
    });
    const ack = await waiter({ method: 'POST', url: `/v1/service-requests/${request.id}/ack` });
    expect(ack.json()).toMatchObject({ status: 'acknowledged' });
    expect(ack.json().acknowledged_by).toMatch(/^Waiter/);
    await waiter({ method: 'POST', url: `/v1/service-requests/${request.id}/close` });
    const open = (await waiter({ method: 'GET', url: `/v1/service-requests?outlet_id=${tenant.outletId}` })).json();
    expect(open.some((r: { id: string }) => r.id === request.id)).toBe(false);
  });
});

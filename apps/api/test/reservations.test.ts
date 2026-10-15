import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BillDTO, OrderDTO, ReservationDTO, TableDTO, WaitlistEntryDTO } from '@dineos/shared/dto';
import { runMaintenance } from '../src/lib/maintenance';
import { addStaff, api, createMenu, createTable, createTenant, startApp, type TestApp, type TestMenu, type TestTenant } from './helpers';

let t: TestApp;
let tenant: TestTenant;
let menu: TestMenu;
let waiter: ReturnType<typeof api>;
let kitchen: ReturnType<typeof api>;

beforeAll(async () => {
  t = await startApp();
  tenant = await createTenant(t);
  menu = await createMenu(t, tenant);
  waiter = api(t, (await addStaff(t, tenant, 'waiter')).token);
  kitchen = api(t, (await addStaff(t, tenant, 'kitchen')).token);
});
afterAll(() => t.close());

const inHours = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();

async function book(payload: Record<string, unknown>) {
  return waiter({ method: 'POST', url: '/v1/reservations', payload: { outlet_id: tenant.outletId, guest_name: 'Kapoor', party_size: 4, slot_start: inHours(2), ...payload } });
}

describe('reservations', () => {
  it('books a table, refuses a clashing booking and suggests free tables', async () => {
    const table = await createTable(t, tenant, 'R1');
    const other = await createTable(t, tenant, 'R2');
    const res = await book({ table_id: table, guest_phone: '9811100001', notes: 'Window seat' });
    expect(res.statusCode).toBe(201);
    const r: ReservationDTO = res.json();
    expect(r.table_label).toBe('R1');
    // No consent, no number kept.
    expect(r.guest_phone).toBeNull();
    expect(r.customer_id).toBeNull();
    expect(new Date(r.slot_end).getTime() - new Date(r.slot_start).getTime()).toBe(90 * 60_000);

    const clash = await book({ table_id: table, slot_start: inHours(3) });
    expect(clash.statusCode).toBe(409);
    expect(clash.json().error.code).toBe('table_booked');
    expect((await book({ table_id: table, slot_start: inHours(3.5) })).statusCode).toBe(201);

    const free = (await waiter({ method: 'GET', url: `/v1/reservations/availability?outlet_id=${tenant.outletId}&slot_start=${encodeURIComponent(inHours(2.5))}&party_size=2` })).json();
    const ids = free.map((x: { id: string }) => x.id);
    expect(ids).toContain(other);
    expect(ids).not.toContain(table);

    // The floor map shows the upcoming booking on the table.
    const floor: TableDTO[] = (await waiter({ method: 'GET', url: `/v1/tables?outlet_id=${tenant.outletId}` })).json();
    expect(floor.find((x) => x.id === table)?.next_reservation?.guest_name).toBe('Kapoor');

    expect((await kitchen({ method: 'GET', url: `/v1/reservations?outlet_id=${tenant.outletId}` })).statusCode).toBe(403);
  });

  it('keeps the phone with consent and links the booking to the customer book', async () => {
    const r: ReservationDTO = (await book({ guest_name: 'Iyer', guest_phone: '9811100002', contact_consent: true, source: 'phone' })).json();
    expect(r.guest_phone).toBe('+919811100002');
    expect(r.customer_id).not.toBeNull();
    const c = await t.ctx.adminDb.selectFrom('customers').select(['name', 'consent_source']).where('id', '=', r.customer_id!).executeTakeFirstOrThrow();
    expect(c).toEqual({ name: 'Iyer', consent_source: 'staff' });
  });

  it('seats a booked party, carries the guest to the bill, and completes the booking when the table closes', async () => {
    const table = await createTable(t, tenant, 'R3');
    const r: ReservationDTO = (await book({ guest_name: 'Shah', guest_phone: '9811100003', contact_consent: true, table_id: table, slot_start: inHours(0.25) })).json();
    const seated = await waiter({ method: 'POST', url: `/v1/reservations/${r.id}/seat`, payload: {} });
    expect(seated.statusCode).toBe(200);
    expect(seated.json().status).toBe('seated');
    expect((await waiter({ method: 'POST', url: `/v1/reservations/${r.id}/seat`, payload: {} })).json().error.code).toBe('not_booked');

    const tables: TableDTO[] = (await waiter({ method: 'GET', url: `/v1/tables?outlet_id=${tenant.outletId}` })).json();
    const live = tables.find((x) => x.id === table)!;
    expect(live.state).toBe('occupied');
    expect(live.session?.guest_count).toBe(4);

    const order: OrderDTO = (
      await waiter({ method: 'POST', url: '/v1/orders', payload: { outlet_id: tenant.outletId, type: 'dine_in', table_id: table, lines: [{ item_id: menu.paneerTikka, qty: 1 }] } })
    ).json();
    const owner = api(t, tenant.ownerToken);
    const bill: BillDTO = (await owner({ method: 'POST', url: '/v1/bills', payload: { table_session_id: order.table_session_id } })).json();
    expect(bill.customer?.id).toBe(r.customer_id);
    await owner({ method: 'POST', url: `/v1/bills/${bill.id}/finalise` });
    await owner({ method: 'POST', url: `/v1/bills/${bill.id}/payments`, payload: { method: 'cash', amount_paise: bill.total_paise } });
    const after = await t.ctx.adminDb.selectFrom('reservations').select('status').where('id', '=', r.id).executeTakeFirstOrThrow();
    expect(after.status).toBe('completed');
  });

  it('cancels, reschedules and marks no-shows after the grace period', async () => {
    const r: ReservationDTO = (await book({ guest_name: 'Late' })).json();
    const moved: ReservationDTO = (await waiter({ method: 'PATCH', url: `/v1/reservations/${r.id}`, payload: { slot_start: inHours(5), party_size: 6 } })).json();
    expect(moved.party_size).toBe(6);
    expect(new Date(moved.slot_end).getTime() - new Date(moved.slot_start).getTime()).toBe(90 * 60_000);
    expect((await waiter({ method: 'PATCH', url: `/v1/reservations/${r.id}`, payload: { status: 'cancelled' } })).json().status).toBe('cancelled');

    const late: ReservationDTO = (await book({ guest_name: 'Ghost' })).json();
    await t.ctx.adminDb
      .updateTable('reservations')
      .set({ slot_start: new Date(Date.now() - 45 * 60_000), slot_end: new Date(Date.now() + 45 * 60_000) })
      .where('id', '=', late.id)
      .execute();
    await runMaintenance(t.ctx.adminDb);
    const row = await t.ctx.adminDb.selectFrom('reservations').select('status').where('id', '=', late.id).executeTakeFirstOrThrow();
    expect(row.status).toBe('no_show');
  });
});

describe('waitlist', () => {
  it('queues walk-ins, notifies them and seats them at a table', async () => {
    const table = await createTable(t, tenant, 'W1');
    const add = await waiter({ method: 'POST', url: '/v1/waitlist', payload: { outlet_id: tenant.outletId, guest_name: 'Rao', party_size: 3, quoted_minutes: 20, guest_phone: '9811100009' } });
    expect(add.statusCode).toBe(201);
    const entry: WaitlistEntryDTO = add.json();
    expect(entry.guest_phone).toBeNull();

    const notified: WaitlistEntryDTO = (await waiter({ method: 'POST', url: `/v1/waitlist/${entry.id}/notify`, payload: {} })).json();
    expect(notified.status).toBe('notified');
    expect(notified.notified_at).not.toBeNull();

    expect((await waiter({ method: 'POST', url: `/v1/waitlist/${entry.id}/seat`, payload: {} })).json().error.code).toBe('table_required');
    const seated: WaitlistEntryDTO = (await waiter({ method: 'POST', url: `/v1/waitlist/${entry.id}/seat`, payload: { table_id: table } })).json();
    expect(seated.status).toBe('seated');
    expect(seated.table_label).toBe('W1');

    const list: WaitlistEntryDTO[] = (await waiter({ method: 'GET', url: `/v1/waitlist?outlet_id=${tenant.outletId}` })).json();
    expect(list.map((w) => w.id)).not.toContain(entry.id);
    expect((await waiter({ method: 'POST', url: `/v1/waitlist/${entry.id}/leave`, payload: {} })).statusCode).toBe(409);
  });
});

// The Talko AI link: connecting, what a link key may and may not reach, booking a table from a chat,
// and the events Mezvaan sends Talko (exactly once, with retries, never late).

import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { BillDTO, OrderDTO, TalkoLinkDTO } from '@mezmitra/shared/dto';
import { clearAuthCache } from '../src/lib/auth';
import { dispatchTalkoOutbox, queueDueReminders } from '../src/modules/integrations/outbox';
import { addStaff, api, createMenu, createTable, createTenant, setOutlet, startApp, type TestApp, type TestMenu, type TestTenant } from './helpers';

interface Received {
  path: string;
  headers: IncomingMessage['headers'];
  body: { event: string; phone: string; name?: string; data: Record<string, unknown> } | null;
}

let talko: Server;
let received: Received[] = [];
let answer = 200;
let t: TestApp;
let a: TestTenant;
let b: TestTenant;

const TALKO_KEY = `ak_live_${'ab12'.repeat(12)}`;
const WEBHOOK_SECRET = 'whsec_test_secret_0123456789abcdefghij';
const ENC_KEY = 'integration-enc-key-for-tests-0123456789';

beforeAll(async () => {
  talko = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      received.push({ path: req.url ?? '', headers: req.headers, body: raw ? JSON.parse(raw) : null });
      res.writeHead(answer, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ success: answer < 300 }));
    });
  });
  await new Promise<void>((resolve) => talko.listen(0, '127.0.0.1', resolve));
  const port = (talko.address() as AddressInfo).port;
  t = await startApp({ INTEGRATION_ENC_KEY: ENC_KEY, TALKO_API_URL: `http://127.0.0.1:${port}` });
  a = await createTenant(t, { plan: 'premium' });
  b = await createTenant(t, { plan: 'premium' });
});
afterAll(async () => {
  await t.close();
  await new Promise<void>((resolve) => talko.close(() => resolve()));
});
beforeEach(() => {
  received = [];
  answer = 200;
});

/** Makes a link key as the owner and completes the link as Talko would. */
async function link(tenant: TestTenant): Promise<string> {
  const made = await api(t, tenant.ownerToken)({ method: 'POST', url: '/v1/integrations/talko' });
  expect(made.statusCode).toBe(201);
  const key: string = made.json().key;
  const res = await api(t, key)({ method: 'POST', url: '/v1/talko/link', payload: { api_key: TALKO_KEY, webhook_secret: WEBHOOK_SECRET, account: 'Talko workspace' } });
  expect(res.statusCode).toBe(200);
  return key;
}

/** Saturday 7 Nov 2026 lunch and dinner, booking on, at the tenant's outlet. */
async function openForBooking(tenant: TestTenant, extra: Record<string, unknown> = {}) {
  const res = await api(t, tenant.ownerToken)({
    method: 'PATCH',
    url: `/v1/outlets/${tenant.outletId}`,
    payload: {
      opening_hours: { sat: [['12:00', '15:30'], ['19:00', '23:00']] },
      online_booking: { enabled: true, max_party: 6, lead_minutes: 0, days_ahead: 90, ...extra },
    },
  });
  expect(res.statusCode).toBe(200);
}

const SAT_8PM = '2026-11-07T14:30:00.000Z';
const flush = () => dispatchTalkoOutbox(t.ctx, { limit: 100 });

/** Each commit also sends its events in the background; this waits for the outcome either way. */
async function until<T>(check: () => Promise<T | undefined | null | false>, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    await flush();
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 50));
  }
}
const outbox = (tenant: TestTenant) => t.ctx.adminDb.selectFrom('integration_outbox').selectAll().where('tenant_id', '=', tenant.tenantId).orderBy('created_at').execute();

describe('connecting Talko AI', () => {
  it('only the owner on a plan with the link can make a key, and never with an idempotency key', async () => {
    const manager = await addStaff(t, a, 'manager', { outletId: null });
    expect((await api(t, manager.token)({ method: 'POST', url: '/v1/integrations/talko' })).statusCode).toBe(403);
    const std = await createTenant(t, { plan: 'standard' });
    const res = await api(t, std.ownerToken)({ method: 'POST', url: '/v1/integrations/talko' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('plan_upgrade');
    const replayable = await api(t, a.ownerToken)({ method: 'POST', url: '/v1/integrations/talko', headers: { 'idempotency-key': 'key-12345678' } });
    expect(replayable.statusCode).toBe(400);
  });

  it('a new key reads nothing until Talko completes the link, and links only once', async () => {
    const made = await api(t, a.ownerToken)({ method: 'POST', url: '/v1/integrations/talko' });
    const key: string = made.json().key;
    expect(key).toMatch(/^mzk_/);
    const asTalko = api(t, key);
    expect((await asTalko({ method: 'GET', url: '/v1/talko/whoami' })).json().link.status).toBe('pending');
    expect((await asTalko({ method: 'GET', url: '/v1/talko/outlets' })).statusCode).toBe(409);
    const bad = await asTalko({ method: 'POST', url: '/v1/talko/link', payload: { api_key: 'not-a-key', webhook_secret: WEBHOOK_SECRET, account: 'x' } });
    expect(bad.statusCode).toBe(400);
    expect((await asTalko({ method: 'POST', url: '/v1/talko/link', payload: { api_key: TALKO_KEY, webhook_secret: WEBHOOK_SECRET, account: 'W' } })).statusCode).toBe(200);
    expect((await asTalko({ method: 'GET', url: '/v1/talko/outlets' })).statusCode).toBe(200);
    // A leaked key cannot re-point events to another Talko account.
    const again = await asTalko({ method: 'POST', url: '/v1/talko/link', payload: { api_key: `ak_live_${'cd34'.repeat(12)}`, webhook_secret: WEBHOOK_SECRET, account: 'Attacker' } });
    expect(again.statusCode).toBe(409);
  });

  it('stores the Talko key encrypted and never shows it', async () => {
    await link(a);
    const row = await t.ctx.adminDb.selectFrom('integration_links').selectAll().where('tenant_id', '=', a.tenantId).where('status', '=', 'active').executeTakeFirstOrThrow();
    expect(row.peer_api_key_enc).not.toContain(TALKO_KEY);
    expect(row.peer_webhook_secret_enc).not.toContain(WEBHOOK_SECRET);
    const view = await api(t, a.ownerToken)({ method: 'GET', url: '/v1/integrations/talko' });
    expect(view.statusCode).toBe(200);
    expect(view.body).not.toContain(TALKO_KEY);
    expect(view.body).not.toContain(WEBHOOK_SECRET);
    expect((view.json() as TalkoLinkDTO).status).toBe('active');
  });

  it('an unused key expires after a day; a revoked key or a downgraded plan stops at once', async () => {
    const made = await api(t, b.ownerToken)({ method: 'POST', url: '/v1/integrations/talko' });
    const key: string = made.json().key;
    await t.ctx.adminDb.updateTable('integration_links').set({ created_at: new Date(Date.now() - 25 * 3600_000) }).where('tenant_id', '=', b.tenantId).where('status', '=', 'pending').execute();
    clearAuthCache();
    expect((await api(t, key)({ method: 'GET', url: '/v1/talko/whoami' })).statusCode).toBe(401);

    const live = await link(b);
    expect((await api(t, live)({ method: 'GET', url: '/v1/talko/outlets' })).statusCode).toBe(200);
    await t.ctx.adminDb.updateTable('tenants').set({ plan_code: 'standard' }).where('id', '=', b.tenantId).execute();
    clearAuthCache();
    expect((await api(t, live)({ method: 'GET', url: '/v1/talko/outlets' })).statusCode).toBe(401);
    await t.ctx.adminDb.updateTable('tenants').set({ plan_code: 'premium' }).where('id', '=', b.tenantId).execute();
    clearAuthCache();
    expect((await api(t, b.ownerToken)({ method: 'DELETE', url: '/v1/integrations/talko' })).statusCode).toBe(204);
    expect((await api(t, live)({ method: 'GET', url: '/v1/talko/outlets' })).statusCode).toBe(401);
  });
});

describe('booking a table from a chat', () => {
  let key: string;
  beforeAll(async () => {
    key = await link(a);
    await createTable(t, a, 'C1');
    await createTable(t, a, 'C2');
  });

  it('offers nothing until the owner sets hours and turns booking on', async () => {
    const res = await api(t, key)({ method: 'GET', url: `/v1/talko/outlets/${a.outletId}/availability?date=2026-11-07&party_size=2` });
    expect(res.json()).toMatchObject({ reason: 'booking_off', slots: [] });
    const refused = await api(t, a.ownerToken)({ method: 'PATCH', url: `/v1/outlets/${a.outletId}`, payload: { online_booking: { enabled: true } } });
    expect(refused.json().error.code).toBe('opening_hours_required');
    const badHours = await api(t, a.ownerToken)({ method: 'PATCH', url: `/v1/outlets/${a.outletId}`, payload: { opening_hours: { sat: [['23:00', '19:00']] } } });
    expect(badHours.statusCode).toBe(400);
  });

  it('books an offered time, then refuses it once every table is taken', async () => {
    await openForBooking(a);
    const avail = (await api(t, key)({ method: 'GET', url: `/v1/talko/outlets/${a.outletId}/availability?date=2026-11-07&party_size=2` })).json();
    expect(avail.reason).toBeNull();
    expect(avail.slots.map((s: { start: string }) => s.start)).toContain(SAT_8PM);
    const book = (phone: string) =>
      api(t, key)({
        method: 'POST',
        url: `/v1/talko/outlets/${a.outletId}/reservations`,
        payload: { slot_start: SAT_8PM, party_size: 2, guest_name: 'Asha', phone, channel: 'whatsapp', external_ref: 'conv-1' },
      });
    const first = await book('9811100001');
    expect(first.statusCode).toBe(201);
    expect(first.json().ref).toMatch(/^BK[A-Z0-9]{6}$/);
    expect((await book('9811100002')).statusCode).toBe(201);
    const full = await book('9811100003');
    expect(full.statusCode).toBe(409);
    expect(full.json().error.code).toBe('slot_unavailable');

    // Staff see it on the reservations list, marked as a WhatsApp booking with its code.
    const list = (await api(t, a.ownerToken)({ method: 'GET', url: `/v1/reservations?outlet_id=${a.outletId}&date=2026-11-07` })).json();
    expect(list.find((r: { public_ref: string }) => r.public_ref === first.json().ref)).toMatchObject({ source: 'whatsapp', guest_name: 'Asha' });
    // A chat-given number never opts anyone into marketing.
    const c = await t.ctx.adminDb.selectFrom('customers').select(['consent_source', 'marketing_opt_in']).where('tenant_id', '=', a.tenantId).where('phone', '=', '+919811100001').executeTakeFirstOrThrow();
    expect(c).toEqual({ consent_source: 'chat', marketing_opt_in: false });
  });

  it('a repeated booking request returns the same booking instead of a second one', async () => {
    const again = () =>
      api(t, key)({ method: 'POST', url: `/v1/talko/outlets/${a.outletId}/reservations`, payload: { slot_start: SAT_8PM, party_size: 2, guest_name: 'Asha', phone: '9811100001', channel: 'whatsapp' } });
    const first = (await again()).json();
    const second = await again();
    expect(second.statusCode).toBe(201);
    expect(second.json().ref).toBe(first.ref);
    const rows = await t.ctx.adminDb.selectFrom('reservations').select('id').where('tenant_id', '=', a.tenantId).where('guest_phone', '=', '+919811100001').where('status', '=', 'booked').execute();
    expect(rows).toHaveLength(1);
  });

  it('refuses times it did not offer, too-big parties and a fourth booking for one number', async () => {
    for (const label of ['C3', 'C4', 'C5']) await createTable(t, a, label);
    const at = (iso: string, party = 2, phone = '9822200001') =>
      api(t, key)({ method: 'POST', url: `/v1/talko/outlets/${a.outletId}/reservations`, payload: { slot_start: iso, party_size: party, guest_name: 'Ravi', phone, channel: 'instagram' } });
    expect((await at('2026-11-07T10:15:00.000Z')).json().error.code).toBe('slot_unavailable'); // 15:45, after last seating
    expect((await at('2026-11-06T14:30:00.000Z')).json().error.code).toBe('slot_unavailable'); // a closed Friday
    expect((await at(SAT_8PM, 7)).json().error.code).toBe('party_too_large');
    for (const time of ['2026-11-07T06:30:00.000Z', '2026-11-07T07:00:00.000Z', '2026-11-07T07:30:00.000Z']) expect((await at(time)).statusCode).toBe(201);
    expect((await at('2026-11-07T08:00:00.000Z')).json().error.code).toBe('too_many_bookings');
  });

  it('lists and cancels a booking only with the matching phone', async () => {
    const made = (
      await api(t, key)({
        method: 'POST',
        url: `/v1/talko/outlets/${a.outletId}/reservations`,
        payload: { slot_start: '2026-11-07T15:30:00.000Z', party_size: 2, guest_name: 'Meera', phone: '9833300001', channel: 'whatsapp' },
      })
    ).json();
    const mine = (await api(t, key)({ method: 'POST', url: '/v1/talko/reservations/lookup', payload: { phone: '9833300001' } })).json();
    expect(mine.bookings.map((x: { ref: string }) => x.ref)).toContain(made.ref);
    const wrong = await api(t, key)({ method: 'POST', url: `/v1/talko/reservations/${made.ref}/cancel`, payload: { phone: '9833300002' } });
    expect(wrong.statusCode).toBe(404);
    const ok = await api(t, key)({ method: 'POST', url: `/v1/talko/reservations/${made.ref}/cancel`, payload: { phone: '+91 98333 00001' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().status).toBe('cancelled');
  });

  it("never reaches another tenant's outlets, bookings or orders", async () => {
    await openForBooking(b);
    const bTable = await createTable(t, b, 'B1');
    expect(bTable).toBeTruthy();
    const asA = api(t, key);
    expect((await asA({ method: 'GET', url: `/v1/talko/outlets/${b.outletId}/menu` })).statusCode).toBe(404);
    expect((await asA({ method: 'GET', url: `/v1/talko/outlets/${b.outletId}/availability?date=2026-11-07&party_size=2` })).statusCode).toBe(404);
    const booking = await asA({ method: 'POST', url: `/v1/talko/outlets/${b.outletId}/reservations`, payload: { slot_start: SAT_8PM, party_size: 2, guest_name: 'X', phone: '9844400001', channel: 'whatsapp' } });
    expect(booking.statusCode).toBe(404);
    const outlets = (await asA({ method: 'GET', url: '/v1/talko/outlets' })).json().outlets;
    expect(outlets.map((o: { id: string }) => o.id)).toEqual([a.outletId]);

    const bKey = await link(b);
    const bBooking = (await api(t, bKey)({ method: 'POST', url: `/v1/talko/outlets/${b.outletId}/reservations`, payload: { slot_start: SAT_8PM, party_size: 2, guest_name: 'B', phone: '9855500001', channel: 'whatsapp' } })).json();
    expect((await asA({ method: 'POST', url: `/v1/talko/reservations/${bBooking.ref}/cancel`, payload: { phone: '9855500001' } })).statusCode).toBe(404);
    expect((await asA({ method: 'POST', url: '/v1/talko/reservations/lookup', payload: { phone: '9855500001' } })).json().bookings).toEqual([]);

    const bMenu = await createMenu(t, b);
    const order: OrderDTO = (await api(t, b.ownerToken)({ method: 'POST', url: '/v1/orders', payload: { outlet_id: b.outletId, type: 'takeaway', lines: [{ item_id: bMenu.paneerTikka, qty: 1 }] } })).json();
    const code = (await t.ctx.adminDb.selectFrom('orders').select('track_code').where('id', '=', order.id).executeTakeFirstOrThrow()).track_code!;
    expect((await asA({ method: 'GET', url: `/v1/talko/orders/${code}` })).statusCode).toBe(404);
    expect((await api(t, bKey)({ method: 'GET', url: `/v1/talko/orders/${code}` })).json().order_no).toBe(order.order_no);
  });

  it('shows guests the menu without tax codes, stations or staff shortcuts', async () => {
    await createMenu(t, a);
    const res = await api(t, key)({ method: 'GET', url: `/v1/talko/outlets/${a.outletId}/menu` });
    expect(res.statusCode).toBe(200);
    const item = res.json().categories.flatMap((c: { items: object[] }) => c.items).find((i: { name: string }) => i.name === 'Paneer Tikka');
    expect(item).toMatchObject({ name: 'Paneer Tikka', price_paise: 25000, is_veg: true, in_stock: true });
    expect(Object.keys(item).sort()).toEqual(['available_now', 'description', 'id', 'in_stock', 'is_veg', 'name', 'price_paise']);
  });

  it('staff can edit a chat booking without losing where it came from', async () => {
    const made = (
      await api(t, key)({
        method: 'POST',
        url: `/v1/talko/outlets/${a.outletId}/reservations`,
        payload: { slot_start: '2026-11-07T16:00:00.000Z', party_size: 2, guest_name: 'Ira', phone: '9833300009', channel: 'messenger' },
      })
    ).json();
    const edited = await api(t, a.ownerToken)({ method: 'PATCH', url: `/v1/reservations/${made.id}`, payload: { party_size: 3, notes: 'Window seat' } });
    expect(edited.statusCode).toBe(200);
    expect(edited.json()).toMatchObject({ source: 'messenger', party_size: 3, public_ref: made.ref });
    // Staff cannot mark a booking as made in a chat.
    const faked = await api(t, a.ownerToken)({ method: 'PATCH', url: `/v1/reservations/${made.id}`, payload: { source: 'whatsapp' } });
    expect(faked.statusCode).toBe(400);
  });

  it('a staff token is not a link key, and a link key is not staff', async () => {
    expect((await api(t, a.ownerToken)({ method: 'GET', url: '/v1/talko/outlets' })).statusCode).toBe(401);
    expect((await api(t, key)({ method: 'GET', url: `/v1/reservations?outlet_id=${a.outletId}` })).statusCode).toBe(401);
    expect((await api(t, key)({ method: 'GET', url: '/v1/integrations/talko' })).statusCode).toBe(401);
  });
});

describe('disconnecting from Talko', () => {
  it('Talko can drop the link, after which its key reads nothing', async () => {
    const tenant = await createTenant(t, { plan: 'premium' });
    const key = await link(tenant);
    expect((await api(t, key)({ method: 'POST', url: '/v1/talko/unlink' })).statusCode).toBe(204);
    expect((await api(t, key)({ method: 'GET', url: '/v1/talko/outlets' })).statusCode).toBe(401);
    const view: TalkoLinkDTO = (await api(t, tenant.ownerToken)({ method: 'GET', url: '/v1/integrations/talko' })).json();
    expect(view.status).toBe('none');
  });
});

describe('events to Talko', () => {
  let tenant: TestTenant;
  let tenantKey: string;
  let menu: TestMenu;
  beforeAll(async () => {
    tenant = await createTenant(t, { plan: 'premium' });
    menu = await createMenu(t, tenant);
    tenantKey = await link(tenant);
    await setOutlet(t, tenant.outletId, { google_review_url: 'https://g.page/r/test/review' });
  });

  async function paidBillFor(phone: string): Promise<BillDTO> {
    const owner = api(t, tenant.ownerToken);
    const customer = (await owner({ method: 'POST', url: '/v1/customers', payload: { outlet_id: tenant.outletId, phone, name: 'Kiran', consent: true } })).json();
    const table = await createTable(t, tenant, `E${phone.slice(-3)}`);
    const order: OrderDTO = (await owner({ method: 'POST', url: '/v1/orders', payload: { outlet_id: tenant.outletId, type: 'dine_in', table_id: table, lines: [{ item_id: menu.paneerTikka, qty: 1 }] } })).json();
    const bill: BillDTO = (await owner({ method: 'POST', url: '/v1/bills', payload: { table_session_id: order.table_session_id } })).json();
    await owner({ method: 'PATCH', url: `/v1/bills/${bill.id}`, payload: { customer_id: customer.id } });
    const printed: BillDTO = (await owner({ method: 'POST', url: `/v1/bills/${bill.id}/finalise` })).json();
    const paid = await owner({ method: 'POST', url: `/v1/bills/${bill.id}/payments`, payload: { method: 'cash', amount_paise: printed.total_paise } });
    expect(paid.statusCode).toBe(201);
    return paid.json();
  }

  it('sends a paid bill once, keyed for idempotency, with the review link', async () => {
    const bill = await paidBillFor('9866600001');
    await until(async () => (await outbox(tenant)).find((r) => r.phone === '+919866600001' && r.status === 'sent'));
    await flush();
    const sent = received.filter((r) => r.body?.event === 'mezmitra.bill.paid');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.path).toBe('/api/events');
    expect(sent[0]!.headers.authorization).toBe(`Bearer ${TALKO_KEY}`);
    expect(sent[0]!.body).toMatchObject({ phone: '+919866600001', name: 'Kiran', data: { bill_id: bill.id, review_url: 'https://g.page/r/test/review', marketing_opt_in: false } });
    const row = (await outbox(tenant)).find((r) => r.event === 'mezmitra.bill.paid')!;
    expect(sent[0]!.headers['idempotency-key']).toBe(row.id);
    expect(row.status).toBe('sent');
  });

  it('retries when Talko is down, and gives up on a rejected key', async () => {
    answer = 503;
    await paidBillFor('9866600002');
    let row = await until(async () => (await outbox(tenant)).find((r) => r.phone === '+919866600002' && r.attempts >= 1));
    expect(row).toMatchObject({ status: 'pending', attempts: 1 });
    expect(row.next_attempt_at.getTime()).toBeGreaterThan(Date.now());

    answer = 401;
    await t.ctx.adminDb.updateTable('integration_outbox').set({ next_attempt_at: new Date() }).where('id', '=', row.id).execute();
    await flush();
    row = (await outbox(tenant)).find((r) => r.id === row.id)!;
    expect(row.status).toBe('dead');
    const view: TalkoLinkDTO = (await api(t, tenant.ownerToken)({ method: 'GET', url: '/v1/integrations/talko' })).json();
    expect(view.last_error).toMatch(/rejected the key/);
    expect(view.recent.find((d) => d.id === row.id)?.phone_tail).toBe('0002');

    answer = 200;
    await api(t, tenant.ownerToken)({ method: 'POST', url: '/v1/integrations/talko/retry' });
    row = (await outbox(tenant)).find((r) => r.id === row.id)!;
    expect(row.status).toBe('sent');
  });

  it('skips a message that would arrive too late', async () => {
    const linkRow = await t.ctx.adminDb.selectFrom('integration_links').select('id').where('tenant_id', '=', tenant.tenantId).where('status', '=', 'active').executeTakeFirstOrThrow();
    await t.ctx.adminDb
      .insertInto('integration_outbox')
      .values({ tenant_id: tenant.tenantId, link_id: linkRow.id, outlet_id: tenant.outletId, event: 'mezmitra.bill.paid', phone: '+919866600003', payload: '{}', dedupe_key: 'late-1', expires_at: new Date(Date.now() - 1000) })
      .execute();
    await flush();
    expect(received.some((r) => r.body?.phone === '+919866600003')).toBe(false);
    expect((await outbox(tenant)).find((r) => r.phone === '+919866600003')!.status).toBe('skipped');
  });

  it('sends nothing for a tenant without a link', async () => {
    const plain = await createTenant(t, { plan: 'premium' });
    const owner = api(t, plain.ownerToken);
    await owner({ method: 'POST', url: '/v1/customers', payload: { outlet_id: plain.outletId, phone: '9877700001', name: 'Nobody', consent: true } });
    expect(await outbox(plain)).toEqual([]);
  });

  it('tells Talko when a takeaway order is ready, with its tracking link', async () => {
    const owner = api(t, tenant.ownerToken);
    const order: OrderDTO = (
      await owner({ method: 'POST', url: '/v1/orders', payload: { outlet_id: tenant.outletId, type: 'takeaway', customer_phone: '98888 00001', customer_name: 'Sam', lines: [{ item_id: menu.paneerTikka, qty: 1 }] } })
    ).json();
    for (const status of ['accepted', 'ready'].filter((s) => s !== order.status)) {
      const res = await owner({ method: 'PATCH', url: `/v1/orders/${order.id}/status`, payload: { status } });
      expect(res.statusCode).toBe(200);
    }
    const ready = await until(async () => received.find((r) => r.body?.event === 'mezmitra.order.ready'));
    expect(ready?.body).toMatchObject({ phone: '+919888800001', data: { order_no: order.order_no } });
    expect(String(ready?.body?.data.track_url)).toMatch(/\/o\/[\w-]+$/);
  });

  it('never sends WhatsApp messages to a number typed into Instagram or website chat', async () => {
    await openForBooking(tenant);
    await createTable(t, tenant, 'IG1');
    const made = await api(t, tenantKey)({
      method: 'POST',
      url: `/v1/talko/outlets/${tenant.outletId}/reservations`,
      payload: { slot_start: '2026-11-07T15:00:00.000Z', party_size: 2, guest_name: 'Typed', phone: '9812312312', channel: 'instagram' },
    });
    expect(made.statusCode).toBe(201);
    expect((await outbox(tenant)).some((r) => r.phone === '+919812312312')).toBe(false);
  });

  it('queues a booking reminder once, inside the outlet reminder window', async () => {
    await openForBooking(tenant, { reminder_minutes: 120 });
    await createTable(t, tenant, 'R1');
    const owner = api(t, tenant.ownerToken);
    const soon = new Date(Date.now() + 60 * 60_000);
    const later = new Date(Date.now() + 5 * 3600_000);
    for (const [slot, phone] of [[soon, '9899900001'], [later, '9899900002']] as const) {
      const res = await owner({ method: 'POST', url: '/v1/reservations', payload: { outlet_id: tenant.outletId, guest_name: 'Rem', guest_phone: phone, contact_consent: true, party_size: 2, slot_start: slot.toISOString() } });
      expect(res.statusCode).toBe(201);
    }
    expect(await queueDueReminders(t.ctx)).toBe(1);
    expect(await queueDueReminders(t.ctx)).toBe(0);
    await until(async () => received.some((r) => r.body?.event === 'mezmitra.reservation.reminder'));
    const reminders = received.filter((r) => r.body?.event === 'mezmitra.reservation.reminder');
    expect(reminders.map((r) => r.body?.phone)).toEqual(['+919899900001']);
  });

  it('turns marketing off when Talko reports an opt-out, only with a valid signature', async () => {
    const owner = api(t, tenant.ownerToken);
    const c = (await owner({ method: 'POST', url: '/v1/customers', payload: { outlet_id: tenant.outletId, phone: '9800011111', name: 'Opt', consent: true } })).json();
    await t.ctx.adminDb.updateTable('customers').set({ marketing_opt_in: true }).where('id', '=', c.id).execute();
    const linkRow = await t.ctx.adminDb.selectFrom('integration_links').select('id').where('tenant_id', '=', tenant.tenantId).where('status', '=', 'active').executeTakeFirstOrThrow();
    const body = JSON.stringify({ id: 'd1', event: 'contact.optout', occurredAt: new Date().toISOString(), tenant: 'x', data: { phone: '919800011111' } });
    const send = (signature: string) =>
      t.app.inject({ method: 'POST', url: `/v1/talko/webhooks/${linkRow.id}`, headers: { 'content-type': 'application/json', 'x-alabs-signature': signature }, payload: body });
    expect((await send('sha256=deadbeef')).statusCode).toBe(401);
    const optIn = () => t.ctx.adminDb.selectFrom('customers').select('marketing_opt_in').where('id', '=', c.id).executeTakeFirstOrThrow();
    expect((await optIn()).marketing_opt_in).toBe(true);
    const good = `sha256=${createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex')}`;
    expect((await send(good)).statusCode).toBe(204);
    expect((await optIn()).marketing_opt_in).toBe(false);
  });
});

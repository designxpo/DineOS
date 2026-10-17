import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BillDTO, CustomerDTO, GuestJoinResponseDTO, GuestSessionDTO, OrderDTO } from '@dineos/shared/dto';
import { addStaff, api, createMenu, createTable, createTenant, setOutlet, startApp, type TestApp, type TestMenu, type TestTenant } from './helpers';

let t: TestApp;
let tenant: TestTenant;
let menu: TestMenu;
let owner: ReturnType<typeof api>;
let cashier: ReturnType<typeof api>;
let waiter: ReturnType<typeof api>;
let manager: { login: string };
let tableNo = 0;

beforeAll(async () => {
  t = await startApp();
  tenant = await createTenant(t);
  menu = await createMenu(t, tenant);
  owner = api(t, tenant.ownerToken);
  cashier = api(t, (await addStaff(t, tenant, 'cashier')).token);
  waiter = api(t, (await addStaff(t, tenant, 'waiter')).token);
  manager = await addStaff(t, tenant, 'manager', { pin: '2468' });
  // 10% back in points, 1 point = ₹1, redeem from 50 points.
  await setOutlet(t, tenant.outletId, { loyalty_enabled: true, loyalty_earn_bp: 1000, loyalty_point_value_paise: 100, loyalty_min_redeem_points: 50 });
});
afterAll(() => t.close());

const outlet = () => tenant.outletId;

async function saveCustomer(phone: string, name = 'Meera'): Promise<CustomerDTO> {
  const res = await cashier({ method: 'POST', url: '/v1/customers', payload: { outlet_id: outlet(), phone, name, consent: true } });
  expect(res.statusCode).toBe(201);
  return res.json();
}

async function billFor(paneerQty: number): Promise<BillDTO> {
  const tableId = await createTable(t, tenant, `L${++tableNo}`);
  const order: OrderDTO = (
    await cashier({ method: 'POST', url: '/v1/orders', payload: { outlet_id: outlet(), type: 'dine_in', table_id: tableId, lines: [{ item_id: menu.paneerTikka, qty: paneerQty }] } })
  ).json();
  const res = await cashier({ method: 'POST', url: '/v1/bills', payload: { table_session_id: order.table_session_id } });
  expect(res.statusCode).toBe(201);
  return res.json();
}

const getCustomer = async (id: string): Promise<CustomerDTO> => (await cashier({ method: 'GET', url: `/v1/customers/${id}?outlet_id=${outlet()}` })).json().customer;

describe('customer book', () => {
  it('saves a number only with consent, normalised and de-duplicated', async () => {
    const refused = await cashier({ method: 'POST', url: '/v1/customers', payload: { outlet_id: outlet(), phone: '9876500001', name: 'No consent' } });
    expect(refused.statusCode).toBe(400);

    const first = await saveCustomer('98765 00001');
    expect(first.phone).toBe('+919876500001');
    expect(first.consent_source).toBe('staff');
    const again = await saveCustomer('+91 98765-00001', 'Someone else');
    expect(again.id).toBe(first.id);
    expect(again.name).toBe('Meera'); // an existing name is not overwritten

    const found: CustomerDTO[] = (await waiter({ method: 'GET', url: `/v1/customers?outlet_id=${outlet()}&q=50000` })).json();
    expect(found.map((c) => c.id)).toContain(first.id);
    expect((await waiter({ method: 'POST', url: '/v1/customers', payload: { outlet_id: outlet(), phone: '9876500002', consent: true } })).statusCode).toBe(403);
  });

  it('earns points when a bill is paid and spends them at finalisation; a void gives them back', async () => {
    const c = await saveCustomer('9876500010');
    const first = await billFor(2); // 50000 + 5% = 52500
    expect((await cashier({ method: 'PATCH', url: `/v1/bills/${first.id}`, payload: { customer_id: c.id } })).json().customer.id).toBe(c.id);
    await cashier({ method: 'POST', url: `/v1/bills/${first.id}/finalise` });
    const paid: BillDTO = (await cashier({ method: 'POST', url: `/v1/bills/${first.id}/payments`, payload: { method: 'cash', amount_paise: 52500 } })).json();
    expect(paid.status).toBe('paid');
    expect(paid.loyalty_points_earned).toBe(52);
    let now = await getCustomer(c.id);
    expect(now.points).toBe(52);
    expect(now.visits).toBe(1);
    expect(now.total_spend_paise).toBe(52500);

    const second = await billFor(1);
    const redeem = (points: number) => cashier({ method: 'PATCH', url: `/v1/bills/${second.id}`, payload: { customer_id: c.id, redeem_points: points } });
    expect((await redeem(30)).json().error.code).toBe('below_minimum');
    expect((await redeem(60)).json().error.code).toBe('not_enough_points');
    const discounted: BillDTO = (await redeem(50)).json();
    expect(discounted.loyalty_points_redeemed).toBe(50);
    expect(discounted.loyalty_discount_paise).toBe(5000);
    expect(discounted.total_paise).toBe(21000); // (25000 - 5000) + 5%
    expect((await getCustomer(c.id)).points).toBe(52); // nothing leaves the balance until finalisation

    await cashier({ method: 'POST', url: `/v1/bills/${second.id}/finalise` });
    expect((await getCustomer(c.id)).points).toBe(2);

    const token = (await cashier({ method: 'POST', url: '/v1/approvals', payload: { outlet_id: outlet(), action: 'bill.void', login: manager.login, pin: '2468' } })).json().approval_token;
    const voided = await cashier({ method: 'POST', url: `/v1/bills/${second.id}/void`, payload: { reason: 'Wrong table' }, headers: { 'x-approval-token': token } });
    expect(voided.statusCode).toBe(200);
    now = await getCustomer(c.id);
    expect(now.points).toBe(52);

    const detail = (await cashier({ method: 'GET', url: `/v1/customers/${c.id}?outlet_id=${outlet()}` })).json();
    expect(detail.ledger.map((l: { kind: string; points: number }) => [l.kind, l.points])).toEqual([
      ['reverse', 50],
      ['redeem', -50],
      ['earn', 52],
    ]);
  });

  it('caps a redemption at the bill value and keeps manual corrections in the ledger', async () => {
    const c = await saveCustomer('9876500020');
    expect((await cashier({ method: 'POST', url: `/v1/customers/${c.id}/points`, payload: { outlet_id: outlet(), points: 1000, note: 'Goodwill' } })).statusCode).toBe(403);
    const adjusted = await owner({ method: 'POST', url: `/v1/customers/${c.id}/points`, payload: { outlet_id: outlet(), points: 1000, note: 'Goodwill' } });
    expect(adjusted.json().points).toBe(1000);
    expect((await owner({ method: 'POST', url: `/v1/customers/${c.id}/points`, payload: { outlet_id: outlet(), points: -5000, note: 'Too much' } })).json().error.code).toBe('not_enough_points');

    const bill = await billFor(1);
    const capped: BillDTO = (await cashier({ method: 'PATCH', url: `/v1/bills/${bill.id}`, payload: { customer_id: c.id, redeem_points: 1000 } })).json();
    expect(capped.loyalty_points_redeemed).toBe(250);
    expect(capped.total_paise).toBe(0);
    await cashier({ method: 'POST', url: `/v1/bills/${bill.id}/finalise` });
    expect((await getCustomer(c.id)).points).toBe(750);
  });

  it('lets a guest join the loyalty programme from the table, and the bill picks them up', async () => {
    const tableId = await createTable(t, tenant, 'G-LOY');
    const qr = new URL((await owner({ method: 'GET', url: `/v1/tables/${tableId}/qr` })).json().url).pathname.split('/').pop()!;
    const joined: GuestJoinResponseDTO = (await t.app.inject({ method: 'POST', url: '/v1/guest/join', payload: { qr_token: qr } })).json();
    const guest = api(t, joined.guest_token);

    expect((await guest({ method: 'POST', url: '/v1/guest/loyalty', payload: { phone: '9876500030', name: 'Ravi' } })).statusCode).toBe(400);
    expect((await guest({ method: 'POST', url: '/v1/guest/loyalty', payload: { phone: '9876500030', name: 'Ravi', consent: true } })).statusCode).toBe(200);
    const session: GuestSessionDTO = (await guest({ method: 'GET', url: '/v1/guest/session' })).json();
    expect(session.customer).toEqual({ phone_last4: '0030' });
    expect(session.loyalty.enabled).toBe(true);

    const order: OrderDTO = (
      await cashier({ method: 'POST', url: '/v1/orders', payload: { outlet_id: outlet(), type: 'dine_in', table_id: tableId, lines: [{ item_id: menu.paneerTikka, qty: 1 }] } })
    ).json();
    const bill: BillDTO = (await cashier({ method: 'POST', url: '/v1/bills', payload: { table_session_id: order.table_session_id } })).json();
    expect(bill.customer?.phone).toBe('+919876500030');
    expect(bill.customer?.name).toBe('Ravi');
    const customer = await t.ctx.adminDb.selectFrom('customers').select('consent_source').where('id', '=', bill.customer!.id).executeTakeFirstOrThrow();
    expect(customer.consent_source).toBe('guest');
  });

  it('never shows a guest who owns a typed number, and never lets them edit that record', async () => {
    const member = await cashier({ method: 'POST', url: '/v1/customers', payload: { outlet_id: outlet(), phone: '9876500060', consent: true } });
    const memberId = member.json().id;
    await owner({ method: 'POST', url: `/v1/customers/${memberId}/points`, payload: { outlet_id: outlet(), points: 400, note: 'Seed' } });

    const tableId = await createTable(t, tenant, 'G-SPY');
    const qr = new URL((await owner({ method: 'GET', url: `/v1/tables/${tableId}/qr` })).json().url).pathname.split('/').pop()!;
    const guest = api(t, (await t.app.inject({ method: 'POST', url: '/v1/guest/join', payload: { qr_token: qr } })).json().guest_token);
    const res = await guest({ method: 'POST', url: '/v1/guest/loyalty', payload: { phone: '9876500060', name: 'Impostor', marketing_opt_in: true, consent: true } });
    expect(res.json()).toEqual({ phone_last4: '0060' });
    // Every value in the response, so ids or timestamps that happen to contain "400" do not count.
    const values: unknown[] = [];
    JSON.parse((await guest({ method: 'GET', url: '/v1/guest/session' })).body, (_key, value) => (values.push(value), value));
    expect(values).not.toContain(400);
    expect(values).not.toContain('Impostor');
    const row = await t.ctx.adminDb.selectFrom('customers').select(['name', 'marketing_opt_in', 'consent_source']).where('id', '=', memberId).executeTakeFirstOrThrow();
    expect(row).toEqual({ name: null, marketing_opt_in: false, consent_source: 'staff' });
  });

  it('erases personal details on request and exports only for managers', async () => {
    const c = await saveCustomer('9876500040', 'Asha');
    expect((await cashier({ method: 'GET', url: `/v1/customers/export.csv?outlet_id=${outlet()}` })).statusCode).toBe(403);
    const csv = await owner({ method: 'GET', url: `/v1/customers/export.csv?outlet_id=${outlet()}` });
    expect(csv.statusCode).toBe(200);
    expect(csv.body).toContain('+919876500040');

    expect((await owner({ method: 'POST', url: `/v1/customers/${c.id}/erase`, payload: { outlet_id: outlet() } })).statusCode).toBe(204);
    expect((await cashier({ method: 'GET', url: `/v1/customers/${c.id}?outlet_id=${outlet()}` })).statusCode).toBe(404);
    const row = await t.ctx.adminDb.selectFrom('customers').select(['phone', 'name', 'erased_at']).where('id', '=', c.id).executeTakeFirstOrThrow();
    expect(row.name).toBeNull();
    expect(row.phone).not.toContain('9876500040');
    expect(row.erased_at).not.toBeNull();
    // The number can be registered again as a new person.
    expect((await saveCustomer('9876500040', 'Asha')).id).not.toBe(c.id);
  });

  it('refuses loyalty actions while the programme is off', async () => {
    await setOutlet(t, tenant.outletId, { loyalty_enabled: false });
    try {
      const c = await saveCustomer('9876500050');
      const bill = await billFor(1);
      expect((await cashier({ method: 'PATCH', url: `/v1/bills/${bill.id}`, payload: { customer_id: c.id, redeem_points: 50 } })).json().error.code).toBe('loyalty_disabled');
    } finally {
      await setOutlet(t, tenant.outletId, { loyalty_enabled: true });
    }
  });
});

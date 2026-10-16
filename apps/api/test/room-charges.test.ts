import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BillDTO, OrderDTO } from '@dineos/shared/dto';
import { addStaff, api, createMenu, createTenant, setOutlet, startApp, type TestApp, type TestMenu, type TestTenant } from './helpers';

let t: TestApp;
let tenant: TestTenant;
let menu: TestMenu;
let owner: ReturnType<typeof api>;
let cashier: ReturnType<typeof api>;
let manager: { login: string };

async function printedBill(qty: number): Promise<BillDTO> {
  const order: OrderDTO = (await cashier({ method: 'POST', url: '/v1/orders', payload: { outlet_id: tenant.outletId, type: 'takeaway', lines: [{ item_id: menu.paneerTikka, qty }] } })).json();
  const draft: BillDTO = (await cashier({ method: 'POST', url: '/v1/bills', payload: { order_id: order.id } })).json();
  return (await cashier({ method: 'POST', url: `/v1/bills/${draft.id}/finalise` })).json();
}
const pay = (bill: BillDTO, body: object) => cashier({ method: 'POST', url: `/v1/bills/${bill.id}/payments`, payload: body });
const report = async (query = '') => (await owner({ method: 'GET', url: `/v1/reports/room-charges?outlet_id=${tenant.outletId}${query}` })).json();

beforeAll(async () => {
  t = await startApp();
  tenant = await createTenant(t);
  menu = await createMenu(t, tenant);
  owner = api(t, tenant.ownerToken);
  cashier = api(t, (await addStaff(t, tenant, 'cashier')).token);
  manager = await addStaff(t, tenant, 'manager', { pin: '4321' });
});
afterAll(() => t.close());

describe('charge to room', () => {
  it('works only where the outlet allows it, and needs a room number', async () => {
    const bill = await printedBill(1);
    expect((await pay(bill, { method: 'room', amount_paise: bill.total_paise, room_no: '204' })).json().error.code).toBe('room_charge_disabled');
    await setOutlet(t, tenant.outletId, { room_charge_enabled: true });
    expect((await pay(bill, { method: 'room', amount_paise: bill.total_paise })).json().error.code).toBe('room_required');
    expect((await pay(bill, { method: 'room', amount_paise: bill.total_paise, room_no: '<script>' })).json().error.code).toBe('room_required');
    const paid: BillDTO = (await pay(bill, { method: 'room', amount_paise: bill.total_paise, room_no: ' 204 ', room_guest: 'Mr. Rao' })).json();
    expect(paid.status).toBe('paid');
    expect(paid.payments[0]).toMatchObject({ method: 'room', room_no: '204', room_guest: 'Mr. Rao', room_posted_at: null });
  });

  it('splits with cash, nets refunds against the room, and lists what the front desk must post', async () => {
    const bill = await printedBill(2);
    await pay(bill, { method: 'cash', amount_paise: 20000 });
    const paid: BillDTO = (await pay(bill, { method: 'room', amount_paise: bill.total_paise - 20000, room_no: '305' })).json();
    expect(paid.status).toBe('paid');
    const roomPayment = paid.payments.find((p) => p.method === 'room')!;

    const approval = (await cashier({ method: 'POST', url: '/v1/approvals', payload: { outlet_id: tenant.outletId, action: 'payment.refund', login: manager.login, pin: '4321' } })).json().approval_token;
    const refunded = await cashier({ method: 'POST', url: `/v1/payments/${roomPayment.id}/refund`, payload: { amount_paise: 5000, reason: 'Cold dish' }, headers: { 'x-approval-token': approval } });
    expect(refunded.statusCode).toBe(200);
    expect(refunded.json().payments.find((p: { kind: string }) => p.kind === 'refund')).toMatchObject({ method: 'room', room_no: '305' });

    const r = await report();
    expect(r.rows.map((x: { room_no: string; amount_paise: number }) => [x.room_no, x.amount_paise])).toEqual([
      ['204', expect.any(Number)],
      ['305', roomPayment.amount_paise],
      ['305', -5000],
    ]);
    expect(r.by_room).toEqual([
      { room_no: '204', amount_paise: r.rows[0].amount_paise },
      { room_no: '305', amount_paise: roomPayment.amount_paise - 5000 },
    ]);
    expect(r.totals.unposted).toBe(3);
  });

  it('managers mark charges as posted to the folio; the report and CSV follow', async () => {
    const r = await report();
    const ids = r.rows.filter((x: { room_no: string }) => x.room_no === '305').map((x: { payment_id: string }) => x.payment_id);
    expect((await cashier({ method: 'POST', url: '/v1/payments/room-posted', payload: { outlet_id: tenant.outletId, payment_ids: ids, posted: true } })).statusCode).toBe(403);
    const res = await owner({ method: 'POST', url: '/v1/payments/room-posted', payload: { outlet_id: tenant.outletId, payment_ids: ids, posted: true } });
    expect(res.json().updated).toBe(2);

    const open = await report('&unposted=1');
    expect(open.rows.map((x: { room_no: string }) => x.room_no)).toEqual(['204']);
    expect(open.totals.unposted).toBe(1);
    const all = await report();
    expect(all.rows.filter((x: { posted_at: string | null }) => x.posted_at)).toHaveLength(2);
    expect(all.rows.find((x: { posted_at: string | null }) => x.posted_at).posted_by_name).toBe('Owner');

    const csv = await owner({ method: 'GET', url: `/v1/reports/room-charges?outlet_id=${tenant.outletId}&format=csv` });
    const [header, first] = csv.body.trim().split('\n');
    expect(header).toBe('date,time,room,guest,invoice,table,type,amount_inr,posted');
    expect(first).toContain(',204,Mr. Rao,');

    const audit = await t.ctx.adminDb.selectFrom('audit_log').select('action').where('tenant_id', '=', tenant.tenantId).where('action', '=', 'payment.room_posted').execute();
    expect(audit).toHaveLength(1);
  });
});

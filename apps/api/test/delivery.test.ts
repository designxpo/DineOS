// Delivery orders entered at the POS: Zomato, Swiggy or the outlet's own riders. On Zomato and
// Swiggy orders the platform collects and pays the GST (CGST Act s. 9(5)), so the outlet's bill
// carries none and is settled by the platform's payout.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BillDTO, OrderDTO } from '@mezmitra/shared/dto';
import { addStaff, api, createMenu, createTenant, setOutlet, startApp, type TestApp, type TestMenu, type TestTenant } from './helpers';

let t: TestApp;
let tenant: TestTenant;
let menu: TestMenu;
let owner: ReturnType<typeof api>;
let cashier: ReturnType<typeof api>;

beforeAll(async () => {
  t = await startApp();
  tenant = await createTenant(t);
  menu = await createMenu(t, tenant);
  owner = api(t, tenant.ownerToken);
  cashier = api(t, (await addStaff(t, tenant, 'cashier')).token);
  await setOutlet(t, tenant.outletId, { delivery_commission_bp: { zomato: 2500, swiggy: 2200 } });
});
afterAll(() => t.close());

async function deliveryOrder(channel: 'zomato' | 'swiggy' | 'own', ref: string | null, qty = 2): Promise<OrderDTO> {
  const res = await cashier({
    method: 'POST',
    url: '/v1/orders',
    payload: { outlet_id: tenant.outletId, type: 'delivery', channel, channel_ref: ref, lines: [{ item_id: menu.paneerTikka, qty }] },
  });
  expect(res.statusCode).toBe(201);
  return res.json();
}

async function billFor(orderId: string): Promise<BillDTO> {
  const draft = await cashier({ method: 'POST', url: '/v1/bills', payload: { order_id: orderId } });
  expect(draft.statusCode).toBe(201);
  const fin = await cashier({ method: 'POST', url: `/v1/bills/${draft.json().id}/finalise` });
  expect(fin.statusCode).toBe(200);
  return fin.json();
}

const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

describe('delivery orders', () => {
  it('needs a channel, and goes to the kitchen showing the platform and its order number', async () => {
    const bad = await cashier({ method: 'POST', url: '/v1/orders', payload: { outlet_id: tenant.outletId, type: 'delivery', lines: [{ item_id: menu.paneerTikka, qty: 1 }] } });
    expect(bad.statusCode).toBe(400);
    const order = await deliveryOrder('zomato', 'ZOM-48213');
    expect(order).toMatchObject({ type: 'delivery', channel: 'zomato', channel_ref: 'ZOM-48213', status: 'accepted' });
    const kds = (await cashier({ method: 'GET', url: `/v1/orders?outlet_id=${tenant.outletId}&type=delivery` })).json();
    expect(kds.find((o: OrderDTO) => o.id === order.id)).toMatchObject({ channel: 'zomato', channel_ref: 'ZOM-48213' });
  });

  it('bills a Zomato order without GST, and only the platform can settle it', async () => {
    const order = await deliveryOrder('zomato', 'ZOM-48214');
    const bill = await billFor(order.id);
    expect(bill).toMatchObject({ tax_by_operator: true, tax_total_paise: 0, service_charge_paise: 0 });
    expect(bill.total_paise).toBe(order.subtotal_paise);
    const invoice = (await cashier({ method: 'GET', url: `/v1/bills/${bill.id}/invoice` })).json();
    expect(invoice.tax_summary).toEqual([]);

    const cash = await cashier({ method: 'POST', url: `/v1/bills/${bill.id}/payments`, payload: { method: 'cash', amount_paise: bill.total_paise } });
    expect(cash.statusCode).toBe(400);
    const paid = await cashier({ method: 'POST', url: `/v1/bills/${bill.id}/payments`, payload: { method: 'platform', amount_paise: bill.total_paise, reference: 'ZOM-48214' } });
    expect(paid.statusCode).toBe(201);
    expect(paid.json().status).toBe('paid');
  });

  it("bills the outlet's own deliveries with GST, like takeaway, and refuses a platform payment there", async () => {
    const order = await deliveryOrder('own', null);
    const bill = await billFor(order.id);
    expect(bill.tax_by_operator).toBe(false);
    expect(bill.tax_total_paise).toBeGreaterThan(0);
    const res = await cashier({ method: 'POST', url: `/v1/bills/${bill.id}/payments`, payload: { method: 'platform', amount_paise: bill.total_paise } });
    expect(res.statusCode).toBe(400);
  });

  it('reports sales, commission and expected payout per channel', async () => {
    const swiggy = await deliveryOrder('swiggy', 'SWG-9001', 1);
    const bill = await billFor(swiggy.id);
    await cashier({ method: 'POST', url: `/v1/bills/${bill.id}/payments`, payload: { method: 'platform', amount_paise: bill.total_paise } });

    expect((await cashier({ method: 'GET', url: `/v1/reports/delivery?outlet_id=${tenant.outletId}&from=${today}&to=${today}` })).statusCode).toBe(403);
    const r = (await owner({ method: 'GET', url: `/v1/reports/delivery?outlet_id=${tenant.outletId}&from=${today}&to=${today}` })).json();
    const sw = r.channels.find((c: { channel: string }) => c.channel === 'swiggy');
    expect(sw).toEqual({
      channel: 'swiggy',
      orders: 1,
      sales_paise: bill.total_paise,
      commission_bp: 2200,
      commission_paise: Math.round((bill.total_paise * 2200) / 10_000),
      payout_paise: bill.total_paise - Math.round((bill.total_paise * 2200) / 10_000),
    });
    expect(r.channels.find((c: { channel: string }) => c.channel === 'zomato')).toMatchObject({ orders: 2, commission_bp: 2500 });
    expect(r.channels.find((c: { channel: string }) => c.channel === 'own')).toMatchObject({ orders: 1, commission_bp: 0, commission_paise: 0 });

    const csv = await owner({ method: 'GET', url: `/v1/reports/delivery?outlet_id=${tenant.outletId}&from=${today}&to=${today}&format=csv` });
    expect(csv.headers['content-type']).toContain('text/csv');
    // Money in rupees, as in the other report exports.
    expect(csv.body.split('\n')[0]).toBe('channel,orders,sales_inr,commission_bp,commission_inr,payout_inr');
    expect(csv.body).toContain(`swiggy,1,${(bill.total_paise / 100).toFixed(2)},2200`);
  });

  it('keeps platform-taxed sales out of the GST rate tables and lists them apart', async () => {
    const g = (await owner({ method: 'GET', url: `/v1/reports/gst?outlet_id=${tenant.outletId}&from=${today}&to=${today}` })).json();
    // Only the own delivery is a taxable supply of the outlet.
    expect(g.by_rate.find((x: { tax_rate_bp: number }) => x.tax_rate_bp === 0)).toBeUndefined();
    const zomato = g.operator_supplies.find((x: { channel: string }) => x.channel === 'zomato');
    const swiggy = g.operator_supplies.find((x: { channel: string }) => x.channel === 'swiggy');
    expect(zomato).toMatchObject({ bills: 1 });
    expect(swiggy).toMatchObject({ bills: 1 });
    expect(zomato.value_paise).toBeGreaterThan(0);
  });
});

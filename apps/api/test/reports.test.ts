import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BillDTO } from '@dineos/shared/dto';
import { addStaff, api, createMenu, createTable, createTenant, startApp, type TestApp, type TestMenu, type TestTenant } from './helpers';

let t: TestApp;
let tenant: TestTenant;
let menu: TestMenu;
let owner: ReturnType<typeof api>;
let paidTotals: number;
let cashTotal: number;

beforeAll(async () => {
  t = await startApp();
  tenant = await createTenant(t);
  menu = await createMenu(t, tenant);
  owner = api(t, tenant.ownerToken);

  async function settle(label: string, method: 'cash' | 'upi', discount = false): Promise<BillDTO> {
    const tableId = await createTable(t, tenant, label);
    const order = (
      await owner({
        method: 'POST',
        url: '/v1/orders',
        payload: { outlet_id: tenant.outletId, type: 'dine_in', table_id: tableId, lines: [{ item_id: menu.paneerTikka, qty: 2 }, { item_id: menu.chickenTikka, qty: 1 }] },
      })
    ).json();
    let bill: BillDTO = (await owner({ method: 'POST', url: '/v1/bills', payload: { table_session_id: order.table_session_id } })).json();
    if (discount) {
      bill = (await owner({ method: 'PATCH', url: `/v1/bills/${bill.id}`, payload: { bill_discount: { kind: 'amount', paise: 5000 }, discount_reason: 'Staff meal' } })).json();
    }
    await owner({ method: 'POST', url: `/v1/bills/${bill.id}/finalise` });
    return (await owner({ method: 'POST', url: `/v1/bills/${bill.id}/payments`, payload: { method, amount_paise: bill.total_paise } })).json();
  }

  const a = await settle('R1', 'cash');
  const b = await settle('R2', 'upi', true);
  const c = await settle('R3', 'cash');
  paidTotals = a.total_paise + b.total_paise + c.total_paise;
  cashTotal = a.total_paise + c.total_paise;

  // One printed-then-voided bill.
  const tableId = await createTable(t, tenant, 'R4');
  const order = (await owner({ method: 'POST', url: '/v1/orders', payload: { outlet_id: tenant.outletId, type: 'dine_in', table_id: tableId, lines: [{ item_id: menu.paneerTikka, qty: 1 }] } })).json();
  const v: BillDTO = (await owner({ method: 'POST', url: '/v1/bills', payload: { table_session_id: order.table_session_id } })).json();
  await owner({ method: 'POST', url: `/v1/bills/${v.id}/finalise` });
  await owner({ method: 'POST', url: `/v1/bills/${v.id}/void`, payload: { reason: 'Duplicate' } });
});
afterAll(() => t.close());

describe('reports', () => {
  it('day-end adds up: sales, payments, expected cash, voids and discounts', async () => {
    const res = await owner({ method: 'GET', url: `/v1/reports/day-end?outlet_id=${tenant.outletId}` });
    expect(res.statusCode).toBe(200);
    const d = res.json();
    expect(d.sales.bills).toBe(3);
    expect(d.sales.net_paise).toBe(paidTotals);
    expect(d.sales.discount_paise).toBe(5000);
    expect(d.expected_cash_paise).toBe(cashTotal);
    expect(d.payments.reduce((s: number, p: { net_paise: number }) => s + p.net_paise, 0)).toBe(paidTotals);
    expect(d.voids).toHaveLength(1);
    expect(d.voids[0].reason).toBe('Duplicate');
    expect(d.discounts[0]).toMatchObject({ discount_paise: 5000, reason: 'Staff meal' });
    expect(d.invoices.count).toBe(4);
    expect(d.invoices.cancelled).toHaveLength(1);
    expect(d.open_bills.count).toBe(0);
    expect(d.top_items[0].name).toBe('Paneer Tikka');
  });

  it('GST by rate reconciles with the sales totals', async () => {
    const g = (await owner({ method: 'GET', url: `/v1/reports/gst?outlet_id=${tenant.outletId}` })).json();
    const s = (await owner({ method: 'GET', url: `/v1/reports/sales?outlet_id=${tenant.outletId}` })).json();
    const tax = g.by_rate.reduce((a: number, r: { cgst_paise: number; sgst_paise: number }) => a + r.cgst_paise + r.sgst_paise, 0);
    expect(tax).toBe(s.totals.tax_paise);
    const taxable = g.by_rate.reduce((a: number, r: { taxable_paise: number }) => a + r.taxable_paise, 0);
    expect(taxable).toBe(s.totals.taxable_paise);
    expect(g.by_rate.map((r: { tax_rate_bp: number }) => r.tax_rate_bp)).toEqual([500, 1800]);
  });

  it('ranks item sales and exports CSV in rupees', async () => {
    const items = (await owner({ method: 'GET', url: `/v1/reports/items?outlet_id=${tenant.outletId}` })).json();
    expect(items[0]).toMatchObject({ name: 'Paneer Tikka', qty: 7, category: 'Starters' });
    const csv = await owner({ method: 'GET', url: `/v1/reports/items?outlet_id=${tenant.outletId}&format=csv` });
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.body.split('\n')[0]).toBe('item_id,name,category,qty,orders,revenue_inr');
    expect(csv.body).toContain('Paneer Tikka,Starters,7,4,1750.00');
  });

  it('dashboard shows the QR order share and table states', async () => {
    const d = (await owner({ method: 'GET', url: `/v1/reports/dashboard?outlet_id=${tenant.outletId}` })).json();
    expect(d.net_sales_paise).toBe(paidTotals);
    expect(d.orders).toBe(4);
    expect(d.qr_order_share).toBe(0);
    expect(d.tables.needs_cleaning).toBe(3);
  });

  it('is for owners and managers only', async () => {
    const cashier = api(t, (await addStaff(t, tenant, 'cashier')).token);
    expect((await cashier({ method: 'GET', url: `/v1/reports/sales?outlet_id=${tenant.outletId}` })).statusCode).toBe(403);
  });
});

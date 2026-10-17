import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BillDTO } from '@mezmitra/shared/dto';
import { previousRange } from '../src/modules/reports/insights';
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

  it('insights: categories, rush hours, team, discount reasons, tables and pilot health', async () => {
    // One guest QR order on top of the three staff orders, accepted by staff.
    const tableId = await createTable(t, tenant, 'R5');
    const qr = new URL((await owner({ method: 'GET', url: `/v1/tables/${tableId}/qr` })).json().url).pathname.split('/').pop()!;
    const guest = api(t, (await t.app.inject({ method: 'POST', url: '/v1/guest/join', payload: { qr_token: qr } })).json().guest_token);
    await guest({ method: 'POST', url: '/v1/guest/cart/lines', payload: { item_id: menu.paneerTikka, qty: 1, modifier_ids: [] } });
    const { order: placed } = (await guest({ method: 'POST', url: '/v1/guest/orders', payload: {} })).json();
    expect((await owner({ method: 'PATCH', url: `/v1/orders/${placed.id}/status`, payload: { status: 'accepted' } })).statusCode).toBe(200);

    const res = await owner({ method: 'GET', url: `/v1/reports/insights?outlet_id=${tenant.outletId}` });
    expect(res.statusCode).toBe(200);
    const d = res.json();
    expect(d.headline.bills).toBe(3);
    expect(d.headline.net_paise).toBe(paidTotals);
    expect(d.headline.change_pct.net).toBeNull(); // nothing the day before
    expect(d.categories).toEqual([{ category: 'Starters', qty: 2 * 3 + 3 + 1 + 1, revenue_paise: (50000 + 32000) * 3 + 25000 + 25000 }]);
    expect(d.heatmap.reduce((a: number, c: { orders: number }) => a + c.orders, 0)).toBe(5);
    expect(d.staff).toEqual([expect.objectContaining({ name: 'Owner', orders: 4, bills: 3, net_paise: paidTotals, discount_paise: 5000 })]);
    expect(d.discounts.by_reason).toEqual([{ reason: 'Staff meal', bills: 1, amount_paise: 5000 }]);
    expect(d.tables.visits).toBe(3);
    expect(d.pilot.orders).toBe(5);
    expect(d.pilot.qr_share_pct).toBe(20);
    expect(d.pilot.qr_flagged).toBe(1);
    expect(d.pilot.qr_avg_accept_seconds).not.toBeNull();
    expect(d.pilot.voided_bills).toBe(1);
  });

  it('compares with the same number of days just before', () => {
    const base = { outletId: 'o', timezone: 'Asia/Kolkata' };
    expect(previousRange({ ...base, from: '2026-10-15', to: '2026-10-15' })).toMatchObject({ from: '2026-10-14', to: '2026-10-14' });
    expect(previousRange({ ...base, from: '2026-10-01', to: '2026-10-07' })).toMatchObject({ from: '2026-09-24', to: '2026-09-30' });
  });

  it('builds the month-end pack: definitions, totals that match the reports, and every invoice', async () => {
    const month = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date()).slice(0, 7);
    const res = await owner({ method: 'GET', url: `/v1/reports/month-pack?outlet_id=${tenant.outletId}&month=${month}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.rawPayload as unknown as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual([
      'Read me', 'Summary', 'Sales by day', 'GST by rate', 'HSN summary', 'Invoices', 'B2B invoices', 'Delivery apps 9(5)', 'Payments', 'Wallet top-ups', 'Free items', 'Discounts', 'Voids', 'Refunds',
    ]);
    const readme = wb.getWorksheet('Read me')!;
    const terms: string[] = [];
    readme.eachRow((r) => terms.push(String(r.getCell(1).value ?? '')));
    expect(terms).toContain('Net sales');
    expect(terms).toContain('Wallet top-ups');

    const summary = wb.getWorksheet('Summary')!;
    const figure = (label: string) => {
      let v: unknown;
      summary.eachRow((r) => {
        if (r.getCell(1).value === label) v = r.getCell(2).value;
      });
      return v;
    };
    expect(figure('Net sales')).toBe(paidTotals / 100);
    expect(figure('Discounts')).toBe(-50);

    // Every invoice, the voided one included and marked.
    const invoices = wb.getWorksheet('Invoices')!;
    expect(invoices.rowCount).toBe(1 + 4);
    const statuses: string[] = [];
    invoices.eachRow((r, i) => i > 1 && statuses.push(String(r.getCell(4).value)));
    expect(statuses.sort()).toEqual(['Paid', 'Paid', 'Paid', 'Voided']);
    const payments = wb.getWorksheet('Payments')!;
    let paid = 0;
    payments.eachRow((r, i) => {
      if (i > 3) paid += Number(r.getCell(5).value);
    });
    expect(Math.round(paid * 100)).toBe(paidTotals);

    expect((await owner({ method: 'GET', url: `/v1/reports/month-pack?outlet_id=${tenant.outletId}&month=2999-01` })).statusCode).toBe(400);
    expect((await owner({ method: 'GET', url: `/v1/reports/month-pack?outlet_id=${tenant.outletId}&month=2026-13` })).statusCode).toBe(400);
    const waiter = api(t, (await addStaff(t, tenant, 'waiter')).token);
    expect((await waiter({ method: 'GET', url: `/v1/reports/month-pack?outlet_id=${tenant.outletId}&month=${month}` })).statusCode).toBe(403);
  });
});

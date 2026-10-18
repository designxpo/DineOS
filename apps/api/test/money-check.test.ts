// The money check, for an outlet that bills on another system while its paid year runs: its sales
// export and its bank statement, with every UPI payment the bills claim checked against the bank.
// Nothing is ordered or billed in Mezmitra meanwhile, and the QR menu is for reading.

import ExcelJS from 'exceljs';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrderDTO, SalesImportDTO, SalesImportResultDTO, UpiCheckDTO } from '@mezmitra/shared/dto';
import { addStaff, api, createMenu, createTable, createTenant, startApp, type TestApp, type TestMenu, type TestTenant } from './helpers';

let t: TestApp;
let tenant: TestTenant;
let menu: TestMenu;
let owner: ReturnType<typeof api>;

beforeAll(async () => {
  t = await startApp();
  tenant = await createTenant(t);
  menu = await createMenu(t, tenant);
  owner = api(t, tenant.ownerToken);
});
afterAll(() => t.close());

const setBilling = (billing_elsewhere: string | null) => owner({ method: 'PATCH', url: `/v1/outlets/${tenant.outletId}`, payload: { billing_elsewhere } });
const sendSales = (file_name: string, data: Buffer, columns?: Record<string, string>, as = owner) =>
  as({ method: 'POST', url: '/v1/reconciliation/sales', payload: { outlet_id: tenant.outletId, file_name, data: data.toString('base64'), columns } });
const sendStatement = (lines: string[]) =>
  owner({
    method: 'POST',
    url: '/v1/reconciliation/statements',
    payload: {
      outlet_id: tenant.outletId,
      file_name: 'statement.csv',
      data: Buffer.from(['Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance', ...lines].join('\n')).toString('base64'),
    },
  });
const uploads = async (): Promise<SalesImportDTO[]> => (await owner({ method: 'GET', url: `/v1/reconciliation/sales?outlet_id=${tenant.outletId}` })).json();

/** What a Petpooja-style bill-wise report looks like, as Excel. */
async function salesXlsx(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Orders');
  ws.addRow(['Order Report']);
  ws.addRow([]);
  ws.addRow(['Invoice No.', 'Date', 'Payment Type', 'Status', 'Grand Total', 'Payment Ref']);
  ws.addRow(['501', new Date('2026-10-10T13:05:00Z'), 'UPI', 'Success', 420, '412345678901']);
  ws.addRow(['502', new Date('2026-10-10T20:15:00Z'), 'UPI', 'Success', 1050, '']);
  ws.addRow(['503', new Date('2026-10-10T21:30:00Z'), 'UPI', 'Success', 760, '']);
  ws.addRow(['504', new Date('2026-10-10T22:00:00Z'), 'Cash', 'Success', 300, '']);
  ws.addRow(['505', new Date('2026-10-10T22:30:00Z'), 'Card', 'Cancelled', 900, '']);
  ws.addRow(['506', new Date('2026-10-11T23:50:00Z'), 'UPI', 'Success', 640, '']);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe('money check (billing on another system)', () => {
  it('needs the outlet to say it bills elsewhere, and only the owner side may say so', async () => {
    expect((await sendSales('orders.xlsx', await salesXlsx())).json().error.code).toBe('bills_here');
    const waiter = api(t, (await addStaff(t, tenant, 'waiter')).token);
    expect((await waiter({ method: 'PATCH', url: `/v1/outlets/${tenant.outletId}`, payload: { billing_elsewhere: 'Petpooja' } })).statusCode).toBe(403);

    // An order still open here must be finished first.
    const order: OrderDTO = (await owner({ method: 'POST', url: '/v1/orders', payload: { outlet_id: tenant.outletId, type: 'takeaway', lines: [{ item_id: menu.paneerTikka, qty: 1 }] } })).json();
    expect((await setBilling('Petpooja')).json().error.code).toBe('open_orders');
    expect((await owner({ method: 'PATCH', url: `/v1/orders/${order.id}/status`, payload: { status: 'cancelled', reason: 'Moving to Petpooja for now' } })).statusCode).toBe(200);
    const res = await setBilling('Petpooja');
    expect(res.statusCode).toBe(200);
    expect(res.json().billing_elsewhere).toBe('Petpooja');
  });

  it('takes no orders here meanwhile; the QR menu is for reading and calling a waiter', async () => {
    const order = await owner({ method: 'POST', url: '/v1/orders', payload: { outlet_id: tenant.outletId, type: 'takeaway', lines: [{ item_id: menu.paneerTikka, qty: 1 }] } });
    expect(order.statusCode).toBe(409);
    expect(order.json().error).toMatchObject({ code: 'bills_elsewhere', message: expect.stringContaining('Petpooja') });

    const table = await createTable(t, tenant, `M${randomUUID().slice(0, 4)}`);
    const qr = new URL((await owner({ method: 'GET', url: `/v1/tables/${table}/qr` })).json().url).pathname.split('/').pop()!;
    expect((await t.app.inject({ method: 'GET', url: `/v1/guest/resolve?qr=${qr}` })).json().outlet.ordering).toBe(false);
    const joined = (await t.app.inject({ method: 'POST', url: '/v1/guest/join', payload: { qr_token: qr } })).json();
    const guest = api(t, joined.guest_token);
    expect((await guest({ method: 'POST', url: '/v1/guest/cart/lines', payload: { item_id: menu.paneerTikka, qty: 1 } })).json().error.code).toBe('menu_only');
    expect((await guest({ method: 'POST', url: '/v1/guest/call-waiter' })).statusCode).toBe(200);
  });

  it('reads the sales export and checks its UPI against the bank: found, missing, not checked yet', async () => {
    const res = await sendSales('Order_Report_Oct.xlsx', await salesXlsx());
    expect(res.statusCode).toBe(201);
    const r: SalesImportResultDTO = res.json();
    expect(r.columns).toMatchObject({ date: 'Date', total: 'Grand Total', method: 'Payment Type', bill_no: 'Invoice No.' });
    expect(r.import).toMatchObject({ system: 'Petpooja', period_from: '2026-10-10', period_to: '2026-10-11', bills: 5, duplicates: 0, skipped: 1 });
    expect(r.import.by_method).toEqual([
      { method: 'upi', count: 4, amount_paise: 287000 },
      { method: 'cash', count: 1, amount_paise: 30000 },
    ]);
    expect(r.import.upi).toMatchObject({ matched: 0, missing: 0, unchecked: 4, unchecked_paise: 287000 });

    const statement = await sendStatement([
      '10/10/26,UPI-ANANYA-ananya@okaxis-UTIB0000001-412345678901-PAY,0000412345678901,10/10/26,,420.00,1000.00',
      '10/10/26,UPI-FATIMA-f@oksbi-SBIN0000001-612345678903-DINNER,0000612345678903,10/10/26,,1050.00,2050.00',
      '12/10/26,UPI-LATE-l@okicici-ICIC0000001-712345678904-UPI,0000712345678904,12/10/26,,640.00,2690.00',
    ]);
    expect(statement.statusCode).toBe(201);
    // Bill 503 (₹760 by UPI) never reached the bank.
    const missing = statement.json().missing as { outside_bill_no: string; amount_paise: number }[];
    expect(missing.map((m) => [m.outside_bill_no, m.amount_paise])).toEqual([['503', 76000]]);

    const [u] = await uploads();
    expect(u!.upi).toMatchObject({ matched: 3, matched_paise: 211000, missing: 1, missing_paise: 76000, unchecked: 0 });

    const check: UpiCheckDTO = (await owner({ method: 'GET', url: `/v1/reconciliation/upi-check?outlet_id=${tenant.outletId}&to=2026-10-11` })).json();
    expect(check.not_received.payments.map((p) => p.outside_bill_no)).toEqual(['503']);
  });

  it('stores a bill once when exports overlap, and a wrong upload can be taken back', async () => {
    const again: SalesImportResultDTO = (await sendSales('Order_Report_Oct (1).xlsx', await salesXlsx())).json();
    expect(again.import).toMatchObject({ bills: 0, duplicates: 5 });

    const [, first] = await uploads();
    expect((await owner({ method: 'DELETE', url: `/v1/reconciliation/sales/${first!.id}` })).statusCode).toBe(204);
    const payments = await t.ctx.adminDb.selectFrom('payments').select('id').where('outlet_id', '=', tenant.outletId).where('outside_bill_id', 'is not', null).execute();
    expect(payments).toEqual([]);
    const matched = await t.ctx.adminDb.selectFrom('bank_credits').select('id').where('outlet_id', '=', tenant.outletId).where('payment_id', 'is not', null).execute();
    expect(matched).toEqual([]);
  });

  it('asks for the columns when it cannot tell them, then matches the bank again on upload', async () => {
    const odd = Buffer.from(['Ref,Day,Mode,Rs', 'X1,10/10/2026,UPI,420', 'X2,10/10/2026,Cash,120'].join('\n'));
    const asked = await sendSales('export.csv', odd);
    expect(asked.statusCode).toBe(400);
    expect(asked.json().error).toMatchObject({ code: 'unknown_sales_export', details: { headers: ['Ref', 'Day', 'Mode', 'Rs'] } });
    const done = await sendSales('export.csv', odd, { date: 'Day', total: 'Rs', method: 'Mode', bill_no: 'Ref' });
    expect(done.statusCode).toBe(201);
    // The ₹420 credit already on file is matched to the new bill straight away.
    expect((done.json() as SalesImportResultDTO).import.upi).toMatchObject({ matched: 1, matched_paise: 42000 });
  });

  it('when the paid year ends, billing moves to Mezmitra and orders are taken again', async () => {
    expect((await setBilling(null)).json().billing_elsewhere).toBeNull();
    const order = await owner({ method: 'POST', url: '/v1/orders', payload: { outlet_id: tenant.outletId, type: 'takeaway', lines: [{ item_id: menu.paneerTikka, qty: 1 }] } });
    expect(order.statusCode).toBe(201);
    expect((await sendSales('later.csv', Buffer.from('Bill No,Date,Total\n9,20/10/2026,100'))).json().error.code).toBe('bills_here');
  });
});

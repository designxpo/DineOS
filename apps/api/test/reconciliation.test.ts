import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BillDTO, OrderDTO, StatementDetailDTO } from '@dineos/shared/dto';
import { addStaff, api, createMenu, createTenant, startApp, type TestApp, type TestMenu, type TestTenant } from './helpers';

let t: TestApp;
let tenant: TestTenant;
let menu: TestMenu;
let owner: ReturnType<typeof api>;
let cashier: ReturnType<typeof api>;
const pay: Record<string, { id: string; amount: number }> = {};

/** A takeaway bill paid by UPI, back-dated to `at` (outlet time). */
async function upiPayment(qty: number, reference: string | null, at: string) {
  const order: OrderDTO = (await owner({ method: 'POST', url: '/v1/orders', payload: { outlet_id: tenant.outletId, type: 'takeaway', lines: [{ item_id: menu.paneerTikka, qty }] } })).json();
  const draft: BillDTO = (await owner({ method: 'POST', url: '/v1/bills', payload: { order_id: order.id } })).json();
  const bill: BillDTO = (await owner({ method: 'POST', url: `/v1/bills/${draft.id}/finalise` })).json();
  const paid: BillDTO = (await owner({ method: 'POST', url: `/v1/bills/${bill.id}/payments`, payload: { method: 'upi', amount_paise: bill.total_paise, reference } })).json();
  const id = paid.payments[0]!.id;
  await t.ctx.adminDb.updateTable('payments').set({ created_at: new Date(at) }).where('id', '=', id).execute();
  return { id, amount: bill.total_paise };
}

const rupees = (paise: number) => (paise / 100).toFixed(2);
const upload = (name: string, data: Buffer, as = owner) =>
  as({ method: 'POST', url: '/v1/reconciliation/statements', payload: { outlet_id: tenant.outletId, file_name: name, data: data.toString('base64') } });

beforeAll(async () => {
  t = await startApp();
  tenant = await createTenant(t);
  menu = await createMenu(t, tenant);
  owner = api(t, tenant.ownerToken);
  cashier = api(t, (await addStaff(t, tenant, 'cashier')).token);
  pay.fullUtr = await upiPayment(1, 'UTR 412345678901', '2026-10-10T13:05:00+05:30');
  pay.lastDigits = await upiPayment(2, '8902', '2026-10-10T13:40:00+05:30');
  pay.noRef = await upiPayment(3, null, '2026-10-10T20:15:00+05:30');
  pay.lateNight = await upiPayment(4, null, '2026-10-10T23:52:00+05:30');
  pay.neverArrived = await upiPayment(5, null, '2026-10-10T21:30:00+05:30');
  pay.lastDay = await upiPayment(6, null, '2026-10-11T22:10:00+05:30');
});
afterAll(() => t.close());

function hdfcCsv(): Buffer {
  return Buffer.from(
    [
      'HDFC BANK Ltd.,,,,,,',
      'Account No :50100123456789,,,,,,',
      ',,,,,,',
      'Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance',
      `10/10/26,UPI-ANANYA-ananya@okaxis-UTIB0000001-412345678901-PAY,0000412345678901,10/10/26,,${rupees(pay.fullUtr!.amount)},1000.00`,
      `10/10/26,UPI-VIKRAM-vik@ybl-YESB0000001-512345678902-PAY,0000512345678902,10/10/26,,${rupees(pay.lastDigits!.amount)},2000.00`,
      `10/10/26,UPI-FATIMA-f@oksbi-SBIN0000001-612345678903-DINNER,0000612345678903,10/10/26,,${rupees(pay.noRef!.amount)},3000.00`,
      `11/10/26,UPI-LATE GUEST-l@okicici-ICIC0000001-712345678904-UPI,0000712345678904,11/10/26,,${rupees(pay.lateNight!.amount)},4000.00`,
      '10/10/26,UPI-WALK IN-w@paytm-PYTM0000001-812345678905-PAYMENT,0000812345678905,10/10/26,,777.00,4777.00',
      '11/10/26,CASH DEPOSIT BY SELF,,11/10/26,,"5,000.00",9777.00',
      '11/10/26,NEFT DR-VEG SUPPLIER,N123,11/10/26,"2,000.00",,7777.00',
    ].join('\n'),
  );
}

const credit = (d: StatementDetailDTO, narration: string) => d.credits.find((c) => c.narration.includes(narration))!;

describe('UPI reconciliation', () => {
  it('matches bank credits to UPI payments and shows what is left on each side', async () => {
    expect((await upload('statement.csv', hdfcCsv(), cashier)).statusCode).toBe(403);
    const res = await upload('Acct_Statement_Oct.csv', hdfcCsv());
    expect(res.statusCode).toBe(201);
    const d: StatementDetailDTO = res.json();
    expect(d.statement).toMatchObject({ period_from: '2026-10-10', period_to: '2026-10-11', credits: 6, duplicates: 0 });

    expect(credit(d, 'ANANYA')).toMatchObject({ match_kind: 'utr', payment: { id: pay.fullUtr!.id } });
    // The cashier typed only the last four digits.
    expect(credit(d, 'VIKRAM')).toMatchObject({ match_kind: 'utr', payment: { id: pay.lastDigits!.id } });
    expect(credit(d, 'FATIMA')).toMatchObject({ match_kind: 'amount_date', payment: { id: pay.noRef!.id } });
    // Paid at 11:52 pm, credited the next morning.
    expect(credit(d, 'LATE GUEST')).toMatchObject({ match_kind: 'amount_date', payment: { id: pay.lateNight!.id } });
    expect(credit(d, 'WALK IN').payment).toBeNull();
    expect(credit(d, 'CASH DEPOSIT')).toMatchObject({ is_upi: false, payment: null });

    expect(d.statement.summary).toMatchObject({ matched: 4, unrecorded_upi: 1, unrecorded_upi_paise: 77700, other_credits: 1, missing: 1, missing_paise: pay.neverArrived!.amount });
    // A payment from the statement's last day may still post on the next statement.
    expect(d.missing.map((m) => [m.id, m.late_possible])).toEqual([
      [pay.neverArrived!.id, false],
      [pay.lastDay!.id, true],
    ]);
    expect(d.missing[0]).toMatchObject({ amount_paise: pay.neverArrived!.amount, invoice_no: expect.stringMatching(/^TST\//) });
  });

  it('stores each credit once when statements overlap, and an Excel export works too', async () => {
    const again: StatementDetailDTO = (await upload('Acct_Statement_Oct (1).csv', hdfcCsv())).json();
    expect(again.statement).toMatchObject({ credits: 0, duplicates: 6 });
    expect(again.statement.summary.matched).toBe(4);

    // Next export, from the bank's Excel download: overlaps the 11th and adds the 12th, where the
    // payment from the 11th finally lands.
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Statement');
    ws.addRow(['Account Statement for 50100123456789']);
    ws.addRow([]);
    ws.addRow(['Txn Date', 'Value Date', 'Description', 'Ref No./Cheque No.', 'Debit', 'Credit', 'Balance']);
    ws.addRow([new Date(Date.UTC(2026, 9, 11)), new Date(Date.UTC(2026, 9, 11)), 'CASH DEPOSIT BY SELF', '', '', 5000, 9777]);
    ws.addRow([new Date(Date.UTC(2026, 9, 12)), new Date(Date.UTC(2026, 9, 12)), 'UPI/CR/912345678906/ROOM 204/HDFC/r@okhdfc/UPI', 'TRANSFER FROM 912345678906', '', pay.lastDay!.amount / 100, 12000]);
    const xlsx = Buffer.from(await wb.xlsx.writeBuffer());
    const res = await upload('statement.xlsx', xlsx);
    expect(res.statusCode).toBe(201);
    const d: StatementDetailDTO = res.json();
    expect(d.statement).toMatchObject({ period_from: '2026-10-11', period_to: '2026-10-12', credits: 1, duplicates: 1 });
    expect(credit(d, 'ROOM 204')).toMatchObject({ match_kind: 'amount_date', payment: { id: pay.lastDay!.id } });
  });

  it('lets a manager fix matches by hand and set aside money that is not a sale, with an audit trail', async () => {
    const list = (await owner({ method: 'GET', url: `/v1/reconciliation/statements?outlet_id=${tenant.outletId}` })).json();
    const first = list.find((s: { file_name: string }) => s.file_name === 'Acct_Statement_Oct.csv');
    let d: StatementDetailDTO = (await owner({ method: 'GET', url: `/v1/reconciliation/statements/${first.id}` })).json();

    const walkIn = credit(d, 'WALK IN');
    const wrongAmount = await owner({ method: 'POST', url: `/v1/reconciliation/credits/${walkIn.id}/match`, payload: { payment_id: pay.neverArrived!.id } });
    expect(wrongAmount.json().error.code).toBe('amount_mismatch');
    const taken = await owner({ method: 'POST', url: `/v1/reconciliation/credits/${credit(d, 'FATIMA').id}/match`, payload: { payment_id: pay.neverArrived!.id } });
    expect(taken.json().error.code).toBe('already_matched');

    d = (await owner({ method: 'DELETE', url: `/v1/reconciliation/credits/${credit(d, 'FATIMA').id}/match` })).json();
    expect(credit(d, 'FATIMA').payment).toBeNull();
    d = (await owner({ method: 'POST', url: `/v1/reconciliation/credits/${credit(d, 'FATIMA').id}/match`, payload: { payment_id: pay.noRef!.id } })).json();
    expect(credit(d, 'FATIMA')).toMatchObject({ match_kind: 'manual', payment: { id: pay.noRef!.id } });

    d = (await owner({ method: 'POST', url: `/v1/reconciliation/credits/${credit(d, 'CASH DEPOSIT').id}/dismiss`, payload: { reason: 'Owner paid in float' } })).json();
    expect(d.statement.summary).toMatchObject({ other_credits: 0, dismissed: 1 });

    const actions = (await t.ctx.adminDb.selectFrom('audit_log').select('action').where('tenant_id', '=', tenant.tenantId).where('action', 'like', 'reconciliation.%').execute()).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['reconciliation.import', 'reconciliation.unmatch', 'reconciliation.match', 'reconciliation.dismiss']));
    expect((await cashier({ method: 'GET', url: `/v1/reconciliation/statements/${first.id}` })).statusCode).toBe(403);
  });

  it('explains files it cannot read', async () => {
    const bad = await upload('menu.csv', Buffer.from('category,name,price\nStarters,Tikka,250'));
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('unknown_statement');
    expect((await upload('statement.pdf', Buffer.from('%PDF-1.4'))).json().error.code).toBe('invalid_file_type');
  });
});

// Delivery payouts: the app's statement for a cycle, set beside what the outlet billed and what the
// bank received, with the dispute over any shortfall.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BillDTO, ChannelPayoutDTO, OrderDTO, StatementDetailDTO } from '@mezmitra/shared/dto';
import { addStaff, api, createMenu, createTenant, setOutlet, startApp, type TestApp, type TestMenu, type TestTenant } from './helpers';

let t: TestApp;
let tenant: TestTenant;
let menu: TestMenu;
let owner: ReturnType<typeof api>;
let cashier: ReturnType<typeof api>;
let sales = 0;
let creditId = '';
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

beforeAll(async () => {
  t = await startApp();
  tenant = await createTenant(t);
  menu = await createMenu(t, tenant);
  owner = api(t, tenant.ownerToken);
  cashier = api(t, (await addStaff(t, tenant, 'cashier')).token);
  await setOutlet(t, tenant.outletId, { delivery_commission_bp: { zomato: 2500, swiggy: 2200 } });
  for (const ref of ['ZOM-1', 'ZOM-2', 'ZOM-3']) {
    const order: OrderDTO = (await cashier({ method: 'POST', url: '/v1/orders', payload: { outlet_id: tenant.outletId, type: 'delivery', channel: 'zomato', channel_ref: ref, lines: [{ item_id: menu.paneerTikka, qty: 2 }] } })).json();
    const draft = await cashier({ method: 'POST', url: '/v1/bills', payload: { order_id: order.id } });
    const bill: BillDTO = (await cashier({ method: 'POST', url: `/v1/bills/${draft.json().id}/finalise` })).json();
    sales += bill.total_paise;
  }
  const d = new Date();
  const dmy = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getFullYear()).slice(2)}`;
  const net = Math.round((sales * 2 * 0.75) / 3) - 5000; // the app paid for two of the three orders, less ₹50 in ads
  const csv = ['HDFC BANK Ltd.,,,,,,', ',,,,,,', 'Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance', `${dmy},NEFT CR-ZOMATO LTD,N1,${dmy},,${(net / 100).toFixed(2)},9000.00`].join('\n');
  const up = await owner({ method: 'POST', url: '/v1/reconciliation/statements', payload: { outlet_id: tenant.outletId, file_name: 'oct.csv', data: Buffer.from(csv).toString('base64') } });
  expect(up.statusCode).toBe(201);
  creditId = (up.json() as StatementDetailDTO).credits[0]!.id;
});
afterAll(() => t.close());

const record = (payload: object, as = owner) => as({ method: 'POST', url: '/v1/reconciliation/payouts', payload: { outlet_id: tenant.outletId, channel: 'zomato', period_from: today, period_to: today, ...payload } });

describe('delivery payouts', () => {
  it('sets the app’s statement beside the outlet’s own sales and the bank credit, and shows where the money went', async () => {
    const gross = Math.round((sales * 2) / 3);
    const commission = Math.round(gross * 0.25);
    const net = Math.round((sales * 2 * 0.75) / 3) - 5000;
    const body = {
      reference: 'ZOM-PAYOUT-77',
      orders_claimed: 2,
      gross_paise: gross,
      net_paise: net,
      lines: [
        { kind: 'commission', amount_paise: commission },
        { kind: 'ads', amount_paise: 5000, note: 'Promoted listing' },
      ],
      bank_credit_id: creditId,
    };
    expect((await record(body, cashier)).statusCode).toBe(403);
    const res = await record(body);
    expect(res.statusCode).toBe(201);
    const p: ChannelPayoutDTO = res.json();
    expect(p.ours).toMatchObject({ orders: 3, sales_paise: sales, commission_bp: 2500 });
    // The app counted two of the three orders: a third of the sales never reached its statement.
    expect(p.missing_paise).toBe(sales - gross);
    expect(Math.abs(p.unexplained_paise)).toBeLessThanOrEqual(1); // rounding only
    expect(p.vs_expected_paise).toBe(p.net_paise - p.ours.expected_net_paise);
    expect(p.vs_expected_paise).toBeLessThan(0);
    expect(p.bank).toMatchObject({ credit_id: creditId });
    expect(Math.abs(p.bank_gap_paise!)).toBeLessThanOrEqual(1);

    // The credit is explained by the payout, so it no longer shows as money with no bill.
    const credit = await t.ctx.adminDb.selectFrom('bank_credits').select('dismissed_reason').where('id', '=', creditId).executeTakeFirstOrThrow();
    expect(credit.dismissed_reason).toMatch(/^Delivery payout: zomato/);

    expect((await record(body)).json().error.code).toBe('payout_exists');
    expect((await owner({ method: 'GET', url: `/v1/reconciliation/payouts?outlet_id=${tenant.outletId}` })).json()).toHaveLength(1);
  });

  it('keeps a dispute with the app until the shortfall is credited back', async () => {
    const [p]: ChannelPayoutDTO[] = (await owner({ method: 'GET', url: `/v1/reconciliation/payouts?outlet_id=${tenant.outletId}` })).json();
    expect(p!.dispute).toBeNull();
    const open = await owner({ method: 'PATCH', url: `/v1/reconciliation/payouts/${p!.id}/dispute`, payload: { status: 'open', note: 'ZOM-3 was delivered but is not on the statement' } });
    expect(open.json().dispute).toMatchObject({ status: 'open', recovered_paise: 0 });
    const done = await owner({ method: 'PATCH', url: `/v1/reconciliation/payouts/${p!.id}/dispute`, payload: { status: 'recovered', recovered_paise: 30000 } });
    expect(done.json().dispute).toMatchObject({ status: 'recovered', recovered_paise: 30000 });
  });

  it('deleting a payout frees its bank credit again', async () => {
    const [p]: ChannelPayoutDTO[] = (await owner({ method: 'GET', url: `/v1/reconciliation/payouts?outlet_id=${tenant.outletId}` })).json();
    expect((await owner({ method: 'DELETE', url: `/v1/reconciliation/payouts/${p!.id}` })).statusCode).toBe(204);
    const credit = await t.ctx.adminDb.selectFrom('bank_credits').select('dismissed_reason').where('id', '=', creditId).executeTakeFirstOrThrow();
    expect(credit.dismissed_reason).toBeNull();
  });
});

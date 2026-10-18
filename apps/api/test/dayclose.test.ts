// Closing the day: every loose end at the outlet in one list, each pointing to where to act, and
// a sign-off by the owner or a manager kept with the day as it stood.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { businessDate } from '@mezmitra/shared/dates';
import type { BillDTO, DayCloseDTO, OrderDTO } from '@mezmitra/shared/dto';
import { addStaff, api, createMenu, createTenant, startApp, type TestApp, type TestMenu, type TestTenant } from './helpers';

let t: TestApp;
let tenant: TestTenant;
let menu: TestMenu;
let owner: ReturnType<typeof api>;
let today: string;
let partial: BillDTO;

beforeAll(async () => {
  t = await startApp();
  tenant = await createTenant(t);
  menu = await createMenu(t, tenant);
  owner = api(t, tenant.ownerToken);
  today = businessDate(new Date(), 'Asia/Kolkata');
});
afterAll(() => t.close());

const order = async (qty = 1): Promise<OrderDTO> =>
  (await owner({ method: 'POST', url: '/v1/orders', payload: { outlet_id: tenant.outletId, type: 'takeaway', lines: [{ item_id: menu.paneerTikka, qty }] } })).json();
const finalBill = async (o: OrderDTO): Promise<BillDTO> => {
  const draft: BillDTO = (await owner({ method: 'POST', url: '/v1/bills', payload: { order_id: o.id } })).json();
  return (await owner({ method: 'POST', url: `/v1/bills/${draft.id}/finalise` })).json();
};
const view = async (as = owner): Promise<DayCloseDTO> => (await as({ method: 'GET', url: `/v1/day-close?outlet_id=${tenant.outletId}` })).json();
const kinds = (d: DayCloseDTO) => d.items.map((i) => `${i.severity}:${i.kind}`).sort();

describe('day-end sign-off', () => {
  it('a quiet day has nothing open', async () => {
    const d = await view();
    expect(d).toMatchObject({ date: today, items: [], signed: null, expected_cash_paise: 0 });
  });

  it('lists every loose end at close, each with where to act on it', async () => {
    // A bill half paid, a draft never finished, food served but never billed.
    partial = await finalBill(await order(2));
    await owner({ method: 'POST', url: `/v1/bills/${partial.id}/payments`, payload: { method: 'cash', amount_paise: 20000 } });
    const drafted = await order();
    const draft: BillDTO = (await owner({ method: 'POST', url: '/v1/bills', payload: { order_id: drafted.id } })).json();
    const forgotten = await order(3);

    // A dish given free, a discount above the cashier's limit, a UPI payment not yet checked.
    const comped = await order(2);
    expect((await owner({ method: 'POST', url: `/v1/order-items/${comped.items[0]!.id}/comp`, payload: { qty: 1, reason: 'mishap', note: 'Burnt' } })).statusCode).toBe(201);
    const discounted = await order(4);
    const dDraft: BillDTO = (await owner({ method: 'POST', url: '/v1/bills', payload: { order_id: discounted.id } })).json();
    await owner({ method: 'PATCH', url: `/v1/bills/${dDraft.id}`, payload: { bill_discount: { kind: 'percent', bp: 2500 }, discount_reason: 'Owner’s friend' } });
    const dBill: BillDTO = (await owner({ method: 'POST', url: `/v1/bills/${dDraft.id}/finalise` })).json();
    await owner({ method: 'POST', url: `/v1/bills/${dBill.id}/payments`, payload: { method: 'upi', amount_paise: dBill.total_paise, reference: '1234' } });

    // A stock count that came out short.
    const ingredient = await t.ctx.adminDb.insertInto('ingredients').values({ tenant_id: tenant.tenantId, outlet_id: tenant.outletId, name: 'Paneer', unit: 'kg' }).returning('id').executeTakeFirstOrThrow();
    await t.ctx.adminDb.insertInto('stock_movements').values({ tenant_id: tenant.tenantId, outlet_id: tenant.outletId, ingredient_id: ingredient.id, type: 'count', qty: '-0.5', note: 'Evening count' }).execute();

    const d = await view();
    expect(kinds(d)).toEqual([
      'check:free_item',
      'check:large_discount',
      'check:stock_difference',
      'check:upi_unchecked',
      'must:draft_bill',
      'must:unbilled_order',
      'must:unbilled_order',
      'must:unpaid_bill',
    ]);
    const item = (k: string) => d.items.filter((i) => i.kind === k);
    expect(item('unpaid_bill')[0]).toMatchObject({ title: `Bill ${partial.invoice_no} not fully paid`, amount_paise: partial.total_paise - 20000, href: `/app/bills/${partial.id}` });
    expect(item('draft_bill')[0]).toMatchObject({ href: `/app/bills/${draft.id}` });
    // The forgotten order and the comped one were never billed; the drafted order is listed once, as the draft.
    expect(item('unbilled_order').map((i) => i.amount_paise).sort()).toEqual([50000, 75000]);
    expect(item('free_item')[0]).toMatchObject({ title: '1 × Paneer Tikka free', detail: 'mishap · given by Owner' });
    expect(item('large_discount')[0]).toMatchObject({ title: `Large discount on ${dBill.invoice_no}`, detail: 'Owner’s friend', href: `/app/bills/${dBill.id}` });
    expect(item('stock_difference')[0]).toMatchObject({ title: 'Paneer: 0.5 kg less than expected', detail: 'stock count · Evening count' });
    expect(item('upi_unchecked')[0]).toMatchObject({ amount_paise: dBill.total_paise, href: '/app/reconcile' });
    expect(d.expected_cash_paise).toBe(20000);
    expect(forgotten.id).toBeTruthy();
  });

  it('only the owner or a manager signs, and money left open needs a reason', async () => {
    const sign = (as: ReturnType<typeof api>, body: object = {}) => as({ method: 'POST', url: '/v1/day-close', payload: { outlet_id: tenant.outletId, date: today, ...body } });
    const cashier = api(t, (await addStaff(t, tenant, 'cashier')).token);
    expect((await cashier({ method: 'GET', url: `/v1/day-close?outlet_id=${tenant.outletId}` })).statusCode).toBe(403);
    const manager = api(t, (await addStaff(t, tenant, 'manager')).token);
    const noNote = await sign(manager, { counted_cash_paise: 19500 });
    expect(noNote.json().error).toMatchObject({ code: 'note_needed', message: expect.stringContaining('4 items are still open') });

    const res = await sign(manager, { counted_cash_paise: 19500, note: 'Table 4 settles tomorrow; draft is a staff meal' });
    expect(res.statusCode).toBe(201);
    const signed: DayCloseDTO = res.json();
    expect(signed.signed).toMatchObject({ signed_by_name: expect.stringMatching(/^Manager/), counted_cash_paise: 19500, note: 'Table 4 settles tomorrow; draft is a staff meal' });
    expect(signed.items).toHaveLength(8);
    expect((await sign(owner, { note: 'Again' })).json().error.code).toBe('already_closed');
    expect((await sign(owner, { date: '2999-01-01' })).json().error.code).toBe('future_date');

    // The sign-off keeps the list as it stood: paying the bill later does not rewrite the day.
    await owner({ method: 'POST', url: `/v1/bills/${partial.id}/payments`, payload: { method: 'cash', amount_paise: partial.total_paise - 20000 } });
    expect(kinds(await view())).toEqual(kinds(signed));
    const log = await t.ctx.adminDb.selectFrom('audit_log').select('after').where('tenant_id', '=', tenant.tenantId).where('action', '=', 'day.close').executeTakeFirstOrThrow();
    expect(log.after).toMatchObject({ date: today, open_must: 4, open_check: 4, expected_cash_paise: 20000, counted_cash_paise: 19500 });
  });
});

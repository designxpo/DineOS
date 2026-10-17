// Paid memberships (sold on their own GST invoice, running from payment) and the prepaid wallet
// (top-ups with a receipt, spending with proof the guest is there, refunds and cash-out).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BillDTO, BillLoyaltyDTO, CustomerDTO, LoyaltyReportDTO, MembershipPlanDTO, OrderDTO, UpiCheckDTO, WalletDTO, WalletPackDTO, WalletTopupDTO } from '@mezmitra/shared/dto';
import { EMPTY_PROGRAM, MEMBERSHIP_TEMPLATES } from '@mezmitra/shared/loyalty';
import { addStaff, api, createMenu, createTable, createTenant, startApp, type TestApp, type TestMenu, type TestTenant } from './helpers';

let t: TestApp;
let tenant: TestTenant;
let menu: TestMenu;
let owner: ReturnType<typeof api>;
let cashier: ReturnType<typeof api>;
let waiter: ReturnType<typeof api>;
let manager: { login: string };
let coffeeCat: string;
let tableNo = 0;
let phoneNo = 0;
const sent: { phone: string; code: string }[] = [];

beforeAll(async () => {
  t = await startApp();
  tenant = await createTenant(t);
  menu = await createMenu(t, tenant);
  owner = api(t, tenant.ownerToken);
  cashier = api(t, (await addStaff(t, tenant, 'cashier')).token);
  waiter = api(t, (await addStaff(t, tenant, 'waiter')).token);
  manager = await addStaff(t, tenant, 'manager', { pin: '2580' });
  coffeeCat = (await t.ctx.adminDb.insertInto('menu_categories').values({ tenant_id: tenant.tenantId, outlet_id: tenant.outletId, name: 'Coffee' }).returning('id').executeTakeFirstOrThrow()).id;
  await t.ctx.adminDb.updateTable('menu_items').set({ category_id: coffeeCat }).where('id', '=', menu.coldCoffee).execute();
});
afterAll(() => t.close());

const outlet = () => tenant.outletId;
const coffee = (qty: number) => ({ item_id: menu.coldCoffee, qty, modifier_ids: [menu.regular] });
const paneer = (qty: number) => ({ item_id: menu.paneerTikka, qty });
const approval = async (action: string) =>
  (await cashier({ method: 'POST', url: '/v1/approvals', payload: { outlet_id: outlet(), action, login: manager.login, pin: '2580' } })).json().approval_token as string;

async function guest(): Promise<CustomerDTO> {
  const res = await cashier({ method: 'POST', url: '/v1/customers', payload: { outlet_id: outlet(), phone: `98222${String(++phoneNo).padStart(5, '0')}`, name: 'Member', consent: true } });
  expect(res.statusCode).toBe(201);
  return res.json();
}

async function visit(customerId: string, lines: object[]): Promise<BillDTO> {
  const tableId = await createTable(t, tenant, `M${++tableNo}`);
  const order: OrderDTO = (await cashier({ method: 'POST', url: '/v1/orders', payload: { outlet_id: outlet(), type: 'dine_in', table_id: tableId, lines } })).json();
  const bill: BillDTO = (await cashier({ method: 'POST', url: '/v1/bills', payload: { table_session_id: order.table_session_id } })).json();
  return (await cashier({ method: 'PATCH', url: `/v1/bills/${bill.id}`, payload: { customer_id: customerId } })).json();
}

async function payCash(billId: string): Promise<BillDTO> {
  const printed: BillDTO = (await cashier({ method: 'POST', url: `/v1/bills/${billId}/finalise` })).json();
  const res = await cashier({ method: 'POST', url: `/v1/bills/${billId}/payments`, payload: { method: 'cash', amount_paise: printed.total_paise } });
  expect(res.statusCode).toBe(201);
  return res.json();
}

const savePlan = (body: object, as = owner) => as({ method: 'POST', url: '/v1/memberships/plans', payload: { outlet_id: outlet(), template: null, is_active: true, ...body } });
const sell = (customerId: string, planId: string) => cashier({ method: 'POST', url: `/v1/customers/${customerId}/memberships`, payload: { outlet_id: outlet(), plan_id: planId } });
const plans = async (): Promise<MembershipPlanDTO[]> => (await cashier({ method: 'GET', url: `/v1/memberships/plans?outlet_id=${outlet()}` })).json();
const memberships = (customerId: string) => t.ctx.adminDb.selectFrom('customer_memberships').selectAll().where('customer_id', '=', customerId).orderBy('created_at').execute();

describe('memberships', () => {
  let diners: MembershipPlanDTO;
  let daily: MembershipPlanDTO;

  it('lets the owner set up plans from templates, and anyone at the till see them', async () => {
    const template = (key: string) => MEMBERSHIP_TEMPLATES.find((x) => x.key === key)!.plan;
    expect((await savePlan(template('diners_club'), waiter)).statusCode).toBe(403);
    expect((await savePlan({ ...template('diners_club'), benefits: { discount: null, daily_item: null, multiplier_bp: 10_000 } })).json().error.message).toBe(
      'Give members something: a discount, a daily item or faster points',
    );
    expect((await savePlan({ ...template('diners_club'), template: 'diners_club' })).statusCode).toBe(200);
    const coffeeADay = template('coffee_a_day');
    await savePlan({ ...coffeeADay, template: 'coffee_a_day', benefits: { ...coffeeADay.benefits, daily_item: { category_ids: [coffeeCat], max_value_paise: 20_000 } } });
    const list = await plans();
    diners = list.find((p) => p.name === "Diners' club")!;
    daily = list.find((p) => p.name === 'Coffee a day')!;
    expect(diners).toMatchObject({ price_paise: 149_900, duration_days: 90, tax_rate_bp: 1800, members: 0 });
  });

  it('sells a membership on its own GST invoice, and starts it when that bill is paid', async () => {
    const g = await guest();
    const res = await sell(g.id, diners.id);
    expect(res.statusCode).toBe(201);
    const bill: BillDTO = res.json();
    expect(bill).toMatchObject({ table_session_id: null, order_id: null, membership: { name: "Diners' club", status: 'pending' }, subtotal_paise: 149_900 });
    expect(bill.lines).toEqual([expect.objectContaining({ name: "Diners' club membership (3 months)", order_item_id: null, tax_rate_bp: 1800 })]);
    // 18% GST on ₹1,499: ₹1,768.82, rounded.
    expect(bill.total_paise).toBe(176_900);

    const paid = await payCash(bill.id);
    expect(paid.invoice_no).toMatch(/^TST\//);
    expect(paid.membership).toMatchObject({ status: 'active' });
    const [m] = await memberships(g.id);
    expect(m!.ends_at!.getTime() - m!.starts_at!.getTime()).toBe(90 * 86_400_000);
    // Buying a membership is not a meal: no visit counted.
    const c = (await cashier({ method: 'GET', url: `/v1/customers/${g.id}?outlet_id=${outlet()}` })).json().customer;
    expect(c.visits).toBe(0);

    // 15% off the next meal.
    const meal = await visit(g.id, [paneer(2)]);
    expect(meal).toMatchObject({ member_discount_paise: 7500, loyalty_discount_paise: 7500 });
    expect(meal.total_paise).toBe(44_600);

    // A second one runs on from the first.
    await payCash(((await sell(g.id, diners.id)).json() as BillDTO).id);
    const [, second] = await memberships(g.id);
    expect(second!.starts_at!.getTime()).toBe(m!.ends_at!.getTime());
    expect((await plans()).find((p) => p.id === diners.id)!.members).toBe(1);
  });

  it('cancels a membership whose bill is voided or discarded', async () => {
    const g = await guest();
    const dropped: BillDTO = (await sell(g.id, diners.id)).json();
    expect((await cashier({ method: 'DELETE', url: `/v1/bills/${dropped.id}` })).statusCode).toBe(204);
    const voidMe: BillDTO = (await sell(g.id, diners.id)).json();
    await cashier({ method: 'POST', url: `/v1/bills/${voidMe.id}/finalise` });
    const voided = await cashier({ method: 'POST', url: `/v1/bills/${voidMe.id}/void`, payload: { reason: 'Changed mind' }, headers: { 'x-approval-token': await approval('bill.void') } });
    expect(voided.statusCode).toBe(200);
    expect((await memberships(g.id)).map((m) => m.status)).toEqual(['cancelled', 'cancelled']);
    expect((await visit(g.id, [paneer(1)])).member_discount_paise).toBe(0);
  });

  it('gives a coffee a day while the membership runs', async () => {
    const g = await guest();
    await payCash(((await sell(g.id, daily.id)).json() as BillDTO).id);
    const bill = await visit(g.id, [coffee(1), paneer(1)]);
    const l: BillLoyaltyDTO = (await cashier({ method: 'GET', url: `/v1/bills/${bill.id}/loyalty` })).json().loyalty;
    const treat = l.rewards.find((r) => r.source === 'membership')!;
    expect(treat.label).toBe('Member treat: a free item from Coffee (up to ₹200)');
    expect(l.memberships).toEqual([expect.objectContaining({ name: 'Coffee a day', status: 'active' })]);
    const coffeeLine = bill.lines.find((x) => x.name.startsWith('Cold Coffee'))!.order_item_id!;
    expect(l.eligible[treat.id]).toEqual([coffeeLine]);
    await cashier({ method: 'POST', url: `/v1/bills/${bill.id}/rewards`, payload: { reward_id: treat.id, order_item_id: coffeeLine } });
    await payCash(bill.id);
    // One a day.
    const later = await visit(g.id, [coffee(1)]);
    expect(((await cashier({ method: 'GET', url: `/v1/bills/${later.id}/loyalty` })).json().loyalty as BillLoyaltyDTO).rewards).toEqual([]);
  });

  it('doubles points for a VIP member', async () => {
    await owner({ method: 'PUT', url: '/v1/loyalty/program', payload: { outlet_id: outlet(), name: 'Points', template: null, status: 'active', config: { ...EMPTY_PROGRAM, earn: { kind: 'points', earn_bp: 1000, point_value_paise: 100, min_redeem_points: 10 } } } });
    const vip = MEMBERSHIP_TEMPLATES.find((x) => x.key === 'vip_year')!.plan;
    await savePlan({ ...vip, benefits: { ...vip.benefits, discount: null } });
    const plan = (await plans()).find((p) => p.name === 'VIP year')!;
    const g = await guest();
    await payCash(((await sell(g.id, plan.id)).json() as BillDTO).id);
    const meal = await payCash((await visit(g.id, [paneer(1)])).id);
    // ₹263 × 10% × 2.
    expect(meal.loyalty_points_earned).toBe(52);
  });
});

describe('wallet', () => {
  let pack: WalletPackDTO;
  let g: CustomerDTO;
  const wallet = async (id = g.id): Promise<WalletDTO> => (await cashier({ method: 'GET', url: `/v1/customers/${id}/wallet?outlet_id=${outlet()}` })).json();
  const payWallet = (billId: string, amount: number, extra: object = {}, headers: Record<string, string> = {}) =>
    cashier({ method: 'POST', url: `/v1/bills/${billId}/payments`, payload: { method: 'wallet', amount_paise: amount, ...extra }, headers });

  it('sells packs that add a bonus, on a receipt rather than a GST invoice', async () => {
    const savePack = (body: object) => owner({ method: 'POST', url: '/v1/wallet/packs', payload: { outlet_id: outlet(), is_active: true, ...body } });
    expect((await savePack({ name: 'Too good', pay_paise: 100_000, bonus_paise: 200_000, validity_days: 365 })).json().error.code).toBe('invalid_pack');
    pack = ((await savePack({ name: 'Silver', pay_paise: 200_000, bonus_paise: 20_000, validity_days: 365 })).json() as WalletPackDTO[])[0]!;
    g = await guest();
    const res = await cashier({ method: 'POST', url: `/v1/customers/${g.id}/wallet/topups`, payload: { outlet_id: outlet(), pack_id: pack.id, method: 'upi', reference: '412300001111' } });
    expect(res.statusCode).toBe(201);
    const topup: WalletTopupDTO = res.json();
    expect(topup).toMatchObject({ paid_paise: 200_000, bonus_paise: 20_000, wallet: { paid_paise: 200_000, bonus_paise: 20_000 } });
    expect(topup.receipt_no).toMatch(/^TSTW\//);
    const payment = await t.ctx.adminDb.selectFrom('payments').selectAll().where('wallet_topup_id', '=', topup.id).executeTakeFirstOrThrow();
    expect(payment).toMatchObject({ bill_id: null, method: 'upi', amount_paise: 200_000 });
    expect((await wallet()).ledger[0]).toMatchObject({ kind: 'topup', paid_paise: 200_000, bonus_paise: 20_000, receipt_no: topup.receipt_no });

    // Not a sale; in the bank like one. The UPI check counts it (with its receipt) until a statement covers it.
    const today = new Date().toISOString().slice(0, 10);
    const check: UpiCheckDTO = (await owner({ method: 'GET', url: `/v1/reconciliation/upi-check?outlet_id=${outlet()}&to=${today}&days=1` })).json();
    expect(check.unchecked.amount_paise).toBeGreaterThanOrEqual(200_000);
  });

  it('needs proof the guest is there to spend it: a manager without SMS, a code with it', async () => {
    const bill = await visit(g.id, [paneer(2)]);
    const printed: BillDTO = (await cashier({ method: 'POST', url: `/v1/bills/${bill.id}/finalise` })).json();
    expect((await payWallet(bill.id, printed.total_paise)).json().error.code).toBe('approval_required');
    const paid = await payWallet(bill.id, printed.total_paise, {}, { 'x-approval-token': await approval('wallet.spend') });
    expect(paid.statusCode).toBe(201);
    expect((paid.json() as BillDTO).status).toBe('paid');
    // ₹525 split as the balance is: 1 part bonus to 10 parts paid.
    const after = await wallet();
    expect(after.paid_paise + after.bonus_paise).toBe(220_000 - printed.total_paise);
    expect(after.ledger[0]).toMatchObject({ kind: 'spend', paid_paise: -47_727, bonus_paise: -4_773, invoice_no: printed.invoice_no });

    t.ctx.otp = { send: async (phone, code) => void sent.push({ phone, code }) };
    try {
      const next = await visit(g.id, [paneer(1)]);
      const due: BillDTO = (await cashier({ method: 'POST', url: `/v1/bills/${next.id}/finalise` })).json();
      expect((await payWallet(next.id, due.total_paise)).json().error.code).toBe('wallet_code_required');
      expect((await cashier({ method: 'POST', url: `/v1/customers/${g.id}/wallet/code`, payload: { outlet_id: outlet() } })).json()).toEqual({ phone_last4: g.phone.slice(-4) });
      const verify = (code: string) => cashier({ method: 'POST', url: `/v1/customers/${g.id}/wallet/code/verify`, payload: { outlet_id: outlet(), code } });
      expect((await verify(sent.at(-1)!.code === '000000' ? '111111' : '000000')).json().error.code).toBe('wrong_code');
      const proof = (await verify(sent.at(-1)!.code)).json().proof as string;
      // A made-up proof is no proof.
      expect((await payWallet(next.id, due.total_paise, { wallet_proof: `${Date.now() + 60_000}.${'0'.repeat(64)}` })).json().error.code).toBe('wallet_code_required');
      expect((await payWallet(next.id, due.total_paise, { wallet_proof: proof })).statusCode).toBe(201);
    } finally {
      t.ctx.otp = null;
    }
  });

  it('puts refunds back in the wallet, refuses more than the balance, and gives paid money back on request', async () => {
    const bill = await visit(g.id, [paneer(1)]);
    const printed: BillDTO = (await cashier({ method: 'POST', url: `/v1/bills/${bill.id}/finalise` })).json();
    const before = await wallet();
    const paid: BillDTO = (await payWallet(bill.id, printed.total_paise, {}, { 'x-approval-token': await approval('wallet.spend') })).json();
    const refund = await cashier({ method: 'POST', url: `/v1/payments/${paid.payments[0]!.id}/refund`, payload: { amount_paise: printed.total_paise, reason: 'Wrong bill' }, headers: { 'x-approval-token': await approval('payment.refund') } });
    expect(refund.statusCode).toBe(200);
    const back = await wallet();
    expect(back).toMatchObject({ paid_paise: before.paid_paise, bonus_paise: before.bonus_paise });
    expect(back.ledger[0]!.kind).toBe('refund');

    const big = await visit(g.id, [paneer(10)]);
    const due: BillDTO = (await cashier({ method: 'POST', url: `/v1/bills/${big.id}/finalise` })).json();
    expect((await payWallet(big.id, due.total_paise, {}, { 'x-approval-token': await approval('wallet.spend') })).json().error.code).toBe('not_enough_wallet');

    // Half of what they paid in goes back in cash; half the bonus goes with it.
    const half = Math.floor(back.paid_paise / 2);
    const out = await cashier({ method: 'POST', url: `/v1/customers/${g.id}/wallet/cash-out`, payload: { outlet_id: outlet(), amount_paise: half, method: 'cash', reason: 'Moving away' }, headers: { 'x-approval-token': await approval('payment.refund') } });
    expect(out.statusCode).toBe(200);
    const left: WalletDTO = out.json();
    expect(left.paid_paise).toBe(back.paid_paise - half);
    expect(left.bonus_paise).toBe(back.bonus_paise - Math.round((back.bonus_paise * half) / back.paid_paise));
  });

  it('shows top-ups in the day end cash, apart from sales', async () => {
    await cashier({ method: 'POST', url: `/v1/customers/${g.id}/wallet/topups`, payload: { outlet_id: outlet(), amount_paise: 50_000, method: 'cash', tendered_paise: 50_000 } });
    const day = (await owner({ method: 'GET', url: `/v1/reports/day-end?outlet_id=${outlet()}` })).json();
    const topupCash = day.wallet_topups.find((p: { method: string }) => p.method === 'cash');
    const billCash = day.payments.find((p: { method: string }) => p.method === 'cash');
    // ₹500 paid in, less the cash given back from the wallet earlier.
    expect(topupCash.received_paise).toBe(50_000);
    expect(topupCash.refunded_paise).toBeGreaterThan(0);
    expect(day.expected_cash_paise).toBe(billCash.net_paise + topupCash.net_paise);
    expect(day.payments.map((p: { method: string }) => p.method)).toContain('wallet');
  });

  it('lapses a balance past its validity', async () => {
    await t.ctx.adminDb.updateTable('customers').set({ wallet_expires_at: new Date(Date.now() - 1000) }).where('id', '=', g.id).execute();
    const w = await wallet();
    expect(w).toMatchObject({ paid_paise: 0, bonus_paise: 0 });
    expect(w.ledger[0]!.kind).toBe('expire');
  });

  it('reports memberships sold and money in wallets', async () => {
    const r: LoyaltyReportDTO = (await owner({ method: 'GET', url: `/v1/reports/loyalty?outlet_id=${outlet()}` })).json();
    expect(r.memberships).toContainEqual(expect.objectContaining({ plan: "Diners' club", sold: 2, active: 1 }));
    expect(r.wallet).toMatchObject({ topped_up_paise: 250_000, bonus_given_paise: 20_000 });
    expect(r.wallet.spent_paise).toBeGreaterThan(0);
  });
});

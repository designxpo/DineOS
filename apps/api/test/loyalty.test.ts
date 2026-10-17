// Loyalty programmes: set up from a template or from scratch, stamps and points earned on paid
// bills, levels, happy hours, moments, and rewards used on bills.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BillDTO, BillLoyaltyDTO, CustomerDTO, LoyaltyReportDTO, OrderDTO } from '@mezmitra/shared/dto';
import { EMPTY_PROGRAM, PROGRAM_TEMPLATES, type LoyaltyConfig } from '@mezmitra/shared/loyalty';
import { businessDate } from '@mezmitra/shared/dates';
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

beforeAll(async () => {
  t = await startApp();
  tenant = await createTenant(t);
  menu = await createMenu(t, tenant);
  owner = api(t, tenant.ownerToken);
  cashier = api(t, (await addStaff(t, tenant, 'cashier')).token);
  waiter = api(t, (await addStaff(t, tenant, 'waiter')).token);
  manager = await addStaff(t, tenant, 'manager', { pin: '1357' });
  // Cold coffee (₹180, 5%) gets its own category for the stamp card.
  coffeeCat = (await t.ctx.adminDb.insertInto('menu_categories').values({ tenant_id: tenant.tenantId, outlet_id: tenant.outletId, name: 'Coffee' }).returning('id').executeTakeFirstOrThrow()).id;
  await t.ctx.adminDb.updateTable('menu_items').set({ category_id: coffeeCat }).where('id', '=', menu.coldCoffee).execute();
});
afterAll(() => t.close());

const outlet = () => tenant.outletId;
const coffee = (qty: number) => ({ item_id: menu.coldCoffee, qty, modifier_ids: [menu.regular] });
const paneer = (qty: number) => ({ item_id: menu.paneerTikka, qty });

const saveProgram = (status: string, config: LoyaltyConfig, as = owner) =>
  as({ method: 'PUT', url: '/v1/loyalty/program', payload: { outlet_id: outlet(), name: 'Test programme', template: null, status, config } });

async function guest(extra: Record<string, unknown> = {}): Promise<CustomerDTO> {
  const res = await cashier({ method: 'POST', url: '/v1/customers', payload: { outlet_id: outlet(), phone: `98111${String(++phoneNo).padStart(5, '0')}`, name: 'Guest', consent: true } });
  expect(res.statusCode).toBe(201);
  const c: CustomerDTO = res.json();
  if (Object.keys(extra).length) await t.ctx.adminDb.updateTable('customers').set(extra).where('id', '=', c.id).execute();
  return c;
}

/** A table's draft bill for these dishes, with the guest attached. */
async function visit(customerId: string, lines: object[]): Promise<BillDTO> {
  const tableId = await createTable(t, tenant, `Y${++tableNo}`);
  const order: OrderDTO = (await cashier({ method: 'POST', url: '/v1/orders', payload: { outlet_id: outlet(), type: 'dine_in', table_id: tableId, lines } })).json();
  const bill: BillDTO = (await cashier({ method: 'POST', url: '/v1/bills', payload: { table_session_id: order.table_session_id } })).json();
  const res = await cashier({ method: 'PATCH', url: `/v1/bills/${bill.id}`, payload: { customer_id: customerId } });
  expect(res.statusCode).toBe(200);
  return res.json();
}

async function pay(bill: BillDTO): Promise<BillDTO> {
  const printed: BillDTO = (await cashier({ method: 'POST', url: `/v1/bills/${bill.id}/finalise` })).json();
  if (printed.status === 'paid') return printed;
  const res = await cashier({ method: 'POST', url: `/v1/bills/${bill.id}/payments`, payload: { method: 'cash', amount_paise: printed.total_paise } });
  expect(res.statusCode).toBe(201);
  return res.json();
}

const card = async (billId: string): Promise<BillLoyaltyDTO> => (await cashier({ method: 'GET', url: `/v1/bills/${billId}/loyalty` })).json().loyalty;
const customer = async (id: string): Promise<CustomerDTO> => (await cashier({ method: 'GET', url: `/v1/customers/${id}?outlet_id=${outlet()}` })).json().customer;
const rewardRows = (customerId: string) => t.ctx.adminDb.selectFrom('customer_rewards').selectAll().where('customer_id', '=', customerId).orderBy('created_at').execute();

describe('setting up a programme', () => {
  it('keeps a half-built draft, and goes live only when it makes sense', async () => {
    expect((await owner({ method: 'GET', url: `/v1/loyalty/program?outlet_id=${outlet()}` })).json()).toEqual({ program: null });
    expect((await saveProgram('draft', EMPTY_PROGRAM, waiter)).statusCode).toBe(403);
    const draft = await saveProgram('draft', EMPTY_PROGRAM);
    expect(draft.statusCode).toBe(200);
    expect(draft.json()).toMatchObject({ status: 'draft', holders: { points_guests: 0 } });
    const live = await saveProgram('active', EMPTY_PROGRAM);
    expect(live.json().error).toMatchObject({ code: 'invalid_program', message: 'Give guests something: points, stamps or a moment' });

    const stampCard = PROGRAM_TEMPLATES.find((x) => x.key === 'stamp_card')!.config;
    const unknown = { ...stampCard, earn: { ...stampCard.earn, category_ids: ['00000000-0000-4000-8000-000000000000'] } } as LoyaltyConfig;
    expect((await saveProgram('active', unknown)).json().error.code).toBe('unknown_category');

    const cats = (await owner({ method: 'GET', url: `/v1/loyalty/categories?outlet_id=${outlet()}` })).json();
    expect(cats).toContainEqual(expect.objectContaining({ id: coffeeCat, name: 'Coffee' }));
  });
});

describe('stamp card', () => {
  it('stamps every coffee, fills the card, and gives a coffee free', async () => {
    const config: LoyaltyConfig = {
      ...EMPTY_PROGRAM,
      earn: { kind: 'stamps', per: 'item', category_ids: [coffeeCat], min_bill_paise: 0, goal: 3, reward: { kind: 'free_item', category_ids: [coffeeCat], max_value_paise: 25_000 } },
    };
    expect((await saveProgram('active', config)).statusCode).toBe(200);
    const g = await guest();

    await pay(await visit(g.id, [coffee(2), paneer(1)]));
    expect((await customer(g.id)).stamps).toBe(2);
    await pay(await visit(g.id, [coffee(2)]));
    // Four stamps: a full card of three, one towards the next.
    expect((await customer(g.id)).stamps).toBe(1);
    const [reward] = await rewardRows(g.id);
    expect(reward).toMatchObject({ source: 'stamps', status: 'available', label: 'Stamp card: a free item from Coffee (up to ₹250)' });

    const bill = await visit(g.id, [coffee(1), paneer(1)]);
    const l = await card(bill.id);
    expect(l.program).toMatchObject({ earn: 'stamps', stamp_goal: 3 });
    const coffeeLine = bill.lines.find((x) => x.name.startsWith('Cold Coffee'))!.order_item_id!;
    const paneerLine = bill.lines.find((x) => x.name === 'Paneer Tikka')!.order_item_id!;
    expect(l.eligible[reward!.id]).toEqual([coffeeLine]);

    const use = (orderItemId: string) => cashier({ method: 'POST', url: `/v1/bills/${bill.id}/rewards`, payload: { reward_id: reward!.id, order_item_id: orderItemId } });
    expect((await use(paneerLine)).json().error.code).toBe('item_not_eligible');
    const free: BillDTO = (await use(coffeeLine)).json();
    expect(free.lines.find((x) => x.order_item_id === coffeeLine)).toMatchObject({ comp_qty: 1, comps: [{ reason: 'loyalty' }] });
    expect(free.rewards.map((r) => r.label)).toEqual([reward!.label]);
    expect(free.total_paise).toBe(bill.total_paise - 18_900);

    // Taken back, the guest keeps the reward; given again, it is spent when the bill is paid.
    const back: BillDTO = (await cashier({ method: 'DELETE', url: `/v1/bills/${bill.id}/rewards/${reward!.id}` })).json();
    expect(back.total_paise).toBe(bill.total_paise);
    expect((await rewardRows(g.id))[0]).toMatchObject({ status: 'available', comp_id: null });
    await use(coffeeLine);
    await pay(bill);
    expect((await rewardRows(g.id))[0]).toMatchObject({ status: 'used', bill_id: bill.id });
    // A free coffee earns no stamp.
    expect((await customer(g.id)).stamps).toBe(1);
    const report = (await owner({ method: 'GET', url: `/v1/reports/comps?outlet_id=${outlet()}` })).json();
    expect(report.by_reason).toContainEqual(expect.objectContaining({ reason: 'loyalty', count: 1, value_paise: 18_000 }));
  });
});

describe('points, levels and happy hours', () => {
  it('earns faster at a higher level and in happy hours, with a monthly perk', async () => {
    const config: LoyaltyConfig = {
      ...EMPTY_PROGRAM,
      earn: { kind: 'points', earn_bp: 1000, point_value_paise: 100, min_redeem_points: 50 },
      levels: [
        { name: 'Member', min_visits: 0, min_spend_paise: 0, multiplier_bp: 10_000, perk: null },
        { name: 'Regular', min_visits: 0, min_spend_paise: 40_000, multiplier_bp: 20_000, perk: { kind: 'amount_off', paise: 5000 } },
      ],
    };
    expect((await saveProgram('active', config)).statusCode).toBe(200);
    const g = await guest();
    // ₹262.50 rounds to ₹263: 10% is 26 points.
    await pay(await visit(g.id, [paneer(1)]));
    expect(await customer(g.id)).toMatchObject({ points: 26, level: 'Member' });
    await pay(await visit(g.id, [paneer(1)]));
    expect(await customer(g.id)).toMatchObject({ points: 52, level: 'Regular' });
    expect((await rewardRows(g.id)).map((r) => [r.source, r.label])).toEqual([['level', 'Level perk: ₹50 off the bill']]);
    await pay(await visit(g.id, [paneer(1)]));
    expect((await customer(g.id)).points).toBe(52 + 52);

    expect((await saveProgram('active', { ...config, happy_hours: { days: [0, 1, 2, 3, 4, 5, 6], from: '00:00', to: '23:59', multiplier_bp: 20_000 } })).statusCode).toBe(200);
    const fourth = await pay(await visit(g.id, [paneer(1)]));
    expect(fourth.loyalty_points_earned).toBe(105);
    // The perk comes once a month, however often they visit.
    expect((await rewardRows(g.id)).filter((r) => r.source === 'level')).toHaveLength(1);
  });
});

describe('money off', () => {
  it('takes one money-off reward per bill, and gives it back when the bill is voided or loses its guest', async () => {
    const config: LoyaltyConfig = { ...EMPTY_PROGRAM, earn: { kind: 'points', earn_bp: 500, point_value_paise: 100, min_redeem_points: 10 } };
    await saveProgram('active', config);
    const g = await guest();
    const add = (reward: object) =>
      t.ctx.adminDb
        .insertInto('customer_rewards')
        .values({ tenant_id: tenant.tenantId, customer_id: g.id, source: 'comeback', label: 'Test', reward: JSON.stringify(reward) as never })
        .returning('id')
        .executeTakeFirstOrThrow();
    const fifty = (await add({ kind: 'amount_off', paise: 5000 })).id;
    const tenPct = (await add({ kind: 'percent_off', bp: 1000, max_paise: null })).id;

    const bill = await visit(g.id, [paneer(2)]);
    const use = (id: string, billId = bill.id) => cashier({ method: 'POST', url: `/v1/bills/${billId}/rewards`, payload: { reward_id: id } });
    const off: BillDTO = (await use(fifty)).json();
    expect(off).toMatchObject({ reward_discount_paise: 5000, loyalty_discount_paise: 5000 });
    // ₹500 − ₹50 = ₹450 taxable, ₹472.50, rounded.
    expect(off.total_paise).toBe(47_300);
    expect((await use(tenPct)).json().error.code).toBe('one_reward');

    // Another guest on the bill: the first guest keeps the reward.
    await cashier({ method: 'PATCH', url: `/v1/bills/${bill.id}`, payload: { customer_id: null } });
    expect((await rewardRows(g.id)).find((r) => r.id === fifty)).toMatchObject({ status: 'available', bill_id: null });

    await cashier({ method: 'PATCH', url: `/v1/bills/${bill.id}`, payload: { customer_id: g.id } });
    await use(tenPct);
    const printed: BillDTO = (await cashier({ method: 'POST', url: `/v1/bills/${bill.id}/finalise` })).json();
    expect(printed.reward_discount_paise).toBe(5000);
    // Reports count reward money off as a discount on that invoice, so the totals add up.
    const day = (await owner({ method: 'GET', url: `/v1/reports/day-end?outlet_id=${outlet()}` })).json();
    expect(day.discounts.find((d: { invoice_no: string }) => d.invoice_no === printed.invoice_no)).toMatchObject({ discount_paise: 5000, reason: 'Loyalty or membership' });
    const sales = (await owner({ method: 'GET', url: `/v1/reports/sales?outlet_id=${outlet()}` })).json();
    expect(sales.totals.loyalty_discount_paise).toBeGreaterThanOrEqual(5000);
    const t0 = sales.totals;
    // Prices here exclude GST: gross, less free dishes and discounts, plus service charge, is the taxable value.
    expect(t0.gross_paise - t0.complimentary_paise - t0.discount_paise + t0.service_charge_paise).toBe(t0.taxable_paise);
    expect((await rewardRows(g.id)).find((r) => r.id === tenPct)).toMatchObject({ status: 'used' });
    const approval = (await cashier({ method: 'POST', url: '/v1/approvals', payload: { outlet_id: outlet(), action: 'bill.void', login: manager.login, pin: '1357' } })).json().approval_token;
    const voided = await cashier({ method: 'POST', url: `/v1/bills/${bill.id}/void`, payload: { reason: 'Wrong table' }, headers: { 'x-approval-token': approval } });
    expect(voided.statusCode).toBe(200);
    expect((await rewardRows(g.id)).find((r) => r.id === tenPct)).toMatchObject({ status: 'available', bill_id: null, used_at: null });

    // Discarding a draft gives it back too.
    const again = await visit(g.id, [paneer(1)]);
    await use(tenPct, again.id);
    expect((await cashier({ method: 'DELETE', url: `/v1/bills/${again.id}` })).statusCode).toBe(204);
    expect((await rewardRows(g.id)).find((r) => r.id === tenPct)).toMatchObject({ status: 'available', bill_id: null });
  });
});

describe('moments', () => {
  const config: LoyaltyConfig = {
    ...EMPTY_PROGRAM,
    welcome: { kind: 'amount_off', paise: 10_000 },
    birthday: { reward: { kind: 'free_item', category_ids: [], max_value_paise: 30_000 }, days: 3 },
    comeback: { after_days: 30, reward: { kind: 'percent_off', bp: 1000, max_paise: 30_000 } },
  };

  it('welcomes a first-time guest for next time, and finds birthdays and comebacks when they turn up', async () => {
    expect((await saveProgram('active', config)).statusCode).toBe(200);
    const newcomer = await guest();
    const first = await visit(newcomer.id, [paneer(1)]);
    expect((await card(first.id)).rewards).toEqual([]);
    await pay(first);
    const [welcome] = await rewardRows(newcomer.id);
    expect(welcome).toMatchObject({ source: 'welcome', label: 'Welcome gift: ₹100 off the bill' });
    // Not on the bill it was earned on, nor straight after.
    expect(welcome!.valid_from.getTime()).toBeGreaterThan(Date.now() + 2 * 3600_000);

    const today = businessDate(new Date(), 'Asia/Kolkata');
    const birthday = await guest({ birthday: `1990-${today.slice(5)}` });
    const b = await visit(birthday.id, [paneer(1)]);
    expect((await card(b.id)).rewards.map((r) => r.source)).toEqual(['birthday']);
    expect((await card(b.id)).eligible[(await card(b.id)).rewards[0]!.id]).toHaveLength(1);

    await t.ctx.adminDb.updateTable('customers').set({ last_visit_at: new Date(Date.now() - 40 * 86_400_000) }).where('id', '=', newcomer.id).execute();
    const back = await visit(newcomer.id, [paneer(1)]);
    expect((await card(back.id)).rewards.map((r) => r.label)).toContain('Welcome back: 10% off the bill (up to ₹300)');
    await visit(newcomer.id, [paneer(1)]);
    expect((await rewardRows(newcomer.id)).filter((r) => r.source === 'comeback')).toHaveLength(1);
  });

  it('lets points lapse after a long absence', async () => {
    await saveProgram('active', { ...EMPTY_PROGRAM, earn: { kind: 'points', earn_bp: 1000, point_value_paise: 100, min_redeem_points: 10 }, expiry_days: 30 });
    const g = await guest();
    await pay(await visit(g.id, [paneer(1)]));
    expect((await customer(g.id)).points).toBe(26);
    await t.ctx.adminDb.updateTable('customers').set({ last_visit_at: new Date(Date.now() - 31 * 86_400_000) }).where('id', '=', g.id).execute();
    await visit(g.id, [paneer(1)]);
    expect((await customer(g.id)).points).toBe(0);
    const lapsed = await t.ctx.adminDb.selectFrom('loyalty_ledger').select(['kind', 'points']).where('customer_id', '=', g.id).where('kind', '=', 'expire').execute();
    expect(lapsed).toEqual([{ kind: 'expire', points: -26 }]);
  });
});

describe('the report', () => {
  it('shows members, points owed and what rewards cost', async () => {
    // One guest's first bill was yesterday: they came back.
    const first = await t.ctx.adminDb.selectFrom('bills').select(['id', 'invoice_date']).where('tenant_id', '=', tenant.tenantId).where('status', '=', 'paid').orderBy('paid_at').limit(1).executeTakeFirstOrThrow();
    const yesterday = new Date(Date.parse(`${first.invoice_date}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    await t.ctx.adminDb.updateTable('bills').set({ invoice_date: yesterday }).where('id', '=', first.id).execute();
    const r: LoyaltyReportDTO = (await owner({ method: 'GET', url: `/v1/reports/loyalty?outlet_id=${outlet()}&from=${yesterday}&to=${first.invoice_date}` })).json();
    expect(r.members).toMatchObject({ visited: 4, repeat: 1 });
    expect(r.member_bill_share_bp).toBe(10_000);
    expect(r.points.outstanding_paise).toBe(r.points.outstanding * 100);
    expect(r.rewards).toContainEqual(expect.objectContaining({ source: 'stamps', issued: 1, used: 1, value_paise: 18_000 }));
    expect(r.levels).toContainEqual({ name: 'Regular', guests: 1 });
  });
});

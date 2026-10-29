// Self-serve plan upgrades paid with Razorpay: what the owner sees, what is charged, and that the
// plan changes only on a payment our server has checked (never on what the browser says alone).

import { createHmac, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PlanCheckoutDTO, PlansPageDTO } from '@mezmitra/shared/dto';
import { addStaff, api, createTenant, startApp, type TestApp, type TestTenant } from './helpers';

const KEY_ID = 'rzp_test_key';
const KEY_SECRET = 'rzp_test_secret_0123456789';
const WEBHOOK_SECRET = 'rzp_webhook_secret_0123456789';

/** A stand-in for Razorpay's REST API: orders, payment lookups and captures. */
const orders = new Map<string, { id: string; amount: number; receipt: string; notes: Record<string, string> }>();
const payments = new Map<string, { id: string; order_id: string; amount: number; currency: string; status: string }>();
const captures: string[] = [];
let razorpay: Server;
let t: TestApp;
/** Logins are limited to 10 a minute, so tests share tenants where they can. */
let standard: TestTenant;

beforeAll(async () => {
  razorpay = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      const auth = Buffer.from(String(req.headers.authorization ?? '').replace('Basic ', ''), 'base64').toString();
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (auth !== `${KEY_ID}:${KEY_SECRET}`) return send(401, { error: { description: 'bad key' } });
      const body = raw ? JSON.parse(raw) : {};
      if (req.method === 'POST' && req.url === '/orders') {
        const order = { id: `order_${randomBytes(7).toString('hex')}`, amount: body.amount, receipt: body.receipt, notes: body.notes, currency: 'INR', status: 'created' };
        orders.set(order.id, order);
        return send(200, order);
      }
      const capture = /^\/payments\/([\w]+)\/capture$/.exec(req.url ?? '');
      if (req.method === 'POST' && capture) {
        const p = payments.get(capture[1]!)!;
        p.status = 'captured';
        captures.push(p.id);
        return send(200, p);
      }
      const get = /^\/payments\/([\w]+)$/.exec(req.url ?? '');
      if (req.method === 'GET' && get) return payments.has(get[1]!) ? send(200, payments.get(get[1]!)) : send(400, { error: { description: 'no such payment' } });
      send(404, {});
    });
  });
  await new Promise<void>((resolve) => razorpay.listen(0, '127.0.0.1', resolve));
  t = await startApp({
    RAZORPAY_KEY_ID: KEY_ID,
    RAZORPAY_KEY_SECRET: KEY_SECRET,
    RAZORPAY_WEBHOOK_SECRET: WEBHOOK_SECRET,
    RAZORPAY_API_URL: `http://127.0.0.1:${(razorpay.address() as AddressInfo).port}`,
  });
  standard = await createTenant(t, { plan: 'standard' });
});
afterAll(async () => {
  await t.close();
  await new Promise<void>((resolve) => razorpay.close(() => resolve()));
});

const sign = (orderId: string, paymentId: string) => createHmac('sha256', KEY_SECRET).update(`${orderId}|${paymentId}`).digest('hex');
const pay = (orderId: string, amount: number, status = 'captured') => {
  const id = `pay_${randomBytes(7).toString('hex')}`;
  payments.set(id, { id, order_id: orderId, amount, currency: 'INR', status });
  return id;
};
const page = async (tenant: TestTenant): Promise<PlansPageDTO> => (await api(t, tenant.ownerToken)({ method: 'GET', url: '/v1/plans' })).json();
const checkout = (tenant: TestTenant, plan: string) => api(t, tenant.ownerToken)({ method: 'POST', url: '/v1/plan/checkout', payload: { plan_code: plan } });
const confirm = (tenant: TestTenant, orderId: string, paymentId: string, signature = sign(orderId, paymentId)) =>
  api(t, tenant.ownerToken)({ method: 'POST', url: '/v1/plan/confirm', payload: { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature } });
const invoices = (tenant: TestTenant) => t.ctx.adminDb.selectFrom('platform_invoices').selectAll().where('tenant_id', '=', tenant.tenantId).execute();
const planOf = async (tenant: TestTenant) => (await t.ctx.adminDb.selectFrom('tenants').select('plan_code').where('id', '=', tenant.tenantId).executeTakeFirstOrThrow()).plan_code;

describe('the plans page', () => {
  it('shows each plan with what it includes and what upgrading costs', async () => {
    const p = await page(standard);
    expect(p.online_payment).toBe(true);
    expect(p.current).toMatchObject({ code: 'standard', features: { max_outlets: 1, max_tables: 40, white_label: true, talko_link: false }, usage: { outlets: 1, tables: 0 } });
    // Other test files add plans to the same database, so check for these rather than an exact list.
    expect(p.plans.map((x) => x.code)).toEqual(expect.arrayContaining(['standard', 'premium']));
    expect(p.plans.map((x) => x.code)).not.toContain('trial'); // the free trial is not offered
    expect(p.plans.find((x) => x.code === 'standard')).toMatchObject({ current: true, upgrade: null });
    expect(p.plans.find((x) => x.code === 'premium')?.upgrade).toMatchObject({ amount_paise: 299900, credit_paise: 0 });
  });

  it('is for the owner only', async () => {
    const manager = await addStaff(t, standard, 'manager', { outletId: null });
    expect((await api(t, manager.token)({ method: 'GET', url: '/v1/plans' })).statusCode).toBe(403);
    expect((await api(t, manager.token)({ method: 'POST', url: '/v1/plan/checkout', payload: { plan_code: 'premium' } })).statusCode).toBe(403);
  });

  it('credits the unused days of a paid period', async () => {
    const tenant = await createTenant(t, { plan: 'standard' });
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
    const start = new Date(Date.parse(`${today}T00:00:00Z`) - 5 * 86_400_000).toISOString().slice(0, 10);
    const end = new Date(Date.parse(`${today}T00:00:00Z`) + 24 * 86_400_000).toISOString().slice(0, 10);
    // The period every new restaurant starts with, paid for.
    const sub = await t.ctx.adminDb
      .updateTable('subscriptions')
      .set({ period_start: start, period_end: end })
      .where('tenant_id', '=', tenant.tenantId)
      .returning('id')
      .executeTakeFirstOrThrow();
    await t.ctx.adminDb
      .insertInto('platform_invoices')
      .values({ tenant_id: tenant.tenantId, subscription_id: sub.id, number: `TEST/${randomBytes(4).toString('hex')}`, amount_paise: 149900, period_start: start, period_end: end, status: 'paid', paid_at: new Date() })
      .execute();
    const premium = (await page(tenant)).plans.find((x) => x.code === 'premium')!;
    // 30-day period, 24 days left after today.
    expect(premium.upgrade!.credit_paise).toBe(Math.floor((149900 * 24) / 30));
    expect(premium.upgrade!.amount_paise).toBe(299900 - premium.upgrade!.credit_paise);
  });
});

describe('paying for an upgrade', () => {
  it('charges our own price and refuses anything that is not an upgrade', async () => {
    const tenant = standard;
    const res = await checkout(tenant, 'premium');
    expect(res.statusCode).toBe(200);
    const c: PlanCheckoutDTO = res.json();
    expect(c).toMatchObject({ key_id: KEY_ID, amount_paise: 299900, currency: 'INR', plan_name: 'Premium' });
    expect(orders.get(c.order_id)).toMatchObject({ amount: 299900, notes: { product: 'mezmitra', tenant_id: tenant.tenantId, plan_code: 'premium' } });
    // A second tap reuses the order rather than making another.
    expect((await checkout(tenant, 'premium')).json().order_id).toBe(c.order_id);
    expect((await checkout(tenant, 'standard')).json().error.code).toBe('not_an_upgrade');
    expect((await checkout(tenant, 'trial')).statusCode).toBe(404);
    expect((await checkout(tenant, 'nope')).statusCode).toBe(404);
  });

  it('changes the plan only for a verified, captured payment of the exact amount', async () => {
    const tenant = await createTenant(t, { plan: 'standard' });
    const c: PlanCheckoutDTO = (await checkout(tenant, 'premium')).json();

    const forged = pay(c.order_id, 299900);
    expect((await confirm(tenant, c.order_id, forged, 'f'.repeat(64))).json().error.code).toBe('payment_unverified');
    const short = pay(c.order_id, 100);
    expect((await confirm(tenant, c.order_id, short)).json().error.code).toBe('payment_mismatch');
    const pending = pay(c.order_id, 299900, 'created');
    expect((await confirm(tenant, c.order_id, pending)).json().error.code).toBe('payment_pending');
    expect(await planOf(tenant)).toBe('standard');

    // Authorized but not captured: we capture it, then upgrade.
    const real = pay(c.order_id, 299900, 'authorized');
    const done = await confirm(tenant, c.order_id, real);
    expect(done.statusCode).toBe(200);
    expect(captures).toContain(real);
    expect((done.json() as PlansPageDTO).current.code).toBe('premium');
    expect(await planOf(tenant)).toBe('premium');
    const [inv] = await invoices(tenant);
    expect(inv).toMatchObject({ amount_paise: 299900, status: 'paid', paid_reference: `Razorpay ${real}` });
    const subs = await t.ctx.adminDb.selectFrom('subscriptions').select(['plan_code', 'status']).where('tenant_id', '=', tenant.tenantId).orderBy('created_at').execute();
    expect(subs).toEqual([
      { plan_code: 'standard', status: 'replaced' },
      { plan_code: 'premium', status: 'active' },
    ]);
    const audit = await t.ctx.adminDb.selectFrom('audit_log').select(['action', 'actor_user_id']).where('tenant_id', '=', tenant.tenantId).where('action', '=', 'plan.upgrade').execute();
    expect(audit).toEqual([{ action: 'plan.upgrade', actor_user_id: tenant.ownerId }]);

    // Sent again: nothing changes twice.
    expect((await confirm(tenant, c.order_id, real)).statusCode).toBe(200);
    expect(await invoices(tenant)).toHaveLength(1);
  });

  it("never applies another restaurant's payment", async () => {
    const a = await createTenant(t, { plan: 'standard' });
    const b = standard;
    const c: PlanCheckoutDTO = (await checkout(a, 'premium')).json();
    const paid = pay(c.order_id, 299900);
    expect((await confirm(b, c.order_id, paid)).statusCode).toBe(404);
    expect(await planOf(a)).toBe('standard');
    expect(await planOf(b)).toBe('standard');
  });

  it('applies a payment from the webhook when the browser closed, once, and only when signed', async () => {
    const tenant = await createTenant(t, { plan: 'standard' });
    const c: PlanCheckoutDTO = (await checkout(tenant, 'premium')).json();
    const paymentId = pay(c.order_id, 299900);
    const body = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: paymentId, order_id: c.order_id, amount: 299900, currency: 'INR', status: 'captured' } } } });
    const hook = (signature: string) =>
      t.app.inject({ method: 'POST', url: '/v1/plan/razorpay/webhook', headers: { 'content-type': 'application/json', 'x-razorpay-signature': signature }, payload: body });
    expect((await hook('0'.repeat(64))).statusCode).toBe(401);
    expect(await planOf(tenant)).toBe('standard');
    const good = createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex');
    expect((await hook(good)).statusCode).toBe(200);
    expect((await hook(good)).statusCode).toBe(200);
    expect(await planOf(tenant)).toBe('premium');
    expect(await invoices(tenant)).toHaveLength(1);
    // The browser's late callback is fine too.
    expect((await confirm(tenant, c.order_id, paymentId)).statusCode).toBe(200);
    expect(await invoices(tenant)).toHaveLength(1);
  });

  it('ignores webhook events for payments that are not ours', async () => {
    const body = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_other', order_id: 'order_from_another_product', amount: 100, currency: 'INR', status: 'captured' } } } });
    const res = await t.app.inject({
      method: 'POST',
      url: '/v1/plan/razorpay/webhook',
      headers: { 'content-type': 'application/json', 'x-razorpay-signature': createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex') },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
  });

  it('turns on what the new plan includes', async () => {
    const tenant = await createTenant(t, { plan: 'standard' });
    const before = (await api(t, tenant.ownerToken)({ method: 'GET', url: '/v1/integrations/talko' })).json();
    expect(before.plan_allows).toBe(false);
    const c: PlanCheckoutDTO = (await checkout(tenant, 'premium')).json();
    await confirm(tenant, c.order_id, pay(c.order_id, 299900));
    const after = (await api(t, tenant.ownerToken)({ method: 'GET', url: '/v1/integrations/talko' })).json();
    expect(after.plan_allows).toBe(true);
  });
});

describe('plan limits', () => {
  it("refuses tables beyond the plan's limit, and allows them after an upgrade", async () => {
    const tenant = await createTenant(t, { plan: 'standard' });
    const owner = api(t, tenant.ownerToken);
    expect((await owner({ method: 'POST', url: '/v1/tables/bulk', payload: { outlet_id: tenant.outletId, prefix: 'T', from: 1, to: 40 } })).statusCode).toBe(201);
    const over = await owner({ method: 'POST', url: '/v1/tables', payload: { outlet_id: tenant.outletId, label: 'T41' } });
    expect(over.statusCode).toBe(409);
    expect(over.json().error.code).toBe('plan_limit');
    const c: PlanCheckoutDTO = (await checkout(tenant, 'premium')).json();
    await confirm(tenant, c.order_id, pay(c.order_id, 299900));
    expect((await owner({ method: 'POST', url: '/v1/tables', payload: { outlet_id: tenant.outletId, label: 'T41' } })).statusCode).toBe(201);
  });

  it('says online payment is not set up when Razorpay is not configured', async () => {
    const plain = await startApp();
    try {
      const tenant = await createTenant(plain, { plan: 'standard' });
      const p: PlansPageDTO = (await api(plain, tenant.ownerToken)({ method: 'GET', url: '/v1/plans' })).json();
      expect(p.online_payment).toBe(false);
      const res = await api(plain, tenant.ownerToken)({ method: 'POST', url: '/v1/plan/checkout', payload: { plan_code: 'premium' } });
      expect(res.json().error.code).toBe('not_configured');
      expect((await plain.app.inject({ method: 'POST', url: '/v1/plan/razorpay/webhook', payload: {} })).statusCode).toBe(404);
    } finally {
      await plain.close();
    }
  });
});

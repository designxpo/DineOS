import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clearAuthCache } from '../src/lib/auth';
import { hashSecret } from '../src/lib/crypto';
import { api, createTable, createTenant, startApp, type TestApp } from './helpers';

let t: TestApp;
let admin: ReturnType<typeof api>;

beforeAll(async () => {
  t = await startApp();
  const email = `ops-${randomUUID().slice(0, 6)}@mezmitra.test`;
  await t.ctx.adminDb.insertInto('platform_admins').values({ name: 'Ops', email, password_hash: await hashSecret('admin-password-1') }).execute();
  const res = await t.app.inject({ method: 'POST', url: '/v1/admin/auth/login', payload: { email, password: 'admin-password-1' } });
  expect(res.statusCode).toBe(200);
  admin = api(t, res.json().token);
});
afterAll(() => t.close());

describe('platform admin', () => {
  it('refuses staff tokens on admin routes and admin tokens on tenant routes', async () => {
    const tenant = await createTenant(t);
    expect((await api(t, tenant.ownerToken)({ method: 'GET', url: '/v1/admin/tenants' })).statusCode).toBe(401);
    expect((await admin({ method: 'GET', url: `/v1/menu?outlet_id=${tenant.outletId}` })).statusCode).toBe(401);
  });

  it('provisions a hotel restaurant tenant whose owner can sign in', async () => {
    const slug = `hotel-${randomUUID().slice(0, 6)}`;
    const res = await admin({
      method: 'POST',
      url: '/v1/admin/tenants',
      payload: {
        name: 'Aurum Grand Hotels',
        slug,
        plan_code: 'trial',
        owner: { name: 'Meera Rao', email: `meera@${slug}.test`, password: 'courtyard-owner' },
        outlet: { name: 'The Courtyard', invoice_prefix: 'AURM', gstin: '29AABCA1234D1Z5', state_code: '29' },
      },
    });
    expect(res.statusCode).toBe(201);
    const login = await t.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { tenant_slug: slug, login: `meera@${slug}.test`, password: 'courtyard-owner' } });
    expect(login.statusCode).toBe(200);
    const dup = await admin({ method: 'POST', url: '/v1/admin/tenants', payload: { name: 'x', slug, plan_code: 'trial', owner: { name: 'x', email: 'x@x.test', password: 'password1' }, outlet: { name: 'x' } } });
    expect(dup.statusCode).toBe(409);
    const list = (await admin({ method: 'GET', url: `/v1/admin/tenants?q=${slug}` })).json();
    expect(list[0]).toMatchObject({ slug, plan_code: 'trial', outlets: 1 });
  });

  it('suspends a tenant: staff are blocked and guests cannot order; reactivating restores both', async () => {
    const tenant = await createTenant(t);
    const tableId = await createTable(t, tenant, 'S1');
    const qr = new URL((await api(t, tenant.ownerToken)({ method: 'GET', url: `/v1/tables/${tableId}/qr` })).json().url).pathname.split('/').pop()!;

    expect((await admin({ method: 'PATCH', url: `/v1/admin/tenants/${tenant.tenantId}`, payload: { status: 'suspended' } })).statusCode).toBe(400);
    const res = await admin({ method: 'PATCH', url: `/v1/admin/tenants/${tenant.tenantId}`, payload: { status: 'suspended', reason: 'Invoice DOS/2627/00004 unpaid for 45 days' } });
    expect(res.json().status).toBe('suspended');
    clearAuthCache();
    expect((await api(t, tenant.ownerToken)({ method: 'GET', url: '/v1/auth/me' })).json().error.code).toBe('tenant_suspended');
    expect((await t.app.inject({ method: 'POST', url: '/v1/guest/join', payload: { qr_token: qr } })).statusCode).toBe(403);

    await admin({ method: 'PATCH', url: `/v1/admin/tenants/${tenant.tenantId}`, payload: { status: 'active', reason: 'Paid' } });
    clearAuthCache();
    expect((await api(t, tenant.ownerToken)({ method: 'GET', url: '/v1/auth/me' })).statusCode).toBe(200);
    const audit = await t.ctx.adminDb.selectFrom('audit_log').select(['action', 'actor_admin_id', 'reason']).where('tenant_id', '=', tenant.tenantId).where('action', '=', 'tenant.update').execute();
    expect(audit).toHaveLength(2);
    expect(audit[0]!.actor_admin_id).not.toBeNull();
  });

  it('impersonates with a mandatory reason, a time limit and an audit trail', async () => {
    const tenant = await createTenant(t);
    expect((await admin({ method: 'POST', url: `/v1/admin/tenants/${tenant.tenantId}/impersonate`, payload: {} })).statusCode).toBe(400);
    const res = await admin({ method: 'POST', url: `/v1/admin/tenants/${tenant.tenantId}/impersonate`, payload: { reason: 'Owner asked for help setting up GST' } });
    expect(res.statusCode).toBe(200);
    const { token, expires_at } = res.json();
    expect(new Date(expires_at).getTime() - Date.now()).toBeLessThanOrEqual(60 * 60_000);
    const me = (await api(t, token)({ method: 'GET', url: '/v1/auth/me' })).json();
    expect(me.impersonated_by).not.toBeNull();

    // Changes made while impersonating are attributed to the admin.
    await api(t, token)({ method: 'PATCH', url: `/v1/outlets/${tenant.outletId}`, payload: { fssai_no: '12345678901234' } });
    const rows = await t.ctx.adminDb.selectFrom('audit_log').select(['action', 'actor_admin_id']).where('tenant_id', '=', tenant.tenantId).execute();
    expect(rows.find((r) => r.action === 'support.impersonate')?.actor_admin_id).not.toBeNull();
    expect(rows.find((r) => r.action === 'outlet.update')?.actor_admin_id).not.toBeNull();
  });

  it('issues gap-free subscription invoices and records manual payment', async () => {
    const tenant = await createTenant(t);
    const make = () =>
      admin({ method: 'POST', url: '/v1/admin/invoices', payload: { tenant_id: tenant.tenantId, period_start: '2026-10-01', period_end: '2026-10-31' } });
    const a = (await make()).json();
    const b = (await make()).json();
    expect(a.amount_paise).toBe(149900);
    const seq = (n: string) => Number(n.split('/').pop());
    expect(seq(b.number)).toBe(seq(a.number) + 1);
    const paid = await admin({ method: 'POST', url: `/v1/admin/invoices/${a.id}/mark-paid`, payload: { reference: 'UPI UTR 300123456789' } });
    expect(paid.json()).toMatchObject({ status: 'paid', paid_reference: 'UPI UTR 300123456789' });
    expect((await admin({ method: 'POST', url: `/v1/admin/invoices/${a.id}/mark-paid`, payload: { reference: 'again' } })).statusCode).toBe(409);
    // The tenant's owner sees their invoices.
    const sub = (await api(t, tenant.ownerToken)({ method: 'GET', url: '/v1/subscription' })).json();
    expect(sub.invoices.map((i: { number: string }) => i.number)).toContain(a.number);
  });

  it('reports monthly usage across tenants', async () => {
    const res = await admin({ method: 'GET', url: '/v1/admin/usage' });
    expect(res.statusCode).toBe(200);
    expect(res.json().tenants.length).toBeGreaterThan(0);
    expect(res.json().tenants[0]).toHaveProperty('gmv_paise');
  });

  it('manages plans', async () => {
    const code = `p${randomUUID().slice(0, 6).replace(/-/g, '')}`;
    const res = await admin({ method: 'POST', url: '/v1/admin/plans', payload: { code, name: 'Chain', price_paise: 999900, features: { max_outlets: 20 } } });
    expect(res.statusCode).toBe(201);
    const up = await admin({ method: 'PATCH', url: `/v1/admin/plans/${code}`, payload: { price_paise: 899900 } });
    expect(up.json().price_paise).toBe(899900);
  });
});

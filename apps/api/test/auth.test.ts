import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clearAuthCache } from '../src/lib/auth';
import { addStaff, api, createTenant, startApp, type TestApp, type TestTenant } from './helpers';

let t: TestApp;
let tenant: TestTenant;

beforeAll(async () => {
  t = await startApp();
  tenant = await createTenant(t);
});
afterAll(() => t.close());

describe('auth', () => {
  it('logs in with restaurant code, email and password and returns the profile', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { tenant_slug: tenant.slug, login: tenant.ownerLogin, password: tenant.password },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.token).toMatch(/^st_/);
    expect(body.me.tenant.slug).toBe(tenant.slug);
    expect(body.me.tenant_roles).toEqual(['owner']);
    expect(body.me.outlets).toHaveLength(1);
    expect(body.me.outlets[0].roles).toContain('owner');
  });

  it('gives the same error for a wrong slug, login or password', async () => {
    for (const payload of [
      { tenant_slug: 'no-such-place', login: tenant.ownerLogin, password: tenant.password },
      { tenant_slug: tenant.slug, login: 'nobody@x.test', password: tenant.password },
      { tenant_slug: tenant.slug, login: tenant.ownerLogin, password: 'wrong' },
    ]) {
      const res = await t.app.inject({ method: 'POST', url: '/v1/auth/login', payload });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('invalid_credentials');
    }
  });

  it('rejects requests without a valid token', async () => {
    expect((await api(t, null)({ method: 'GET', url: '/v1/auth/me' })).statusCode).toBe(401);
    expect((await api(t, 'st_bogus')({ method: 'GET', url: '/v1/auth/me' })).statusCode).toBe(401);
  });

  it('revokes the session on logout', async () => {
    const waiter = await addStaff(t, tenant, 'waiter');
    const call = api(t, waiter.token);
    expect((await call({ method: 'GET', url: '/v1/auth/me' })).statusCode).toBe(200);
    expect((await call({ method: 'POST', url: '/v1/auth/logout' })).statusCode).toBe(204);
    expect((await call({ method: 'GET', url: '/v1/auth/me' })).statusCode).toBe(401);
  });

  it('blocks staff of a suspended tenant', async () => {
    const other = await createTenant(t);
    await t.ctx.adminDb.updateTable('tenants').set({ status: 'suspended' }).where('id', '=', other.tenantId).execute();
    clearAuthCache();
    const res = await api(t, other.ownerToken)({ method: 'GET', url: '/v1/auth/me' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('tenant_suspended');
  });

  it('issues a single-use manager approval from a PIN', async () => {
    const manager = await addStaff(t, tenant, 'manager', { pin: '4321' });
    const cashier = await addStaff(t, tenant, 'cashier');
    const call = api(t, cashier.token);
    const bad = await call({
      method: 'POST',
      url: '/v1/approvals',
      payload: { outlet_id: tenant.outletId, action: 'bill.void', login: manager.login, pin: '0000' },
    });
    expect(bad.statusCode).toBe(403);
    const ok = await call({
      method: 'POST',
      url: '/v1/approvals',
      payload: { outlet_id: tenant.outletId, action: 'bill.void', login: manager.login, pin: '4321' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().approval_token).toMatch(/^ap_/);
    const waiterApprover = await addStaff(t, tenant, 'waiter', { pin: '1111' });
    const denied = await call({
      method: 'POST',
      url: '/v1/approvals',
      payload: { outlet_id: tenant.outletId, action: 'bill.void', login: waiterApprover.login, pin: '1111' },
    });
    expect(denied.statusCode).toBe(403);
  });
});

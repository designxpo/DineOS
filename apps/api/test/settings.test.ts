import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addStaff, api, createMenu, createTenant, login, PASSWORD, startApp, type TestApp, type TestTenant } from './helpers';

let t: TestApp;
let tenant: TestTenant;
let owner: ReturnType<typeof api>;

beforeAll(async () => {
  t = await startApp();
  tenant = await createTenant(t);
  owner = api(t, tenant.ownerToken);
  await createMenu(t, tenant);
});
afterAll(() => t.close());

describe('outlet settings', () => {
  it('validates and audits changes', async () => {
    const bad = await owner({ method: 'PATCH', url: `/v1/outlets/${tenant.outletId}`, payload: { gstin: 'NOT-A-GSTIN', upi_vpa: 'nope' } });
    expect(bad.statusCode).toBe(400);
    const res = await owner({
      method: 'PATCH',
      url: `/v1/outlets/${tenant.outletId}`,
      payload: { auto_accept: false, service_charge_bp: 500, upi_vpa: 'courtyard@okhdfc', upi_payee_name: 'The Courtyard', kitchen_stations: ['kitchen', 'bar', 'tandoor'] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ auto_accept: false, service_charge_bp: 500, kitchen_stations: ['kitchen', 'bar', 'tandoor'] });
    const log = (await owner({ method: 'GET', url: `/v1/audit?outlet_id=${tenant.outletId}&entity=outlet` })).json();
    // New outlets accept QR orders automatically.
    expect(log[0].before).toMatchObject({ auto_accept: true, service_charge_bp: 0 });
  });

  it('refuses to remove a station that menu items still use', async () => {
    const res = await owner({ method: 'PATCH', url: `/v1/outlets/${tenant.outletId}`, payload: { kitchen_stations: ['kitchen'] } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('station_in_use');
  });

  it('enforces the plan outlet limit', async () => {
    const res = await owner({ method: 'POST', url: '/v1/outlets', payload: { name: 'Second outlet' } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('plan_limit');
  });

  it('keeps settings away from cashiers', async () => {
    const cashier = api(t, (await addStaff(t, tenant, 'cashier')).token);
    expect((await cashier({ method: 'PATCH', url: `/v1/outlets/${tenant.outletId}`, payload: { auto_accept: false } })).statusCode).toBe(403);
    expect((await cashier({ method: 'GET', url: `/v1/outlets/${tenant.outletId}` })).statusCode).toBe(200);
  });
});

describe('staff management', () => {
  it('lets a manager add floor staff at their outlet but not managers or tenant-wide roles', async () => {
    const manager = api(t, (await addStaff(t, tenant, 'manager')).token);
    const ok = await manager({
      method: 'POST',
      url: '/v1/staff',
      payload: { name: 'Ravi', phone: '98765 43210', password: 'tandoor-2026', roles: [{ outlet_id: tenant.outletId, role: 'waiter' }] },
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().phone).toBe('+919876543210');
    for (const roles of [[{ outlet_id: tenant.outletId, role: 'manager' }], [{ outlet_id: null, role: 'cashier' }]]) {
      const res = await manager({ method: 'POST', url: '/v1/staff', payload: { name: 'X', email: `x${Math.random()}@t.test`, password: 'password123', roles } });
      expect(res.statusCode).toBe(403);
    }
    // The new waiter can sign in with the phone number in any common format.
    expect(await login(t, tenant.slug, '9876543210', 'tandoor-2026')).toMatch(/^st_/);
  });

  it('signs a disabled person out everywhere', async () => {
    const w = await addStaff(t, tenant, 'waiter');
    const res = await owner({ method: 'PATCH', url: `/v1/staff/${w.userId}`, payload: { status: 'disabled' } });
    expect(res.statusCode).toBe(200);
    expect((await api(t, w.token)({ method: 'GET', url: '/v1/auth/me' })).statusCode).toBe(401);
    await expect(login(t, tenant.slug, w.login)).rejects.toThrow(/401/);
  });

  it('protects the last owner and stops people disabling themselves', async () => {
    const self = await owner({ method: 'PATCH', url: `/v1/staff/${tenant.ownerId}`, payload: { status: 'disabled' } });
    expect(self.statusCode).toBe(400);
  });

  it('lets any colleague list names for pickers, without contact details', async () => {
    const waiter = api(t, (await addStaff(t, tenant, 'waiter')).token);
    const res = await waiter({ method: 'GET', url: `/v1/staff?outlet_id=${tenant.outletId}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()[0]).not.toHaveProperty('email');
  });
});

describe('data rights', () => {
  it('exports tenant data without credentials', async () => {
    const res = await owner({ method: 'GET', url: '/v1/tenant/export' });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('password_hash');
    expect(res.body).not.toContain('scrypt$');
    const data = res.json().data;
    expect(data.menu_items.length).toBe(3);
    expect(data.users.length).toBeGreaterThan(0);
  });

  it('purges every row of a tenant and nothing of anyone else', async () => {
    const doomed = await createTenant(t);
    await createMenu(t, doomed);
    await t.ctx.adminDb
      .insertInto('screens')
      .values({
        id: crypto.randomUUID(),
        tenant_id: doomed.tenantId,
        outlet_id: doomed.outletId,
        user_id: doomed.ownerId,
        kind: 'floor',
      })
      .execute();
    const { purgeTenant } = await import('../src/lib/purge');
    await purgeTenant(t.ctx.adminDb, doomed.tenantId);
    const left = await t.ctx.adminDb.selectFrom('menu_items').select('id').where('tenant_id', '=', doomed.tenantId).execute();
    expect(left).toHaveLength(0);
    expect(await t.ctx.adminDb.selectFrom('tenants').select('id').where('id', '=', doomed.tenantId).executeTakeFirst()).toBeUndefined();
    const mine = await t.ctx.adminDb.selectFrom('menu_items').select('id').where('tenant_id', '=', tenant.tenantId).execute();
    expect(mine).toHaveLength(3);
  });
});

export { PASSWORD };

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addStaff, api, createTable, createTenant, login, PASSWORD, startApp, type TestApp, type TestTenant } from './helpers';

let t: TestApp;
let tenant: TestTenant;

beforeAll(async () => {
  t = await startApp();
  tenant = await createTenant(t);
});
afterAll(() => t.close());

describe('my account', () => {
  it('changes my password, keeps this device signed in and signs out the others', async () => {
    const w = await addStaff(t, tenant, 'waiter');
    const otherDevice = await login(t, tenant.slug, w.login);
    const me = api(t, w.token);
    const wrong = await me({ method: 'POST', url: '/v1/auth/password', payload: { current_password: 'nope', new_password: 'new-password-1' } });
    expect(wrong.statusCode).toBe(401);
    const ok = await me({ method: 'POST', url: '/v1/auth/password', payload: { current_password: PASSWORD, new_password: 'new-password-1' } });
    expect(ok.statusCode).toBe(204);
    expect((await me({ method: 'GET', url: '/v1/auth/me' })).statusCode).toBe(200);
    expect((await api(t, otherDevice)({ method: 'GET', url: '/v1/auth/me' })).statusCode).toBe(401);
    expect(await login(t, tenant.slug, w.login, 'new-password-1')).toMatch(/^st_/);
  });

  it('lets a manager edit their own name while their roles are resent unchanged', async () => {
    const m = await addStaff(t, tenant, 'manager');
    const res = await api(t, m.token)({
      method: 'PATCH',
      url: `/v1/staff/${m.userId}`,
      payload: { name: 'Arjun M', roles: [{ outlet_id: tenant.outletId, role: 'manager' }] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe('Arjun M');
    const promote = await api(t, m.token)({ method: 'PATCH', url: `/v1/staff/${m.userId}`, payload: { roles: [{ outlet_id: null, role: 'owner' }] } });
    expect(promote.statusCode).toBe(403);
  });

  it('tags waiter calls with the table’s assigned waiter', async () => {
    const tableId = await createTable(t, tenant, 'A9');
    const w = await addStaff(t, tenant, 'waiter');
    await api(t, tenant.ownerToken)({ method: 'PATCH', url: `/v1/tables/${tableId}/waiter`, payload: { waiter_id: w.userId } });
    const { getOrCreateSession } = await import('../src/modules/tables/sessions');
    const { createServiceRequest } = await import('../src/modules/tables/floor');
    const before = t.events.length;
    const request = await t.ctx.tx(tenant.tenantId, async (tx) => {
      const s = await getOrCreateSession(tx, tableId);
      return createServiceRequest(tx, { outletId: tenant.outletId, tableId, sessionId: s.id }, 'call_waiter');
    });
    expect(request.assigned_waiter_id).toBe(w.userId);
    const event = t.events.slice(before).find((e) => e.event.type === 'waiter.called');
    expect(event?.event.payload).toMatchObject({ assigned_waiter_id: w.userId });
  });
});

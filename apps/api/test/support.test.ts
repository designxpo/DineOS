// Help from inside the portal: staff raise a case with how bad it is; Mezmitra support picks it up,
// replies and moves it on; the outlet says when service runs again and closes it only when it works.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AdminSupportCaseDTO, SupportCaseDTO } from '@mezmitra/shared/dto';
import { missedTarget, supportOpen } from '@mezmitra/shared/support';
import { hashSecret } from '../src/lib/crypto';
import type { PushMessage } from '../src/lib/push';
import { addStaff, api, createTenant, startApp, type TestApp, type TestTenant } from './helpers';

let t: TestApp;
let tenant: TestTenant;
let other: TestTenant;
let owner: ReturnType<typeof api>;
let cashier: ReturnType<typeof api>;
let cashierId: string;
let admin: ReturnType<typeof api>;
const delivered: { endpoint: string; message: PushMessage }[] = [];
const cashierEndpoint = `https://push.example.com/cashier-${randomUUID()}`;

beforeAll(async () => {
  t = await startApp();
  tenant = await createTenant(t);
  other = await createTenant(t);
  owner = api(t, tenant.ownerToken);
  const c = await addStaff(t, tenant, 'cashier');
  cashier = api(t, c.token);
  cashierId = c.userId;
  const email = `support-${randomUUID().slice(0, 6)}@mezmitra.test`;
  await t.ctx.adminDb.insertInto('platform_admins').values({ name: 'Asha', email, password_hash: await hashSecret('admin-password-1') }).execute();
  const res = await t.app.inject({ method: 'POST', url: '/v1/admin/auth/login', payload: { email, password: 'admin-password-1' } });
  admin = api(t, res.json().token);
  t.ctx.push = {
    publicKey: 'BTestPublicKey',
    send: async (device, message) => {
      delivered.push({ endpoint: device.endpoint, message });
      return 'ok';
    },
  };
});
afterAll(() => t.close());

const outlet = () => tenant.outletId;
const raise = (as: ReturnType<typeof api>, body: Record<string, unknown>) => as({ method: 'POST', url: '/v1/support/cases', payload: { outlet_id: outlet(), ...body } });
const view = async (id: string): Promise<SupportCaseDTO> => (await owner({ method: 'GET', url: `/v1/support/cases/${id}?outlet_id=${outlet()}` })).json();
const queue = async (include = 'open'): Promise<AdminSupportCaseDTO[]> => (await admin({ method: 'GET', url: `/v1/admin/support/cases?include=${include}` })).json();

describe('help cases', () => {
  it('lets any staff member raise a case with a technical report, and support sees it first in the queue', async () => {
    const q = await raise(owner, { severity: 'question', summary: 'How do I add a printer?' });
    expect(q.statusCode, q.body).toBe(201);
    const res = await raise(cashier, {
      severity: 'stopped',
      summary: 'Bills will not print',
      details: 'The counter printer stopped at 8 pm.',
      diagnostics: { page: '/app/bills', online: true, screen: '1280x800' },
    });
    expect(res.statusCode).toBe(201);
    const c = res.json() as SupportCaseDTO;
    expect(c).toMatchObject({ severity: 'stopped', status: 'open', raised_by_name: expect.any(String) });
    expect(c.number).toBeGreaterThan(1000);
    expect(c.messages!.map((m) => m.author)).toEqual(['system', 'outlet']);
    expect(t.events.some((e) => e.event.type === 'support.updated' && (e.event.payload as { case_id: string }).case_id === c.id)).toBe(true);

    const mine = (await queue()).filter((x) => x.tenant_id === tenant.tenantId);
    expect(mine.map((x) => x.severity)).toEqual(['stopped', 'question']);
    expect(mine[0]).toMatchObject({ diagnostics: { page: '/app/bills' }, outlet_name: expect.any(String), tenant_name: expect.any(String) });

    // Bad input, and another restaurant cannot see it.
    expect((await raise(owner, { severity: 'urgent', summary: 'Help' })).statusCode).toBe(400);
    expect((await raise(owner, { severity: 'question', summary: 'x' })).statusCode).toBe(400);
    expect((await api(t, other.ownerToken)({ method: 'GET', url: `/v1/support/cases/${c.id}?outlet_id=${other.outletId}` })).statusCode).toBe(404);
    expect((await api(t, other.ownerToken)({ method: 'GET', url: `/v1/support/cases?outlet_id=${other.outletId}` })).json()).toEqual([]);
    expect((await owner({ method: 'GET', url: '/v1/admin/support/cases' })).statusCode).toBe(401);
  });

  it('runs a case from pick-up to "it works": owner, replies, waiting on the outlet, resumed, resolved, closed', async () => {
    const c = (await raise(cashier, { severity: 'degraded', summary: 'Kitchen screen is slow' })).json() as SupportCaseDTO;
    await t.ctx.adminDb
      .insertInto('push_subscriptions')
      .values({ tenant_id: tenant.tenantId, outlet_id: outlet(), user_id: cashierId, endpoint: cashierEndpoint, p256dh: 'BKey', auth: 'secret' })
      .execute();
    await t.ctx.adminDb
      .insertInto('push_subscriptions')
      .values({ tenant_id: tenant.tenantId, outlet_id: outlet(), user_id: tenant.ownerId, endpoint: `https://push.example.com/owner-${randomUUID()}`, p256dh: 'BKey', auth: 'secret' })
      .execute();

    expect((await admin({ method: 'POST', url: `/v1/admin/support/cases/${c.id}/assign` })).statusCode).toBe(200);
    let v = await view(c.id);
    expect(v).toMatchObject({ status: 'in_progress', assignee_name: 'Asha' });
    expect(v.first_response_at).toBeTruthy();

    // A question back to the outlet reaches only the person who raised it.
    const ask = await admin({ method: 'POST', url: `/v1/admin/support/cases/${c.id}/reply`, payload: { body: 'Which screen: the one by the tandoor?', status: 'waiting_on_outlet' } });
    expect(ask.statusCode).toBe(200);
    await expect.poll(() => delivered.filter((d) => d.message.tag === `support-${c.id}`).length).toBe(1);
    const push = delivered.find((d) => d.message.tag === `support-${c.id}`)!;
    expect(push.endpoint).toBe(cashierEndpoint);
    expect(push.message.title).toMatch(new RegExp(`^Help case #${c.number}: Support asked you something`));
    expect(push.message.body).toBe('Which screen: the one by the tandoor?');

    // The answer sends it back to support.
    expect((await cashier({ method: 'POST', url: `/v1/support/cases/${c.id}/messages`, payload: { outlet_id: outlet(), body: 'Yes, by the tandoor.' } })).statusCode).toBe(200);
    expect((await view(c.id)).status).toBe('open');

    // Service running again is recorded once, separate from the fix.
    expect((await cashier({ method: 'POST', url: `/v1/support/cases/${c.id}/resumed`, payload: { outlet_id: outlet() } })).statusCode).toBe(200);
    expect((await cashier({ method: 'POST', url: `/v1/support/cases/${c.id}/resumed`, payload: { outlet_id: outlet() } })).statusCode).toBe(409);
    expect((await view(c.id)).resumed_at).toBeTruthy();

    expect((await admin({ method: 'POST', url: `/v1/admin/support/cases/${c.id}/reply`, payload: { body: 'Restarted the screen app.', status: 'resolved' } })).statusCode).toBe(200);
    v = await view(c.id);
    expect(v.status).toBe('resolved');
    expect(v.resolved_at).toBeTruthy();

    // Still broken: reopen. Then fixed for real: the outlet closes it.
    expect((await cashier({ method: 'POST', url: `/v1/support/cases/${c.id}/reopen`, payload: { outlet_id: outlet(), body: 'Slow again after 10 minutes.' } })).statusCode).toBe(200);
    v = await view(c.id);
    expect(v).toMatchObject({ status: 'open', reopened: 1, resolved_at: null });
    expect((await admin({ method: 'POST', url: `/v1/admin/support/cases/${c.id}/reply`, payload: { body: 'Cleared the cache on that tablet.', status: 'resolved' } })).statusCode).toBe(200);
    expect((await owner({ method: 'POST', url: `/v1/support/cases/${c.id}/close`, payload: { outlet_id: outlet() } })).statusCode).toBe(200);
    v = await view(c.id);
    expect(v.status).toBe('closed');
    expect(v.closed_at).toBeTruthy();
    expect(v.messages!.filter((m) => m.author === 'support').map((m) => m.author_name)).toEqual(['Asha', 'Asha', 'Asha']);

    // Closed cases leave the open queue and take no more replies.
    expect((await queue()).some((x) => x.id === c.id)).toBe(false);
    expect((await queue('all')).find((x) => x.id === c.id)?.status).toBe('closed');
    expect((await admin({ method: 'POST', url: `/v1/admin/support/cases/${c.id}/reply`, payload: { body: 'More' } })).statusCode).toBe(409);
    expect((await cashier({ method: 'POST', url: `/v1/support/cases/${c.id}/messages`, payload: { outlet_id: outlet(), body: 'More' } })).statusCode).toBe(409);
  });

  it('judges the first-answer target only within support hours', () => {
    // 2026-10-17 14:00 IST is 08:30 UTC; 03:00 IST is 21:30 UTC the day before.
    const afternoon = '2026-10-17T08:30:00.000Z';
    const night = '2026-10-16T21:30:00.000Z';
    expect(supportOpen(new Date(afternoon))).toBe(true);
    expect(supportOpen(new Date(night))).toBe(false);
    const at = (iso: string, minutes: number) => new Date(new Date(iso).getTime() + minutes * 60_000);
    expect(missedTarget({ severity: 'stopped', created_at: afternoon, first_response_at: at(afternoon, 8).toISOString() })).toBe(false);
    expect(missedTarget({ severity: 'stopped', created_at: afternoon, first_response_at: null }, at(afternoon, 11))).toBe(true);
    expect(missedTarget({ severity: 'degraded', created_at: afternoon, first_response_at: null }, at(afternoon, 30))).toBe(false);
    expect(missedTarget({ severity: 'question', created_at: afternoon, first_response_at: null }, at(afternoon, 600))).toBe(false);
    expect(missedTarget({ severity: 'stopped', created_at: night, first_response_at: null }, at(night, 60))).toBe(false);
  });
});

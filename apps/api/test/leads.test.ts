// Demo requests from the website land in the admin console; bots and bad input do not.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashSecret } from '../src/lib/crypto';
import { api, createTenant, startApp, type TestApp } from './helpers';

let t: TestApp;
let admin: ReturnType<typeof api>;

beforeAll(async () => {
  t = await startApp();
  const email = `leads-${randomUUID().slice(0, 6)}@mezmitra.test`;
  await t.ctx.adminDb.insertInto('platform_admins').values({ name: 'Sales', email, password_hash: await hashSecret('admin-password-1') }).execute();
  admin = api(t, (await t.app.inject({ method: 'POST', url: '/v1/admin/auth/login', payload: { email, password: 'admin-password-1' } })).json().token);
});
afterAll(() => t.close());

const ask = (payload: object) => t.app.inject({ method: 'POST', url: '/v1/public/demo-requests', payload, remoteAddress: `10.0.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` });
const mine = async (restaurant: string) => ((await admin({ method: 'GET', url: '/v1/admin/demo-requests' })).json() as { restaurant: string; id: string; phone: string; status: string; pains: string[]; contacted_at: string | null; renews_on: string | null }[]).filter((r) => r.restaurant === restaurant);

describe('demo requests', () => {
  it('records a request from the website for Mezvaan to follow up', async () => {
    const restaurant = `Chai Point ${randomUUID().slice(0, 4)}`;
    const res = await ask({ name: 'Kavya', restaurant, phone: '98450 12345', city: 'Pune', tables: '11-25', plan: 'Table service', pains: ['payments_mismatch', 'month_end', 'month_end'], note: 'Two outlets soon', current_system: 'Petpooja', renews: '2027-03' });
    expect(res.statusCode).toBe(201);
    const [row] = await mine(restaurant);
    expect(row).toMatchObject({ phone: '+919845012345', status: 'new', pains: ['payments_mismatch', 'month_end'], current_system: 'Petpooja', renews_on: '2027-03-01' });

    const done = await admin({ method: 'PATCH', url: `/v1/admin/demo-requests/${row!.id}`, payload: { status: 'contacted' } });
    expect(done.json()).toMatchObject({ status: 'contacted', contacted_at: expect.any(String) });
  });

  it('keeps no renewal month for a restaurant on paper: there is no contract to wait for', async () => {
    const restaurant = `Dosa Corner ${randomUUID().slice(0, 4)}`;
    expect((await ask({ name: 'Ravi', restaurant, phone: '9845012399', current_system: 'Paper or Excel', renews: '2027-01' })).statusCode).toBe(201);
    expect((await mine(restaurant))[0]).toMatchObject({ current_system: 'Paper or Excel', renews_on: null });
    expect((await ask({ name: 'Ravi', restaurant, phone: '9845012399', renews: 'March' })).statusCode).toBe(400);
  });

  it('turns away bad input, quietly drops bots, and keeps requests away from restaurants', async () => {
    expect((await ask({ name: 'A', restaurant: 'B', phone: 'call me' })).statusCode).toBe(400);
    expect((await ask({ name: 'A', restaurant: 'B', phone: '9845012345', tables: 'lots' })).statusCode).toBe(400);
    const bot = `Spam ${randomUUID().slice(0, 4)}`;
    expect((await ask({ name: 'A', restaurant: bot, phone: '9845012345', website: 'http://spam.example' })).statusCode).toBe(201);
    expect(await mine(bot)).toEqual([]);

    const tenant = await createTenant(t);
    expect((await api(t, tenant.ownerToken)({ method: 'GET', url: '/v1/admin/demo-requests' })).statusCode).toBe(401);
  });

  it('limits how often one address can send the form', async () => {
    const from = { remoteAddress: '10.9.9.9' };
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) {
      codes.push((await t.app.inject({ method: 'POST', url: '/v1/public/demo-requests', payload: { name: 'A', restaurant: `Flood ${i}`, phone: '9845012345' }, ...from })).statusCode);
    }
    expect(codes.slice(0, 5).every((c) => c === 201)).toBe(true);
    expect(codes[5]).toBe(429);
  });
});

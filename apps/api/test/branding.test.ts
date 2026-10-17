// A restaurant's own look (white label for its staff and guests): logo, cover photo, colour and
// heading style on the portal, the QR menu, order tracking and the pickup screen. Paid plans show
// it, the trial shows the Mezmitra look, and Mezmitra can set it per restaurant.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MeDTO, OrderDTO, TenantBrandDTO } from '@mezmitra/shared/dto';
import { hashSecret } from '../src/lib/crypto';
import { api, createMenu, createTable, createTenant, startApp, type TestApp, type TestMenu, type TestTenant } from './helpers';
import { multipart } from './multipart';

let t: TestApp;
let tenant: TestTenant;
let menu: TestMenu;
let owner: ReturnType<typeof api>;
let admin: ReturnType<typeof api>;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

beforeAll(async () => {
  t = await startApp();
  tenant = await createTenant(t, { plan: 'trial' });
  menu = await createMenu(t, tenant);
  owner = api(t, tenant.ownerToken);
  const email = `brand-${randomUUID().slice(0, 6)}@mezmitra.test`;
  await t.ctx.adminDb.insertInto('platform_admins').values({ name: 'Ops', email, password_hash: await hashSecret('admin-password-1') }).execute();
  admin = api(t, (await t.app.inject({ method: 'POST', url: '/v1/admin/auth/login', payload: { email, password: 'admin-password-1' } })).json().token);
});
afterAll(() => t.close());

const me = async (): Promise<MeDTO> => (await owner({ method: 'GET', url: '/v1/auth/me' })).json();
const settings = async (): Promise<TenantBrandDTO> => (await owner({ method: 'GET', url: '/v1/tenant' })).json();
async function guestBrand() {
  const table = await createTable(t, tenant, `B${randomUUID().slice(0, 4)}`);
  const qr = new URL((await owner({ method: 'GET', url: `/v1/tables/${table}/qr` })).json().url).pathname.split('/').pop()!;
  return (await t.app.inject({ method: 'GET', url: `/v1/guest/resolve?qr=${qr}` })).json().tenant.branding;
}

describe('restaurant brand', () => {
  it('lets the owner set it up on the trial, but shows the Mezmitra look until the plan includes it', async () => {
    expect((await owner({ method: 'POST', url: '/v1/tenant/logo', ...multipart('logo.png', 'image/png', png) })).statusCode).toBe(200);
    expect((await owner({ method: 'POST', url: '/v1/tenant/cover', ...multipart('cover.png', 'image/png', png) })).statusCode).toBe(200);
    const saved = await owner({ method: 'PATCH', url: '/v1/tenant', payload: { branding: { primary_color: '#1D4ED8', heading_style: 'sans' } } });
    expect(saved.statusCode).toBe(200);

    const s = await settings();
    expect(s.branding).toMatchObject({ primary_color: '#1d4ed8', heading_style: 'sans', logo_url: expect.stringMatching(/^http/), cover_url: expect.stringMatching(/^http/) });
    expect(s.white_label).toBe(false);
    expect(s.white_label_plans).toEqual(expect.arrayContaining(['Standard', 'Premium']));
    expect(s.white_label_plans).not.toContain('Trial (30 days)');

    expect((await me()).tenant).toMatchObject({ white_label: false, branding: {} });
    expect(await guestBrand()).toEqual({});
    expect((await t.app.inject({ method: 'GET', url: `/v1/public/brand/${tenant.slug}` })).json()).toMatchObject({ name: expect.any(String), branding: {} });
  });

  it('shows it everywhere once the restaurant is on a paid plan: portal, QR menu, tracking, pickup screen, sign-in', async () => {
    await t.ctx.adminDb.updateTable('tenants').set({ plan_code: 'standard' }).where('id', '=', tenant.tenantId).execute();
    const brand = { primary_color: '#1d4ed8', heading_style: 'sans' };
    expect((await me()).tenant).toMatchObject({ white_label: true, branding: brand });
    expect((await me()).tenant.branding.logo_url).toMatch(/^http/);
    expect(await guestBrand()).toMatchObject({ ...brand, cover_url: expect.stringMatching(/^http/) });

    const order: OrderDTO = (await owner({ method: 'POST', url: '/v1/orders', payload: { outlet_id: tenant.outletId, type: 'takeaway', lines: [{ item_id: menu.paneerTikka, qty: 1 }] } })).json();
    expect((await t.app.inject({ method: 'GET', url: `/v1/public/track/${order.track_code}` })).json()).toMatchObject({ branding: brand, tenant_name: expect.any(String) });
    const link = (await owner({ method: 'GET', url: `/v1/outlets/${tenant.outletId}/pickup-link` })).json().url as string;
    expect((await t.app.inject({ method: 'GET', url: `/v1/public/pickup/${link.split('/').pop()}` })).json()).toMatchObject({ branding: brand });
    expect((await t.app.inject({ method: 'GET', url: `/v1/public/brand/${tenant.slug.toUpperCase()}` })).json()).toMatchObject({ slug: tenant.slug, branding: brand });
    expect((await t.app.inject({ method: 'GET', url: '/v1/public/brand/no-such-restaurant' })).statusCode).toBe(404);
  });

  it('lets Mezmitra switch it off or on for one restaurant, whatever its plan', async () => {
    const set = (white_label: boolean | null) => admin({ method: 'PATCH', url: `/v1/admin/tenants/${tenant.tenantId}`, payload: { white_label } });
    expect((await set(false)).statusCode).toBe(200);
    expect((await me()).tenant).toMatchObject({ white_label: false, branding: {} });
    await t.ctx.adminDb.updateTable('tenants').set({ plan_code: 'trial' }).where('id', '=', tenant.tenantId).execute();
    expect((await set(true)).json()).toMatchObject({ white_label: true });
    expect((await me()).tenant.white_label).toBe(true);
    expect((await guestBrand()).primary_color).toBe('#1d4ed8');
    expect((await set(null)).statusCode).toBe(200);
    expect((await me()).tenant.white_label).toBe(false);
  });

  it('takes only colours and styles it can show; pictures come by upload and can be removed', async () => {
    const patch = (branding: object) => owner({ method: 'PATCH', url: '/v1/tenant', payload: { branding } });
    expect((await patch({ primary_color: 'blue' })).statusCode).toBe(400);
    expect((await patch({ heading_style: 'comic' })).statusCode).toBe(400);
    expect((await patch({ logo_url: 'https://tracker.example.com/pixel.png' })).statusCode).toBe(400);
    expect((await patch({ cover_url: null })).statusCode).toBe(200);
    expect((await settings()).branding.cover_url).toBeNull();
    expect((await owner({ method: 'POST', url: '/v1/tenant/cover', ...multipart('cover.txt', 'text/plain', 'not an image') })).statusCode).toBe(400);
  });
});

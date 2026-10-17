// Fixes from the October 2026 security audit (docs/security-audit.md): manager PIN lockout, image
// uploads checked by content, storage paths that cannot leave the storage folder, security
// headers on every response, and bounded in-memory caches.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PIN_MAX_ATTEMPTS } from '@mezmitra/shared/permissions';
import { detectImage } from '../src/lib/images';
import { containedPath } from '../src/lib/storage';
import { TtlCache } from '../src/lib/ttl-cache';
import { addStaff, api, createTenant, PASSWORD, startApp, type TestApp, type TestTenant } from './helpers';
import { multipart } from './multipart';

let t: TestApp;
let tenant: TestTenant;
let owner: ReturnType<typeof api>;

beforeAll(async () => {
  t = await startApp();
  tenant = await createTenant(t);
  owner = api(t, tenant.ownerToken);
});
afterAll(() => t.close());

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

describe('manager PIN guessing', () => {
  const ask = (cashier: ReturnType<typeof api>, login: string, pin: string) =>
    cashier({ method: 'POST', url: '/v1/approvals', payload: { outlet_id: tenant.outletId, action: 'bill.void', login, pin } });
  const state = (userId: string) => t.ctx.adminDb.selectFrom('users').select(['pin_failed_attempts', 'pin_locked_until']).where('id', '=', userId).executeTakeFirstOrThrow();

  it(`locks a manager's PIN after ${PIN_MAX_ATTEMPTS} wrong guesses in a row and tells the owner`, async () => {
    const manager = await addStaff(t, tenant, 'manager', { pin: '4321' });
    const cashier = api(t, (await addStaff(t, tenant, 'cashier')).token);
    for (let i = 1; i < PIN_MAX_ATTEMPTS; i++) expect((await ask(cashier, manager.login, '0000')).statusCode).toBe(403);
    expect((await state(manager.userId)).pin_failed_attempts).toBe(PIN_MAX_ATTEMPTS - 1);

    const locked = await ask(cashier, manager.login, '0000');
    expect(locked.statusCode).toBe(423);
    expect(locked.json().error.code).toBe('pin_locked');
    // Even the right PIN, and from another cashier's screen.
    const otherCashier = api(t, (await addStaff(t, tenant, 'cashier')).token);
    expect((await ask(otherCashier, manager.login, '4321')).statusCode).toBe(423);

    const audit = await t.ctx.adminDb.selectFrom('audit_log').select(['action', 'entity_id']).where('tenant_id', '=', tenant.tenantId).where('action', '=', 'approval.pin_locked').execute();
    expect(audit).toContainEqual({ action: 'approval.pin_locked', entity_id: manager.userId });
    const events = await t.ctx.adminDb.selectFrom('outlet_events').select('payload').where('outlet_id', '=', tenant.outletId).where('type', '=', 'staff.pin_locked').execute();
    expect(events.map((e) => (e.payload as { user_id: string }).user_id)).toContain(manager.userId);

    // When the lock runs out, the right PIN works and the count starts again.
    await t.ctx.adminDb.updateTable('users').set({ pin_locked_until: new Date(Date.now() - 1000) }).where('id', '=', manager.userId).execute();
    expect((await ask(otherCashier, manager.login, '4321')).statusCode).toBe(200);
    expect(await state(manager.userId)).toEqual({ pin_failed_attempts: 0, pin_locked_until: null });
  });

  it('starts counting again after a right PIN, and a new PIN lifts a lock', async () => {
    const manager = await addStaff(t, tenant, 'manager', { pin: '2468' });
    const cashier = api(t, (await addStaff(t, tenant, 'cashier')).token);
    for (let i = 1; i < PIN_MAX_ATTEMPTS; i++) await ask(cashier, manager.login, '1111');
    expect((await ask(cashier, manager.login, '2468')).statusCode).toBe(200);
    expect((await state(manager.userId)).pin_failed_attempts).toBe(0);

    const second = api(t, (await addStaff(t, tenant, 'cashier')).token);
    for (let i = 0; i < PIN_MAX_ATTEMPTS; i++) await ask(second, manager.login, '1111');
    expect((await state(manager.userId)).pin_locked_until).not.toBeNull();
    const asManager = api(t, manager.token);
    expect((await asManager({ method: 'POST', url: '/v1/auth/pin', payload: { password: PASSWORD, pin: '135790' } })).statusCode).toBe(204);
    const third = api(t, (await addStaff(t, tenant, 'cashier')).token);
    expect((await ask(third, manager.login, '135790')).statusCode).toBe(200);
  });

  it('answers the same for an unknown login', async () => {
    const cashier = api(t, (await addStaff(t, tenant, 'cashier')).token);
    const res = await ask(cashier, 'nobody@example.com', '1234');
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('approval_denied');
  });
});

describe('uploads', () => {
  async function newItem() {
    const cat = await owner({ method: 'POST', url: '/v1/menu/categories', payload: { outlet_id: tenant.outletId, name: `Cat ${Math.random()}` } });
    const item = await owner({ method: 'POST', url: '/v1/menu/items', payload: { outlet_id: tenant.outletId, category_id: cat.json().id, name: 'Poha', price_paise: 12000, is_veg: true } });
    return item.json().id as string;
  }

  it('refuses a file that only claims to be an image', async () => {
    const id = await newItem();
    const html = Buffer.from('<!doctype html><script>alert(document.cookie)</script>');
    const res = await owner({ method: 'POST', url: `/v1/menu/items/${id}/photo`, ...multipart('poha.png', 'image/png', html) });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_file_type');
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>');
    expect((await owner({ method: 'POST', url: '/v1/tenant/logo', ...multipart('logo.svg', 'image/png', svg) })).statusCode).toBe(400);
  });

  it('stores an image as what it really is, served so that nothing in it can run', async () => {
    const id = await newItem();
    const res = await owner({ method: 'POST', url: `/v1/menu/items/${id}/photo`, ...multipart('poha.jpg', 'image/jpeg', PNG) });
    expect(res.statusCode).toBe(200);
    const url = new URL(res.json().photo_url);
    expect(url.pathname).toMatch(/\.png$/);
    const file = await t.app.inject({ method: 'GET', url: url.pathname });
    expect(file.headers).toMatchObject({
      'content-type': 'image/png',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'cross-origin-resource-policy': 'cross-origin',
    });
  });

  it('serves only images from inside the storage folder', async () => {
    const dir = join(t.ctx.config.storageDir, tenant.tenantId, 'menu');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'notes.json'), '{"secret":true}');
    expect((await t.app.inject({ method: 'GET', url: `/files/${tenant.tenantId}/menu/notes.json` })).statusCode).toBe(404);
    for (const path of ['/files/..%2f..%2fpackage.json', '/files/%2e%2e/%2e%2e/package.json', '/files/..\\..\\package.json']) {
      expect((await t.app.inject({ method: 'GET', url: path })).statusCode, path).toBe(404);
    }
    expect(() => containedPath('/srv/storage', '../etc/passwd')).toThrow();
    expect(() => containedPath('/srv/storage', '/etc/passwd')).not.toThrow();
    expect(containedPath('/srv/storage', '/etc/passwd')).toBe('/srv/storage/etc/passwd');
    expect(() => containedPath('/srv/storage', 'a/../../b.png')).toThrow();
    expect(() => containedPath('/srv/storage', '')).toThrow();
    expect(containedPath('/srv/storage', 't1/menu/x-1.png')).toBe('/srv/storage/t1/menu/x-1.png');
  });

  it('tells images apart by their first bytes', () => {
    expect(detectImage(PNG)).toEqual({ ext: 'png', contentType: 'image/png' });
    expect(detectImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]))).toEqual({ ext: 'jpg', contentType: 'image/jpeg' });
    expect(detectImage(Buffer.from('RIFF\x00\x00\x00\x00WEBPVP8 ', 'latin1'))).toEqual({ ext: 'webp', contentType: 'image/webp' });
    expect(detectImage(Buffer.from('GIF89a......'))).toBeNull();
    expect(detectImage(Buffer.from('%PDF-1.7 ....'))).toBeNull();
    expect(detectImage(Buffer.alloc(4))).toBeNull();
  });
});

describe('security headers', () => {
  it('are on every API response, including errors', async () => {
    for (const res of [await t.app.inject({ method: 'GET', url: '/healthz' }), await t.app.inject({ method: 'GET', url: '/v1/auth/me' }), await t.app.inject({ method: 'GET', url: '/v1/nope' })]) {
      expect(res.headers).toMatchObject({
        'x-content-type-options': 'nosniff',
        'x-frame-options': 'DENY',
        'referrer-policy': 'no-referrer',
        'cross-origin-opener-policy': 'same-origin',
        'cross-origin-resource-policy': 'same-site',
      });
      expect(res.headers['content-security-policy']).toContain("default-src 'none'");
      expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    }
  });
});

describe('in-memory caches', () => {
  it('forget entries after their time and never grow past their cap', () => {
    const cache = new TtlCache<number>(1000, 3);
    cache.set('a', 1, 0);
    expect(cache.get('a', 999)).toBe(1);
    expect(cache.get('a', 1000)).toBeUndefined();
    for (const [i, k] of ['b', 'c', 'd', 'e'].entries()) cache.set(k, i, 2000);
    expect(cache.size).toBe(3);
    expect(cache.get('b', 2000)).toBeUndefined();
    expect(cache.get('e', 2000)).toBe(3);
    // Expired entries are swept out on later writes.
    cache.set('f', 9, 5000);
    expect(cache.size).toBe(1);
  });
});

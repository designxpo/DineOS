// Test harness. Each test file starts its own app on a random port and provisions its own tenants,
// so files never see each other's data (RLS keeps them apart even in one database).

import { randomUUID } from 'node:crypto';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { io as ioClient, type Socket } from 'socket.io-client';
import type { OutletEvent } from '@dineos/shared/events';
import type { Role } from '@dineos/shared/enums';
import { buildApp } from '../src/app';
import type { AppContext } from '../src/context';
import { hashSecret } from '../src/lib/crypto';
import { provisionTenant } from '../src/modules/admin/provision';
import { attachRealtime } from '../src/realtime/hub';
import { testConfig } from './env';

export interface TestApp {
  app: FastifyInstance;
  routes: { method: string; url: string }[];
  ctx: AppContext;
  url: string;
  /** Every event published on the bus, newest last. */
  events: { tenantId: string; event: OutletEvent }[];
  close(): Promise<void>;
}

export async function startApp(overrides: Record<string, string> = {}): Promise<TestApp> {
  const { app, ctx, routes } = await buildApp({ config: testConfig(overrides), logger: false, rateLimitMax: 100_000 });
  await attachRealtime(app, ctx);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const events: TestApp['events'] = [];
  ctx.bus.subscribe((tenantId, list) => {
    for (const event of list) events.push({ tenantId, event });
  });
  return { app, ctx, routes, url: `http://127.0.0.1:${port}`, events, close: () => app.close() };
}

export interface TestTenant {
  tenantId: string;
  outletId: string;
  ownerId: string;
  slug: string;
  ownerLogin: string;
  password: string;
  ownerToken: string;
}

export const PASSWORD = 'correct-horse-battery';

export async function createTenant(t: TestApp, opts: { plan?: string; invoicePrefix?: string } = {}): Promise<TestTenant> {
  const slug = `t-${randomUUID().slice(0, 8)}`;
  const ownerLogin = `owner@${slug}.test`;
  const ids = await provisionTenant(t.ctx.adminDb, {
    name: `Test ${slug}`,
    slug,
    plan_code: opts.plan ?? 'standard',
    owner: { name: 'Owner', email: ownerLogin, password: PASSWORD },
    outlet: { name: 'Main Outlet', invoice_prefix: opts.invoicePrefix ?? 'TST', gstin: '29ABCDE1234F1Z5', state_code: '29' },
  });
  const ownerToken = await login(t, slug, ownerLogin);
  return { ...ids, slug, ownerLogin, password: PASSWORD, ownerToken };
}

export async function login(t: TestApp, slug: string, loginId: string, password = PASSWORD): Promise<string> {
  const res = await t.app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { tenant_slug: slug, login: loginId, password },
  });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`);
  return res.json().token;
}

/** Adds a staff member with one role at the tenant's outlet (or tenant-wide) and returns a token. */
export async function addStaff(
  t: TestApp,
  tenant: TestTenant,
  role: Role,
  opts: { outletId?: string | null; pin?: string } = {},
): Promise<{ userId: string; token: string; login: string }> {
  const loginId = `${role}-${randomUUID().slice(0, 6)}@${tenant.slug}.test`;
  const outletId = opts.outletId === undefined ? tenant.outletId : opts.outletId;
  const user = await t.ctx.adminDb
    .insertInto('users')
    .values({
      tenant_id: tenant.tenantId,
      name: `${role[0]!.toUpperCase()}${role.slice(1)} ${loginId.slice(role.length + 1, role.length + 5)}`,
      email: loginId,
      password_hash: await hashSecret(PASSWORD),
      pin_hash: opts.pin ? await hashSecret(opts.pin) : null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await t.ctx.adminDb
    .insertInto('user_outlet_roles')
    .values({ tenant_id: tenant.tenantId, user_id: user.id, outlet_id: outletId, role })
    .execute();
  return { userId: user.id, token: await login(t, tenant.slug, loginId), login: loginId };
}

export interface TestMenu {
  categoryId: string;
  /** ₹250, veg, no modifiers, kitchen station */
  paneerTikka: string;
  /** ₹180, with a required Size group (Regular +0 / Large +60) and optional Add-ons (max 2) */
  coldCoffee: string;
  /** ₹320, non-veg, 18% tax, kitchen station */
  chickenTikka: string;
  sizeGroupId: string;
  regular: string;
  large: string;
  addonGroupId: string;
  extraShot: string;
  iceCream: string;
}

/** Seeds a small menu directly (admin connection) so tests do not depend on the menu module. */
export async function createMenu(t: TestApp, tenant: TestTenant, outletId = tenant.outletId): Promise<TestMenu> {
  const db = t.ctx.adminDb;
  const base = { tenant_id: tenant.tenantId, outlet_id: outletId };
  const cat = await db.insertInto('menu_categories').values({ ...base, name: 'Starters' }).returning('id').executeTakeFirstOrThrow();
  const item = (name: string, price: number, extra: Record<string, unknown> = {}) =>
    db
      .insertInto('menu_items')
      .values({ ...base, category_id: cat.id, name, price_paise: price, ...extra })
      .returning('id')
      .executeTakeFirstOrThrow()
      .then((r) => r.id);
  const paneerTikka = await item('Paneer Tikka', 25000);
  const coldCoffee = await item('Cold Coffee', 18000, { station: 'bar' });
  const chickenTikka = await item('Chicken Tikka', 32000, { is_veg: false, tax_rate_bp: 1800 });

  const group = (name: string, min: number, max: number) =>
    db
      .insertInto('modifier_groups')
      .values({ ...base, name, min_select: min, max_select: max })
      .returning('id')
      .executeTakeFirstOrThrow()
      .then((r) => r.id);
  const sizeGroupId = await group('Size', 1, 1);
  const addonGroupId = await group('Add-ons', 0, 2);
  const mod = (groupId: string, name: string, delta: number) =>
    db
      .insertInto('modifiers')
      .values({ tenant_id: tenant.tenantId, group_id: groupId, name, price_delta_paise: delta })
      .returning('id')
      .executeTakeFirstOrThrow()
      .then((r) => r.id);
  const regular = await mod(sizeGroupId, 'Regular', 0);
  const large = await mod(sizeGroupId, 'Large', 6000);
  const extraShot = await mod(addonGroupId, 'Extra shot', 4000);
  const iceCream = await mod(addonGroupId, 'Ice cream', 5000);
  await db
    .insertInto('item_modifier_groups')
    .values([
      { tenant_id: tenant.tenantId, item_id: coldCoffee, group_id: sizeGroupId, sort: 0 },
      { tenant_id: tenant.tenantId, item_id: coldCoffee, group_id: addonGroupId, sort: 1 },
    ])
    .execute();
  return { categoryId: cat.id, paneerTikka, coldCoffee, chickenTikka, sizeGroupId, regular, large, addonGroupId, extraShot, iceCream };
}

export async function createTable(t: TestApp, tenant: TestTenant, label = 'T1', outletId = tenant.outletId): Promise<string> {
  const row = await t.ctx.adminDb
    .insertInto('tables')
    .values({ tenant_id: tenant.tenantId, outlet_id: outletId, label, seats: 4 })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

export async function setOutlet(t: TestApp, outletId: string, values: Record<string, unknown>): Promise<void> {
  await t.ctx.adminDb.updateTable('outlets').set(values).where('id', '=', outletId).execute();
}

/** inject() with a bearer token. */
export function api(t: TestApp, token: string | null) {
  return (opts: InjectOptions & { url: string }) =>
    t.app.inject({
      ...opts,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(opts.headers ?? {}) },
    });
}

/** Connects a Socket.IO client and resolves once the server says it is ready. */
export function connectSocket(t: TestApp, namespace: '/staff' | '/guest' | '/device', token: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = ioClient(`${t.url}${namespace}`, { auth: { token }, transports: ['websocket'], forceNew: true });
    const timer = setTimeout(() => reject(new Error('socket did not become ready')), 5000);
    socket.once('ready', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('connect_error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** Resolves with the first `event` matching `type` (and optional predicate) on a socket. */
export function nextEvent<P = unknown>(
  socket: Socket,
  type: string,
  predicate: (e: OutletEvent<P>) => boolean = () => true,
  timeoutMs = 5000,
): Promise<OutletEvent<P>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('event', handler);
      reject(new Error(`no ${type} event within ${timeoutMs}ms`));
    }, timeoutMs);
    const handler = (e: OutletEvent<P>) => {
      if (e.type === type && predicate(e)) {
        clearTimeout(timer);
        socket.off('event', handler);
        resolve(e);
      }
    };
    socket.on('event', handler);
  });
}

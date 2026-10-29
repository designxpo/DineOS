import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sql } from 'kysely';
import type { Role } from '@mezmitra/shared/enums';
import { rolesCan, type Action } from '@mezmitra/shared/permissions';
import type { AppContext, Tx } from '../context';
import { sha256 } from './crypto';
import { AppError, forbidden, unauthorized } from './errors';
import { verifyGuestToken } from './tokens';
import { TtlCache } from './ttl-cache';

export interface StaffAuth {
  kind: 'staff';
  tenantId: string;
  userId: string;
  sessionId: string;
  impersonatedBy: string | null;
  /** outletId null = applies to every outlet in the tenant. */
  roles: { outletId: string | null; role: Role }[];
}
export interface GuestAuth {
  kind: 'guest';
  tenantId: string;
  outletId: string;
  tableId: string;
  sessionId: string;
  deviceId: string;
}
export interface DeviceAuth {
  kind: 'device';
  tenantId: string;
  outletId: string;
  deviceId: string;
  deviceKind: 'print_agent' | 'vision';
}
export interface AdminAuth {
  kind: 'admin';
  adminId: string;
  sessionId: string;
}
/** Another product acting for one tenant with a link key (mzk_...), e.g. Talko AI. */
export interface IntegrationAuth {
  kind: 'integration';
  tenantId: string;
  linkId: string;
  provider: 'talko';
  /** pending until the other product completes the link; only linking works before then. */
  status: 'pending' | 'active';
  scopes: string[];
}
export type Auth = StaffAuth | GuestAuth | DeviceAuth | AdminAuth | IntegrationAuth;

declare module 'fastify' {
  interface FastifyRequest {
    auth: Auth | null;
  }
}

// Short cache so every request does not cost two extra queries. Logout evicts locally; other
// nodes notice within the TTL. Bounded in time and size, so it cannot grow without limit.
const CACHE_TTL_MS = 15_000;
const cache = new TtlCache<Auth>(CACHE_TTL_MS, 20_000);

function remember(hash: string, auth: Auth): void {
  cache.set(hash, auth);
}

export function evictCachedAuth(token: string): void {
  cache.delete(sha256(token));
}

/** Evicts by the stored hash, for keys we no longer hold in plain (a revoked link key). */
export function evictCachedAuthHash(hash: string): void {
  cache.delete(hash);
}

export function clearAuthCache(): void {
  cache.clear();
}

const tenantStatusCache = new TtlCache<string>(CACHE_TTL_MS, 10_000);

/** How long a new link key may wait to be pasted into the other product. */
export const PENDING_LINK_MS = 24 * 3600_000;

async function tenantStatus(ctx: AppContext, tenantId: string): Promise<string | null> {
  const hit = tenantStatusCache.get(tenantId);
  if (hit) return hit;
  const { rows } = await sql<{ status: string | null }>`select auth_tenant_status(${tenantId}) as status`.execute(ctx.db);
  const status = rows[0]?.status ?? null;
  if (status) tenantStatusCache.set(tenantId, status);
  return status;
}

function assertTenantActive(status: string | null): void {
  if (status === 'suspended') throw new AppError(403, 'tenant_suspended', 'This account is suspended. Contact support.');
  if (status !== 'active') throw unauthorized();
}

/** Resolves a bearer token to a principal. Returns null for unknown tokens; throws for blocked ones. */
export async function authenticate(ctx: AppContext, token: string): Promise<Auth | null> {
  if (token.startsWith('gt_')) {
    const claims = verifyGuestToken(ctx.config.TOKEN_SECRET, token);
    if (!claims) return null;
    assertTenantActive(await tenantStatus(ctx, claims.tenantId));
    return {
      kind: 'guest',
      tenantId: claims.tenantId,
      outletId: claims.outletId,
      tableId: claims.tableId,
      sessionId: claims.sessionId,
      deviceId: claims.deviceId,
    };
  }

  const hash = sha256(token);
  const hit = cache.get(hash);
  if (hit) return hit;

  let auth: Auth | null = null;
  if (token.startsWith('st_')) {
    const { rows } = await sql<{
      session_id: string;
      user_id: string;
      tenant_id: string;
      expires_at: Date;
      impersonated_by: string | null;
      tenant_status: string;
      user_status: string;
    }>`select * from auth_user_session(${hash})`.execute(ctx.db);
    const s = rows[0];
    if (!s || s.expires_at.getTime() < Date.now() || s.user_status !== 'active') return null;
    // Platform support can still impersonate into a suspended tenant to help them.
    if (!s.impersonated_by) assertTenantActive(s.tenant_status);
    const roles = await ctx.tx(s.tenant_id, (tx) =>
      tx.db
        .selectFrom('user_outlet_roles')
        .select(['outlet_id', 'role'])
        .where('user_id', '=', s.user_id)
        .execute(),
    );
    auth = {
      kind: 'staff',
      tenantId: s.tenant_id,
      userId: s.user_id,
      sessionId: s.session_id,
      impersonatedBy: s.impersonated_by,
      roles: roles.map((r) => ({ outletId: r.outlet_id, role: r.role as Role })),
    };
  } else if (token.startsWith('dv_')) {
    const { rows } = await sql<{
      device_id: string;
      tenant_id: string;
      outlet_id: string;
      kind: 'print_agent' | 'vision';
      status: string;
      tenant_status: string;
    }>`select * from auth_device(${hash})`.execute(ctx.db);
    const d = rows[0];
    if (!d || d.status !== 'active') return null;
    assertTenantActive(d.tenant_status);
    auth = { kind: 'device', tenantId: d.tenant_id, outletId: d.outlet_id, deviceId: d.device_id, deviceKind: d.kind };
  } else if (token.startsWith('mzk_')) {
    const { rows } = await sql<{
      link_id: string;
      tenant_id: string;
      provider: 'talko';
      status: string;
      scopes: string[];
      created_at: Date;
      tenant_status: string;
      plan_allows: boolean;
    }>`select * from auth_integration(${hash})`.execute(ctx.db);
    const l = rows[0];
    // A revoked link, or a plan that no longer includes the link, ends access at once. A key
    // nobody used to finish linking stops working after a day.
    if (!l || !l.plan_allows) return null;
    if (l.status !== 'active' && !(l.status === 'pending' && Date.now() - l.created_at.getTime() < PENDING_LINK_MS)) return null;
    assertTenantActive(l.tenant_status);
    auth = { kind: 'integration', tenantId: l.tenant_id, linkId: l.link_id, provider: l.provider, status: l.status, scopes: l.scopes };
  } else if (token.startsWith('ad_')) {
    const row = await ctx.adminDb
      .selectFrom('admin_sessions')
      .innerJoin('platform_admins', 'platform_admins.id', 'admin_sessions.admin_id')
      .select(['admin_sessions.id', 'admin_sessions.admin_id', 'admin_sessions.expires_at', 'platform_admins.status'])
      .where('admin_sessions.token_hash', '=', hash)
      .executeTakeFirst();
    if (!row || row.expires_at.getTime() < Date.now() || row.status !== 'active') return null;
    auth = { kind: 'admin', adminId: row.admin_id, sessionId: row.id };
  }

  if (auth) remember(hash, auth);
  return auth;
}

export function bearerToken(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  return header.slice(7).trim() || null;
}

/** Populates req.auth on every request. Routes decide what kind of principal they accept. */
export function registerAuth(app: FastifyInstance, ctx: AppContext): void {
  app.decorateRequest('auth', null);
  app.addHook('onRequest', async (req) => {
    const token = bearerToken(req);
    req.auth = token ? await authenticate(ctx, token) : null;
  });
}

export function requireStaff(req: FastifyRequest): StaffAuth {
  if (req.auth?.kind !== 'staff') throw unauthorized();
  return req.auth;
}

export function requireGuest(req: FastifyRequest): GuestAuth {
  if (req.auth?.kind !== 'guest') throw unauthorized('Scan the table QR code again');
  return req.auth;
}

export function requireDevice(req: FastifyRequest, kind?: DeviceAuth['deviceKind']): DeviceAuth {
  if (req.auth?.kind !== 'device' || (kind && req.auth.deviceKind !== kind)) throw unauthorized();
  return req.auth;
}

export function requireAdmin(req: FastifyRequest): AdminAuth {
  if (req.auth?.kind !== 'admin') throw unauthorized();
  return req.auth;
}

/**
 * A linked product with `scope`. Before the link is complete only the `link` scope works, so a key
 * that leaks while it waits to be pasted cannot read anything.
 */
export function requireIntegration(req: FastifyRequest, scope: string): IntegrationAuth {
  if (req.auth?.kind !== 'integration') throw unauthorized();
  if (!req.auth.scopes.includes(scope)) throw forbidden();
  if (req.auth.status !== 'active' && scope !== 'link') throw new AppError(409, 'link_incomplete', 'Finish connecting the link first');
  return req.auth;
}

/** Throws 403 unless the staff member is a tenant-wide owner. */
export function assertTenantOwner(auth: StaffAuth): void {
  if (!auth.roles.some((r) => r.outletId === null && r.role === 'owner')) throw forbidden('Only the owner can do this');
}

export function rolesAt(auth: StaffAuth, outletId: string): Role[] {
  return auth.roles.filter((r) => r.outletId === null || r.outletId === outletId).map((r) => r.role);
}

export function can(auth: StaffAuth, outletId: string, action: Action): boolean {
  return rolesCan(rolesAt(auth, outletId), action);
}

/** Throws 403 unless the staff member may perform `action` at `outletId`. */
export function assertCan(auth: StaffAuth, outletId: string, action: Action): void {
  if (!can(auth, outletId, action)) throw forbidden();
}

/** Throws 403 unless the staff member holds any role at `outletId`. */
export function assertOutletAccess(auth: StaffAuth, outletId: string): void {
  if (rolesAt(auth, outletId).length === 0) throw forbidden();
}

/** Staff principal allowed to perform `action` at `outletId`, or 403. */
export function requireAction(req: FastifyRequest, outletId: string, action: Action): StaffAuth {
  const auth = requireStaff(req);
  if (!can(auth, outletId, action)) throw forbidden();
  return auth;
}

export function isTenantWide(auth: StaffAuth): boolean {
  return auth.roles.some((r) => r.outletId === null);
}

/** Outlets this staff member can see: all of them for tenant-wide roles. */
export async function accessibleOutletIds(tx: Tx, auth: StaffAuth): Promise<string[]> {
  if (isTenantWide(auth)) {
    const rows = await tx.db.selectFrom('outlets').select('id').execute();
    return rows.map((r) => r.id);
  }
  return [...new Set(auth.roles.map((r) => r.outletId).filter((id): id is string => id !== null))];
}

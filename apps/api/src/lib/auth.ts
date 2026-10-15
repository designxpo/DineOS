import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sql } from 'kysely';
import type { Role } from '@dineos/shared/enums';
import { rolesCan, type Action } from '@dineos/shared/permissions';
import type { AppContext, Tx } from '../context';
import { sha256 } from './crypto';
import { AppError, forbidden, unauthorized } from './errors';
import { verifyGuestToken } from './tokens';

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
export type Auth = StaffAuth | GuestAuth | DeviceAuth | AdminAuth;

declare module 'fastify' {
  interface FastifyRequest {
    auth: Auth | null;
  }
}

// Short cache so every request does not cost two extra queries. Logout evicts locally; other
// nodes notice within the TTL.
const CACHE_TTL_MS = 15_000;
const cache = new Map<string, { auth: Auth; at: number }>();

export function evictCachedAuth(token: string): void {
  cache.delete(sha256(token));
}

export function clearAuthCache(): void {
  cache.clear();
}

const tenantStatusCache = new Map<string, { status: string; at: number }>();

async function tenantStatus(ctx: AppContext, tenantId: string): Promise<string | null> {
  const hit = tenantStatusCache.get(tenantId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.status;
  const { rows } = await sql<{ status: string | null }>`select auth_tenant_status(${tenantId}) as status`.execute(ctx.db);
  const status = rows[0]?.status ?? null;
  if (status) tenantStatusCache.set(tenantId, { status, at: Date.now() });
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
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.auth;

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

  if (auth) cache.set(hash, { auth, at: Date.now() });
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

export function rolesAt(auth: StaffAuth, outletId: string): Role[] {
  return auth.roles.filter((r) => r.outletId === null || r.outletId === outletId).map((r) => r.role);
}

export function can(auth: StaffAuth, outletId: string, action: Action): boolean {
  return rolesCan(rolesAt(auth, outletId), action);
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

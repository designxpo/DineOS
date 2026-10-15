import type { MeDTO } from '@dineos/shared/dto';
import type { Role } from '@dineos/shared/enums';
import { looksLikeEmail, normalizePhone } from '@dineos/shared/phone';
import type { Tx } from '../../context';
import { accessibleOutletIds, rolesAt, type StaffAuth } from '../../lib/auth';
import { randomToken, sha256 } from '../../lib/crypto';

export const STAFF_SESSION_DAYS = 30;

/** Finds an active user in the current tenant by email or phone. */
export function findUserByLogin(tx: Tx, login: string) {
  const q = tx.db.selectFrom('users').selectAll().where('status', '=', 'active');
  return looksLikeEmail(login)
    ? q.where((eb) => eb(eb.fn('lower', ['email']), '=', login.trim().toLowerCase())).executeTakeFirst()
    : q.where('phone', '=', normalizePhone(login)).executeTakeFirst();
}

export async function createStaffSession(
  tx: Tx,
  userId: string,
  opts: { userAgent?: string | null; impersonatedBy?: string | null; ttlMs?: number } = {},
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomToken('st');
  const expiresAt = new Date(Date.now() + (opts.ttlMs ?? STAFF_SESSION_DAYS * 86_400_000));
  await tx.db
    .insertInto('user_sessions')
    .values({
      tenant_id: tx.tenantId,
      user_id: userId,
      token_hash: sha256(token),
      expires_at: expiresAt,
      impersonated_by: opts.impersonatedBy ?? null,
      user_agent: opts.userAgent?.slice(0, 200) ?? null,
    })
    .execute();
  return { token, expiresAt };
}

export async function buildMe(tx: Tx, auth: StaffAuth): Promise<MeDTO> {
  const user = await tx.db
    .selectFrom('users')
    .select(['id', 'name', 'email', 'phone'])
    .where('id', '=', auth.userId)
    .executeTakeFirstOrThrow();
  const tenant = await tx.db
    .selectFrom('tenants')
    .select(['id', 'name', 'slug', 'status', 'branding'])
    .where('id', '=', auth.tenantId)
    .executeTakeFirstOrThrow();
  const outletIds = await accessibleOutletIds(tx, auth);
  const outlets = outletIds.length
    ? await tx.db.selectFrom('outlets').select(['id', 'name']).where('id', 'in', outletIds).orderBy('name').execute()
    : [];
  return {
    user,
    tenant: { ...tenant, branding: (tenant.branding ?? {}) as MeDTO['tenant']['branding'] },
    outlets: outlets.map((o) => ({ id: o.id, name: o.name, roles: [...new Set(rolesAt(auth, o.id))] as Role[] })),
    tenant_roles: auth.roles.filter((r) => r.outletId === null).map((r) => r.role),
    impersonated_by: auth.impersonatedBy,
  };
}

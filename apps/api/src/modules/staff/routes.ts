import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { ROLES, type Role } from '@mezmitra/shared/enums';
import { normalizePhone } from '@mezmitra/shared/phone';
import type { AppContext, Tx } from '../../context';
import { audit } from '../../lib/audit';
import { can, clearAuthCache, isTenantWide, requireStaff, rolesAt, type StaffAuth } from '../../lib/auth';
import { hashSecret } from '../../lib/crypto';
import { badRequest, forbidden, notFound } from '../../lib/errors';
import { idParams, parse } from '../../lib/validate';

const roleGrant = z.object({ outlet_id: z.uuid().nullable(), role: z.enum(ROLES) });
const staffFields = {
  name: z.string().trim().min(1).max(80),
  email: z.email().trim().toLowerCase().nullable().optional(),
  phone: z.string().trim().min(10).max(16).nullable().optional(),
  password: z.string().min(8, 'Use at least 8 characters').max(200),
  roles: z.array(roleGrant).min(1).max(20),
};
const createBody = z.object(staffFields).refine((b) => b.email || b.phone, { message: 'Give an email or a phone number', path: ['email'] });
const updateBody = z.object({ ...staffFields, status: z.enum(['active', 'disabled']) }).partial();

function isOwner(auth: StaffAuth) {
  return auth.roles.some((r) => r.outletId === null && r.role === 'owner');
}

/**
 * Owners grant anything. Managers grant cashier, waiter and kitchen at outlets they manage, never
 * tenant-wide roles and never owner or manager.
 */
function assertCanGrant(auth: StaffAuth, grants: { outlet_id: string | null; role: Role }[]): void {
  if (isOwner(auth)) return;
  for (const g of grants) {
    if (g.outlet_id === null) throw forbidden('Only the owner can give access to every outlet');
    if (g.role === 'owner' || g.role === 'manager') throw forbidden('Only the owner can add managers');
    if (!can(auth, g.outlet_id, 'staff.manage')) throw forbidden();
  }
}

async function staffList(tx: Tx, ids?: string[]) {
  let q = tx.db.selectFrom('users').select(['id', 'name', 'email', 'phone', 'status', 'created_at', 'pin_hash']);
  if (ids) q = q.where('id', 'in', ids);
  const users = await q.orderBy('name').execute();
  if (users.length === 0) return [];
  const roles = await tx.db
    .selectFrom('user_outlet_roles')
    .select(['user_id', 'outlet_id', 'role'])
    .where('user_id', 'in', users.map((u) => u.id))
    .execute();
  return users.map(({ pin_hash, ...u }) => ({
    ...u,
    has_pin: !!pin_hash,
    created_at: u.created_at.toISOString(),
    roles: roles.filter((r) => r.user_id === u.id).map((r) => ({ outlet_id: r.outlet_id, role: r.role as Role })),
  }));
}

async function setRoles(tx: Tx, userId: string, grants: { outlet_id: string | null; role: Role }[]) {
  const unique = [...new Map(grants.map((g) => [`${g.outlet_id}:${g.role}`, g])).values()];
  const outletIds = [...new Set(unique.map((g) => g.outlet_id).filter((x): x is string => !!x))];
  if (outletIds.length) {
    const found = await tx.db.selectFrom('outlets').select('id').where('id', 'in', outletIds).execute();
    if (found.length !== outletIds.length) throw badRequest('invalid_outlet', 'Unknown outlet');
  }
  await tx.db.deleteFrom('user_outlet_roles').where('user_id', '=', userId).execute();
  await tx.db
    .insertInto('user_outlet_roles')
    .values(unique.map((g) => ({ tenant_id: tx.tenantId, user_id: userId, outlet_id: g.outlet_id, role: g.role })))
    .execute();
}

export default function routes(ctx: AppContext): FastifyPluginAsync {
  return async (app) => {
    app.get('/staff', async (req) => {
      const auth = requireStaff(req);
      const q = parse(z.object({ outlet_id: z.uuid().optional() }), req.query);
      if (q.outlet_id ? !can(auth, q.outlet_id, 'staff.manage') : !isTenantWide(auth)) {
        // Waiter pickers etc. only need names: anyone at the outlet may list active colleagues.
        if (!q.outlet_id || rolesAt(auth, q.outlet_id).length === 0) throw forbidden();
        return ctx.tx(auth.tenantId, async (tx) => {
          const all = await staffList(tx);
          return all
            .filter((u) => u.status === 'active' && u.roles.some((r) => r.outlet_id === null || r.outlet_id === q.outlet_id))
            .map((u) => ({ id: u.id, name: u.name, roles: u.roles.filter((r) => r.outlet_id === null || r.outlet_id === q.outlet_id) }));
        });
      }
      return ctx.tx(auth.tenantId, async (tx) => {
        const all = await staffList(tx);
        return q.outlet_id ? all.filter((u) => u.roles.some((r) => r.outlet_id === null || r.outlet_id === q.outlet_id)) : all;
      });
    });

    app.post('/staff', async (req, reply) => {
      const auth = requireStaff(req);
      const body = parse(createBody, req.body);
      assertCanGrant(auth, body.roles);
      const user = await ctx.tx(auth.tenantId, async (tx) => {
        const row = await tx.db
          .insertInto('users')
          .values({
            tenant_id: tx.tenantId,
            name: body.name,
            email: body.email ?? null,
            phone: body.phone ? normalizePhone(body.phone) : null,
            password_hash: await hashSecret(body.password),
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        await setRoles(tx, row.id, body.roles);
        await audit(tx, auth, { action: 'staff.create', entity: 'user', entityId: row.id, after: { name: body.name, roles: body.roles } });
        return (await staffList(tx, [row.id]))[0];
      });
      return reply.status(201).send(user);
    });

    app.patch('/staff/:id', async (req) => {
      const auth = requireStaff(req);
      const { id } = parse(idParams, req.params);
      const body = parse(updateBody, req.body);
      return ctx.tx(auth.tenantId, async (tx) => {
        const [target] = await staffList(tx, [id]);
        if (!target) throw notFound('Staff member');
        // Managers cannot touch owners or other managers, nor staff at outlets they do not manage.
        // Re-sending the same roles is not a change (the editor always sends them).
        const key = (rs: { outlet_id: string | null; role: string }[]) => rs.map((r) => `${r.outlet_id}:${r.role}`).sort().join('|');
        if (body.roles && key(body.roles) === key(target.roles)) delete body.roles;
        if (id !== auth.userId) assertCanGrant(auth, target.roles);
        if (body.roles) assertCanGrant(auth, body.roles);
        if (id === auth.userId && (body.status === 'disabled' || body.roles)) {
          throw badRequest('self_change', 'You cannot disable yourself or change your own roles');
        }
        if (target.roles.some((r) => r.role === 'owner') && body.roles && !body.roles.some((r) => r.role === 'owner' && r.outlet_id === null)) {
          const owners = await tx.db.selectFrom('user_outlet_roles').select('user_id').where('role', '=', 'owner').where('outlet_id', 'is', null).execute();
          if (owners.length <= 1) throw badRequest('last_owner', 'The account needs at least one owner');
        }
        await tx.db
          .updateTable('users')
          .set({
            ...(body.name ? { name: body.name } : {}),
            ...(body.email !== undefined ? { email: body.email } : {}),
            ...(body.phone !== undefined ? { phone: body.phone ? normalizePhone(body.phone) : null } : {}),
            ...(body.status ? { status: body.status } : {}),
            ...(body.password ? { password_hash: await hashSecret(body.password) } : {}),
          })
          .where('id', '=', id)
          .execute();
        if (body.roles) await setRoles(tx, id, body.roles);
        // Disabling or a new password signs the person out everywhere.
        if (body.status === 'disabled' || body.password) {
          await tx.db.deleteFrom('user_sessions').where('user_id', '=', id).execute();
          clearAuthCache();
        }
        if (body.roles) clearAuthCache();
        await audit(tx, auth, {
          action: 'staff.update',
          entity: 'user',
          entityId: id,
          before: { status: target.status, roles: target.roles },
          after: { status: body.status ?? target.status, roles: body.roles ?? target.roles, password_changed: !!body.password },
        });
        return (await staffList(tx, [id]))[0];
      });
    });
  };
}

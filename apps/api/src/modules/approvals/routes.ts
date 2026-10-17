import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { MANAGER_APPROVAL_ACTIONS, PIN_LOCK_MINUTES, PIN_MAX_ATTEMPTS, rolesCan } from '@mezmitra/shared/permissions';
import type { Role } from '@mezmitra/shared/enums';
import type { AppContext } from '../../context';
import { audit } from '../../lib/audit';
import { requireStaff } from '../../lib/auth';
import { hashSecret, randomToken, sha256, verifySecret } from '../../lib/crypto';
import { AppError } from '../../lib/errors';
import { parse } from '../../lib/validate';
import { findUserByLogin } from '../auth/service';

const body = z.object({
  outlet_id: z.uuid(),
  action: z.enum(MANAGER_APPROVAL_ACTIONS),
  login: z.string().min(3),
  pin: z.string().regex(/^\d{4,6}$/),
});

const APPROVAL_TTL_MS = 2 * 60_000;
const PIN_LOCK_MS = PIN_LOCK_MINUTES * 60_000;

const denied = () => new AppError(403, 'approval_denied', 'Wrong manager login or PIN');
const lockedError = (name: string, until: Date) =>
  new AppError(423, 'pin_locked', `${name}'s PIN is locked after too many wrong tries. Ask another manager, or try again in ${PIN_LOCK_MINUTES} minutes.`, {
    locked_until: until.toISOString(),
  });

// A login with no PIN still costs one scrypt check, so timing does not tell which logins exist.
let dummyHash: Promise<string> | null = null;

type Outcome = { error: AppError } | { approval: { approval_token: string; approver: { id: string; name: string }; expires_at: string } };

export default function routes(ctx: AppContext): FastifyPluginAsync {
  return async (app) => {
    /**
     * A manager types their phone/email and PIN on the cashier's screen. Returns a single-use
     * token the cashier sends as X-Approval-Token with the void, refund or cancel request.
     * Five wrong PINs in a row lock that manager's PIN for a while and tell the owner; the count
     * is kept on the manager, so switching devices or networks does not reset it.
     */
    app.post('/approvals', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
      const auth = requireStaff(req);
      const input = parse(body, req.body);
      // Wrong guesses are stored before the error is returned, so the count survives it.
      const outcome = await ctx.tx(auth.tenantId, async (tx): Promise<Outcome> => {
        const approver = await findUserByLogin(tx, input.login);
        if (!approver?.pin_hash) {
          await verifySecret(input.pin, await (dummyHash ??= hashSecret('mezmitra-no-pin')));
          return { error: denied() };
        }
        const state = await tx.db
          .selectFrom('users')
          .select(['pin_failed_attempts', 'pin_locked_until'])
          .where('id', '=', approver.id)
          .forUpdate()
          .executeTakeFirstOrThrow();
        const now = Date.now();
        if (state.pin_locked_until && state.pin_locked_until.getTime() > now) return { error: lockedError(approver.name, state.pin_locked_until) };

        if (!(await verifySecret(input.pin, approver.pin_hash))) {
          // A lock that has run out starts a fresh count.
          const attempts = (state.pin_locked_until ? 0 : state.pin_failed_attempts) + 1;
          if (attempts < PIN_MAX_ATTEMPTS) {
            await tx.db.updateTable('users').set({ pin_failed_attempts: attempts, pin_locked_until: null }).where('id', '=', approver.id).execute();
            return { error: denied() };
          }
          const until = new Date(now + PIN_LOCK_MS);
          await tx.db.updateTable('users').set({ pin_failed_attempts: 0, pin_locked_until: until }).where('id', '=', approver.id).execute();
          const requester = await tx.db.selectFrom('users').select('name').where('id', '=', auth.userId).executeTakeFirst();
          await audit(tx, auth, {
            outletId: input.outlet_id,
            action: 'approval.pin_locked',
            entity: 'user',
            entityId: approver.id,
            reason: `${PIN_MAX_ATTEMPTS} wrong PINs in a row while asking to approve ${input.action}`,
          });
          await tx.emit({
            outletId: input.outlet_id,
            type: 'staff.pin_locked',
            channels: ['outlet'],
            payload: { user_id: approver.id, user_name: approver.name, requested_by: auth.userId, requested_by_name: requester?.name ?? null, action: input.action, locked_until: until.toISOString() },
          });
          return { error: lockedError(approver.name, until) };
        }

        if (state.pin_failed_attempts > 0 || state.pin_locked_until) {
          await tx.db.updateTable('users').set({ pin_failed_attempts: 0, pin_locked_until: null }).where('id', '=', approver.id).execute();
        }
        const roles = await tx.db
          .selectFrom('user_outlet_roles')
          .select('role')
          .where('user_id', '=', approver.id)
          .where((eb) => eb.or([eb('outlet_id', 'is', null), eb('outlet_id', '=', input.outlet_id)]))
          .execute();
        if (!rolesCan(roles.map((r) => r.role as Role), input.action)) {
          return { error: new AppError(403, 'approval_denied', `${approver.name} cannot approve this`) };
        }
        const token = randomToken('ap');
        const expiresAt = new Date(now + APPROVAL_TTL_MS);
        await tx.db
          .insertInto('approval_tokens')
          .values({
            tenant_id: tx.tenantId,
            outlet_id: input.outlet_id,
            approver_id: approver.id,
            requested_by: auth.userId,
            action: input.action,
            token_hash: sha256(token),
            expires_at: expiresAt,
          })
          .execute();
        return { approval: { approval_token: token, approver: { id: approver.id, name: approver.name }, expires_at: expiresAt.toISOString() } };
      });
      if ('error' in outcome) throw outcome.error;
      return outcome.approval;
    });
  };
}

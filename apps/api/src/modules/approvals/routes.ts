import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { MANAGER_APPROVAL_ACTIONS, rolesCan } from '@dineos/shared/permissions';
import type { Role } from '@dineos/shared/enums';
import type { AppContext } from '../../context';
import { requireStaff } from '../../lib/auth';
import { randomToken, sha256, verifySecret } from '../../lib/crypto';
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

export default function routes(ctx: AppContext): FastifyPluginAsync {
  return async (app) => {
    /**
     * A manager types their phone/email and PIN on the cashier's screen. Returns a single-use
     * token the cashier sends as X-Approval-Token with the void, refund or cancel request.
     */
    app.post('/approvals', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
      const auth = requireStaff(req);
      const input = parse(body, req.body);
      return ctx.tx(auth.tenantId, async (tx) => {
        const approver = await findUserByLogin(tx, input.login);
        const ok = approver?.pin_hash ? await verifySecret(input.pin, approver.pin_hash) : false;
        if (!approver || !ok) throw new AppError(403, 'approval_denied', 'Wrong manager login or PIN');
        const roles = await tx.db
          .selectFrom('user_outlet_roles')
          .select('role')
          .where('user_id', '=', approver.id)
          .where((eb) => eb.or([eb('outlet_id', 'is', null), eb('outlet_id', '=', input.outlet_id)]))
          .execute();
        if (!rolesCan(roles.map((r) => r.role as Role), input.action)) {
          throw new AppError(403, 'approval_denied', `${approver.name} cannot approve this`);
        }
        const token = randomToken('ap');
        const expiresAt = new Date(Date.now() + APPROVAL_TTL_MS);
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
        return { approval_token: token, approver: { id: approver.id, name: approver.name }, expires_at: expiresAt.toISOString() };
      });
    });
  };
}

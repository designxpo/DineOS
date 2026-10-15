import type { FastifyPluginAsync } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';
import type { LoginResponseDTO } from '@dineos/shared/dto';
import type { AppContext } from '../../context';
import { authenticate, bearerToken, evictCachedAuth, requireStaff, type StaffAuth } from '../../lib/auth';
import { hashSecret, verifySecret } from '../../lib/crypto';
import { AppError, unauthorized } from '../../lib/errors';
import { parse } from '../../lib/validate';
import { buildMe, createStaffSession, findUserByLogin } from './service';

const loginBody = z.object({
  tenant_slug: z.string().min(1).max(60),
  login: z.string().min(3).max(200),
  password: z.string().min(1).max(200),
});

const pinBody = z.object({
  password: z.string().min(1),
  pin: z.string().regex(/^\d{4,6}$/, 'PIN must be 4 to 6 digits'),
});

export default function routes(ctx: AppContext): FastifyPluginAsync {
  return async (app) => {
    app.post('/auth/login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req): Promise<LoginResponseDTO> => {
      const body = parse(loginBody, req.body);
      const { rows } = await sql<{ id: string; status: string }>`select id, status from auth_tenant_by_slug(${body.tenant_slug})`.execute(ctx.db);
      const tenant = rows[0];
      if (!tenant) throw new AppError(401, 'invalid_credentials', 'Wrong restaurant code, login or password');
      if (tenant.status === 'suspended') throw new AppError(403, 'tenant_suspended', 'This account is suspended. Contact support.');
      if (tenant.status !== 'active') throw new AppError(401, 'invalid_credentials', 'Wrong restaurant code, login or password');

      const session = await ctx.tx(tenant.id, async (tx) => {
        const user = await findUserByLogin(tx, body.login);
        if (!user || !(await verifySecret(body.password, user.password_hash))) return null;
        return createStaffSession(tx, user.id, { userAgent: req.headers['user-agent'] ?? null });
      });
      if (!session) throw new AppError(401, 'invalid_credentials', 'Wrong restaurant code, login or password');

      const auth = (await authenticate(ctx, session.token)) as StaffAuth;
      const me = await ctx.tx(tenant.id, (tx) => buildMe(tx, auth));
      return { token: session.token, expires_at: session.expiresAt.toISOString(), me };
    });

    app.post('/auth/logout', async (req, reply) => {
      const auth = requireStaff(req);
      const token = bearerToken(req)!;
      await ctx.tx(auth.tenantId, (tx) => tx.db.deleteFrom('user_sessions').where('id', '=', auth.sessionId).execute());
      evictCachedAuth(token);
      return reply.status(204).send();
    });

    app.get('/auth/me', async (req) => {
      const auth = requireStaff(req);
      return ctx.tx(auth.tenantId, (tx) => buildMe(tx, auth));
    });

    app.post('/auth/pin', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
      const auth = requireStaff(req);
      const body = parse(pinBody, req.body);
      await ctx.tx(auth.tenantId, async (tx) => {
        const user = await tx.db.selectFrom('users').select('password_hash').where('id', '=', auth.userId).executeTakeFirstOrThrow();
        if (!(await verifySecret(body.password, user.password_hash))) throw unauthorized('Password is incorrect');
        await tx.db.updateTable('users').set({ pin_hash: await hashSecret(body.pin) }).where('id', '=', auth.userId).execute();
      });
      return reply.status(204).send();
    });
  };
}

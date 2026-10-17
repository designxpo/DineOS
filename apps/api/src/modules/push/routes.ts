import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../context';
import { accessibleOutletIds, requireStaff } from '../../lib/auth';
import { AppError, forbidden } from '../../lib/errors';
import { parse } from '../../lib/validate';

const subscription = z.object({
  outlet_id: z.uuid(),
  endpoint: z.string().max(1000).refine((u) => /^https:\/\/[^\s]+$/.test(u), 'Push endpoints use https'),
  keys: z.object({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(100) }),
});

export default function routes(ctx: AppContext): FastifyPluginAsync {
  return async (app) => {
    /** The VAPID public key the browser subscribes with. */
    app.get('/push/config', async (req) => {
      requireStaff(req);
      if (!ctx.push) throw new AppError(404, 'push_unavailable', 'Phone alerts are not set up');
      return { public_key: ctx.push.publicKey };
    });

    /** Turns alerts on for this device, for one outlet. */
    app.post('/push/subscriptions', async (req, reply) => {
      const auth = requireStaff(req);
      const body = parse(subscription, req.body);
      await ctx.tx(auth.tenantId, async (tx) => {
        if (!(await accessibleOutletIds(tx, auth)).includes(body.outlet_id)) throw forbidden('You do not work at this outlet');
      });
      // An endpoint belongs to the browser, so a phone shared between accounts (or restaurants)
      // moves to whoever turned alerts on last.
      await ctx.adminDb.deleteFrom('push_subscriptions').where('endpoint', '=', body.endpoint).execute();
      await ctx.tx(auth.tenantId, (tx) =>
        tx.db
          .insertInto('push_subscriptions')
          .values({ tenant_id: tx.tenantId, user_id: auth.userId, outlet_id: body.outlet_id, endpoint: body.endpoint, p256dh: body.keys.p256dh, auth: body.keys.auth })
          .execute(),
      );
      return reply.status(201).send({ ok: true });
    });

    /** Turns alerts off for this device. Only its owner's rows go. */
    app.delete('/push/subscriptions', async (req, reply) => {
      const auth = requireStaff(req);
      const body = parse(z.object({ endpoint: z.string().max(1000) }), req.body);
      await ctx.tx(auth.tenantId, (tx) => tx.db.deleteFrom('push_subscriptions').where('endpoint', '=', body.endpoint).where('user_id', '=', auth.userId).execute());
      return reply.status(204).send();
    });
  };
}

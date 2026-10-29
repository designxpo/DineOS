import { timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import type { AppContext } from '../../context';
import { notFound, unauthorized } from '../../lib/errors';
import { runMaintenance } from '../../lib/maintenance';
import { runTalkoJobs } from '../integrations/outbox';

/**
 * Housekeeping for hosts without an always-on process: Vercel Cron calls this with
 * `Authorization: Bearer $CRON_SECRET`. The route does not exist unless CRON_SECRET is set.
 */
export default function routes(ctx: AppContext): FastifyPluginAsync {
  return async (app) => {
    app.get('/internal/maintenance', async (req) => {
      const secret = ctx.config.CRON_SECRET;
      if (!secret) throw notFound('Route');
      const given = Buffer.from(req.headers.authorization ?? '');
      const expected = Buffer.from(`Bearer ${secret}`);
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw unauthorized();
      const result = await runMaintenance(ctx.adminDb);
      const talko = await runTalkoJobs(ctx);
      // null: another instance holds the lock and is doing the same work.
      return { ran: result !== null, result, talko };
    });
  };
}

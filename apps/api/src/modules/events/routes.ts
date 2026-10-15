import type { FastifyPluginAsync } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';
import type { Channel, EventType, OutletEvent } from '@dineos/shared/events';
import type { AppContext, Tx } from '../../context';
import { accessibleOutletIds, requireGuest, requireStaff } from '../../lib/auth';
import { forbidden } from '../../lib/errors';
import { parse } from '../../lib/validate';

const MAX_EVENTS = 500;

async function eventsSince(tx: Tx, outletId: string, since: number, channels: string[]) {
  const rows = await tx.db
    .selectFrom('outlet_events')
    .select(['outlet_id', 'seq', 'type', 'channels', 'payload', 'created_at'])
    .where('outlet_id', '=', outletId)
    .where('seq', '>', since)
    .where(sql<boolean>`channels && ${sql.val(channels)}::text[]`)
    .orderBy('seq')
    .limit(MAX_EVENTS + 1)
    .execute();
  const last = await tx.db.selectFrom('outlets').select('event_seq').where('id', '=', outletId).executeTakeFirstOrThrow();
  const events: OutletEvent[] = rows.slice(0, MAX_EVENTS).map((r) => ({
    outlet_id: r.outlet_id,
    seq: r.seq,
    type: r.type as EventType,
    channels: r.channels as Channel[],
    payload: r.payload,
    at: r.created_at.toISOString(),
  }));
  // When truncated the client should refetch its screens rather than replay.
  return { events, last_seq: last.event_seq, truncated: rows.length > MAX_EVENTS };
}

export default function routes(ctx: AppContext): FastifyPluginAsync {
  return async (app) => {
    /** Missed-event replay for staff screens after a reconnect (spec §9). */
    app.get('/events', async (req) => {
      const auth = requireStaff(req);
      const q = parse(z.object({ outlet_id: z.uuid(), since: z.coerce.number().int().min(0) }), req.query);
      return ctx.tx(auth.tenantId, async (tx) => {
        if (!(await accessibleOutletIds(tx, auth)).includes(q.outlet_id)) throw forbidden();
        return eventsSince(tx, q.outlet_id, q.since, ['outlet']);
      });
    });

    app.get('/guest/events', async (req) => {
      const auth = requireGuest(req);
      const q = parse(z.object({ since: z.coerce.number().int().min(0) }), req.query);
      return ctx.tx(auth.tenantId, (tx) => eventsSince(tx, auth.outletId, q.since, [`session:${auth.sessionId}`, 'menu']));
    });
  };
}

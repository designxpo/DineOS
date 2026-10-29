import type { FastifyInstance } from 'fastify';
import { sql, type RawBuilder } from 'kysely';
import type { Json } from '../db/schema';
import type { AppContext } from '../context';
import { sha256 } from './crypto';
import { AppError, badRequest, conflict } from './errors';

declare module 'fastify' {
  interface FastifyRequest {
    idempotency?: { tenantId: string; actor: string; key: string };
  }
}

const MUTATING = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);
const STALE_CLAIM_MS = 60_000;

/**
 * Honours the Idempotency-Key header on mutating requests (spec §9). The first request claims the
 * key; a retry with the same key and body replays the stored response; a different body is a 422.
 * Offline POS queues rely on this to replay safely after a network drop.
 */
export function registerIdempotency(app: FastifyInstance, ctx: AppContext): void {
  app.addHook('preHandler', async (req, reply) => {
    const key = req.headers['idempotency-key'];
    if (key === undefined || !MUTATING.has(req.method)) return;
    const auth = req.auth;
    if (!auth || auth.kind === 'admin') return;
    if (typeof key !== 'string' || key.length < 8 || key.length > 100) {
      throw badRequest('invalid_idempotency_key', 'Idempotency-Key must be 8 to 100 characters');
    }
    const actor =
      auth.kind === 'staff'
        ? `user:${auth.userId}`
        : auth.kind === 'guest'
          ? `guest:${auth.deviceId}`
          : auth.kind === 'integration'
            ? `link:${auth.linkId}`
            : `device:${auth.deviceId}`;
    const requestHash = sha256(`${req.method} ${req.url} ${JSON.stringify(req.body ?? null)}`);

    const existing = await ctx.tx(auth.tenantId, async (tx) => {
      const claimed = await tx.db
        .insertInto('idempotency_keys')
        .values({ tenant_id: auth.tenantId, key, actor, method: req.method, path: req.url, request_hash: requestHash })
        .onConflict((oc) => oc.columns(['tenant_id', 'actor', 'key']).doNothing())
        .returning('key')
        .executeTakeFirst();
      if (claimed) return null;
      // A claim left behind by a crashed request can be taken over after a minute.
      const reclaimed = await tx.db
        .updateTable('idempotency_keys')
        .set({ created_at: new Date(), request_hash: requestHash })
        .where('tenant_id', '=', auth.tenantId)
        .where('actor', '=', actor)
        .where('key', '=', key)
        .where('status_code', 'is', null)
        .where('created_at', '<', new Date(Date.now() - STALE_CLAIM_MS))
        .returning('key')
        .executeTakeFirst();
      if (reclaimed) return null;
      return tx.db
        .selectFrom('idempotency_keys')
        .selectAll()
        .where('tenant_id', '=', auth.tenantId)
        .where('actor', '=', actor)
        .where('key', '=', key)
        .executeTakeFirstOrThrow();
    });

    if (!existing) {
      req.idempotency = { tenantId: auth.tenantId, actor, key };
      return;
    }
    if (existing.request_hash !== requestHash) {
      throw new AppError(422, 'idempotency_key_reused', 'This Idempotency-Key was used for a different request');
    }
    if (existing.status_code === null) {
      throw conflict('request_in_progress', 'The original request is still being processed');
    }
    reply.header('idempotent-replayed', 'true');
    return reply.status(existing.status_code).send(existing.response);
  });

  app.addHook('onSend', async (req, reply, payload) => {
    const claim = req.idempotency;
    if (!claim) return payload;
    req.idempotency = undefined;
    await ctx.tx(claim.tenantId, async (tx) => {
      const where = tx.db
        .updateTable('idempotency_keys')
        .where('tenant_id', '=', claim.tenantId)
        .where('actor', '=', claim.actor)
        .where('key', '=', claim.key);
      if (reply.statusCode >= 500) {
        // Let the client retry a server failure with the same key.
        await tx.db
          .deleteFrom('idempotency_keys')
          .where('tenant_id', '=', claim.tenantId)
          .where('actor', '=', claim.actor)
          .where('key', '=', claim.key)
          .execute();
        return;
      }
      const body = typeof payload === 'string' && payload.length < 256_000 ? payload : null;
      let response: RawBuilder<Json> | null = null;
      if (body) {
        try {
          JSON.parse(body);
          response = sql<Json>`${body}::jsonb`;
        } catch {
          // non-JSON response: replay with an empty body
        }
      }
      await where.set({ status_code: reply.statusCode, response }).execute();
    });
    return payload;
  });
}

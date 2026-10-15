import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';
import type { GuestJoinResponseDTO } from '@dineos/shared/dto';
import type { AppContext, Tx } from '../../context';
import { requireGuest } from '../../lib/auth';
import { AppError, conflict, notFound } from '../../lib/errors';
import { signGuestToken, verifyQrToken, type QrClaims } from '../../lib/tokens';
import { parse } from '../../lib/validate';
import { loadMenu } from '../menu/service';
import { createServiceRequest } from '../tables/floor';
import { getOrCreateSession } from '../tables/sessions';
import {
  addCartLine,
  guestContext,
  guestSessionView,
  placeGuestOrder,
  readGuestSession,
  removeCartLines,
  updateCartLine,
} from './service';

const invalidQr = () =>
  new AppError(404, 'invalid_qr', 'This QR code is no longer valid. Please ask a staff member for help.');

const cartLine = z.object({
  item_id: z.uuid(),
  qty: z.number().int().min(1).max(99),
  modifier_ids: z.array(z.uuid()).max(20).default([]),
  note: z.string().max(200).nullable().optional(),
});

export default function routes(ctx: AppContext): FastifyPluginAsync {
  /** Verifies a printed QR token against the live table (active, current version) and tenant. */
  async function checkQr(tx: Tx, claims: QrClaims) {
    const row = await tx.db
      .selectFrom('tables')
      .innerJoin('outlets', 'outlets.id', 'tables.outlet_id')
      .select(['tables.id', 'tables.is_active', 'tables.qr_token_version', 'outlets.status as outlet_status'])
      .where('tables.id', '=', claims.tableId)
      .where('tables.outlet_id', '=', claims.outletId)
      .executeTakeFirst();
    if (!row || !row.is_active || row.qr_token_version !== claims.version || row.outlet_status !== 'active') throw invalidQr();
  }

  async function qrClaims(token: string): Promise<QrClaims> {
    const claims = verifyQrToken(ctx.config.TOKEN_SECRET, token);
    if (!claims) throw invalidQr();
    const { rows } = await sql<{ status: string | null }>`select auth_tenant_status(${claims.tenantId}) as status`.execute(ctx.db);
    if (rows[0]?.status !== 'active') throw new AppError(403, 'outlet_unavailable', 'Ordering is not available here right now.');
    return claims;
  }

  return async (app) => {
    /** Landing page data before joining: who and where. No session is created. */
    app.get('/guest/resolve', async (req) => {
      const { qr } = parse(z.object({ qr: z.string().min(10).max(200) }), req.query);
      const claims = await qrClaims(qr);
      return ctx.tx(claims.tenantId, async (tx) => {
        await checkQr(tx, claims);
        return guestContext(tx, claims.outletId, claims.tableId);
      });
    });

    /** Attaches this phone to the table's current session (creating a pending one if needed). */
    app.post('/guest/join', { config: { rateLimit: { max: ctx.config.GUEST_JOIN_RATE_LIMIT, timeWindow: '1 minute', keyGenerator: (r) => r.ip } } }, async (req): Promise<GuestJoinResponseDTO> => {
      const body = parse(z.object({ qr_token: z.string().min(10).max(200), device_id: z.uuid().optional() }), req.body);
      const claims = await qrClaims(body.qr_token);
      const session = await ctx.tx(claims.tenantId, async (tx) => {
        await checkQr(tx, claims);
        return getOrCreateSession(tx, claims.tableId);
      });
      const deviceId = body.device_id ?? randomUUID();
      const guestToken = signGuestToken(ctx.config.TOKEN_SECRET, {
        tenantId: claims.tenantId,
        outletId: claims.outletId,
        tableId: claims.tableId,
        sessionId: session.id,
        deviceId,
      });
      return { guest_token: guestToken, device_id: deviceId, session_id: session.id };
    });

    /**
     * The guest menu, cacheable by URL. The version in the query changes whenever the menu does,
     * so a CDN or browser can keep a versioned response forever (spec §6: menu under 2 s on 4G).
     */
    app.get('/public/menu/:tenantId/:outletId', async (req, reply) => {
      const p = parse(z.object({ tenantId: z.uuid(), outletId: z.uuid() }), req.params);
      const q = parse(z.object({ v: z.coerce.number().int().optional() }), req.query);
      const { rows } = await sql<{ status: string | null }>`select auth_tenant_status(${p.tenantId}) as status`.execute(ctx.db);
      if (rows[0]?.status !== 'active') throw notFound('Menu');
      const menu = await ctx.tx(p.tenantId, async (tx) => {
        const outlet = await tx.db.selectFrom('outlets').select(['status']).where('id', '=', p.outletId).executeTakeFirst();
        if (!outlet || outlet.status !== 'active') throw notFound('Menu');
        return loadMenu(tx, p.outletId, { forGuest: true });
      });
      // available_now depends on the clock, so even a versioned response is only fresh briefly.
      reply.header(
        'cache-control',
        q.v === menu.menu_version ? 'public, max-age=60, stale-while-revalidate=300' : 'no-cache',
      );
      reply.header('etag', `"menu-${menu.menu_version}-${Math.floor(Date.now() / 60_000)}"`);
      return menu;
    });

    app.get('/guest/session', async (req) => {
      const auth = requireGuest(req);
      return ctx.tx(auth.tenantId, (tx) => guestSessionView(tx, auth));
    });

    app.post('/guest/cart/lines', async (req) => {
      const auth = requireGuest(req);
      const body = parse(cartLine, req.body);
      return ctx.tx(auth.tenantId, (tx) => addCartLine(tx, auth, body));
    });

    app.patch('/guest/cart/lines/:lineId', async (req) => {
      const auth = requireGuest(req);
      const { lineId } = parse(z.object({ lineId: z.uuid() }), req.params);
      const body = parse(z.object({ qty: z.number().int().min(0).max(99).optional(), note: z.string().max(200).nullable().optional() }), req.body);
      return ctx.tx(auth.tenantId, (tx) => updateCartLine(tx, auth, lineId, body));
    });

    app.delete('/guest/cart/lines/:lineId', async (req) => {
      const auth = requireGuest(req);
      const { lineId } = parse(z.object({ lineId: z.uuid() }), req.params);
      return ctx.tx(auth.tenantId, (tx) => removeCartLines(tx, auth, [lineId]));
    });

    app.delete('/guest/cart', async (req) => {
      const auth = requireGuest(req);
      return ctx.tx(auth.tenantId, (tx) => removeCartLines(tx, auth, 'all'));
    });

    app.post('/guest/orders', async (req, reply) => {
      const auth = requireGuest(req);
      const body = parse(z.object({ line_ids: z.array(z.uuid()).max(50).optional(), note: z.string().max(300).nullable().optional() }), req.body);
      const result = await ctx.tx(auth.tenantId, (tx) => placeGuestOrder(tx, auth, body));
      return reply.status(201).send(result);
    });

    app.post('/guest/call-waiter', async (req) => {
      const auth = requireGuest(req);
      return ctx.tx(auth.tenantId, async (tx) => {
        const s = await readGuestSession(tx, auth);
        return createServiceRequest(tx, { outletId: auth.outletId, tableId: s.table_id, sessionId: s.id }, 'call_waiter');
      });
    });

    app.post('/guest/request-bill', async (req) => {
      const auth = requireGuest(req);
      return ctx.tx(auth.tenantId, async (tx) => {
        const s = await readGuestSession(tx, auth);
        if (s.status !== 'open') throw conflict('nothing_to_bill', 'Place an order first');
        return createServiceRequest(tx, { outletId: auth.outletId, tableId: s.table_id, sessionId: s.id }, 'bill');
      });
    });
  };
}

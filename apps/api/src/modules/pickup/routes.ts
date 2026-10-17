// Counter-service cafés: a screen by the counter with the order numbers being made and ready to
// collect, and a link on the receipt that lets the guest follow their order on their phone. Both
// are public and read-only: order numbers and dish names only, no amounts or names.

import { sql } from 'kysely';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { OrderStatus, OrderType } from '@mezmitra/shared/enums';
import type { PickupBoardDTO, TrackedOrderDTO } from '@mezmitra/shared/dto';
import type { AppContext } from '../../context';
import { assertCan, requireStaff } from '../../lib/auth';
import { shownBrand } from '../../lib/branding';
import { notFound } from '../../lib/errors';
import { pickupUrl } from '../../lib/links';
import { verifyPickupToken } from '../../lib/tokens';
import { idParams, parse } from '../../lib/validate';

/** Ready orders leave the screen once collected (served), or after this long if nobody marks them. */
const READY_SHOWN_MS = 30 * 60_000;
/** Orders older than this are not "being made" any more, whatever their status. */
const BOARD_WINDOW_MS = 6 * 3600_000;
const COUNTER_TYPES: OrderType[] = ['takeaway', 'counter', 'delivery'];
const CHANNEL: Record<string, string> = { zomato: 'Zomato', swiggy: 'Swiggy', own: 'Delivery' };

const publicLimit = { rateLimit: { max: 120, timeWindow: '1 minute' } };

export default function routes(ctx: AppContext): FastifyPluginAsync {
  async function tenantActive(tenantId: string): Promise<boolean> {
    const { rows } = await sql<{ status: string | null }>`select auth_tenant_status(${tenantId}) as status`.execute(ctx.db);
    return rows[0]?.status === 'active';
  }

  return async (app) => {
    /** The pickup screen: counter, takeaway and delivery orders, being made and ready. */
    app.get('/public/pickup/:token', { config: publicLimit }, async (req, reply): Promise<PickupBoardDTO> => {
      const { token } = parse(z.object({ token: z.string().min(20).max(120) }), req.params);
      const claims = verifyPickupToken(ctx.config.TOKEN_SECRET, token);
      if (!claims || !(await tenantActive(claims.tenantId))) throw notFound('Pickup screen');
      reply.header('cache-control', 'no-store');
      return ctx.tx(claims.tenantId, async (tx) => {
        const outlet = await tx.db.selectFrom('outlets').select(['name', 'status', 'pickup_link_version']).where('id', '=', claims.outletId).executeTakeFirst();
        if (!outlet || outlet.status !== 'active' || outlet.pickup_link_version !== claims.version) throw notFound('Pickup screen');
        const now = Date.now();
        const orders = await tx.db
          .selectFrom('orders')
          .select(['order_no', 'status', 'type', 'channel', 'channel_ref', 'ready_at'])
          .where('outlet_id', '=', claims.outletId)
          .where('type', 'in', COUNTER_TYPES)
          .where('status', 'in', ['accepted', 'preparing', 'ready'])
          .where('placed_at', '>', new Date(now - BOARD_WINDOW_MS))
          .orderBy('placed_at')
          .limit(200)
          .execute();
        const label = (o: (typeof orders)[number]) => (o.type === 'delivery' && o.channel ? `${CHANNEL[o.channel] ?? o.channel}${o.channel_ref ? ` #${o.channel_ref}` : ''}` : null);
        const brand = await shownBrand(tx);
        return {
          outlet_name: outlet.name,
          tenant_name: brand.name,
          branding: brand.branding,
          preparing: orders.filter((o) => o.status !== 'ready').map((o) => ({ order_no: o.order_no, label: label(o) })),
          ready: orders
            .filter((o) => o.status === 'ready' && (!o.ready_at || now - o.ready_at.getTime() < READY_SHOWN_MS))
            .sort((a, b) => (b.ready_at?.getTime() ?? 0) - (a.ready_at?.getTime() ?? 0))
            .map((o) => ({ order_no: o.order_no, label: label(o), ready_at: o.ready_at?.toISOString() ?? null })),
        };
      });
    });

    /** One order, followed by the guest from the link on their receipt. */
    app.get('/public/track/:code', { config: publicLimit }, async (req, reply): Promise<TrackedOrderDTO> => {
      const { code } = parse(z.object({ code: z.string().min(16).max(40).regex(/^[\w-]+$/) }), req.params);
      const { rows } = await sql<{ tenant_id: string; order_id: string }>`select * from mezmitra_track_order(${code})`.execute(ctx.db);
      const found = rows[0];
      if (!found || !(await tenantActive(found.tenant_id))) throw notFound('Order');
      reply.header('cache-control', 'no-store');
      return ctx.tx(found.tenant_id, async (tx) => {
        const o = await tx.db
          .selectFrom('orders')
          .innerJoin('outlets', 'outlets.id', 'orders.outlet_id')
          .select(['orders.id', 'orders.order_no', 'orders.type', 'orders.status', 'orders.placed_at', 'orders.ready_at', 'outlets.name as outlet_name'])
          .where('orders.id', '=', found.order_id)
          .executeTakeFirst();
        if (!o) throw notFound('Order');
        const items = await tx.db
          .selectFrom('order_items')
          .select(['name_snapshot', 'qty'])
          .where('order_id', '=', o.id)
          .where('status', '<>', 'cancelled')
          .orderBy('position')
          .execute();
        const brand = await shownBrand(tx);
        return {
          outlet_name: o.outlet_name,
          tenant_name: brand.name,
          branding: brand.branding,
          order_no: o.order_no,
          type: o.type as OrderType,
          status: o.status as OrderStatus,
          placed_at: o.placed_at.toISOString(),
          ready_at: o.ready_at?.toISOString() ?? null,
          items: items.map((i) => ({ name: i.name_snapshot, qty: i.qty })),
        };
      });
    });

    /** The pickup screen's link, for Settings. */
    app.get('/outlets/:id/pickup-link', async (req) => {
      const auth = requireStaff(req);
      const { id } = parse(idParams, req.params);
      assertCan(auth, id, 'outlet.settings');
      return ctx.tx(auth.tenantId, async (tx) => {
        const o = await tx.db.selectFrom('outlets').select('pickup_link_version').where('id', '=', id).executeTakeFirst();
        if (!o) throw notFound('Outlet');
        return { url: pickupUrl(ctx.config, { tenantId: auth.tenantId, outletId: id, version: o.pickup_link_version }) };
      });
    });

    /** A new link; the old one stops working (a TV that should no longer show the screen). */
    app.post('/outlets/:id/pickup-link/rotate', async (req) => {
      const auth = requireStaff(req);
      const { id } = parse(idParams, req.params);
      assertCan(auth, id, 'outlet.settings');
      return ctx.tx(auth.tenantId, async (tx) => {
        const o = await tx.db
          .updateTable('outlets')
          .set((eb) => ({ pickup_link_version: sql<number>`case when ${eb.ref('pickup_link_version')} >= 65535 then 1 else ${eb.ref('pickup_link_version')} + 1 end` }))
          .where('id', '=', id)
          .returning('pickup_link_version')
          .executeTakeFirst();
        if (!o) throw notFound('Outlet');
        return { url: pickupUrl(ctx.config, { tenantId: auth.tenantId, outletId: id, version: o.pickup_link_version }) };
      });
    });
  };
}

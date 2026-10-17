import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { DELIVERY_CHANNELS, ITEM_STATUSES, ORDER_STATUSES, ORDER_TYPES, type OrderStatus } from '@dineos/shared/enums';
import type { KotDoc } from '@dineos/shared/print';
import type { AppContext } from '../../context';
import { approvalHeader } from '../../lib/approvals';
import { assertCan, assertOutletAccess, requireAction, requireStaff } from '../../lib/auth';
import { badRequest, notFound } from '../../lib/errors';
import { idParams, outletQuery, parse } from '../../lib/validate';
import { printTargets, queuePrintJob } from '../print/jobs';
import { getOrCreateSession } from '../tables/sessions';
import { editOrderItems } from './edit';
import { loadOrder, loadOrders } from './serialize';
import { createOrder, setItemStatus, setItemsStatus, transitionOrder } from './service';

const line = z.object({
  item_id: z.uuid(),
  qty: z.number().int().min(1).max(99),
  modifier_ids: z.array(z.uuid()).max(20).default([]),
  note: z.string().max(200).nullable().optional(),
  seat_no: z.number().int().min(1).max(50).nullable().optional(),
});

const createBody = z
  .object({
    outlet_id: z.uuid(),
    type: z.enum(ORDER_TYPES),
    source: z.enum(['waiter', 'pos']).default('pos'),
    table_id: z.uuid().optional(),
    lines: z.array(line).min(1).max(100),
    note: z.string().max(300).nullable().optional(),
    customer_name: z.string().max(80).nullable().optional(),
    customer_phone: z.string().max(20).nullable().optional(),
    guest_count: z.number().int().min(1).max(100).optional(),
    channel: z.enum(DELIVERY_CHANNELS).optional(),
    channel_ref: z.string().trim().max(40).nullable().optional(),
  })
  .refine((b) => b.type !== 'dine_in' || b.table_id, { message: 'Pick a table for dine-in', path: ['table_id'] })
  .refine((b) => (b.type === 'delivery') === !!b.channel, { message: 'Delivery orders need a channel: Zomato, Swiggy or own', path: ['channel'] });

const listQuery = outletQuery.extend({
  status: z.string().optional(),
  type: z.enum(ORDER_TYPES).optional(),
  table_session_id: z.uuid().optional(),
  since: z.iso.datetime().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

const ACTIVE_FOR_KDS: OrderStatus[] = ['accepted', 'preparing', 'ready'];

export default function routes(ctx: AppContext): FastifyPluginAsync {
  return async (app) => {
    app.get('/orders', async (req) => {
      const auth = requireStaff(req);
      const q = parse(listQuery, req.query);
      assertCan(auth, q.outlet_id, 'order.view');
      const statuses = q.status?.split(',').filter(Boolean) ?? [];
      for (const s of statuses) if (!(ORDER_STATUSES as readonly string[]).includes(s)) throw badRequest('invalid_status', `Unknown status ${s}`);
      return ctx.tx(auth.tenantId, async (tx) => {
        let query = tx.db.selectFrom('orders').select('id').where('outlet_id', '=', q.outlet_id);
        if (statuses.length) query = query.where('status', 'in', statuses);
        if (q.type) query = query.where('type', '=', q.type);
        if (q.table_session_id) query = query.where('table_session_id', '=', q.table_session_id);
        if (q.since) query = query.where('placed_at', '>=', new Date(q.since));
        else if (!statuses.length && !q.table_session_id) query = query.where('placed_at', '>=', new Date(Date.now() - 86_400_000));
        const rows = await query.orderBy('placed_at', 'desc').limit(q.limit).execute();
        return loadOrders(tx, rows.map((r) => r.id));
      });
    });

    app.get('/orders/:id', async (req) => {
      const auth = requireStaff(req);
      const { id } = parse(idParams, req.params);
      return ctx.tx(auth.tenantId, async (tx) => {
        const order = await loadOrder(tx, id);
        if (!order) throw notFound('Order');
        assertCan(auth, order.outlet_id, 'order.view');
        return order;
      });
    });

    /** Waiter tablet or POS order. Staff orders skip approval and go straight to the kitchen. */
    app.post('/orders', async (req, reply) => {
      const body = parse(createBody, req.body);
      const auth = requireAction(req, body.outlet_id, 'order.create');
      const order = await ctx.tx(auth.tenantId, async (tx) => {
        let sessionId: string | null = null;
        if (body.type === 'dine_in') {
          const table = await tx.db.selectFrom('tables').select(['outlet_id']).where('id', '=', body.table_id!).executeTakeFirst();
          if (!table || table.outlet_id !== body.outlet_id) throw badRequest('invalid_table', 'Table is not in this outlet');
          const session = await getOrCreateSession(tx, body.table_id!);
          sessionId = session.id;
          if (body.guest_count && !session.guest_count) {
            await tx.db.updateTable('table_sessions').set({ guest_count: body.guest_count }).where('id', '=', session.id).execute();
          }
        }
        return createOrder(tx, {
          outletId: body.outlet_id,
          type: body.type,
          source: body.source,
          sessionId,
          lines: body.lines,
          note: body.note,
          createdBy: auth.userId,
          customerName: body.customer_name,
          customerPhone: body.customer_phone,
          channel: body.channel ?? null,
          channelRef: body.channel_ref || null,
        });
      });
      return reply.status(201).send(order);
    });

    app.patch('/orders/:id/status', async (req) => {
      const auth = requireStaff(req);
      const { id } = parse(idParams, req.params);
      const body = parse(z.object({ status: z.enum(ORDER_STATUSES), reason: z.string().max(300).nullable().optional() }), req.body);
      return ctx.tx(auth.tenantId, (tx) =>
        transitionOrder(tx, auth, id, body.status, { reason: body.reason, approvalToken: approvalHeader(req.headers) }),
      );
    });

    app.patch('/orders/:id/items', async (req) => {
      const auth = requireStaff(req);
      const { id } = parse(idParams, req.params);
      const body = parse(
        z.object({
          add: z.array(line).max(50).optional(),
          cancel: z.array(z.object({ order_item_id: z.uuid(), reason: z.string().min(1).max(200) })).max(100).optional(),
          set_qty: z.array(z.object({ order_item_id: z.uuid(), qty: z.number().int().min(1).max(99) })).max(100).optional(),
        }),
        req.body,
      );
      return ctx.tx(auth.tenantId, (tx) => editOrderItems(tx, auth, id, body, approvalHeader(req.headers)));
    });

    /** KDS: one dish at a time. */
    app.patch('/order-items/:id/status', async (req) => {
      const auth = requireStaff(req);
      const { id } = parse(idParams, req.params);
      const body = parse(z.object({ status: z.enum(ITEM_STATUSES) }), req.body);
      return ctx.tx(auth.tenantId, (tx) => setItemStatus(tx, auth, id, body.status));
    });

    /** Several items of one order at once: a station's "all ready", or serving the drinks first. */
    app.patch('/orders/:id/items/status', async (req) => {
      const auth = requireStaff(req);
      const { id } = parse(idParams, req.params);
      const body = parse(z.object({ item_ids: z.array(z.uuid()).min(1).max(100), status: z.enum(ITEM_STATUSES) }), req.body);
      return ctx.tx(auth.tenantId, (tx) => setItemsStatus(tx, auth, id, body.item_ids, body.status));
    });

    /** Orders the kitchen is working on, optionally only one station's items. */
    app.get('/kds', async (req) => {
      const auth = requireStaff(req);
      const q = parse(outletQuery.extend({ station: z.string().max(30).optional() }), req.query);
      assertOutletAccess(auth, q.outlet_id);
      assertCan(auth, q.outlet_id, 'order.view');
      return ctx.tx(auth.tenantId, async (tx) => {
        const rows = await tx.db
          .selectFrom('orders')
          .select('id')
          .where('outlet_id', '=', q.outlet_id)
          .where('status', 'in', ACTIVE_FOR_KDS)
          .orderBy('accepted_at')
          .limit(200)
          .execute();
        const orders = await loadOrders(tx, rows.map((r) => r.id));
        if (!q.station) return orders;
        return orders
          .map((o) => ({ ...o, items: o.items.filter((i) => i.station === q.station) }))
          // A station's ticket leaves its screen once its own items are served (the drinks went
          // out), even while the rest of the order is still cooking.
          .filter((o) => o.items.some((i) => i.status !== 'cancelled' && i.status !== 'served'));
      });
    });

    app.post('/orders/:id/reprint-kot', async (req) => {
      const auth = requireStaff(req);
      const { id } = parse(idParams, req.params);
      const body = parse(z.object({ station: z.string().max(30).optional() }), req.body ?? {});
      return ctx.tx(auth.tenantId, async (tx) => {
        const order = await tx.db.selectFrom('orders').select(['outlet_id']).where('id', '=', id).executeTakeFirst();
        if (!order) throw notFound('Order');
        assertCan(auth, order.outlet_id, 'order.view');
        let q = tx.db.selectFrom('kots').select(['id', 'station', 'items']).where('order_id', '=', id);
        if (body.station) q = q.where('station', '=', body.station);
        const kots = await q.orderBy('created_at').execute();
        if (kots.length === 0) throw notFound('Kitchen ticket');
        const printers = await printTargets(tx, order.outlet_id);
        if (!printers) return { queued: 0, message: 'No print agent is connected; use the browser print view' };
        const printable = kots.filter((k) => printers.has(k.station));
        if (printable.length === 0) return { queued: 0, message: 'No printer is set up for this station; use the browser print view' };
        for (const kot of printable) {
          const doc = { ...(kot.items as unknown as KotDoc), reprint: true };
          await queuePrintJob(tx, order.outlet_id, { target: kot.station, refId: kot.id, doc });
        }
        return { queued: printable.length };
      });
    });

    /** Kitchen tickets of an order, for the browser print fallback. */
    app.get('/orders/:id/kots', async (req) => {
      const auth = requireStaff(req);
      const { id } = parse(idParams, req.params);
      return ctx.tx(auth.tenantId, async (tx) => {
        const order = await tx.db.selectFrom('orders').select(['outlet_id']).where('id', '=', id).executeTakeFirst();
        if (!order) throw notFound('Order');
        assertCan(auth, order.outlet_id, 'order.view');
        const kots = await tx.db.selectFrom('kots').select(['id', 'items', 'created_at']).where('order_id', '=', id).orderBy('created_at').execute();
        return kots.map((k) => ({ id: k.id, created_at: k.created_at.toISOString(), doc: k.items as unknown as KotDoc }));
      });
    });
  };
}

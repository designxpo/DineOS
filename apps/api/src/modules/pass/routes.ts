// The pass: food that is ready and not yet served, each dish with an owner or a clock running.
// A waiter takes a dish ("I've got it"); anyone who serves may take it over; the manager sees what
// has waited too long. Serving a dish ends it, so nothing needs closing by hand.

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { passLevel } from '@mezmitra/shared/pass';
import type { PassItemDTO } from '@mezmitra/shared/dto';
import { ACTIVE_ORDER_STATUSES } from '@mezmitra/shared/enums';
import type { AppContext, Tx } from '../../context';
import { audit } from '../../lib/audit';
import { assertCan, assertOutletAccess, requireStaff } from '../../lib/auth';
import { outletQuery, parse } from '../../lib/validate';

export async function passItems(tx: Tx, outletId: string): Promise<PassItemDTO[]> {
  const rows = await tx.db
    .selectFrom('order_items')
    .innerJoin('orders', 'orders.id', 'order_items.order_id')
    .leftJoin('table_sessions', 'table_sessions.id', 'orders.table_session_id')
    .leftJoin('tables', 'tables.id', 'table_sessions.table_id')
    .leftJoin('users as waiter', 'waiter.id', 'tables.assigned_waiter_id')
    .leftJoin('users as holder', 'holder.id', 'order_items.claimed_by')
    .select([
      'order_items.id',
      'order_items.order_id',
      'order_items.name_snapshot',
      'order_items.qty',
      'order_items.station',
      'order_items.ready_at',
      'order_items.claimed_by',
      'order_items.claimed_at',
      'orders.order_no',
      'orders.type',
      'tables.label',
      'tables.assigned_waiter_id',
      'waiter.name as waiter_name',
      'holder.name as holder_name',
    ])
    .where('orders.outlet_id', '=', outletId)
    .where('orders.status', 'in', [...ACTIVE_ORDER_STATUSES])
    .where('order_items.status', '=', 'ready')
    .where('order_items.ready_at', 'is not', null)
    .orderBy('order_items.ready_at')
    .execute();
  const now = Date.now();
  return rows.map((r) => ({
    order_item_id: r.id,
    order_id: r.order_id,
    order_no: r.order_no,
    name: r.name_snapshot,
    qty: r.qty,
    station: r.station,
    table_label: r.label,
    order_type: r.type,
    assigned_waiter_id: r.assigned_waiter_id,
    assigned_waiter_name: r.waiter_name,
    ready_at: r.ready_at!.toISOString(),
    claimed_by: r.claimed_by,
    claimed_by_name: r.holder_name,
    claimed_at: r.claimed_at?.toISOString() ?? null,
    level: passLevel({ ready_at: r.ready_at!, claimed_at: r.claimed_at }, now),
  }));
}

export default function routes(ctx: AppContext): FastifyPluginAsync {
  return async (app) => {
    app.get('/pass', async (req): Promise<PassItemDTO[]> => {
      const auth = requireStaff(req);
      const { outlet_id } = parse(outletQuery, req.query);
      assertOutletAccess(auth, outlet_id);
      assertCan(auth, outlet_id, 'order.view');
      return ctx.tx(auth.tenantId, (tx) => passItems(tx, outlet_id));
    });

    /** Takes dishes waiting at the pass (or lets go of them). Taking one someone else holds is a handover. */
    app.post('/pass/claim', async (req) => {
      const auth = requireStaff(req);
      const body = parse(z.object({ outlet_id: z.uuid(), order_item_ids: z.array(z.uuid()).min(1).max(100), claimed: z.boolean() }), req.body);
      assertCan(auth, body.outlet_id, 'order.serve');
      return ctx.tx(auth.tenantId, async (tx) => {
        const before = await tx.db
          .selectFrom('order_items')
          .innerJoin('orders', 'orders.id', 'order_items.order_id')
          .select(['order_items.id', 'order_items.claimed_by'])
          .where('orders.outlet_id', '=', body.outlet_id)
          .where('order_items.status', '=', 'ready')
          .where('order_items.id', 'in', body.order_item_ids)
          .forUpdate()
          .execute();
        // Letting go of a dish someone else holds is not yours to do.
        const ids = before.filter((b) => body.claimed || b.claimed_by === auth.userId).map((b) => b.id);
        if (ids.length) {
          await tx.db
            .updateTable('order_items')
            .set(body.claimed ? { claimed_by: auth.userId, claimed_at: new Date() } : { claimed_by: null, claimed_at: null })
            .where('id', 'in', ids)
            .execute();
        }
        const handovers = before.filter((b) => body.claimed && b.claimed_by && b.claimed_by !== auth.userId);
        if (handovers.length) {
          await audit(tx, auth, {
            outletId: body.outlet_id,
            action: 'pass.handover',
            entity: 'order_item',
            after: { order_items: handovers.map((h) => ({ id: h.id, from: h.claimed_by })) },
          });
        }
        return { updated: ids.length };
      });
    });
  };
}

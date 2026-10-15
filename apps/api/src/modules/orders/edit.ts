import type { OrderDTO } from '@dineos/shared/dto';
import type { ItemStatus, OrderStatus } from '@dineos/shared/enums';
import { deriveOrderStatus } from '@dineos/shared/order-state';
import type { Tx } from '../../context';
import { requireApproval } from '../../lib/approvals';
import { audit } from '../../lib/audit';
import { assertCan, type StaffAuth } from '../../lib/auth';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { syncStock } from '../inventory/stock';
import { loadOrder } from './serialize';
import { announceOrder, createKots, insertOrderItems, loadOutlet, prepareLines, type OrderLineInput } from './service';

export interface EditItemsInput {
  add?: OrderLineInput[];
  cancel?: { order_item_id: string; reason: string }[];
  set_qty?: { order_item_id: string; qty: number }[];
}

const EDITABLE: OrderStatus[] = ['placed', 'accepted', 'preparing', 'ready', 'served'];
const ADDABLE: OrderStatus[] = ['placed', 'accepted', 'preparing'];

/**
 * Inbox edits (spec §7 "edit or cancel items"). Before the kitchen has the order anything goes;
 * afterwards cancelling an item needs a manager and prints a cancellation ticket.
 */
export async function editOrderItems(
  tx: Tx,
  auth: StaffAuth,
  orderId: string,
  input: EditItemsInput,
  approvalToken?: string | null,
): Promise<OrderDTO> {
  const order = await tx.db.selectFrom('orders').selectAll().where('id', '=', orderId).forUpdate().executeTakeFirst();
  if (!order) throw notFound('Order');
  assertCan(auth, order.outlet_id, 'order.edit_items');
  const status = order.status as OrderStatus;
  if (!EDITABLE.includes(status)) throw conflict('order_closed', `This order is ${status} and can no longer be edited`);
  const accepted = status !== 'placed';
  const outlet = await loadOutlet(tx, order.outlet_id);
  const items = await tx.db.selectFrom('order_items').selectAll().where('order_id', '=', orderId).execute();
  const byId = new Map(items.map((i) => [i.id, i]));

  if (input.set_qty?.length) {
    if (accepted) throw conflict('order_accepted', 'Quantities are locked once the kitchen has the order; cancel and add instead');
    for (const { order_item_id, qty } of input.set_qty) {
      const item = byId.get(order_item_id);
      if (!item || item.status === 'cancelled') throw badRequest('invalid_item', 'Item is not part of this order');
      await tx.db.updateTable('order_items').set({ qty }).where('id', '=', order_item_id).execute();
    }
  }

  const cancelledAfterAccept: string[] = [];
  if (input.cancel?.length) {
    let approvedBy: string | null = null;
    if (accepted) approvedBy = await requireApproval(tx, auth, order.outlet_id, 'order.cancel_after_accept', approvalToken);
    for (const { order_item_id, reason } of input.cancel) {
      const item = byId.get(order_item_id);
      if (!item) throw badRequest('invalid_item', 'Item is not part of this order');
      if (item.status === 'cancelled') continue;
      if (!reason.trim()) throw badRequest('reason_required', 'Give a reason for cancelling');
      await tx.db
        .updateTable('order_items')
        .set({ status: 'cancelled', cancelled_reason: reason.trim() })
        .where('id', '=', order_item_id)
        .execute();
      if (item.status !== 'placed') cancelledAfterAccept.push(order_item_id);
      if (accepted) {
        await audit(tx, auth, {
          outletId: order.outlet_id,
          action: 'order_item.cancel',
          entity: 'order_item',
          entityId: order_item_id,
          before: { status: item.status, name: item.name_snapshot, qty: item.qty },
          after: { status: 'cancelled' },
          reason,
          approvedBy,
        });
      }
    }
  }

  let addedIds: string[] = [];
  if (input.add?.length) {
    if (!ADDABLE.includes(status)) throw conflict('order_progressed', 'This order is already ready; start a new order instead');
    const lines = await prepareLines(tx, outlet, input.add);
    addedIds = await insertOrderItems(tx, orderId, lines, accepted ? 'accepted' : 'placed');
  }

  // An order whose items were all cancelled is cancelled; otherwise its status never goes backwards.
  const fresh = await tx.db.selectFrom('order_items').select('status').where('order_id', '=', orderId).execute();
  const derived = deriveOrderStatus(fresh.map((i) => ({ status: i.status as ItemStatus })));
  if (derived === 'cancelled') {
    await tx.db
      .updateTable('orders')
      .set({ status: 'cancelled', cancelled_reason: input.cancel?.[0]?.reason ?? 'All items cancelled' })
      .where('id', '=', orderId)
      .execute();
  }

  await syncStock(tx, orderId, auth.userId);
  const dto = (await loadOrder(tx, orderId))!;
  if (cancelledAfterAccept.length) await createKots(tx, outlet, dto, cancelledAfterAccept, { cancelled: true });
  if (accepted && addedIds.length) await createKots(tx, outlet, dto, addedIds);
  await announceOrder(tx, dto, derived === 'cancelled' ? 'order.status_changed' : 'order.updated');
  return dto;
}

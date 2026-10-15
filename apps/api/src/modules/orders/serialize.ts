import type { GuestOrderDTO, ModifierSnapshot, OrderDTO, OrderItemDTO } from '@dineos/shared/dto';
import type { ItemStatus, OrderSource, OrderStatus, OrderType } from '@dineos/shared/enums';
import type { Tx } from '../../context';

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/** Loads orders with their items as API DTOs, in the order of `ids`. */
export async function loadOrders(tx: Tx, ids: readonly string[]): Promise<OrderDTO[]> {
  if (ids.length === 0) return [];
  const orders = await tx.db
    .selectFrom('orders')
    .leftJoin('tables', 'tables.id', 'orders.table_id')
    .leftJoin('users', 'users.id', 'orders.created_by')
    .selectAll('orders')
    .select(['tables.label as table_label', 'users.name as created_by_name'])
    .where('orders.id', 'in', [...ids])
    .execute();
  const items = await tx.db
    .selectFrom('order_items')
    .selectAll()
    .where('order_id', 'in', [...ids])
    .orderBy('created_at')
    .orderBy('id')
    .execute();

  const byOrder = new Map<string, OrderItemDTO[]>();
  for (const i of items) {
    const dto: OrderItemDTO = {
      id: i.id,
      item_id: i.item_id,
      name: i.name_snapshot,
      qty: i.qty,
      unit_price_paise: i.unit_price_paise,
      modifiers: i.modifiers_snapshot as unknown as ModifierSnapshot[],
      note: i.note,
      status: i.status as ItemStatus,
      station: i.station,
      seat_no: i.seat_no,
      is_veg: i.is_veg,
      cancelled_reason: i.cancelled_reason,
    };
    const list = byOrder.get(i.order_id) ?? [];
    list.push(dto);
    byOrder.set(i.order_id, list);
  }

  const map = new Map(
    orders.map((o) => {
      const orderItems = byOrder.get(o.id) ?? [];
      const dto: OrderDTO = {
        id: o.id,
        outlet_id: o.outlet_id,
        order_no: o.order_no,
        type: o.type as OrderType,
        status: o.status as OrderStatus,
        source: o.source as OrderSource,
        table_id: o.table_id,
        table_label: o.table_label,
        table_session_id: o.table_session_id,
        note: o.note,
        flagged: o.flagged,
        flag_reason: o.flag_reason,
        customer_name: o.customer_name,
        customer_phone: o.customer_phone,
        placed_at: o.placed_at.toISOString(),
        accepted_at: iso(o.accepted_at),
        ready_at: iso(o.ready_at),
        served_at: iso(o.served_at),
        rejected_reason: o.rejected_reason,
        cancelled_reason: o.cancelled_reason,
        created_by_name: o.created_by_name,
        items: orderItems,
        subtotal_paise: orderItems
          .filter((i) => i.status !== 'cancelled')
          .reduce((sum, i) => sum + i.qty * i.unit_price_paise, 0),
      };
      return [o.id, dto] as const;
    }),
  );
  return ids.map((id) => map.get(id)).filter((o): o is OrderDTO => !!o);
}

export async function loadOrder(tx: Tx, id: string): Promise<OrderDTO | null> {
  const [order] = await loadOrders(tx, [id]);
  return order ?? null;
}

/** The guest-safe view of an order. */
export function toGuestOrder(o: OrderDTO): GuestOrderDTO {
  return {
    id: o.id,
    order_no: o.order_no,
    status: o.status,
    placed_at: o.placed_at,
    rejected_reason: o.rejected_reason,
    items: o.items.map((i) => ({
      id: i.id,
      name: i.name,
      qty: i.qty,
      unit_price_paise: i.unit_price_paise,
      modifiers: i.modifiers.map((m) => m.name),
      note: i.note,
      status: i.status,
      is_veg: i.is_veg,
    })),
    subtotal_paise: o.subtotal_paise,
  };
}

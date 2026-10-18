// Core order loop: create, transition, per-item status, kitchen tickets (spec §5, §7).
// Used by the guest module (QR orders), the staff inbox, KDS and POS.

import { businessDate } from '@mezmitra/shared/dates';
import type { AvailabilitySchedule, ItemsReadyDTO, ModifierSnapshot, OrderDTO } from '@mezmitra/shared/dto';
import type { DeliveryChannel, ItemStatus, OrderSource, OrderStatus, OrderType } from '@mezmitra/shared/enums';
import { checkModifierSelection, isScheduleOpen, type ModifierGroupRule } from '@mezmitra/shared/menu';
import {
  canItemTransition,
  canTransition,
  cancelNeedsManager,
  deriveOrderStatus,
  itemStatusForOrder,
  itemWasMade,
  readyNews,
} from '@mezmitra/shared/order-state';
import type { Action } from '@mezmitra/shared/permissions';
import type { KotDoc } from '@mezmitra/shared/print';
import type { Tx } from '../../context';
import { json } from '../../db';
import { requireApproval } from '../../lib/approvals';
import { audit } from '../../lib/audit';
import { can, type StaffAuth } from '../../lib/auth';
import { nextCounter } from '../../lib/counters';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors';
import { syncStock } from '../inventory/stock';
import { printTargets, queuePrintJob } from '../print/jobs';
import { lockLiveSession, openSession, refreshSessionTables } from '../tables/sessions';
import { loadOrder, toGuestOrder } from './serialize';

export interface OrderLineInput {
  item_id: string;
  qty: number;
  modifier_ids: string[];
  note?: string | null;
  seat_no?: number | null;
}

export interface PreparedLine {
  item_id: string;
  name: string;
  price_paise: number;
  unit_price_paise: number;
  modifiers: ModifierSnapshot[];
  is_veg: boolean;
  tax_rate_bp: number;
  hsn_sac: string | null;
  qty: number;
  note: string | null;
  station: string;
  seat_no: number | null;
}

type Unavailable = { item_id: string; reason: string; message: string };

/**
 * Validates lines against the live menu and snapshots name, price and modifiers so later menu
 * edits never change this order or its bill. Throws 409 items_unavailable listing every problem.
 */
export async function prepareLines(
  tx: Tx,
  outlet: { id: string; timezone: string },
  lines: readonly OrderLineInput[],
  now = new Date(),
): Promise<PreparedLine[]> {
  if (lines.length === 0) throw badRequest('empty_order', 'Add at least one item');
  const itemIds = [...new Set(lines.map((l) => l.item_id))];
  const items = await tx.db
    .selectFrom('menu_items')
    .innerJoin('menu_categories', 'menu_categories.id', 'menu_items.category_id')
    .select([
      'menu_items.id',
      'menu_items.name',
      'menu_items.price_paise',
      'menu_items.is_veg',
      'menu_items.tax_rate_bp',
      'menu_items.hsn_sac',
      'menu_items.in_stock',
      'menu_items.station',
      'menu_categories.is_active as category_active',
      'menu_categories.available_schedule',
      'menu_categories.deleted_at as category_deleted_at',
    ])
    .where('menu_items.id', 'in', itemIds)
    .where('menu_items.outlet_id', '=', outlet.id)
    .where('menu_items.deleted_at', 'is', null)
    .execute();
  const itemById = new Map(items.map((i) => [i.id, i]));

  const links = await tx.db
    .selectFrom('item_modifier_groups')
    .innerJoin('modifier_groups', 'modifier_groups.id', 'item_modifier_groups.group_id')
    .select([
      'item_modifier_groups.item_id',
      'modifier_groups.id',
      'modifier_groups.name',
      'modifier_groups.min_select',
      'modifier_groups.max_select',
    ])
    .where('item_modifier_groups.item_id', 'in', itemIds)
    .where('modifier_groups.deleted_at', 'is', null)
    .execute();
  const groupIds = [...new Set(links.map((l) => l.id))];
  const mods = groupIds.length
    ? await tx.db
        .selectFrom('modifiers')
        .select(['id', 'group_id', 'name', 'price_delta_paise', 'in_stock'])
        .where('group_id', 'in', groupIds)
        .where('deleted_at', 'is', null)
        .execute()
    : [];
  const modById = new Map(mods.map((m) => [m.id, m]));

  const problems: Unavailable[] = [];
  const prepared: PreparedLine[] = [];
  for (const line of lines) {
    const item = itemById.get(line.item_id);
    if (!item || item.category_deleted_at || !item.category_active) {
      problems.push({ item_id: line.item_id, reason: 'not_found', message: 'This item is no longer on the menu' });
      continue;
    }
    if (!item.in_stock) {
      problems.push({ item_id: item.id, reason: 'out_of_stock', message: `${item.name} just ran out` });
      continue;
    }
    if (!isScheduleOpen(item.available_schedule as AvailabilitySchedule | null, now, outlet.timezone)) {
      problems.push({ item_id: item.id, reason: 'not_available_now', message: `${item.name} is not served right now` });
      continue;
    }
    const groups: ModifierGroupRule[] = links
      .filter((l) => l.item_id === item.id)
      .map((g) => ({
        id: g.id,
        name: g.name,
        min_select: g.min_select,
        max_select: g.max_select,
        modifiers: mods.filter((m) => m.group_id === g.id).map((m) => ({ id: m.id, in_stock: m.in_stock })),
      }));
    const check = checkModifierSelection(groups, line.modifier_ids);
    if (!check.ok) {
      problems.push({ item_id: item.id, reason: check.code, message: check.message });
      continue;
    }
    const snapshot: ModifierSnapshot[] = line.modifier_ids.map((id) => {
      const m = modById.get(id)!;
      return {
        modifier_id: m.id,
        group_name: groups.find((g) => g.id === m.group_id)!.name,
        name: m.name,
        price_delta_paise: m.price_delta_paise,
      };
    });
    prepared.push({
      item_id: item.id,
      name: item.name,
      price_paise: item.price_paise,
      unit_price_paise: item.price_paise + snapshot.reduce((s, m) => s + m.price_delta_paise, 0),
      modifiers: snapshot,
      is_veg: item.is_veg,
      tax_rate_bp: item.tax_rate_bp,
      hsn_sac: item.hsn_sac,
      qty: line.qty,
      note: line.note?.trim() || null,
      station: item.station,
      seat_no: line.seat_no ?? null,
    });
  }
  if (problems.length) {
    throw conflict('items_unavailable', problems.length === 1 ? problems[0]!.message : 'Some items are no longer available', {
      items: problems,
    });
  }
  return prepared;
}

export async function insertOrderItems(
  tx: Tx,
  orderId: string,
  lines: readonly PreparedLine[],
  status: ItemStatus,
): Promise<string[]> {
  const last = await tx.db
    .selectFrom('order_items')
    .select((eb) => eb.fn.max('position').as('max'))
    .where('order_id', '=', orderId)
    .executeTakeFirst();
  const start = (last?.max ?? -1) + 1;
  const rows = await tx.db
    .insertInto('order_items')
    .values(
      lines.map((l, i) => ({
        position: start + i,
        tenant_id: tx.tenantId,
        order_id: orderId,
        item_id: l.item_id,
        name_snapshot: l.name,
        price_snapshot_paise: l.price_paise,
        unit_price_paise: l.unit_price_paise,
        modifiers_snapshot: json(l.modifiers),
        is_veg: l.is_veg,
        tax_rate_bp: l.tax_rate_bp,
        hsn_sac: l.hsn_sac,
        qty: l.qty,
        note: l.note,
        status,
        station: l.station,
        seat_no: l.seat_no,
      })),
    )
    .returning('id')
    .execute();
  return rows.map((r) => r.id);
}

export async function loadOutlet(tx: Tx, outletId: string) {
  const outlet = await tx.db.selectFrom('outlets').selectAll().where('id', '=', outletId).executeTakeFirst();
  if (!outlet || outlet.status !== 'active') throw notFound('Outlet');
  return outlet;
}

/** How long after a visit closes a phone from it counts as "was at this table earlier". */
const RETURNING_DEVICE_WINDOW_MS = 12 * 3_600_000;

/** Staff know these guests are really at the table: a waiter seated them, or an order was accepted. */
async function visitVouchedFor(tx: Tx, session: { id: string; waiter_id: string | null; guest_count: number | null }): Promise<boolean> {
  if (session.waiter_id || session.guest_count != null) return true;
  const accepted = await tx.db
    .selectFrom('orders')
    .select('id')
    .where('table_session_id', '=', session.id)
    .where('status', 'not in', ['placed', 'rejected', 'cancelled'])
    .executeTakeFirst();
  return !!accepted;
}

export interface CreateOrderInput {
  outletId: string;
  type: OrderType;
  source: OrderSource;
  /** Required for dine-in. */
  sessionId?: string | null;
  lines: OrderLineInput[];
  note?: string | null;
  deviceId?: string | null;
  createdBy?: string | null;
  customerName?: string | null;
  customerPhone?: string | null;
  /** Delivery orders: who delivers, and the platform's order number. */
  channel?: DeliveryChannel | null;
  channelRef?: string | null;
  /**
   * Staff only: the items are already at the table (bottled water left there), so the order is
   * served at once and the kitchen gets no ticket.
   */
  alreadyServed?: boolean;
}

export async function createOrder(tx: Tx, input: CreateOrderInput): Promise<OrderDTO> {
  const outlet = await loadOutlet(tx, input.outletId);
  // Until its paid year on another system ends, the outlet bills there: an order here would be billed twice.
  if (outlet.billing_elsewhere) throw conflict('bills_elsewhere', `This outlet bills on ${outlet.billing_elsewhere} for now, so orders are taken there`);
  const now = new Date();

  let session: Awaited<ReturnType<typeof lockLiveSession>> | null = null;
  if (input.type === 'dine_in') {
    if (!input.sessionId) throw badRequest('session_required', 'Dine-in orders need a table');
    session = await lockLiveSession(tx, input.sessionId);
    if (session.outlet_id !== outlet.id) throw notFound('Table session');
  }

  const lines = await prepareLines(tx, outlet, input.lines, now);

  let flagged = false;
  let flagReason: string | null = null;
  let mustWait = false;
  if (input.source === 'guest_qr' && session) {
    const prior = input.deviceId
      ? await tx.db
          .selectFrom('orders')
          .select('id')
          .where('table_session_id', '=', session.id)
          .where('device_id', '=', input.deviceId)
          .where('status', 'not in', ['rejected', 'cancelled'])
          .executeTakeFirst()
      : undefined;
    if (!prior) {
      // A phone that ordered in an earlier visit at this table, now closed (a guest who paid and
      // left, still holding the page), waits for staff whatever the outlet's settings.
      const earlier = input.deviceId
        ? await tx.db
            .selectFrom('orders')
            .innerJoin('table_sessions', 'table_sessions.id', 'orders.table_session_id')
            .select('orders.id')
            .where('table_sessions.table_id', '=', session.table_id)
            .where('table_sessions.id', '!=', session.id)
            .where('table_sessions.closed_at', '>', new Date(now.getTime() - RETURNING_DEVICE_WINDOW_MS))
            .where('orders.device_id', '=', input.deviceId)
            .executeTakeFirst()
        : undefined;
      if (earlier) {
        flagged = true;
        flagReason = 'returning_device';
        mustWait = true;
      } else if (!(await visitVouchedFor(tx, session))) {
        // Checked once per visit, not once per phone: a party of fifteen should not need fifteen
        // approvals once staff know the table is real.
        flagged = true;
        flagReason = 'first_order_from_device';
      }
    }
  }

  // Staff-entered orders go straight to the kitchen. Guest orders wait for a manager unless the
  // outlet auto-accepts, and flagged ones still wait when approval of flagged orders is on.
  const accepted =
    input.source !== 'guest_qr' || (!mustWait && outlet.auto_accept && !(flagged && outlet.approve_flagged_orders));
  const served = !!input.alreadyServed && input.source !== 'guest_qr';
  const status: OrderStatus = served ? 'served' : accepted ? 'accepted' : 'placed';
  const day = businessDate(now, outlet.timezone);

  const order = await tx.db
    .insertInto('orders')
    .values({
      tenant_id: tx.tenantId,
      outlet_id: outlet.id,
      table_session_id: session?.id ?? null,
      table_id: session?.table_id ?? null,
      order_no: await nextCounter(tx, outlet.id, 'order', day),
      business_date: day,
      type: input.type,
      status,
      source: input.source,
      note: input.note?.trim() || null,
      flagged,
      flag_reason: flagReason,
      device_id: input.deviceId ?? null,
      customer_name: input.customerName ?? null,
      customer_phone: input.customerPhone ?? null,
      channel: input.channel ?? null,
      channel_ref: input.channelRef ?? null,
      created_by: input.createdBy ?? null,
      placed_at: now,
      accepted_at: accepted ? now : null,
      ...(served ? { served_at: now } : {}),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await insertOrderItems(tx, order.id, lines, served ? 'served' : status === 'accepted' ? 'accepted' : 'placed');

  if (session) {
    if (session.status === 'pending') await openSession(tx, session.id, { waiterId: input.createdBy ?? null });
    // A new order supersedes an earlier bill request (water counted at billing does not).
    if (session.bill_requested_at && !served) {
      await tx.db.updateTable('table_sessions').set({ bill_requested_at: null }).where('id', '=', session.id).execute();
    }
  }

  if (accepted) await syncStock(tx, order.id, input.createdBy ?? null);
  const dto = (await loadOrder(tx, order.id))!;
  if (accepted && !served) await createKots(tx, outlet, dto, dto.items.map((i) => i.id));
  await tx.emit({ outletId: outlet.id, type: 'order.placed', channels: ['outlet'], payload: { order: dto } });
  if (session) {
    await tx.emit({
      outletId: outlet.id,
      type: 'order.placed',
      channels: [`session:${session.id}`],
      payload: { order: toGuestOrder(dto) },
    });
    await refreshSessionTables(tx, session.id, 'order');
  }
  return dto;
}

/**
 * Prints kitchen tickets for the given order items, one ticket per station. Without a print agent
 * the KDS screen is the ticket, but the KOT number is still issued for the record.
 */
export async function createKots(
  tx: Tx,
  outlet: { id: string; name: string; timezone: string },
  order: OrderDTO,
  orderItemIds: readonly string[],
  opts: { cancelled?: boolean } = {},
): Promise<void> {
  const wanted = new Set(orderItemIds);
  const items = order.items.filter((i) => wanted.has(i.id));
  if (items.length === 0) return;
  const printers = await printTargets(tx, outlet.id);
  const day = businessDate(new Date(), outlet.timezone);
  const stations = [...new Set(items.map((i) => i.station))];
  for (const station of stations) {
    const stationItems = items.filter((i) => i.station === station);
    const kotNo = await nextCounter(tx, outlet.id, 'kot', day);
    const doc: KotDoc = {
      kind: 'kot',
      outlet_name: outlet.name,
      kot_no: kotNo,
      order_no: order.order_no,
      station,
      table_label: order.table_label,
      order_type: order.type,
      placed_at: order.placed_at,
      items: stationItems.map((i) => ({
        name: i.name,
        qty: i.qty,
        modifiers: i.modifiers.map((m) => m.name),
        note: i.note,
        seat_no: i.seat_no,
      })),
      note: order.note,
      cancelled: opts.cancelled ?? false,
      reprint: false,
    };
    const kot = await tx.db
      .insertInto('kots')
      .values({
        tenant_id: tx.tenantId,
        outlet_id: outlet.id,
        order_id: order.id,
        kot_no: kotNo,
        station,
        items: json(doc),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    if (printers?.has(station)) await queuePrintJob(tx, outlet.id, { target: station, refId: kot.id, doc });
  }
}

/** Emits the staff and guest views of an order change and refreshes the table's state. */
export async function announceOrder(tx: Tx, order: OrderDTO, type: 'order.status_changed' | 'order.updated'): Promise<void> {
  await tx.emit({
    outletId: order.outlet_id,
    type,
    channels: ['outlet'],
    payload: { order_id: order.id, status: order.status, order },
  });
  if (order.table_session_id) {
    await tx.emit({
      outletId: order.outlet_id,
      type,
      channels: [`session:${order.table_session_id}`],
      payload: { order_id: order.id, status: order.status, reason: order.rejected_reason ?? order.cancelled_reason, order: toGuestOrder(order) },
    });
    await refreshSessionTables(tx, order.table_session_id, 'order');
  }
}

/**
 * Tells the floor when something is waiting at the pass: one station's part of an order (the
 * bar's drinks while the kitchen still cooks) or the whole order. `justReady`: items this change
 * moved to ready.
 */
async function announceReady(tx: Tx, order: OrderDTO, justReady: ReadonlySet<string>): Promise<void> {
  const news = readyNews(order.items, justReady);
  if (!news) return;
  const table = order.table_id
    ? await tx.db.selectFrom('tables').select('assigned_waiter_id').where('id', '=', order.table_id).executeTakeFirst()
    : undefined;
  const payload: ItemsReadyDTO = {
    order_id: order.id,
    order_no: order.order_no,
    order_type: order.type,
    channel: order.channel,
    channel_ref: order.channel_ref,
    table_id: order.table_id,
    table_label: order.table_label,
    assigned_waiter_id: table?.assigned_waiter_id ?? null,
    ...news,
  };
  await tx.emit({ outletId: order.outlet_id, type: 'order.items_ready', channels: ['outlet'], payload });
}

function actionForStatus(to: OrderStatus): Action {
  switch (to) {
    case 'accepted':
    case 'rejected':
      return 'order.accept';
    case 'preparing':
    case 'ready':
      return 'order.kitchen';
    case 'served':
      return 'order.serve';
    default:
      return 'order.accept';
  }
}

async function lockOrder(tx: Tx, orderId: string) {
  const order = await tx.db.selectFrom('orders').selectAll().where('id', '=', orderId).forUpdate().executeTakeFirst();
  if (!order) throw notFound('Order');
  return order;
}

const STATUS_TIMESTAMP: Partial<Record<OrderStatus, 'accepted_at' | 'ready_at' | 'served_at'>> = {
  accepted: 'accepted_at',
  ready: 'ready_at',
  served: 'served_at',
};

/**
 * Moves an order through its lifecycle (staff inbox and KDS). Rejection needs a reason and is
 * only possible before acceptance; cancelling after acceptance needs a manager.
 */
export async function transitionOrder(
  tx: Tx,
  auth: StaffAuth,
  orderId: string,
  to: OrderStatus,
  opts: { reason?: string | null; approvalToken?: string | null } = {},
): Promise<OrderDTO> {
  const order = await lockOrder(tx, orderId);
  const from = order.status as OrderStatus;
  if (to === 'billed') throw badRequest('invalid_transition', 'Orders are marked billed when their bill is finalised');
  if (!canTransition(from, to)) {
    throw conflict('invalid_transition', `Cannot move an order from ${from} to ${to}`, { from, to });
  }

  const reason = opts.reason?.trim() || null;
  let approvedBy: string | null = null;
  if (to === 'cancelled') {
    if (!reason) throw badRequest('reason_required', 'Give a reason for cancelling');
    if (cancelNeedsManager(from)) {
      approvedBy = await requireApproval(tx, auth, order.outlet_id, 'order.cancel_after_accept', opts.approvalToken);
    } else if (!can(auth, order.outlet_id, 'order.accept')) {
      throw forbidden();
    }
  } else {
    if (!can(auth, order.outlet_id, actionForStatus(to))) throw forbidden();
    if (to === 'rejected' && !reason) throw badRequest('reason_required', 'Tell the guest why the order was rejected');
  }

  const now = new Date();
  const stamp = STATUS_TIMESTAMP[to];
  await tx.db
    .updateTable('orders')
    .set({
      status: to,
      ...(stamp ? { [stamp]: now } : {}),
      ...(to === 'rejected' ? { rejected_reason: reason } : {}),
      ...(to === 'cancelled' ? { cancelled_reason: reason } : {}),
    })
    .where('id', '=', orderId)
    .execute();

  const items = await tx.db.selectFrom('order_items').select(['id', 'status']).where('order_id', '=', orderId).execute();
  const justReady = new Set<string>();
  for (const item of items) {
    const next = itemStatusForOrder(item.status as ItemStatus, to);
    if (next === 'ready' && next !== item.status) justReady.add(item.id);
    if (next !== item.status) {
      await tx.db
        .updateTable('order_items')
        .set({
          status: next,
          ...(next === 'cancelled' ? { cancelled_made: itemWasMade(item.status as ItemStatus), ...(reason ? { cancelled_reason: reason } : {}) } : {}),
        })
        .where('id', '=', item.id)
        .execute();
    }
  }

  await syncStock(tx, orderId, auth.userId);
  const dto = (await loadOrder(tx, orderId))!;
  const outlet = await loadOutlet(tx, order.outlet_id);
  if (to === 'accepted') {
    await createKots(tx, outlet, dto, dto.items.filter((i) => i.status !== 'cancelled').map((i) => i.id));
  }
  if (to === 'cancelled' && from !== 'placed') {
    await createKots(tx, outlet, dto, dto.items.map((i) => i.id), { cancelled: true });
    await audit(tx, auth, {
      outletId: order.outlet_id,
      action: 'order.cancel',
      entity: 'order',
      entityId: orderId,
      before: { status: from },
      after: { status: to },
      reason,
      approvedBy,
    });
  }
  await announceOrder(tx, dto, 'order.status_changed');
  await announceReady(tx, dto, justReady);
  return dto;
}

/** KDS per-item progress: one dish at a time. */
export async function setItemStatus(tx: Tx, auth: StaffAuth, orderItemId: string, to: ItemStatus): Promise<OrderDTO> {
  const item = await tx.db.selectFrom('order_items').select(['order_id']).where('id', '=', orderItemId).executeTakeFirst();
  if (!item) throw notFound('Order item');
  return setItemsStatus(tx, auth, item.order_id, [orderItemId], to);
}

/**
 * Moves some of an order's items at once: a station's "all ready" on the KDS, or a waiter serving
 * the drinks while the food still cooks. Items already at or past `to` are left as they are; the
 * order's status follows its least-advanced active item.
 */
export async function setItemsStatus(tx: Tx, auth: StaffAuth, orderId: string, itemIds: readonly string[], to: ItemStatus): Promise<OrderDTO> {
  if (to === 'cancelled' || to === 'placed') {
    throw badRequest('invalid_transition', 'Use the order item edit endpoint to cancel items');
  }
  const order = await lockOrder(tx, orderId);
  if (order.status === 'placed') throw conflict('order_not_accepted', 'Accept the order first');
  if (!can(auth, order.outlet_id, actionForStatus(to as OrderStatus))) throw forbidden();
  const items = await tx.db.selectFrom('order_items').select(['id', 'status']).where('order_id', '=', orderId).execute();
  const wanted = new Set(itemIds);
  const chosen = items.filter((i) => wanted.has(i.id));
  if (chosen.length !== wanted.size) throw notFound('Order item');
  const moving = chosen.filter((i) => canItemTransition(i.status as ItemStatus, to)).map((i) => i.id);
  if (moving.length === 0) {
    const from = chosen.length === 1 ? chosen[0]!.status : null;
    throw conflict('invalid_transition', from ? `Cannot move an item from ${from} to ${to}` : `Those items are already ${to} or further along`);
  }
  await tx.db.updateTable('order_items').set({ status: to }).where('id', 'in', moving).execute();

  const moved = new Set(moving);
  const derived = deriveOrderStatus(items.map((i) => ({ status: (moved.has(i.id) ? to : i.status) as ItemStatus })));
  const current = order.status as OrderStatus;
  const changed = derived !== current && derived !== 'cancelled' && canTransition(current, derived);
  if (changed) {
    const stamp = STATUS_TIMESTAMP[derived];
    await tx.db
      .updateTable('orders')
      .set({ status: derived, ...(stamp ? { [stamp]: new Date() } : {}) })
      .where('id', '=', orderId)
      .execute();
  }
  const dto = (await loadOrder(tx, orderId))!;
  await announceOrder(tx, dto, changed ? 'order.status_changed' : 'order.updated');
  if (to === 'ready') await announceReady(tx, dto, moved);
  return dto;
}

/** System transition with no permission checks, e.g. `billed` when a bill is finalised. */
export async function markOrdersBilled(tx: Tx, orderIds: readonly string[]): Promise<void> {
  for (const id of orderIds) {
    const order = await lockOrder(tx, id);
    if (!canTransition(order.status as OrderStatus, 'billed')) continue;
    await tx.db.updateTable('orders').set({ status: 'billed' }).where('id', '=', id).execute();
    const dto = (await loadOrder(tx, id))!;
    await announceOrder(tx, dto, 'order.status_changed');
  }
}

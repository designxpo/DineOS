// Live floor map data and floor operations: seat, transfer, merge, release, clean (spec §7, §8).

import type { ServiceRequestDTO, TableDTO } from '@dineos/shared/dto';
import { ACTIVE_ORDER_STATUSES, type ServiceRequestKind, type SessionStatus, type TableState } from '@dineos/shared/enums';
import { CAMERA_FRESH_MS, cleaningLapsed, deriveTableState, guestsPresent, type CameraState } from '@dineos/shared/table-state';
import type { Tx } from '../../context';
import { json } from '../../db';
import { badRequest, conflict, notFound } from '../../lib/errors';
import {
  closeSession,
  getOrCreateSession,
  openSession,
  refreshSessionTables,
  refreshTableStates,
} from './sessions';

/**
 * A state that only the camera put there (no visit, not flagged by staff) lapses when the camera
 * goes quiet, e.g. the edge box lost power, instead of showing an old reading forever.
 */
function cameraExpired(r: { state: string; needs_cleaning: boolean; session_status: string | null; camera_at: Date | null }): boolean {
  if (r.session_status === 'open' || r.needs_cleaning || !['occupied', 'needs_cleaning'].includes(r.state)) return false;
  return !r.camera_at || Date.now() - r.camera_at.getTime() >= CAMERA_FRESH_MS;
}

/**
 * The stored state moves on with the clock, not only with events: guests whose phones went quiet
 * no longer hold the table, and a table left to be cleaned counts as clean after the outlet's
 * clearing time. Same rules as when the state is stored.
 */
function stateNow(r: {
  state: string;
  needs_cleaning: boolean;
  needs_cleaning_since: Date | null;
  auto_clean_minutes: number;
  session_status: string | null;
  guest_seen_at: Date | null;
  camera_id: string | null;
  camera_state: string | null;
  camera_at: Date | null;
}): TableState {
  if (r.session_status === 'open') return r.state as TableState;
  if (cameraExpired(r) && !(r.session_status === 'pending' && guestsPresent(r.guest_seen_at))) return 'vacant';
  return deriveTableState({
    needsCleaning: r.needs_cleaning,
    cleaning: { since: r.needs_cleaning_since, autoMinutes: r.auto_clean_minutes },
    session: r.session_status ? { status: r.session_status as SessionStatus, bill_requested_at: null } : null,
    guestSeenAt: r.guest_seen_at,
    orderStatuses: [],
    camera: r.camera_id && r.camera_state && r.camera_at ? { state: r.camera_state as CameraState, at: r.camera_at } : null,
  });
}

export async function loadTables(tx: Tx, outletId: string, onlyIds?: readonly string[]): Promise<TableDTO[]> {
  let q = tx.db
    .selectFrom('tables')
    .leftJoin('table_sessions', 'table_sessions.id', 'tables.current_session_id')
    .leftJoin('users', 'users.id', 'tables.assigned_waiter_id')
    .innerJoin('outlets', 'outlets.id', 'tables.outlet_id')
    .select([
      'tables.id',
      'tables.outlet_id',
      'tables.label',
      'tables.seats',
      'tables.zone',
      'tables.sort',
      'tables.state',
      'tables.needs_cleaning',
      'tables.assigned_waiter_id',
      'tables.qr_token_version',
      'tables.is_active',
      'tables.current_session_id',
      'tables.camera_id',
      'tables.camera_state',
      'tables.camera_confidence',
      'tables.camera_at',
      'tables.camera_occupied_since',
      'tables.needs_cleaning_since',
      'outlets.auto_clean_minutes',
      'users.name as waiter_name',
      'table_sessions.status as session_status',
      'table_sessions.opened_at',
      'table_sessions.guest_count',
      'table_sessions.bill_requested_at',
      'table_sessions.waiter_id',
      'table_sessions.guests_since',
      'table_sessions.guest_seen_at',
      'table_sessions.water_bottles',
    ])
    .where('tables.outlet_id', '=', outletId);
  q = onlyIds ? q.where('tables.id', 'in', [...onlyIds]) : q.where('tables.is_active', '=', true);
  const rows = await q.orderBy('tables.zone').orderBy('tables.sort').orderBy('tables.label').execute();
  if (rows.length === 0) return [];

  const sessionIds = [...new Set(rows.map((r) => r.current_session_id).filter((id): id is string => !!id))];
  const totals = sessionIds.length
    ? await tx.db
        .selectFrom('orders')
        .innerJoin('order_items', 'order_items.order_id', 'orders.id')
        .select((eb) => [
          'orders.table_session_id',
          eb.fn.sum<number>(eb('order_items.qty', '*', eb.ref('order_items.unit_price_paise'))).as('total'),
        ])
        .where('orders.table_session_id', 'in', sessionIds)
        .where('orders.status', 'not in', ['rejected', 'cancelled'])
        .where('order_items.status', '<>', 'cancelled')
        .groupBy('orders.table_session_id')
        .execute()
    : [];
  const openCounts = sessionIds.length
    ? await tx.db
        .selectFrom('orders')
        .select((eb) => ['table_session_id', eb.fn.countAll<number>().as('n')])
        .where('table_session_id', 'in', sessionIds)
        .where('status', 'in', [...ACTIVE_ORDER_STATUSES])
        .groupBy('table_session_id')
        .execute()
    : [];
  // Walkout watch: served food nobody has billed yet, and printed bills nobody has paid.
  const lastServed = sessionIds.length
    ? await tx.db
        .selectFrom('orders')
        .select((eb) => ['table_session_id', eb.fn.max('served_at').as('at')])
        .where('table_session_id', 'in', sessionIds)
        .where('status', '=', 'served')
        .groupBy('table_session_id')
        .execute()
    : [];
  const unpaidBills = sessionIds.length
    ? await tx.db
        .selectFrom('bills')
        .select((eb) => ['table_session_id', eb.fn.min('finalised_at').as('at')])
        .where('table_session_id', 'in', sessionIds)
        .where('status', '=', 'finalised')
        .groupBy('table_session_id')
        .execute()
    : [];
  // Dishes and drinks sitting at the pass, so the floor sees which tables to carry to.
  const readyCounts = sessionIds.length
    ? await tx.db
        .selectFrom('orders')
        .innerJoin('order_items', 'order_items.order_id', 'orders.id')
        .select((eb) => ['orders.table_session_id', eb.fn.sum<number>('order_items.qty').as('n')])
        .where('orders.table_session_id', 'in', sessionIds)
        .where('orders.status', 'in', [...ACTIVE_ORDER_STATUSES])
        .where('order_items.status', '=', 'ready')
        .groupBy('orders.table_session_id')
        .execute()
    : [];
  const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);
  const requests = await loadServiceRequests(tx, outletId, rows.map((r) => r.id));
  // The next booking per table, from slightly in the past (late arrivals) to a few hours ahead.
  const upcoming = await tx.db
    .selectFrom('reservations')
    .select(['id', 'table_id', 'guest_name', 'party_size', 'slot_start'])
    .where('outlet_id', '=', outletId)
    .where('status', '=', 'booked')
    .where('table_id', 'in', rows.map((r) => r.id))
    .where('slot_start', '>', new Date(Date.now() - 60 * 60_000))
    .where('slot_start', '<', new Date(Date.now() + 4 * 3600_000))
    .orderBy('slot_start')
    .execute();

  return rows.map((r) => {
    const sid = r.current_session_id;
    const live = sid && r.session_status !== 'closed';
    return {
      id: r.id,
      outlet_id: r.outlet_id,
      label: r.label,
      seats: r.seats,
      zone: r.zone,
      sort: r.sort,
      state: stateNow(r),
      needs_cleaning: r.needs_cleaning && !cleaningLapsed(r.needs_cleaning_since, r.auto_clean_minutes),
      needs_cleaning_since: r.needs_cleaning && !cleaningLapsed(r.needs_cleaning_since, r.auto_clean_minutes) ? iso(r.needs_cleaning_since) : null,
      guests_since: r.session_status === 'pending' && guestsPresent(r.guest_seen_at) ? iso(r.guests_since) : null,
      assigned_waiter_id: r.assigned_waiter_id,
      assigned_waiter_name: r.waiter_name,
      qr_token_version: r.qr_token_version,
      session: live
        ? {
            id: sid,
            status: r.session_status as SessionStatus,
            opened_at: r.opened_at?.toISOString() ?? null,
            guest_count: r.guest_count,
            bill_requested_at: r.bill_requested_at?.toISOString() ?? null,
            waiter_id: r.waiter_id,
            water_bottles: r.water_bottles,
          }
        : null,
      merged_with: sid ? rows.filter((o) => o.current_session_id === sid && o.id !== r.id).map((o) => o.label) : [],
      open_orders: openCounts.find((c) => c.table_session_id === sid)?.n ?? 0,
      running_total_paise: Number(totals.find((t) => t.table_session_id === sid)?.total ?? 0),
      last_served_at: live ? iso(lastServed.find((x) => x.table_session_id === sid)?.at) : null,
      unpaid_bill_since: live ? iso(unpaidBills.find((x) => x.table_session_id === sid)?.at) : null,
      ready_items: live ? Number(readyCounts.find((x) => x.table_session_id === sid)?.n ?? 0) : 0,
      open_requests: requests.filter((q) => q.table_id === r.id),
      is_active: r.is_active,
      camera:
        r.camera_id && r.camera_state && r.camera_at && Date.now() - r.camera_at.getTime() < CAMERA_FRESH_MS
          ? {
              state: r.camera_state as CameraState,
              confidence: r.camera_confidence,
              at: r.camera_at.toISOString(),
              occupied_since: r.camera_occupied_since?.toISOString() ?? null,
            }
          : null,
      next_reservation: (() => {
        const n = upcoming.find((u) => u.table_id === r.id);
        return n ? { id: n.id, guest_name: n.guest_name, party_size: n.party_size, slot_start: n.slot_start.toISOString() } : null;
      })(),
    };
  });
}

export async function loadServiceRequests(tx: Tx, outletId: string, tableIds?: string[]): Promise<ServiceRequestDTO[]> {
  let q = tx.db
    .selectFrom('service_requests')
    .innerJoin('tables', 'tables.id', 'service_requests.table_id')
    .leftJoin('users', 'users.id', 'service_requests.acknowledged_by')
    .select([
      'service_requests.id',
      'service_requests.table_id',
      'tables.label as table_label',
      'service_requests.kind',
      'service_requests.status',
      'service_requests.created_at',
      'users.name as acknowledged_by',
      'tables.assigned_waiter_id',
    ])
    .where('service_requests.outlet_id', '=', outletId)
    .where('service_requests.status', '<>', 'closed');
  if (tableIds) {
    if (tableIds.length === 0) return [];
    q = q.where('service_requests.table_id', 'in', tableIds);
  }
  const rows = await q.orderBy('service_requests.created_at').execute();
  return rows.map((r) => ({
    id: r.id,
    table_id: r.table_id,
    table_label: r.table_label,
    kind: r.kind as ServiceRequestKind,
    status: r.status as ServiceRequestDTO['status'],
    created_at: r.created_at.toISOString(),
    acknowledged_by: r.acknowledged_by,
    assigned_waiter_id: r.assigned_waiter_id,
  }));
}

/** Tells floor screens to refetch after structural changes (create, merge, transfer...). */
export async function announceTables(tx: Tx, outletId: string, tableIds: string[]): Promise<void> {
  await tx.emit({ outletId, type: 'tables.updated', channels: ['outlet'], payload: { table_ids: tableIds } });
}

async function lockTable(tx: Tx, tableId: string) {
  const t = await tx.db.selectFrom('tables').selectAll().where('id', '=', tableId).forUpdate().executeTakeFirst();
  if (!t || !t.is_active) throw notFound('Table');
  return t;
}

/** A waiter seats a party: opens (or reuses) the table's session. */
export async function seatTable(tx: Tx, tableId: string, opts: { guestCount?: number | null; waiterId?: string | null }) {
  const session = await getOrCreateSession(tx, tableId);
  await openSession(tx, session.id, opts);
  await tx.db.updateTable('tables').set({ needs_cleaning: false }).where('id', '=', tableId).execute();
  await refreshSessionTables(tx, session.id, 'staff');
  return session.id;
}

async function sessionHasBills(tx: Tx, sessionId: string): Promise<boolean> {
  const bill = await tx.db
    .selectFrom('bills')
    .select('id')
    .where('table_session_id', '=', sessionId)
    .where('status', 'in', ['finalised', 'paid'])
    .executeTakeFirst();
  return !!bill;
}

async function hasOrders(tx: Tx, sessionId: string): Promise<boolean> {
  const o = await tx.db
    .selectFrom('orders')
    .select('id')
    .where('table_session_id', '=', sessionId)
    .where('status', 'not in', ['rejected', 'cancelled'])
    .executeTakeFirst();
  return !!o;
}

/** Moves a party (session, orders, bill) to a free table. */
export async function transferTable(tx: Tx, fromId: string, toId: string): Promise<void> {
  if (fromId === toId) throw badRequest('same_table', 'Pick a different table');
  const [from, to] = await Promise.all([lockTable(tx, fromId), lockTable(tx, toId)]);
  if (from.outlet_id !== to.outlet_id) throw badRequest('different_outlet', 'Tables are in different outlets');
  if (!from.current_session_id) throw conflict('table_free', `${from.label} has no guests to move`);
  if (to.current_session_id) {
    const target = await tx.db
      .selectFrom('table_sessions')
      .select(['id', 'status', 'cart'])
      .where('id', '=', to.current_session_id)
      .executeTakeFirstOrThrow();
    // A pending session with an empty cart is just someone who scanned and left.
    const emptyPending = target.status === 'pending' && Array.isArray(target.cart) && target.cart.length === 0;
    if (!emptyPending) throw conflict('table_occupied', `${to.label} is occupied`);
    await closeSession(tx, target.id, 'staff', { cleaning: false });
  }
  const sessionId = from.current_session_id;
  const session = await tx.db.selectFrom('table_sessions').select(['table_id', 'status']).where('id', '=', sessionId).executeTakeFirstOrThrow();
  // Only the session's primary table moves; tables merged into it stay merged.
  if (session.table_id === fromId) {
    await tx.db.updateTable('table_sessions').set({ table_id: toId }).where('id', '=', sessionId).execute();
    await tx.db.updateTable('orders').set({ table_id: toId }).where('table_session_id', '=', sessionId).execute();
  }
  await tx.db
    .updateTable('tables')
    .set({ current_session_id: null, needs_cleaning: session.status === 'open' })
    .where('id', '=', fromId)
    .execute();
  await tx.db.updateTable('tables').set({ current_session_id: sessionId, needs_cleaning: false }).where('id', '=', toId).execute();
  await refreshTableStates(tx, [fromId, toId], 'staff');
  await announceTables(tx, from.outlet_id, [fromId, toId]);
}

/**
 * Joins tables into one party and one bill. The first table is the primary; other tables'
 * orders and cart lines move into its session.
 */
export async function mergeTables(tx: Tx, tableIds: string[]): Promise<string> {
  const [primaryId, ...others] = tableIds;
  if (!primaryId || others.length === 0) throw badRequest('merge_needs_two', 'Pick at least two tables');
  if (new Set(tableIds).size !== tableIds.length) throw badRequest('duplicate_table', 'A table is listed twice');
  const tables = [];
  for (const id of tableIds) tables.push(await lockTable(tx, id));
  if (new Set(tables.map((t) => t.outlet_id)).size !== 1) throw badRequest('different_outlet', 'Tables are in different outlets');

  const primarySessionId = await seatTable(tx, primaryId, {});
  const primary = await tx.db
    .selectFrom('table_sessions')
    .select(['id', 'cart', 'cart_version'])
    .where('id', '=', primarySessionId)
    .forUpdate()
    .executeTakeFirstOrThrow();
  let cart = Array.isArray(primary.cart) ? [...primary.cart] : [];

  for (const table of tables.slice(1)) {
    const sid = table.current_session_id;
    if (sid === primarySessionId) continue;
    if (sid) {
      if (await sessionHasBills(tx, sid)) {
        throw conflict('table_has_bill', `${table.label} already has a printed bill; settle it before merging`);
      }
      const other = await tx.db.selectFrom('table_sessions').select(['cart']).where('id', '=', sid).executeTakeFirstOrThrow();
      if (Array.isArray(other.cart)) cart = [...cart, ...other.cart];
      await tx.db.updateTable('orders').set({ table_session_id: primarySessionId }).where('table_session_id', '=', sid).execute();
      await tx.db.deleteFrom('bills').where('table_session_id', '=', sid).where('status', '=', 'draft').execute();
      await tx.db
        .updateTable('service_requests')
        .set({ table_session_id: primarySessionId })
        .where('table_session_id', '=', sid)
        .execute();
      // Guests on the old session are told it ended; their next scan lands in the merged session.
      await closeSession(tx, sid, 'staff', { cleaning: false });
    }
    await tx.db
      .updateTable('tables')
      .set({ current_session_id: primarySessionId, needs_cleaning: false })
      .where('id', '=', table.id)
      .execute();
  }
  await tx.db
    .updateTable('table_sessions')
    .set({ cart: json(cart), cart_version: primary.cart_version + 1 })
    .where('id', '=', primarySessionId)
    .execute();
  await refreshTableStates(tx, tableIds, 'staff');
  await announceTables(tx, tables[0]!.outlet_id, tableIds);
  return primarySessionId;
}

/** Detaches a merged table from the party. The primary table cannot be unmerged. */
export async function unmergeTable(tx: Tx, tableId: string): Promise<void> {
  const table = await lockTable(tx, tableId);
  if (!table.current_session_id) throw conflict('not_merged', `${table.label} is not merged`);
  const session = await tx.db
    .selectFrom('table_sessions')
    .select('table_id')
    .where('id', '=', table.current_session_id)
    .executeTakeFirstOrThrow();
  if (session.table_id === tableId) throw conflict('primary_table', 'This is the main table of the party; transfer it instead');
  await tx.db.updateTable('tables').set({ current_session_id: null }).where('id', '=', tableId).execute();
  await refreshTableStates(tx, [tableId], 'staff');
  await announceTables(tx, table.outlet_id, [tableId]);
}

/** Frees a table whose party never ordered (or walked out before anything was billed). */
export async function releaseTable(tx: Tx, tableId: string): Promise<void> {
  const table = await lockTable(tx, tableId);
  if (!table.current_session_id) return;
  const sid = table.current_session_id;
  const session = await tx.db.selectFrom('table_sessions').select(['status']).where('id', '=', sid).executeTakeFirstOrThrow();
  if (session.status === 'open' && (await hasOrders(tx, sid))) {
    throw conflict('session_has_orders', 'This table has orders. Settle the bill or cancel the orders first.');
  }
  await closeSession(tx, sid, 'staff', { cleaning: session.status === 'open' });
}

export async function markClean(tx: Tx, tableId: string): Promise<void> {
  const table = await lockTable(tx, tableId);
  // Staff saying "clean" also overrides a camera that still thinks the table is messy.
  await tx.db
    .updateTable('tables')
    .set((eb) => ({ needs_cleaning: false, camera_state: eb.case().when('camera_state', '=', 'needs_cleaning').then(null).else(eb.ref('camera_state')).end() }))
    .where('id', '=', tableId)
    .execute();
  await refreshTableStates(tx, [table.id], 'staff');
}

/** Guest presses "call waiter" or "request bill". Repeated presses reuse the open request. */
export async function createServiceRequest(
  tx: Tx,
  g: { outletId: string; tableId: string; sessionId: string },
  kind: ServiceRequestKind,
): Promise<ServiceRequestDTO> {
  let request = await tx.db
    .selectFrom('service_requests')
    .select('id')
    .where('table_session_id', '=', g.sessionId)
    .where('kind', '=', kind)
    .where('status', '<>', 'closed')
    .executeTakeFirst();
  const fresh = !request;
  if (!request) {
    request = await tx.db
      .insertInto('service_requests')
      .values({ tenant_id: tx.tenantId, outlet_id: g.outletId, table_id: g.tableId, table_session_id: g.sessionId, kind })
      .returning('id')
      .executeTakeFirstOrThrow();
  }
  if (kind === 'bill') {
    await tx.db
      .updateTable('table_sessions')
      .set({ bill_requested_at: new Date() })
      .where('id', '=', g.sessionId)
      .where('bill_requested_at', 'is', null)
      .execute();
    await refreshSessionTables(tx, g.sessionId, 'order');
  }
  const [dto] = (await loadServiceRequests(tx, g.outletId)).filter((r) => r.id === request.id);
  if (fresh) {
    await tx.emit({
      outletId: g.outletId,
      type: kind === 'bill' ? 'bill.requested' : 'waiter.called',
      channels: ['outlet'],
      payload: { table_id: g.tableId, session_id: g.sessionId, assigned_waiter_id: dto!.assigned_waiter_id, request: dto },
    });
  }
  return dto!;
}

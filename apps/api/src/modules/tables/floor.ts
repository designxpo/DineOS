// Live floor map data and floor operations: seat, transfer, merge, release, clean (spec §7, §8).

import type { ServiceRequestDTO, TableDTO } from '@dineos/shared/dto';
import { ACTIVE_ORDER_STATUSES, type ServiceRequestKind, type SessionStatus, type TableState } from '@dineos/shared/enums';
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

export async function loadTables(tx: Tx, outletId: string, onlyIds?: readonly string[]): Promise<TableDTO[]> {
  let q = tx.db
    .selectFrom('tables')
    .leftJoin('table_sessions', 'table_sessions.id', 'tables.current_session_id')
    .leftJoin('users', 'users.id', 'tables.assigned_waiter_id')
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
      'users.name as waiter_name',
      'table_sessions.status as session_status',
      'table_sessions.opened_at',
      'table_sessions.guest_count',
      'table_sessions.bill_requested_at',
      'table_sessions.waiter_id',
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
  const requests = await loadServiceRequests(tx, outletId, rows.map((r) => r.id));

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
      state: r.state as TableState,
      needs_cleaning: r.needs_cleaning,
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
          }
        : null,
      merged_with: sid ? rows.filter((o) => o.current_session_id === sid && o.id !== r.id).map((o) => o.label) : [],
      open_orders: openCounts.find((c) => c.table_session_id === sid)?.n ?? 0,
      running_total_paise: Number(totals.find((t) => t.table_session_id === sid)?.total ?? 0),
      open_requests: requests.filter((q) => q.table_id === r.id),
      is_active: r.is_active,
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
  await tx.db.updateTable('tables').set({ needs_cleaning: false }).where('id', '=', tableId).execute();
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
      payload: { table_id: g.tableId, session_id: g.sessionId, request: dto },
    });
  }
  return dto!;
}

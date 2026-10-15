// Table sessions and derived table state (spec §5). Core module shared by guest, orders, billing
// and floor operations. Every function runs inside the caller's tenant transaction.

import type { OrderStatus, SessionStatus, TableState, TableStateSource } from '@dineos/shared/enums';
import { deriveTableState } from '@dineos/shared/table-state';
import type { Tx } from '../../context';
import { json } from '../../db';
import { gone, notFound } from '../../lib/errors';

export interface SessionRow {
  id: string;
  outlet_id: string;
  table_id: string;
  status: SessionStatus;
  opened_at: Date | null;
  bill_requested_at: Date | null;
  guest_count: number | null;
  waiter_id: string | null;
}

const SESSION_COLUMNS = ['id', 'outlet_id', 'table_id', 'status', 'opened_at', 'bill_requested_at', 'guest_count', 'waiter_id'] as const;

/** Locks and returns a session that is still usable. Closed sessions are 410 Gone for guests. */
export async function lockLiveSession(tx: Tx, sessionId: string): Promise<SessionRow> {
  const s = await tx.db
    .selectFrom('table_sessions')
    .select(SESSION_COLUMNS)
    .where('id', '=', sessionId)
    .forUpdate()
    .executeTakeFirst();
  if (!s) throw notFound('Table session');
  if (s.status === 'closed') throw gone('session_closed', 'This table visit has ended. Scan the QR code again.');
  return s as SessionRow;
}

/**
 * The table's current session, creating a pending one if the table is free. The table row lock
 * makes two phones scanning at the same moment land in the same session.
 */
export async function getOrCreateSession(tx: Tx, tableId: string): Promise<SessionRow> {
  const table = await tx.db
    .selectFrom('tables')
    .select(['id', 'outlet_id', 'current_session_id', 'is_active'])
    .where('id', '=', tableId)
    .forUpdate()
    .executeTakeFirst();
  if (!table || !table.is_active) throw notFound('Table');
  if (table.current_session_id) {
    const s = await tx.db
      .selectFrom('table_sessions')
      .select(SESSION_COLUMNS)
      .where('id', '=', table.current_session_id)
      .executeTakeFirstOrThrow();
    if (s.status !== 'closed') return s as SessionRow;
  }
  const created = await tx.db
    .insertInto('table_sessions')
    .values({ tenant_id: tx.tenantId, outlet_id: table.outlet_id, table_id: table.id, status: 'pending' })
    .returning(SESSION_COLUMNS)
    .executeTakeFirstOrThrow();
  await tx.db.updateTable('tables').set({ current_session_id: created.id }).where('id', '=', table.id).execute();
  return created as SessionRow;
}

/** pending -> open. Called by the first placed order or when a waiter seats guests. */
export async function openSession(
  tx: Tx,
  sessionId: string,
  opts: { guestCount?: number | null; waiterId?: string | null } = {},
): Promise<void> {
  await tx.db
    .updateTable('table_sessions')
    .set({ status: 'open', opened_at: new Date() })
    .where('id', '=', sessionId)
    .where('status', '=', 'pending')
    .execute();
  if (opts.guestCount != null || opts.waiterId != null) {
    await tx.db
      .updateTable('table_sessions')
      .set({
        ...(opts.guestCount != null ? { guest_count: opts.guestCount } : {}),
        ...(opts.waiterId != null ? { waiter_id: opts.waiterId } : {}),
      })
      .where('id', '=', sessionId)
      .execute();
  }
}

/**
 * Ends a session: releases its tables (marking them for cleaning if guests were seated), kills
 * every guest token and cart tied to it, and tells the guests' phones.
 */
export async function closeSession(
  tx: Tx,
  sessionId: string,
  source: TableStateSource,
  opts: { cleaning?: boolean } = {},
): Promise<void> {
  const s = await tx.db
    .selectFrom('table_sessions')
    .select(['id', 'outlet_id', 'status'])
    .where('id', '=', sessionId)
    .forUpdate()
    .executeTakeFirstOrThrow();
  if (s.status === 'closed') return;
  const cleaning = opts.cleaning ?? s.status === 'open';
  await tx.db
    .updateTable('table_sessions')
    .set({ status: 'closed', closed_at: new Date(), cart: json([]), cart_version: 0 })
    .where('id', '=', sessionId)
    .execute();
  const tables = await tx.db
    .updateTable('tables')
    .set({ current_session_id: null, ...(cleaning ? { needs_cleaning: true } : {}) })
    .where('current_session_id', '=', sessionId)
    .returning('id')
    .execute();
  await tx.db
    .updateTable('service_requests')
    .set({ status: 'closed' })
    .where('table_session_id', '=', sessionId)
    .where('status', '<>', 'closed')
    .execute();
  await refreshTableStates(
    tx,
    tables.map((t) => t.id),
    source,
  );
  await tx.emit({
    outletId: s.outlet_id,
    type: 'session.closed',
    channels: [`session:${sessionId}`],
    payload: { session_id: sessionId },
  });
}

/**
 * Recomputes the derived state of each table and, where it changed, stores it, logs a
 * table_state_events row and emits table.state_changed to staff.
 */
export async function refreshTableStates(tx: Tx, tableIds: readonly string[], source: TableStateSource): Promise<void> {
  if (tableIds.length === 0) return;
  const tables = await tx.db
    .selectFrom('tables')
    .leftJoin('table_sessions', 'table_sessions.id', 'tables.current_session_id')
    .select([
      'tables.id',
      'tables.outlet_id',
      'tables.state',
      'tables.needs_cleaning',
      'tables.current_session_id',
      'table_sessions.status as session_status',
      'table_sessions.bill_requested_at',
    ])
    .where('tables.id', 'in', [...new Set(tableIds)])
    .execute();

  const sessionIds = tables.map((t) => t.current_session_id).filter((id): id is string => !!id);
  const orders = sessionIds.length
    ? await tx.db
        .selectFrom('orders')
        .select(['table_session_id', 'status'])
        .where('table_session_id', 'in', sessionIds)
        .execute()
    : [];

  for (const t of tables) {
    const state = deriveTableState({
      needsCleaning: t.needs_cleaning,
      session:
        t.current_session_id && t.session_status
          ? { status: t.session_status as SessionStatus, bill_requested_at: t.bill_requested_at }
          : null,
      orderStatuses: orders.filter((o) => o.table_session_id === t.current_session_id).map((o) => o.status as OrderStatus),
    });
    if (state === t.state) continue;
    await setTableState(tx, { id: t.id, outlet_id: t.outlet_id }, state, source);
  }
}

export async function setTableState(
  tx: Tx,
  table: { id: string; outlet_id: string },
  state: TableState,
  source: TableStateSource,
  confidence: number | null = null,
): Promise<void> {
  await tx.db.updateTable('tables').set({ state }).where('id', '=', table.id).execute();
  await tx.db
    .insertInto('table_state_events')
    .values({ tenant_id: tx.tenantId, outlet_id: table.outlet_id, table_id: table.id, source, state, confidence })
    .execute();
  await tx.emit({
    outletId: table.outlet_id,
    type: 'table.state_changed',
    channels: ['outlet'],
    payload: { table_id: table.id, state, source },
  });
}

/** Refreshes every table attached to a session (merged tables share one). */
export async function refreshSessionTables(tx: Tx, sessionId: string, source: TableStateSource): Promise<void> {
  const rows = await tx.db.selectFrom('tables').select('id').where('current_session_id', '=', sessionId).execute();
  await refreshTableStates(
    tx,
    rows.map((r) => r.id),
    source,
  );
}

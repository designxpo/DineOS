import { ACTIVE_ORDER_STATUSES, type OrderStatus, type SessionStatus, type TableState } from './enums';

export interface TableStateInput {
  needsCleaning: boolean;
  session: { status: SessionStatus; bill_requested_at: string | Date | null } | null;
  /** Statuses of the session's orders. */
  orderStatuses: readonly OrderStatus[];
}

/**
 * Table state from orders and bills (spec §5). A pending session (guests browsing, cart only)
 * still counts as vacant: scanning and adding to cart does not occupy a table.
 */
export function deriveTableState({ needsCleaning, session, orderStatuses }: TableStateInput): TableState {
  if (!session || session.status !== 'open') return needsCleaning ? 'needs_cleaning' : 'vacant';
  if (session.bill_requested_at) return 'bill_requested';
  if (orderStatuses.some((s) => ACTIVE_ORDER_STATUSES.includes(s))) return 'ordered';
  if (orderStatuses.some((s) => s === 'served' || s === 'billed')) return 'served';
  return 'occupied';
}

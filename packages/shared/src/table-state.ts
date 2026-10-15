import { ACTIVE_ORDER_STATUSES, type OrderStatus, type SessionStatus, type TableState } from './enums';

export type CameraState = 'vacant' | 'occupied' | 'needs_cleaning';

/** Camera readings older than this are ignored (the worker resends its view every few minutes). */
export const CAMERA_FRESH_MS = 15 * 60_000;

export interface TableStateInput {
  needsCleaning: boolean;
  session: { status: SessionStatus; bill_requested_at: string | Date | null } | null;
  /** Statuses of the session's orders. */
  orderStatuses: readonly OrderStatus[];
  /** Latest camera reading, if the table has a camera zone (Phase 3). */
  camera?: { state: CameraState; at: string | Date } | null;
  now?: Date;
}

/**
 * Table state from orders and bills (spec §5). A pending session (guests browsing, cart only)
 * still counts as vacant: scanning and adding to cart does not occupy a table.
 */
export function deriveTableState({ needsCleaning, session, orderStatuses, camera, now = new Date() }: TableStateInput): TableState {
  if (!session || session.status !== 'open') {
    if (needsCleaning) return 'needs_cleaning';
    // Fusion rule (spec §5): the camera only fills gaps. With no open visit it may say a table is
    // taken or left messy; an open session or order always wins over it.
    if (camera && now.getTime() - new Date(camera.at).getTime() < CAMERA_FRESH_MS) {
      return camera.state;
    }
    return 'vacant';
  }
  if (session.bill_requested_at) return 'bill_requested';
  if (orderStatuses.some((s) => ACTIVE_ORDER_STATUSES.includes(s))) return 'ordered';
  if (orderStatuses.some((s) => s === 'served' || s === 'billed')) return 'served';
  return 'occupied';
}

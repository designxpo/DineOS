import { ACTIVE_ORDER_STATUSES, type OrderStatus, type SessionStatus, type TableState } from './enums';

export type CameraState = 'vacant' | 'occupied' | 'needs_cleaning';

/** Camera readings older than this are ignored (the worker resends its view every few minutes). */
export const CAMERA_FRESH_MS = 15 * 60_000;

/** A guest's scan (or cart change) counts as people at the table for this long. */
export const GUESTS_PRESENT_MINUTES = 20;
/** Guests who scanned this long ago with nobody seating them or taking an order: tell the floor. */
export const GUESTS_WAITING_ALERT_MINUTES = 5;
/** A table waiting this long to be cleaned (when the outlet clears tables by hand) is flagged. */
export const CLEANING_ALERT_MINUTES = 10;

const minutesAgo = (t: string | Date, now: Date) => (now.getTime() - new Date(t).getTime()) / 60_000;

/** Whether phones at the table were active recently enough to mean people are sitting there. */
export function guestsPresent(guestSeenAt: string | Date | null | undefined, now = new Date()): boolean {
  return !!guestSeenAt && minutesAgo(guestSeenAt, now) < GUESTS_PRESENT_MINUTES;
}

/**
 * Whether a table left to be cleaned now counts as clean: the outlet clears tables within
 * `autoCleanMinutes` of guests leaving (0 means staff mark them clean).
 */
export function cleaningLapsed(needsCleaningSince: string | Date | null | undefined, autoCleanMinutes: number, now = new Date()): boolean {
  return autoCleanMinutes > 0 && !!needsCleaningSince && minutesAgo(needsCleaningSince, now) >= autoCleanMinutes;
}

export interface TableStateInput {
  needsCleaning: boolean;
  /** When the table started waiting to be cleaned, and how long the outlet takes to clear one. */
  cleaning?: { since: string | Date | null; autoMinutes: number } | null;
  session: { status: SessionStatus; bill_requested_at: string | Date | null } | null;
  /** Latest scan or cart change by a guest phone in a pending session. */
  guestSeenAt?: string | Date | null;
  /** Statuses of the session's orders. */
  orderStatuses: readonly OrderStatus[];
  /** Latest camera reading, if the table has a camera zone (Phase 3). */
  camera?: { state: CameraState; at: string | Date } | null;
  now?: Date;
}

/**
 * Table state from orders and bills (spec §5). Without an order, a guest phone that scanned the
 * table QR in the last few minutes means people are sitting there (occupied); a table left to be
 * cleaned counts as clean again after the outlet's clearing time.
 */
export function deriveTableState({ needsCleaning, cleaning, session, guestSeenAt, orderStatuses, camera, now = new Date() }: TableStateInput): TableState {
  if (!session || session.status !== 'open') {
    if (session?.status === 'pending' && guestsPresent(guestSeenAt, now)) return 'occupied';
    if (needsCleaning && !(cleaning && cleaningLapsed(cleaning.since, cleaning.autoMinutes, now))) return 'needs_cleaning';
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

/** Food served this long ago with no bill asked for or printed is flagged on the floor. */
export const NOT_BILLED_ALERT_MINUTES = 30;
/** A bill asked for or printed this long ago and still unpaid is flagged on the floor. */
export const NOT_PAID_ALERT_MINUTES = 20;

export interface PaymentAlertInput {
  /** When the last served-but-unbilled order on the table was served. */
  lastServedAt: string | Date | null;
  billRequestedAt: string | Date | null;
  /** When the oldest printed, unpaid bill on the table was printed. */
  unpaidBillSince: string | Date | null;
  now?: Date;
}

/**
 * Where money can walk out of the door: guests served a while ago that nobody has billed, or a
 * bill that was asked for or printed and is still unpaid.
 */
export function paymentAlert({ lastServedAt, billRequestedAt, unpaidBillSince, now = new Date() }: PaymentAlertInput): { kind: 'not_billed' | 'not_paid'; minutes: number } | null {
  const minutesSince = (t: string | Date) => Math.floor((now.getTime() - new Date(t).getTime()) / 60_000);
  const pending = [billRequestedAt, unpaidBillSince].filter((t): t is string | Date => t != null).map(minutesSince);
  if (pending.length > 0) {
    const minutes = Math.max(...pending);
    return minutes >= NOT_PAID_ALERT_MINUTES ? { kind: 'not_paid', minutes } : null;
  }
  if (lastServedAt) {
    const minutes = minutesSince(lastServedAt);
    if (minutes >= NOT_BILLED_ALERT_MINUTES) return { kind: 'not_billed', minutes };
  }
  return null;
}

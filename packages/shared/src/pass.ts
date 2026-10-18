// Food waiting at the pass: how long it may wait before it counts as going cold.

/** Minutes a ready dish may sit with nobody holding it before the floor is warned. */
export const PASS_UNCLAIMED_OVERDUE_MIN = 3;
/** Minutes before the manager is told, held by nobody. */
export const PASS_UNCLAIMED_ESCALATE_MIN = 6;
/** Minutes a waiter may hold a dish before it counts as stuck, and before the manager is told. */
export const PASS_CLAIMED_OVERDUE_MIN = 5;
export const PASS_CLAIMED_ESCALATE_MIN = 10;

export type PassLevel = 'waiting' | 'overdue' | 'escalated';

/**
 * A claim restarts the clock: someone has it, and gets a few minutes to carry it. Past that the
 * dish is overdue, and later still the manager sees it, whether or not anyone had taken it.
 */
export function passLevel(item: { ready_at: string | Date; claimed_at: string | Date | null }, now = Date.now()): PassLevel {
  const minutes = (since: string | Date) => (now - new Date(since).getTime()) / 60_000;
  if (item.claimed_at) {
    const m = minutes(item.claimed_at);
    return m >= PASS_CLAIMED_ESCALATE_MIN ? 'escalated' : m >= PASS_CLAIMED_OVERDUE_MIN ? 'overdue' : 'waiting';
  }
  const m = minutes(item.ready_at);
  return m >= PASS_UNCLAIMED_ESCALATE_MIN ? 'escalated' : m >= PASS_UNCLAIMED_OVERDUE_MIN ? 'overdue' : 'waiting';
}

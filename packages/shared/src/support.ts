// Help cases: how bad a problem is, how fast support answers it, and when support is staffed.
// Promise only hours the team can staff; say plainly what happens outside them.

export const SUPPORT_SEVERITIES = ['stopped', 'degraded', 'question'] as const;
export type SupportSeverity = (typeof SUPPORT_SEVERITIES)[number];

export const SUPPORT_STATUSES = ['open', 'in_progress', 'waiting_on_outlet', 'resolved', 'closed'] as const;
export type SupportStatus = (typeof SUPPORT_STATUSES)[number];

/** Minutes to a first answer during support hours; null is the same or next working day. */
export const SUPPORT_TARGET_MINUTES: Record<SupportSeverity, number | null> = { stopped: 10, degraded: 60, question: null };

/** Support is staffed every day in these hours, India time. */
export const SUPPORT_HOURS = { from: '11:00', to: '23:00', timeZone: 'Asia/Kolkata', label: '11 am to 11 pm' } as const;

/** Whether support is staffed at `at`. */
export function supportOpen(at: Date = new Date()): boolean {
  const hm = new Intl.DateTimeFormat('en-GB', { timeZone: SUPPORT_HOURS.timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);
  return hm >= SUPPORT_HOURS.from && hm < SUPPORT_HOURS.to;
}

/** Whether a case's first answer came (or is still due) later than its target, counting only from when support opened. */
export function missedTarget(c: { severity: SupportSeverity; created_at: string; first_response_at: string | null }, now: Date = new Date()): boolean {
  const target = SUPPORT_TARGET_MINUTES[c.severity];
  if (target === null) return false;
  const answered = c.first_response_at ? new Date(c.first_response_at) : now;
  // A case raised out of hours is due from the next opening; this check only judges in-hours cases.
  if (!supportOpen(new Date(c.created_at))) return false;
  return answered.getTime() - new Date(c.created_at).getTime() > target * 60_000;
}

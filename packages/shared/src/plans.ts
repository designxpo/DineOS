// What each plan includes, and what an upgrade costs. Shared by the API, which charges and
// enforces, and the plans page, which shows the same numbers.

/** Plan features as stored in plans.features. Only the keys below are enforced by the API. */
export interface PlanFeatures {
  max_outlets?: number;
  max_tables?: number;
  white_label?: boolean;
  talko_link?: boolean;
}

/** One comparable line on the plans page. Only lines the API actually enforces belong here. */
export const PLAN_LINES: { key: keyof PlanFeatures; label: string; kind: 'count' | 'flag' }[] = [
  { key: 'max_outlets', label: 'Outlets', kind: 'count' },
  { key: 'max_tables', label: 'Tables', kind: 'count' },
  { key: 'white_label', label: 'Your own logo and colours on the menu, receipts and screens', kind: 'flag' },
  { key: 'talko_link', label: 'Talko AI: tables booked in chat, WhatsApp after bills and bookings', kind: 'flag' },
];

/** Everything here is on every plan. */
export const ALL_PLANS_INCLUDE = [
  'QR menu and ordering',
  'Kitchen display',
  'POS and GST billing',
  'Kitchen and bill printers',
  'Reservations and waitlist',
  'Loyalty and memberships',
  'Inventory and recipes',
  'Reports',
];

export function planFeatures(raw: unknown): PlanFeatures {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const count = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined);
  return {
    max_outlets: count(r.max_outlets),
    max_tables: count(r.max_tables),
    white_label: r.white_label === true,
    talko_link: r.talko_link === true,
  };
}

/** Days from `a` to `b` (calendar dates, YYYY-MM-DD). */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Last day of a billing period that starts on `start`: a month (or a year) later, less a day.
 * 31 Jan + 1 month ends on 28 Feb (or 29), not in March.
 */
export function periodEnd(start: string, billingPeriod: string): string {
  const [y, m, d] = start.split('-').map(Number) as [number, number, number];
  const months = billingPeriod === 'yearly' ? 12 : 1;
  const targetMonth = m - 1 + months;
  const ty = y + Math.floor(targetMonth / 12);
  const tm = targetMonth % 12;
  const lastDay = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  const next = new Date(Date.UTC(ty, tm, Math.min(d, lastDay))).toISOString().slice(0, 10);
  return addDays(next, -1);
}

/** Razorpay will not take less than ₹1. */
export const MIN_CHARGE_PAISE = 100;

export interface UpgradeQuote {
  /** What the restaurant pays now. */
  amount_paise: number;
  /** Taken off for the days already paid for on the current plan and not used. */
  credit_paise: number;
  /** The new plan's period: from today. */
  period_start: string;
  period_end: string;
}

/**
 * The price of moving to a plan today: its full price for a new period starting today, less the
 * unused part of what was paid for the current period. Today's day counts as used.
 */
export function upgradeQuote(input: {
  pricePaise: number;
  billingPeriod: string;
  today: string;
  current: { periodStart: string; periodEnd: string; paidPaise: number } | null;
}): UpgradeQuote {
  const { pricePaise, billingPeriod, today, current } = input;
  let credit = 0;
  if (current && current.paidPaise > 0 && current.periodEnd > today) {
    const total = daysBetween(current.periodStart, current.periodEnd) + 1;
    const unused = Math.min(total, daysBetween(today, current.periodEnd));
    if (total > 0 && unused > 0) credit = Math.floor((current.paidPaise * unused) / total);
  }
  credit = Math.min(credit, Math.max(0, pricePaise - MIN_CHARGE_PAISE));
  return {
    amount_paise: Math.max(MIN_CHARGE_PAISE, pricePaise - credit),
    credit_paise: credit,
    period_start: today,
    period_end: periodEnd(today, billingPeriod),
  };
}

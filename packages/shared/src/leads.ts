// The website's demo request form: what a restaurant can tell us before we call.

export const DEMO_TABLES = ['1-10', '11-25', '26-40', '41+'] as const;
export type DemoTables = (typeof DEMO_TABLES)[number];

/** What hurts most, in the owner's words. */
export const DEMO_PAINS = ['orders_slip', 'payments_mismatch', 'free_food', 'month_end', 'internet', 'support'] as const;
export type DemoPain = (typeof DEMO_PAINS)[number];

export const DEMO_PAIN_LABELS: Record<DemoPain, string> = {
  orders_slip: 'Orders and drinks get missed in the rush',
  payments_mismatch: 'Cash and UPI do not match the bills',
  free_food: 'Free food and discounts go unrecorded',
  month_end: 'Month end and GST take too long',
  internet: 'Billing stops when the internet does',
  support: 'Our software vendor is slow to help',
};

/**
 * What the restaurant bills on today. Most already pay for software, often a year ahead, so the
 * answer (and when it renews) says when they can move: the form offers these, any short text is kept.
 */
export const CURRENT_SYSTEMS = ['Petpooja', 'Posist / Restroworks', 'DotPe', 'Other software', 'Paper or Excel'] as const;

/** Paper, Excel or nothing: there is no contract to wait for. */
export const noContract = (system: string | null | undefined) => !system || /paper|excel|none|nothing/i.test(system);

/** How long before a renewal to call: time to show the money check and plan a quiet switch. */
export const CALL_BEFORE_RENEWAL_DAYS = 45;

/** The day to start calling about a renewal on `renewsOn` (YYYY-MM-DD, the first of its month). */
export function callFrom(renewsOn: string): string {
  return new Date(Date.parse(`${renewsOn}T00:00:00Z`) - CALL_BEFORE_RENEWAL_DAYS * 86_400_000).toISOString().slice(0, 10);
}

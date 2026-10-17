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

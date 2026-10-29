import { describe, expect, it } from 'vitest';
import { periodEnd, planFeatures, upgradeQuote } from './plans';

describe('plan periods', () => {
  it('ends a month (or year) later, less a day, without spilling into the next month', () => {
    expect(periodEnd('2026-10-29', 'monthly')).toBe('2026-11-28');
    expect(periodEnd('2026-01-31', 'monthly')).toBe('2026-02-27');
    expect(periodEnd('2028-01-31', 'monthly')).toBe('2028-02-28');
    expect(periodEnd('2026-12-15', 'monthly')).toBe('2027-01-14');
    expect(periodEnd('2026-10-29', 'yearly')).toBe('2027-10-28');
  });
});

describe('upgrade price', () => {
  it('charges the full price when nothing was paid (trial or no period)', () => {
    expect(upgradeQuote({ pricePaise: 299900, billingPeriod: 'monthly', today: '2026-10-29', current: null })).toEqual({
      amount_paise: 299900,
      credit_paise: 0,
      period_start: '2026-10-29',
      period_end: '2026-11-28',
    });
    expect(upgradeQuote({ pricePaise: 299900, billingPeriod: 'monthly', today: '2026-10-29', current: { periodStart: '2026-10-15', periodEnd: '2026-11-14', paidPaise: 0 } }).credit_paise).toBe(0);
  });

  it('takes off the unused days of the paid current period', () => {
    // Standard paid for 1-31 Oct (31 days); upgrading on 21 Oct leaves 10 unused days.
    const q = upgradeQuote({ pricePaise: 299900, billingPeriod: 'monthly', today: '2026-10-21', current: { periodStart: '2026-10-01', periodEnd: '2026-10-31', paidPaise: 149900 } });
    expect(q.credit_paise).toBe(Math.floor((149900 * 10) / 31));
    expect(q.amount_paise).toBe(299900 - q.credit_paise);
  });

  it('gives no credit for a period that has ended, or on its last day', () => {
    const base = { pricePaise: 299900, billingPeriod: 'monthly' };
    expect(upgradeQuote({ ...base, today: '2026-11-02', current: { periodStart: '2026-10-01', periodEnd: '2026-10-31', paidPaise: 149900 } }).credit_paise).toBe(0);
    expect(upgradeQuote({ ...base, today: '2026-10-31', current: { periodStart: '2026-10-01', periodEnd: '2026-10-31', paidPaise: 149900 } }).credit_paise).toBe(0);
  });

  it('never charges less than ₹1', () => {
    const q = upgradeQuote({ pricePaise: 150000, billingPeriod: 'monthly', today: '2026-10-01', current: { periodStart: '2026-10-01', periodEnd: '2026-10-31', paidPaise: 1_000_000 } });
    expect(q.amount_paise).toBe(100);
  });
});

describe('plan features', () => {
  it('reads only the enforced keys, ignoring junk', () => {
    expect(planFeatures({ max_outlets: 5, max_tables: 100, white_label: true, talko_link: 'yes', kds: true })).toEqual({ max_outlets: 5, max_tables: 100, white_label: true, talko_link: false });
    expect(planFeatures(null)).toEqual({ max_outlets: undefined, max_tables: undefined, white_label: false, talko_link: false });
  });
});

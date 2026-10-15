import { describe, expect, it } from 'vitest';
import { allocate, computeBill, splitEvenly } from './billing';

const base = { service_charge_bp: 0, service_charge_tax_rate_bp: 500, prices_include_tax: false };

describe('allocate', () => {
  it('sums exactly to the total', () => {
    expect(allocate(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(allocate(1001, [300, 700]).reduce((a, b) => a + b)).toBe(1001);
  });
  it('returns zeros for zero weights', () => {
    expect(allocate(50, [0, 0])).toEqual([0, 0]);
  });
});

describe('splitEvenly', () => {
  it('splits ₹1000.01 three ways without losing a paisa', () => {
    const parts = splitEvenly(100001, 3);
    expect(parts).toEqual([33334, 33334, 33333]);
  });
  it('rejects non-positive counts', () => {
    expect(() => splitEvenly(100, 0)).toThrow();
  });
});

describe('computeBill', () => {
  it('applies 5% GST split equally into CGST and SGST', () => {
    const t = computeBill({
      ...base,
      lines: [{ key: 'a', qty: 2, unit_price_paise: 25000, tax_rate_bp: 500 }],
    });
    expect(t.subtotal_paise).toBe(50000);
    expect(t.cgst_paise).toBe(1250);
    expect(t.sgst_paise).toBe(1250);
    expect(t.total_paise).toBe(52500);
    expect(t.round_off_paise).toBe(0);
  });

  it('rounds the grand total to the nearest rupee and records the round-off', () => {
    const t = computeBill({
      ...base,
      lines: [{ key: 'a', qty: 1, unit_price_paise: 12345, tax_rate_bp: 500 }],
    });
    // 12345 + 309 + 309 = 12963 -> 13000
    expect(t.tax_total_paise).toBe(618);
    expect(t.total_paise).toBe(13000);
    expect(t.round_off_paise).toBe(37);
  });

  it('takes item discounts before a percent bill discount, and taxes the discounted value', () => {
    const t = computeBill({
      ...base,
      lines: [
        { key: 'a', qty: 1, unit_price_paise: 40000, tax_rate_bp: 500, item_discount_paise: 10000 },
        { key: 'b', qty: 1, unit_price_paise: 30000, tax_rate_bp: 1800 },
      ],
      bill_discount: { kind: 'percent', bp: 1000 },
    });
    expect(t.item_discount_paise).toBe(10000);
    expect(t.bill_discount_paise).toBe(6000);
    const [a, b] = t.lines;
    expect(a!.bill_discount_paise + b!.bill_discount_paise).toBe(6000);
    expect(a!.taxable_paise).toBe(27000);
    expect(b!.taxable_paise).toBe(27000);
    expect(a!.tax_paise).toBe(1350);
    expect(b!.tax_paise).toBe(4860);
  });

  it('caps an amount discount at the bill value', () => {
    const t = computeBill({
      ...base,
      lines: [{ key: 'a', qty: 1, unit_price_paise: 10000, tax_rate_bp: 500 }],
      bill_discount: { kind: 'amount', paise: 99999 },
    });
    expect(t.bill_discount_paise).toBe(10000);
    expect(t.total_paise).toBe(0);
  });

  it('adds service charge on the discounted value and taxes it', () => {
    const t = computeBill({
      ...base,
      service_charge_bp: 1000,
      lines: [{ key: 'a', qty: 1, unit_price_paise: 100000, tax_rate_bp: 500 }],
    });
    expect(t.service_charge_paise).toBe(10000);
    expect(t.service_charge_tax_paise).toBe(500);
    expect(t.taxable_paise).toBe(110000);
    expect(t.total_paise).toBe(115500);
  });

  it('backs tax out of inclusive prices', () => {
    const t = computeBill({
      ...base,
      prices_include_tax: true,
      lines: [{ key: 'a', qty: 1, unit_price_paise: 10500, tax_rate_bp: 500 }],
    });
    expect(t.taxable_paise).toBe(10000);
    expect(t.tax_total_paise).toBe(500);
    expect(t.total_paise).toBe(10500);
  });

  it('applies loyalty after the bill discount, capped, and taxes the rest', () => {
    const t = computeBill({
      ...base,
      lines: [{ key: 'a', qty: 1, unit_price_paise: 100000, tax_rate_bp: 500 }],
      bill_discount: { kind: 'percent', bp: 1000 },
      loyalty_paise: 20000,
    });
    expect(t.bill_discount_paise).toBe(10000);
    expect(t.loyalty_discount_paise).toBe(20000);
    expect(t.taxable_paise).toBe(70000);
    expect(t.tax_total_paise).toBe(3500);
    const capped = computeBill({ ...base, lines: [{ key: 'a', qty: 1, unit_price_paise: 5000, tax_rate_bp: 500 }], loyalty_paise: 99999 });
    expect(capped.loyalty_discount_paise).toBe(5000);
    expect(capped.total_paise).toBe(0);
  });

  it('handles an empty bill', () => {
    const t = computeBill({ ...base, lines: [] });
    expect(t.total_paise).toBe(0);
  });
});

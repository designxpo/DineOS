import { describe, expect, it } from 'vitest';
import { businessDate, financialYear, formatInvoiceNo } from './dates';
import { rupeesToPaise, formatRate } from './money';

describe('businessDate', () => {
  it('uses India time, not UTC', () => {
    // 20:00 UTC on 31 March is 01:30 IST on 1 April
    expect(businessDate(new Date('2026-03-31T20:00:00Z'))).toBe('2026-04-01');
  });
});

describe('financialYear', () => {
  it('starts in April', () => {
    expect(financialYear('2026-04-01').code).toBe('2627');
    expect(financialYear('2026-03-31').code).toBe('2526');
    expect(financialYear('2026-10-15').label).toBe('2026-27');
  });
});

describe('formatInvoiceNo', () => {
  it('stays within the 16-character GST limit', () => {
    const no = formatInvoiceNo('AURM', '2627', 999999);
    expect(no).toBe('AURM/2627/999999');
    expect(no.length).toBeLessThanOrEqual(16);
  });
});

describe('money', () => {
  it('parses rupees without float drift', () => {
    expect(rupeesToPaise('0.29')).toBe(29);
    expect(rupeesToPaise(199.9)).toBe(19990);
    expect(rupeesToPaise('-12.5')).toBe(-1250);
    expect(() => rupeesToPaise('12.345')).toThrow();
  });
  it('formats rates', () => {
    expect(formatRate(500)).toBe('5%');
    expect(formatRate(250)).toBe('2.5%');
  });
});

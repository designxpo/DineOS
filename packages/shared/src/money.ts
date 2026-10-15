const inr = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const inrWhole = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
});

/** ₹1,234.50 */
export function formatPaise(paise: number): string {
  return inr.format(paise / 100);
}

/** ₹1,235 when whole rupees, ₹1,234.50 otherwise. Used on menus. */
export function formatPrice(paise: number): string {
  return paise % 100 === 0 ? inrWhole.format(paise / 100) : inr.format(paise / 100);
}

/** Parses "1234.5" or 1234.5 rupees into paise without float drift. */
export function rupeesToPaise(rupees: string | number): number {
  const s = typeof rupees === 'number' ? rupees.toFixed(2) : rupees.trim();
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) throw new Error(`Invalid rupee amount: ${rupees}`);
  const [whole, frac = ''] = s.replace('-', '').split('.');
  const paise = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  return s.startsWith('-') ? -paise : paise;
}

/** 500 → "5%", 250 → "2.5%" */
export function formatRate(bp: number): string {
  return `${Number((bp / 100).toFixed(2))}%`;
}

export const DEFAULT_TIMEZONE = 'Asia/Kolkata';

/** Calendar date (YYYY-MM-DD) of `at` in the outlet's timezone. Business days follow this. */
export function businessDate(at: Date, timeZone = DEFAULT_TIMEZONE): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
  return parts; // en-CA formats as YYYY-MM-DD
}

/** Indian financial year (April to March) containing `date` (YYYY-MM-DD). */
export function financialYear(date: string): { startYear: number; code: string; label: string } {
  const [y, m] = date.split('-').map(Number) as [number, number];
  const startYear = m >= 4 ? y : y - 1;
  const a = String(startYear % 100).padStart(2, '0');
  const b = String((startYear + 1) % 100).padStart(2, '0');
  return { startYear, code: `${a}${b}`, label: `${startYear}-${b}` };
}

/**
 * GST invoice number: PREFIX/FYCODE/SEQ, at most 16 characters (CGST rule 46).
 * Prefix is limited to 4 characters, so sequences up to 999,999 fit.
 */
export function formatInvoiceNo(prefix: string, fyCode: string, seq: number): string {
  return `${prefix}/${fyCode}/${String(seq).padStart(6, '0')}`;
}

/** Minutes and seconds elapsed, for KDS timers. */
export function elapsed(from: Date | string, now: Date = new Date()): { minutes: number; seconds: number } {
  const ms = Math.max(0, now.getTime() - new Date(from).getTime());
  return { minutes: Math.floor(ms / 60000), seconds: Math.floor((ms % 60000) / 1000) };
}

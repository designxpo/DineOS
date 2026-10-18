// Sales exported from the billing system an outlet already uses (Petpooja and the like), as CSV
// or Excel. Layouts differ: one row per bill with a payment type column, or an amount column per
// method for bills paid in parts; a few rows of report details above the header; totals below.
// When the columns cannot be told from their names, the person uploading names them.

import type { PaymentMethod } from '@mezmitra/shared/enums';
import { badRequest } from '../../lib/errors';
import { parseAmount, parseBankDate } from './statement';

export const SALES_ROLES = ['date', 'total', 'method', 'bill_no', 'time', 'reference', 'status'] as const;
export type SalesRole = (typeof SALES_ROLES)[number];
/** Header text per role, as the person uploading picked them. */
export type SalesColumnNames = Partial<Record<SalesRole, string>>;

export interface OutsidePayment {
  method: PaymentMethod;
  amount_paise: number;
  reference: string | null;
}

export interface OutsideBill {
  bill_no: string | null;
  business_date: string;
  /** HH:MM, outlet time; null when the export has dates only. */
  time: string | null;
  total_paise: number;
  payments: OutsidePayment[];
}

export interface ParsedSales {
  bills: OutsideBill[];
  period_from: string;
  period_to: string;
  skipped: number;
  /** Bills marked as paid in parts with no amounts per method: counted under "other". */
  unsplit: number;
  /** Which header was read for what, so the person can see it was understood. */
  columns: SalesColumnNames;
}

const SPLIT_METHODS = ['cash', 'upi', 'card_slip', 'platform', 'other'] as const;
type SplitMethod = (typeof SPLIT_METHODS)[number];

const norm = (h: string) => h.toLowerCase().replace(/[^a-z/ ]+/g, ' ').replace(/\s+/g, ' ').trim();

/** What a payment type cell means. Unknown words are "other", never guessed as UPI. */
export function methodOf(raw: string): PaymentMethod | 'split' {
  const s = raw.toLowerCase();
  if (/\b(part|split|multiple|mixed)\b/.test(s)) return 'split';
  if (/\b(due|on account|credit sale|unpaid|pending)\b/.test(s)) return 'other';
  if (/cash/.test(s)) return 'cash';
  if (/\b(upi|gpay|g pay|google ?pay|phone ?pe|paytm|bhim|qr|amazon ?pay)\b/.test(s)) return 'upi';
  if (/\b(card|credit|debit|visa|master|rupay|amex|swipe|edc)\b/.test(s)) return 'card_slip';
  if (/\b(zomato|swiggy|online|aggregator|magicpin|ondc|eazydiner|dineout)\b/.test(s)) return 'platform';
  return 'other';
}

/** "21:34", "9:34 PM", "2026-10-15 21:34:10" -> "21:34". */
export function parseTime(raw: string): string | null {
  const m = /(?:^|[\sT])(\d{1,2}):(\d{2})(?::\d{2})?\s*([ap])?\.?\s*m?\.?/i.exec(` ${raw}`);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2]);
  const half = m[3]?.toLowerCase();
  if (half === 'p' && h < 12) h += 12;
  if (half === 'a' && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

type Indexes = Record<SalesRole, number> & { split: Partial<Record<SplitMethod, number>> };

function findColumns(header: string[]): Indexes | null {
  const h = header.map(norm);
  const taken = new Set<number>();
  const pick = (...tests: RegExp[]) => {
    for (const re of tests) {
      const i = h.findIndex((x, j) => !taken.has(j) && re.test(x));
      if (i >= 0) {
        taken.add(i);
        return i;
      }
    }
    return -1;
  };
  // Amounts per method, for bills paid in parts: the header is the method itself.
  const split: Indexes['split'] = {};
  const splitTests: Record<SplitMethod, RegExp> = {
    cash: /^cash( amount| amt| paid)?$/,
    upi: /^(upi|gpay|phonepe|paytm|wallet upi)( amount| amt| paid)?$/,
    card_slip: /^card( amount| amt| paid)?$/,
    platform: /^(online|zomato|swiggy|aggregator)( amount| amt| paid)?$/,
    other: /^(other|others|due)( amount| amt| paid)?$/,
  };
  for (const m of SPLIT_METHODS) {
    const i = h.findIndex((x) => splitTests[m].test(x));
    if (i >= 0) split[m] = i;
  }
  // One such column alone is more likely cash tendered than a bill paid in parts.
  if (Object.keys(split).length < 2) for (const m of SPLIT_METHODS) delete split[m];
  for (const i of Object.values(split)) taken.add(i);
  const cols: Indexes = {
    date: pick(/^(bill|invoice|order|txn|transaction|sale)s? ?date( ?time)?$/, /^date( ?time)?$/, /^(created|billed|settled)( at| on| date)?$/, /date/),
    time: pick(/^(bill|invoice|order)? ?time$/),
    total: pick(
      /^grand total( amount| amt)?$/,
      /^(net|final) (total|amount|amt|sales)$/,
      /^(bill|invoice|order|total) (amount|amt|value|total)$/,
      /^total( inr| rs)?$/,
      /^(paid )?(amount|amt)( inr| rs)?$/,
    ),
    method: pick(/^(payment|pay|settlement|settle|tender)( ?(type|mode|method|by))?$/, /mode of payment/, /payment (type|mode|method)/),
    bill_no: pick(/^(bill|invoice|inv|order|receipt)( ?(no|number|num|id))?$/),
    reference: pick(/utr/, /^(payment |txn |transaction )?(ref|reference)( no| number| id)?$/, /^(transaction|txn) id$/),
    status: pick(/^(order |bill |invoice )?status$/),
    split,
  };
  if (cols.date < 0 || (cols.total < 0 && !Object.keys(split).length)) return null;
  return cols;
}

function namedColumns(header: string[], names: SalesColumnNames): Indexes {
  const h = header.map((x) => x.trim().toLowerCase());
  const at = (role: SalesRole) => {
    const want = names[role]?.trim().toLowerCase();
    if (!want) return -1;
    const i = h.indexOf(want);
    if (i < 0) throw badRequest('unknown_column', `There is no column called "${names[role]}"`);
    return i;
  };
  const cols = { ...Object.fromEntries(SALES_ROLES.map((r) => [r, at(r)])), split: {} } as Indexes;
  if (cols.date < 0 || cols.total < 0) throw badRequest('columns_needed', 'Pick the date and bill total columns');
  return cols;
}

/** The likeliest header row: the first of the top rows with the most filled cells. */
function guessHeader(grid: string[][]): string[] {
  let best: string[] = [];
  for (const row of grid.slice(0, 40)) {
    const filled = row.filter((c) => c.trim()).length;
    if (filled > best.filter((c) => c.trim()).length) best = row;
  }
  return best.map((c) => c.trim());
}

const SKIP_STATUS = /cancel|void|delet|reject|refund|complimentary|\bnc\b|no charge|unsettled|running/i;

/** Turns an export grid into its bills. `names` overrides header detection. */
export function parseSalesExport(grid: string[][], names?: SalesColumnNames): ParsedSales {
  let start = -1;
  let cols: Indexes | null = null;
  if (names && Object.values(names).some(Boolean)) {
    const header = guessHeader(grid);
    start = grid.findIndex((r) => r.map((c) => c.trim()).join('\u0000') === header.join('\u0000'));
    cols = namedColumns(header, names);
  } else {
    for (let i = 0; i < Math.min(grid.length, 40); i++) {
      cols = findColumns(grid[i]!);
      if (cols) {
        start = i;
        break;
      }
    }
  }
  if (!cols) {
    throw badRequest('unknown_sales_export', 'Could not tell which columns hold the date and the bill total. Pick them below.', {
      headers: guessHeader(grid).filter(Boolean),
    });
  }

  const header = grid[start]!;
  const bills: OutsideBill[] = [];
  let skipped = 0;
  let unsplit = 0;
  for (const row of grid.slice(start + 1)) {
    const cell = (i: number | undefined) => (i !== undefined && i >= 0 ? (row[i] ?? '').trim() : '');
    const date = parseBankDate(cell(cols.date));
    if (!date) {
      if (row.some((c) => c.trim())) skipped++;
      continue; // totals, subheadings, footers
    }
    if (SKIP_STATUS.test(cell(cols.status))) {
      skipped++;
      continue;
    }
    const reference = cell(cols.reference) || null;
    let payments: OutsidePayment[] = Object.entries(cols.split)
      .map(([m, i]) => ({ method: m as SplitMethod, amount_paise: parseAmount(cell(i)), reference: m === 'upi' ? reference : null }))
      .filter((p) => Number.isFinite(p.amount_paise) && p.amount_paise > 0);
    let total = cols.total >= 0 ? parseAmount(cell(cols.total)) : payments.reduce((a, p) => a + p.amount_paise, 0);
    if (!Number.isFinite(total)) throw badRequest('invalid_amount', `Could not read the bill total on ${date}`);
    if (total <= 0) {
      skipped++;
      continue;
    }
    if (!payments.length) {
      const m = methodOf(cell(cols.method));
      if (m === 'split') unsplit++;
      payments = [{ method: m === 'split' ? 'other' : m, amount_paise: total, reference: m === 'upi' ? reference : null }];
    } else {
      // Rounding, tips or a method without its own column: the rest is "other" so the bill adds up.
      const paid = payments.reduce((a, p) => a + p.amount_paise, 0);
      if (paid < total) payments.push({ method: 'other', amount_paise: total - paid, reference: null });
      else total = paid;
    }
    bills.push({
      bill_no: cell(cols.bill_no).slice(0, 60) || null,
      business_date: date,
      time: parseTime(cell(cols.time)) ?? parseTime(cell(cols.date)),
      total_paise: total,
      payments,
    });
  }
  if (!bills.length) throw badRequest('no_bills', 'The file has no paid bills');
  const merged = mergeRows(bills);
  const dates = merged.map((b) => b.business_date).sort();
  const columns: SalesColumnNames = {};
  for (const role of SALES_ROLES) if (cols[role] >= 0) columns[role] = header[cols[role]]!.trim();
  return { bills: merged, period_from: dates[0]!, period_to: dates.at(-1)!, skipped, unsplit, columns };
}

/**
 * Some exports list a bill once per payment, or once per dish: rows with the same bill number on
 * the same day are one bill. Parts paid the same way add up, unless each has its own reference
 * (two UPI payments reach the bank as two credits).
 */
function mergeRows(rows: OutsideBill[]): OutsideBill[] {
  const byBill = new Map<string, OutsideBill>();
  const out: OutsideBill[] = [];
  for (const b of rows) {
    const key = b.bill_no ? `${b.bill_no}|${b.business_date}` : null;
    const first = key ? byBill.get(key) : undefined;
    if (!first) {
      if (key) byBill.set(key, b);
      out.push(b);
      continue;
    }
    first.total_paise += b.total_paise;
    first.time ??= b.time;
    for (const p of b.payments) {
      const same = first.payments.find((x) => x.method === p.method && (x.reference === p.reference || !x.reference || !p.reference));
      if (same) {
        same.amount_paise += p.amount_paise;
        same.reference ??= p.reference;
      } else first.payments.push(p);
    }
  }
  return out;
}

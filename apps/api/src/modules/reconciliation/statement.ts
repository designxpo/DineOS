// Bank statement exports from Indian net banking, as CSV or Excel. Layouts differ by bank: a few
// rows of account details before the header, separate credit and debit columns or one amount
// with a Cr/Dr column, and day-first dates written several ways. Only credits matter here.

import { badRequest } from '../../lib/errors';

export interface StatementCredit {
  txn_date: string;
  amount_paise: number;
  narration: string;
  reference: string | null;
  /** 12-digit UPI/IMPS reference found in the reference or narration. */
  utr: string | null;
  is_upi: boolean;
}

export interface ParsedStatement {
  credits: StatementCredit[];
  period_from: string;
  period_to: string;
  debits_skipped: number;
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

/** Day-first dates as banks write them: 15/10/2026, 15-10-26, 15 Oct 2026, 15-OCT-2026, 2026-10-15. */
export function parseBankDate(raw: string): string | null {
  const s = raw.trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  let y: number, mo: number, d: number;
  if (m) [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  else if ((m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})\b/.exec(s))) [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  else if ((m = /^(\d{1,2})[\s/-]+([A-Za-z]{3,4})[a-z]*[\s/-]+(\d{2}|\d{4})\b/.exec(s))) {
    const month = MONTHS[m[2]!.toLowerCase()];
    if (!month) return null;
    [d, mo, y] = [Number(m[1]), month, Number(m[3])];
  } else return null;
  if (y < 100) y += 2000;
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d || y < 2000 || y > 2100) return null;
  return date.toISOString().slice(0, 10);
}

/** "1,23,456.70", "₹ 500", "500.5 Cr" -> paise. Empty or zero -> 0. Exact decimal handling. */
export function parseAmount(raw: string): number {
  const s = raw.replace(/[₹,\s]|INR|Rs\.?|Cr|Dr/gi, '').replace(/^\((.*)\)$/, '-$1');
  if (!s || s === '-') return 0;
  const m = /^(-?)(\d+)(?:\.(\d{0,2})\d*)?$/.exec(s);
  if (!m) return Number.NaN;
  const paise = Number(m[2]) * 100 + Number((m[3] ?? '').padEnd(2, '0') || 0);
  return m[1] ? -paise : paise;
}

export function findUtr(...texts: (string | null | undefined)[]): string | null {
  for (const t of texts) {
    const m = t ? /(?<!\d)(\d{12})(?!\d)/.exec(t) : null;
    if (m) return m[1]!;
  }
  return null;
}

const norm = (h: string) => h.toLowerCase().replace(/[^a-z/ ]+/g, ' ').replace(/\s+/g, ' ').trim();

interface Columns {
  date: number;
  narration: number;
  reference: number;
  credit: number;
  debit: number;
  amount: number;
  drcr: number;
}

function findColumns(header: string[]): Columns | null {
  const h = header.map(norm);
  const pick = (...tests: RegExp[]) => {
    for (const re of tests) {
      const i = h.findIndex((x) => re.test(x));
      if (i >= 0) return i;
    }
    return -1;
  };
  const cols: Columns = {
    date: pick(/^(txn|tran|transaction|posting) ?date$/, /^date$/, /^value ?(dt|date)$/, /date/),
    narration: pick(/narration/, /description/, /particulars/, /remarks/, /details/),
    reference: pick(/utr/, /ref/, /chq|cheque/),
    credit: pick(/^(credit|deposit)s?( amount| amt)?( inr)?$/, /deposit/, /^cr( amount| amt)?$/, /credit/),
    debit: pick(/^(debit|withdrawal)s?( amount| amt)?( inr)?$/, /withdraw/, /^dr( amount| amt)?$/, /debit/),
    amount: pick(/^(txn |transaction )?amount( inr)?$/, /amount/),
    drcr: pick(/^(dr ?\/ ?cr|cr ?\/ ?dr|type|txn type|debit ?\/ ?credit)$/),
  };
  if (cols.date < 0 || (cols.credit < 0 && (cols.amount < 0 || cols.drcr < 0))) return null;
  return cols;
}

/** Turns a statement grid into its credits. The header can sit below a block of account details. */
export function parseStatement(grid: string[][]): ParsedStatement {
  let start = -1;
  let cols: Columns | null = null;
  for (let i = 0; i < Math.min(grid.length, 40); i++) {
    cols = findColumns(grid[i]!);
    if (cols) {
      start = i;
      break;
    }
  }
  if (!cols) throw badRequest('unknown_statement', 'Could not find the date and credit columns. Export the statement from net banking as CSV or Excel.');

  const credits: StatementCredit[] = [];
  let debits = 0;
  for (const row of grid.slice(start + 1)) {
    const cell = (i: number) => (i >= 0 ? (row[i] ?? '').trim() : '');
    const date = parseBankDate(cell(cols.date));
    if (!date) continue; // totals, opening balance, footers
    let amount: number;
    if (cols.credit >= 0) {
      amount = parseAmount(cell(cols.credit));
      if (!amount && cols.debit >= 0 && parseAmount(cell(cols.debit))) debits++;
    } else {
      const type = cell(cols.drcr).toLowerCase();
      const value = parseAmount(cell(cols.amount));
      const isCredit = /^c/.test(type) || /cr$/i.test(cell(cols.amount));
      amount = isCredit ? value : 0;
      if (!isCredit && value) debits++;
    }
    if (!Number.isFinite(amount)) throw badRequest('invalid_amount', `Could not read the amount on ${date}`);
    if (amount <= 0) continue;
    const narration = cell(cols.narration);
    const reference = cell(cols.reference) || null;
    credits.push({
      txn_date: date,
      amount_paise: amount,
      narration,
      reference,
      utr: findUtr(reference, narration),
      is_upi: /\bupi\b/i.test(narration) || /\bupi\b/i.test(reference ?? ''),
    });
  }
  if (!credits.length) throw badRequest('no_credits', 'The statement has no money coming in');
  const dates = credits.map((c) => c.txn_date).sort();
  return { credits, period_from: dates[0]!, period_to: dates.at(-1)!, debits_skipped: debits };
}

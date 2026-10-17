import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import type { BankCreditDTO, BankStatementDTO, MissingHints, ReconPaymentDTO, ReconSummaryDTO, StatementDetailDTO, UpiCheckDTO } from '@dineos/shared/dto';
import type { Tx } from '../../context';
import { notFound } from '../../lib/errors';
import type { ParsedStatement } from './statement';

const DAY = 86_400_000;
const shift = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
const digits = (s: string | null) => (s ?? '').replace(/\D/g, '');

/** Stores the statement's credits once each (overlapping statements share rows) and matches them. */
export async function importStatement(tx: Tx, outletId: string, userId: string, fileName: string, parsed: ParsedStatement): Promise<{ id: string; inserted: number }> {
  const statement = await tx.db
    .insertInto('bank_statements')
    .values({ tenant_id: tx.tenantId, outlet_id: outletId, file_name: fileName, period_from: parsed.period_from, period_to: parsed.period_to, uploaded_by: userId })
    .returning('id')
    .executeTakeFirstOrThrow();
  // Identical lines (same day, amount and text) are told apart by their position among equals.
  const seen = new Map<string, number>();
  let inserted = 0;
  for (const c of parsed.credits) {
    const base = [c.txn_date, c.amount_paise, c.utr ?? '', c.reference ?? '', c.narration].join('|');
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    const row = await tx.db
      .insertInto('bank_credits')
      .values({
        tenant_id: tx.tenantId,
        outlet_id: outletId,
        statement_id: statement.id,
        txn_date: c.txn_date,
        amount_paise: c.amount_paise,
        narration: c.narration.slice(0, 500),
        reference: c.reference?.slice(0, 120) ?? null,
        utr: c.utr,
        is_upi: c.is_upi,
        fingerprint: createHash('sha256').update(`${base}|${n}`).digest('hex'),
      })
      .onConflict((oc) => oc.columns(['outlet_id', 'fingerprint']).doNothing())
      .returning('id')
      .executeTakeFirst();
    if (row) inserted++;
  }
  await tx.db
    .updateTable('bank_statements')
    .set({ credits: inserted, duplicates: parsed.credits.length - inserted })
    .where('id', '=', statement.id)
    .execute();
  await autoMatch(tx, outletId, parsed.period_from, parsed.period_to);
  return { id: statement.id, inserted };
}

type OpenCredit = { id: string; txn_date: string; amount_paise: number; utr: string | null; is_upi: boolean };
type OpenPayment = { id: string; amount_paise: number; reference: string | null; day: string };

/**
 * Pairs as many credits with payments of their amount as possible, a credit taking a payment from
 * its own day or the day before (late-night payments post the next morning), the same day first.
 * Augmenting paths (Kuhn) so an early greedy choice never leaves a payment unpaired that could be.
 */
function pairByDate(credits: OpenCredit[], payments: OpenPayment[]): Map<string, string> {
  const onDay = new Map<string, string[]>();
  for (const p of payments) onDay.set(p.day, [...(onDay.get(p.day) ?? []), p.id]);
  const options = new Map(credits.map((c) => [c.id, [...(onDay.get(c.txn_date) ?? []), ...(onDay.get(shift(c.txn_date, -1)) ?? [])]]));
  const creditOf = new Map<string, string>();
  const place = (creditId: string, seen: Set<string>): boolean => {
    for (const paymentId of options.get(creditId)!) {
      if (seen.has(paymentId)) continue;
      seen.add(paymentId);
      const holder = creditOf.get(paymentId);
      if (holder === undefined || place(holder, seen)) {
        creditOf.set(paymentId, creditId);
        return true;
      }
    }
    return false;
  };
  for (const c of credits) place(c.id, new Set());
  return creditOf;
}

/**
 * First by UTR: the 12-digit number anywhere in the reference staff typed or pasted, with the same
 * amount. The same UTR on a different amount means the guest paid something else, so neither side
 * is matched and both wait for a person. Typing just the last digits counts with the same amount
 * and day when exactly one payment and one credit fit. Then, for UPI credits only, by amount and
 * date (pairByDate). Where the bank has fewer credits of an amount than staff recorded, which
 * payment it lacks cannot be known; missingHints says so. Runs over every open credit in the
 * dates, so a later upload also settles credits an earlier one could not.
 */
export async function autoMatch(tx: Tx, outletId: string, periodFrom: string, periodTo: string): Promise<number> {
  const outlet = await tx.db.selectFrom('outlets').select('timezone').where('id', '=', outletId).executeTakeFirstOrThrow();
  const credits = await tx.db
    .selectFrom('bank_credits')
    .select(['id', 'txn_date', 'amount_paise', 'utr', 'is_upi'])
    .where('outlet_id', '=', outletId)
    .where('txn_date', '>=', periodFrom)
    .where('txn_date', '<=', periodTo)
    .where('payment_id', 'is', null)
    .where('dismissed_reason', 'is', null)
    .orderBy('txn_date')
    .orderBy('amount_paise')
    .execute();
  if (!credits.length) return 0;
  const from = shift(credits[0]!.txn_date, -2);
  const to = shift(credits.at(-1)!.txn_date, 1);
  const day = sql<string>`(payments.created_at at time zone ${outlet.timezone})::date::text`;
  const payments = await tx.db
    .selectFrom('payments')
    .select(['payments.id', 'payments.amount_paise', 'payments.reference', 'payments.created_at', day.as('day')])
    .where('payments.outlet_id', '=', outletId)
    .where('payments.method', '=', 'upi')
    .where('payments.kind', '=', 'payment')
    .where(day, '>=', from)
    .where(day, '<=', to)
    .where(({ not, exists, selectFrom }) => not(exists(selectFrom('bank_credits').select('bank_credits.id').whereRef('bank_credits.payment_id', '=', 'payments.id'))))
    .orderBy('payments.created_at')
    .execute();

  const matches: { creditId: string; paymentId: string; kind: 'utr' | 'amount_date' }[] = [];
  // Matched, or waiting for a person: out of the amount-and-date pass either way.
  const used = new Set<string>();
  const link = (c: OpenCredit, p: OpenPayment) => {
    used.add(c.id).add(p.id);
    matches.push({ creditId: c.id, paymentId: p.id, kind: 'utr' });
  };
  const near = (p: OpenPayment, c: OpenCredit) => p.day === c.txn_date || p.day === shift(c.txn_date, -1);
  for (const c of credits) {
    if (!c.utr) continue;
    const named = payments.filter((x) => !used.has(x.id) && digits(x.reference).includes(c.utr!));
    if (named.length) {
      const same = named.find((x) => x.amount_paise === c.amount_paise);
      if (same) link(c, same);
      else for (const x of [c, ...named]) used.add(x.id);
      continue;
    }
    const tails = payments.filter((x) => {
      const ref = digits(x.reference);
      return !used.has(x.id) && ref.length >= 4 && c.utr!.endsWith(ref) && x.amount_paise === c.amount_paise && near(x, c);
    });
    if (tails.length !== 1) continue;
    const ref = digits(tails[0]!.reference);
    const rivals = credits.filter((o) => !used.has(o.id) && o.utr?.endsWith(ref) && o.amount_paise === c.amount_paise && near(tails[0]!, o));
    if (rivals.length === 1) link(c, tails[0]!);
  }

  const open = credits.filter((c) => c.is_upi && !used.has(c.id));
  const free = payments.filter((p) => !used.has(p.id));
  for (const amount of new Set(open.map((c) => c.amount_paise))) {
    const pairs = pairByDate(
      open.filter((c) => c.amount_paise === amount),
      free.filter((p) => p.amount_paise === amount),
    );
    for (const [paymentId, creditId] of pairs) matches.push({ creditId, paymentId, kind: 'amount_date' });
  }
  for (const m of matches) {
    await tx.db.updateTable('bank_credits').set({ payment_id: m.paymentId, match_kind: m.kind, matched_at: new Date() }).where('id', '=', m.creditId).execute();
  }
  return matches.length;
}

async function paymentDtos(tx: Tx, ids: string[]): Promise<Map<string, ReconPaymentDTO>> {
  if (!ids.length) return new Map();
  const rows = await tx.db
    .selectFrom('payments')
    .leftJoin('bills', 'bills.id', 'payments.bill_id')
    .leftJoin('wallet_topups', 'wallet_topups.id', 'payments.wallet_topup_id')
    .leftJoin('table_sessions', 'table_sessions.id', 'bills.table_session_id')
    .leftJoin('tables', 'tables.id', 'table_sessions.table_id')
    .leftJoin('users', 'users.id', 'payments.confirmed_by')
    .select([
      'payments.id',
      'payments.bill_id',
      'bills.invoice_no',
      'wallet_topups.receipt_no',
      'tables.label as table_label',
      'payments.amount_paise',
      'payments.reference',
      'users.name as confirmed_by_name',
      'payments.created_at',
    ])
    .where('payments.id', 'in', ids)
    .execute();
  return new Map(rows.map((r) => [r.id, { ...r, created_at: r.created_at.toISOString() }]));
}

/**
 * What can be told about UPI payments the bank shows no credit for: how many payments of the same
 * amount, within a day, were matched on amount and date alone (any of them may be the one the bank
 * lacks), and an open credit carrying the UTR staff recorded but for another amount.
 */
async function missingHints(tx: Tx, outletId: string, timezone: string, missing: OpenPayment[]): Promise<Map<string, MissingHints>> {
  const out = new Map<string, MissingHints>();
  if (!missing.length) return out;
  const days = missing.map((m) => m.day).sort();
  const from = shift(days[0]!, -1);
  const to = shift(days.at(-1)!, 1);
  const day = sql<string>`(payments.created_at at time zone ${timezone})::date::text`;
  const alike = await tx.db
    .selectFrom('payments')
    .innerJoin('bank_credits', 'bank_credits.payment_id', 'payments.id')
    .select(['payments.amount_paise', day.as('day')])
    .where('payments.outlet_id', '=', outletId)
    .where('bank_credits.match_kind', '=', 'amount_date')
    .where('payments.amount_paise', 'in', [...new Set(missing.map((m) => m.amount_paise))])
    .where(day, '>=', from)
    .where(day, '<=', to)
    .execute();
  const named = await tx.db
    .selectFrom('bank_credits')
    .select(['utr', 'amount_paise'])
    .where('outlet_id', '=', outletId)
    .where('payment_id', 'is', null)
    .where('dismissed_reason', 'is', null)
    .where('utr', 'is not', null)
    .where('txn_date', '>=', from)
    .where('txn_date', '<=', shift(to, 1))
    .execute();
  for (const m of missing) {
    const around = new Set([shift(m.day, -1), m.day, shift(m.day, 1)]);
    const ref = digits(m.reference);
    const credit = ref ? named.find((c) => ref.includes(c.utr!) && c.amount_paise !== m.amount_paise) : undefined;
    out.set(m.id, {
      lookalikes: alike.filter((a) => a.amount_paise === m.amount_paise && around.has(a.day)).length,
      utr_credit_paise: credit?.amount_paise ?? null,
    });
  }
  return out;
}

/** UPI payments taken on the statement's dates that no bank credit accounts for. */
async function missingPayments(tx: Tx, outletId: string, from: string, to: string): Promise<StatementDetailDTO['missing']> {
  const outlet = await tx.db.selectFrom('outlets').select('timezone').where('id', '=', outletId).executeTakeFirstOrThrow();
  const day = sql<string>`(payments.created_at at time zone ${outlet.timezone})::date::text`;
  const rows = await tx.db
    .selectFrom('payments')
    .select(['payments.id', day.as('day')])
    .where('payments.outlet_id', '=', outletId)
    .where('payments.method', '=', 'upi')
    .where('payments.kind', '=', 'payment')
    .where(day, '>=', from)
    .where(day, '<=', to)
    .where(({ not, exists, selectFrom }) => not(exists(selectFrom('bank_credits').select('bank_credits.id').whereRef('bank_credits.payment_id', '=', 'payments.id'))))
    .execute();
  const dtos = await paymentDtos(tx, rows.map((r) => r.id));
  const hints = await missingHints(tx, outletId, outlet.timezone, rows.map((r) => ({ ...dtos.get(r.id)!, day: r.day })));
  return rows
    .map((r) => ({ ...dtos.get(r.id)!, late_possible: r.day === to, ...hints.get(r.id)! }))
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}

function summarise(credits: BankCreditDTO[], missing: StatementDetailDTO['missing']): ReconSummaryDTO {
  const sum = (xs: { amount_paise: number }[]) => xs.reduce((a, x) => a + x.amount_paise, 0);
  const open = credits.filter((c) => !c.payment && !c.dismissed_reason);
  const matched = credits.filter((c) => c.payment);
  const unrecorded = open.filter((c) => c.is_upi);
  const notLate = missing.filter((m) => !m.late_possible);
  return {
    matched: matched.length,
    matched_paise: sum(matched),
    unrecorded_upi: unrecorded.length,
    unrecorded_upi_paise: sum(unrecorded),
    other_credits: open.filter((c) => !c.is_upi).length,
    dismissed: credits.filter((c) => c.dismissed_reason).length,
    missing: notLate.length,
    missing_paise: sum(notLate),
  };
}

export async function statementDetail(tx: Tx, statementId: string): Promise<StatementDetailDTO> {
  const s = await tx.db
    .selectFrom('bank_statements')
    .leftJoin('users', 'users.id', 'bank_statements.uploaded_by')
    .selectAll('bank_statements')
    .select('users.name as uploaded_by_name')
    .where('bank_statements.id', '=', statementId)
    .executeTakeFirst();
  if (!s) throw notFound('Statement');
  // Every credit in the statement's dates, including ones first seen in an overlapping upload.
  const rows = await tx.db
    .selectFrom('bank_credits')
    .selectAll()
    .where('outlet_id', '=', s.outlet_id)
    .where('txn_date', '>=', s.period_from)
    .where('txn_date', '<=', s.period_to)
    .orderBy('txn_date')
    .orderBy('created_at')
    .execute();
  const payments = await paymentDtos(tx, rows.flatMap((r) => (r.payment_id ? [r.payment_id] : [])));
  const credits: BankCreditDTO[] = rows.map((r) => ({
    id: r.id,
    txn_date: r.txn_date,
    amount_paise: r.amount_paise,
    narration: r.narration,
    reference: r.reference,
    utr: r.utr,
    is_upi: r.is_upi,
    match_kind: r.match_kind as BankCreditDTO['match_kind'],
    payment: r.payment_id ? (payments.get(r.payment_id) ?? null) : null,
    dismissed_reason: r.dismissed_reason,
  }));
  const missing = await missingPayments(tx, s.outlet_id, s.period_from, s.period_to);
  return {
    statement: {
      id: s.id,
      outlet_id: s.outlet_id,
      file_name: s.file_name,
      period_from: s.period_from,
      period_to: s.period_to,
      credits: s.credits,
      duplicates: s.duplicates,
      uploaded_by_name: s.uploaded_by_name,
      created_at: s.created_at.toISOString(),
      summary: summarise(credits, missing),
    },
    credits,
    missing,
  };
}

export async function listStatements(tx: Tx, outletId: string): Promise<BankStatementDTO[]> {
  const rows = await tx.db.selectFrom('bank_statements').select('id').where('outlet_id', '=', outletId).orderBy('period_to', 'desc').orderBy('created_at', 'desc').limit(24).execute();
  const out: BankStatementDTO[] = [];
  for (const r of rows) out.push((await statementDetail(tx, r.id)).statement);
  return out;
}

/**
 * The last `days` days of UPI payments, up to `to`, against the bank: found in a statement, missing
 * from one, or not checked yet. Staff confirm UPI by looking at the guest's phone, so this is what
 * catches a faked payment screen.
 */
export async function upiCheck(tx: Tx, outletId: string, to: string, days = 7): Promise<UpiCheckDTO> {
  const from = shift(to, -(days - 1));
  const outlet = await tx.db.selectFrom('outlets').select('timezone').where('id', '=', outletId).executeTakeFirstOrThrow();
  const day = sql<string>`(payments.created_at at time zone ${outlet.timezone})::date::text`;
  const rows = await tx.db
    .selectFrom('payments')
    .select((eb) => [
      'payments.id',
      'payments.amount_paise',
      day.as('day'),
      eb.exists(eb.selectFrom('bank_credits').select('bank_credits.id').whereRef('bank_credits.payment_id', '=', 'payments.id')).as('matched'),
    ])
    .where('payments.outlet_id', '=', outletId)
    .where('payments.method', '=', 'upi')
    .where('payments.kind', '=', 'payment')
    .where(day, '>=', from)
    .where(day, '<=', to)
    .execute();
  const statements = await tx.db.selectFrom('bank_statements').select(['period_from', 'period_to']).where('outlet_id', '=', outletId).execute();
  // A day is settled once a statement covers it and runs past it; a payment late on a statement's
  // last day may only post the next morning.
  const settled = (d: string) => statements.some((s) => s.period_from <= d && d < s.period_to);

  const matched = rows.filter((r) => r.matched);
  const missing = rows.filter((r) => !r.matched && settled(r.day));
  const pending = rows.filter((r) => !r.matched && !settled(r.day));
  const sum = (xs: { amount_paise: number }[]) => xs.reduce((a, x) => a + x.amount_paise, 0);
  const dtos = await paymentDtos(tx, missing.map((r) => r.id));
  const hints = await missingHints(tx, outletId, outlet.timezone, missing.map((r) => ({ ...dtos.get(r.id)!, day: r.day })));
  return {
    from,
    to,
    last_statement_to: statements.reduce<string | null>((a, s) => (a && a > s.period_to ? a : s.period_to), null),
    checked: { count: matched.length, amount_paise: sum(matched) },
    not_received: {
      count: missing.length,
      amount_paise: sum(missing),
      payments: missing.map((r) => ({ ...dtos.get(r.id)!, ...hints.get(r.id)! })).sort((a, b) => a.created_at.localeCompare(b.created_at)),
    },
    unchecked: { count: pending.length, amount_paise: sum(pending), oldest_day: pending.map((r) => r.day).sort()[0] ?? null },
  };
}

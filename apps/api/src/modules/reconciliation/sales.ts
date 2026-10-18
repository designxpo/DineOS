// Bills from the billing system an outlet uses instead of Mezmitra, from its sales export. Their
// money goes in payments like a Mezmitra bill's, tied to the outside bill, so the UPI check and
// bank matching work on them unchanged.

import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import type { PaymentMethod } from '@mezmitra/shared/enums';
import type { SalesImportDTO } from '@mezmitra/shared/dto';
import type { Tx } from '../../context';
import { conflict, notFound } from '../../lib/errors';
import type { ParsedSales } from './sales-export';
import { autoMatch } from './service';

const DAY = 86_400_000;
const shift = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
const CHUNK = 500;

/** Stores the export's bills once each (overlapping exports share them) and matches the bank. */
export async function importSales(
  tx: Tx,
  outlet: { id: string; timezone: string; billing_elsewhere: string | null },
  userId: string,
  fileName: string,
  parsed: ParsedSales,
): Promise<string> {
  if (!outlet.billing_elsewhere) throw conflict('bills_here', 'This outlet bills on Mezmitra. Name the system it bills on in Settings first.');
  const imp = await tx.db
    .insertInto('sales_imports')
    .values({
      tenant_id: tx.tenantId,
      outlet_id: outlet.id,
      file_name: fileName,
      system: outlet.billing_elsewhere,
      period_from: parsed.period_from,
      period_to: parsed.period_to,
      skipped: parsed.skipped,
      uploaded_by: userId,
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  // A bill is known by its number and day; without numbers, identical rows are told apart by
  // their position among equals.
  const seen = new Map<string, number>();
  const rows = parsed.bills.map((b) => {
    const base = b.bill_no
      ? `bill|${b.bill_no}|${b.business_date}`
      : ['row', b.business_date, b.time ?? '', b.total_paise, b.payments.map((p) => `${p.method}:${p.amount_paise}`).join(',')].join('|');
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return { bill: b, fingerprint: createHash('sha256').update(`${base}|${n}`).digest('hex') };
  });

  let inserted = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const stored = await tx.db
      .insertInto('outside_bills')
      .values(
        chunk.map(({ bill, fingerprint }) => ({
          tenant_id: tx.tenantId,
          outlet_id: outlet.id,
          import_id: imp.id,
          bill_no: bill.bill_no,
          business_date: bill.business_date,
          // Outlet wall-clock time; noon when the export has dates only, so the day stays right.
          billed_at: sql<Date>`${`${bill.business_date} ${bill.time ?? '12:00'}`}::timestamp at time zone ${outlet.timezone}`,
          time_known: bill.time !== null,
          total_paise: bill.total_paise,
          fingerprint,
        })),
      )
      .onConflict((oc) => oc.columns(['outlet_id', 'fingerprint']).doNothing())
      .returning(['id', 'fingerprint', 'billed_at'])
      .execute();
    if (!stored.length) continue;
    inserted += stored.length;
    const byPrint = new Map(chunk.map((r) => [r.fingerprint, r.bill]));
    await tx.db
      .insertInto('payments')
      .values(
        stored.flatMap((s) =>
          byPrint.get(s.fingerprint)!.payments.map((p) => ({
            tenant_id: tx.tenantId,
            outlet_id: outlet.id,
            outside_bill_id: s.id,
            kind: 'payment',
            method: p.method,
            amount_paise: p.amount_paise,
            reference: p.reference?.slice(0, 120) ?? null,
            created_at: s.billed_at,
          })),
        ),
      )
      .execute();
  }
  await tx.db
    .updateTable('sales_imports')
    .set({ bills: inserted, duplicates: parsed.bills.length - inserted })
    .where('id', '=', imp.id)
    .execute();
  // A payment late on the last day may reach the bank the next morning.
  await autoMatch(tx, outlet.id, parsed.period_from, shift(parsed.period_to, 1));
  return imp.id;
}

/** What the outside bills in an upload's dates say was taken, and how much of the UPI the bank shows. */
async function describe(tx: Tx, row: { id: string; outlet_id: string; file_name: string; system: string; period_from: string; period_to: string; bills: number; duplicates: number; skipped: number; uploaded_by_name: string | null; created_at: Date }): Promise<SalesImportDTO> {
  const pays = await tx.db
    .selectFrom('payments')
    .innerJoin('outside_bills', 'outside_bills.id', 'payments.outside_bill_id')
    .select((eb) => [
      'payments.method',
      'payments.amount_paise',
      'outside_bills.business_date',
      eb.exists(eb.selectFrom('bank_credits').select('bank_credits.id').whereRef('bank_credits.payment_id', '=', 'payments.id')).as('matched'),
    ])
    .where('payments.outlet_id', '=', row.outlet_id)
    .where('outside_bills.business_date', '>=', row.period_from)
    .where('outside_bills.business_date', '<=', row.period_to)
    .execute();
  const statements = await tx.db.selectFrom('bank_statements').select(['period_from', 'period_to']).where('outlet_id', '=', row.outlet_id).execute();
  // As in the UPI check: a day is settled once a statement covers it and runs past it.
  const settled = (d: string) => statements.some((s) => s.period_from <= d && d < s.period_to);

  const byMethod = new Map<PaymentMethod, { count: number; amount_paise: number }>();
  const upi = { matched: 0, matched_paise: 0, missing: 0, missing_paise: 0, unchecked: 0, unchecked_paise: 0 };
  for (const p of pays) {
    const m = byMethod.get(p.method as PaymentMethod) ?? { count: 0, amount_paise: 0 };
    m.count++;
    m.amount_paise += p.amount_paise;
    byMethod.set(p.method as PaymentMethod, m);
    if (p.method !== 'upi') continue;
    const k = p.matched ? 'matched' : settled(p.business_date) ? 'missing' : 'unchecked';
    upi[k]++;
    upi[`${k}_paise`] += p.amount_paise;
  }
  return {
    id: row.id,
    outlet_id: row.outlet_id,
    file_name: row.file_name,
    system: row.system,
    period_from: row.period_from,
    period_to: row.period_to,
    bills: row.bills,
    duplicates: row.duplicates,
    skipped: row.skipped,
    uploaded_by_name: row.uploaded_by_name,
    created_at: row.created_at.toISOString(),
    by_method: [...byMethod].map(([method, v]) => ({ method, ...v })).sort((a, b) => b.amount_paise - a.amount_paise),
    upi,
  };
}

function importRows(tx: Tx) {
  return tx.db
    .selectFrom('sales_imports')
    .leftJoin('users', 'users.id', 'sales_imports.uploaded_by')
    .select([
      'sales_imports.id',
      'sales_imports.outlet_id',
      'sales_imports.file_name',
      'sales_imports.system',
      'sales_imports.period_from',
      'sales_imports.period_to',
      'sales_imports.bills',
      'sales_imports.duplicates',
      'sales_imports.skipped',
      'sales_imports.created_at',
      'users.name as uploaded_by_name',
    ]);
}

export async function salesImport(tx: Tx, id: string): Promise<SalesImportDTO> {
  const row = await importRows(tx).where('sales_imports.id', '=', id).executeTakeFirst();
  if (!row) throw notFound('Sales upload');
  return describe(tx, row);
}

export async function listSalesImports(tx: Tx, outletId: string): Promise<SalesImportDTO[]> {
  const rows = await importRows(tx).where('sales_imports.outlet_id', '=', outletId).orderBy('sales_imports.period_to', 'desc').orderBy('sales_imports.created_at', 'desc').limit(24).execute();
  const out: SalesImportDTO[] = [];
  for (const r of rows) out.push(await describe(tx, r));
  return out;
}

/** Removes a wrong upload: its bills and their payments go, and bank matches made to them are undone. */
export async function deleteSalesImport(tx: Tx, id: string): Promise<void> {
  const ofImport = tx.db
    .selectFrom('payments')
    .innerJoin('outside_bills', 'outside_bills.id', 'payments.outside_bill_id')
    .select('payments.id')
    .where('outside_bills.import_id', '=', id);
  await tx.db.updateTable('bank_credits').set({ payment_id: null, match_kind: null, matched_by: null, matched_at: null }).where('payment_id', 'in', ofImport).execute();
  await tx.db.deleteFrom('payments').where('id', 'in', ofImport).execute();
  await tx.db.deleteFrom('sales_imports').where('id', '=', id).execute();
}

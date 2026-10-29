import { sql, type Transaction } from 'kysely';
import { financialYear } from '@mezmitra/shared/dates';
import type { DB } from '../db/schema';

/** Next number in our own (platform) invoice series, DOS/<fy>/00001. Admin connection only. */
export async function nextPlatformInvoiceNumber(trx: Transaction<DB>, today = new Date()): Promise<string> {
  const fy = financialYear(today.toISOString().slice(0, 10)).code;
  const { value } = await trx
    .insertInto('platform_counters')
    .values({ name: 'invoice', period: fy, value: 1 })
    .onConflict((oc) => oc.columns(['name', 'period']).doUpdateSet({ value: sql`platform_counters.value + 1` }))
    .returning('value')
    .executeTakeFirstOrThrow();
  return `DOS/${fy}/${String(value).padStart(5, '0')}`;
}

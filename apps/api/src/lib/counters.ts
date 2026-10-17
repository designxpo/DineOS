import { sql } from 'kysely';
import type { Tx } from '../context';

export type CounterName = 'order' | 'kot' | 'invoice' | 'wallet';

/**
 * Next value of a per-outlet counter, e.g. ('invoice', '2627') or ('order', '2026-10-15').
 * The upsert holds the row lock until commit and a rollback returns the number, so the sequence
 * has no gaps and no duplicates even under concurrency.
 */
export async function nextCounter(tx: Tx, outletId: string, name: CounterName, period: string): Promise<number> {
  const row = await tx.db
    .insertInto('counters')
    .values({ tenant_id: tx.tenantId, outlet_id: outletId, name, period, value: 1 })
    .onConflict((oc) => oc.columns(['outlet_id', 'name', 'period']).doUpdateSet({ value: sql`counters.value + 1` }))
    .returning('value')
    .executeTakeFirstOrThrow();
  return row.value;
}

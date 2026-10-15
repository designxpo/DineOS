import type { Tx } from '../context';
import { notFound } from './errors';

/**
 * A tenant-wide role passes permission checks for any outlet id, so routes that only use the
 * request's outlet id as context confirm it belongs to the tenant (RLS hides other tenants' rows).
 */
export async function assertOutletExists(tx: Tx, outletId: string): Promise<void> {
  const o = await tx.db.selectFrom('outlets').select('id').where('id', '=', outletId).executeTakeFirst();
  if (!o) throw notFound('Outlet');
}

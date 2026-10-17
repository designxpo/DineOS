import { sql } from 'kysely';
import type { Tx } from '../context';

/**
 * The outlet's menu or settings changed: a new version for every screen and print computer to
 * apply. Screens hear it live and confirm when they check in; ones that missed it catch up then.
 */
export async function bumpConfig(tx: Tx, outletId: string): Promise<number> {
  const row = await tx.db
    .updateTable('outlets')
    .set({ config_version: sql`config_version + 1` })
    .where('id', '=', outletId)
    .returning('config_version')
    .executeTakeFirstOrThrow();
  const version = Number(row.config_version);
  await tx.emit({ outletId, type: 'config.changed', channels: ['outlet'], payload: { config_version: version } });
  return version;
}

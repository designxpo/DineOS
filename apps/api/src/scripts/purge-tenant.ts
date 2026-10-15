// Permanently deletes every row a tenant owns (spec §12 data rights: delete on request).
// Deliberately CLI-only and slow to type:
//   npm run tenant:purge -w @dineos/api -- --slug the-courtyard --confirm the-courtyard
// Export first (GET /v1/tenant/export) if the restaurant wants a copy. Backups age out on their own schedule.
import { parseArgs } from 'node:util';
import { sql } from 'kysely';
import { loadConfig } from '../config';
import { createDb, type Database } from '../db';

/** Children before parents so foreign keys never block. */
export const PURGE_ORDER = [
  'bill_lines',
  'payments',
  'bills',
  'kots',
  'print_jobs',
  'order_items',
  'orders',
  'service_requests',
  'table_state_events',
  'table_sessions',
  'tables',
  'item_modifier_groups',
  'modifiers',
  'modifier_groups',
  'menu_items',
  'menu_categories',
  'approval_tokens',
  'user_sessions',
  'audit_log',
  'idempotency_keys',
  'outlet_events',
  'counters',
  'devices',
  'user_outlet_roles',
  'users',
  'outlets',
  'platform_invoices',
  'subscriptions',
] as const;

export async function purgeTenant(db: Database, tenantId: string): Promise<Record<string, number>> {
  return db.transaction().execute(async (trx) => {
    const counts: Record<string, number> = {};
    await trx.updateTable('tables').set({ current_session_id: null }).where('tenant_id', '=', tenantId).execute();
    for (const table of PURGE_ORDER) {
      const res = await sql`delete from ${sql.table(table)} where tenant_id = ${tenantId}`.execute(trx);
      counts[table] = Number(res.numAffectedRows ?? 0);
    }
    await trx.deleteFrom('tenants').where('id', '=', tenantId).execute();
    return counts;
  });
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const { values } = parseArgs({ options: { slug: { type: 'string' }, confirm: { type: 'string' } } });
  if (!values.slug || values.confirm !== values.slug) {
    console.error('Usage: --slug <restaurant-code> --confirm <restaurant-code again>');
    process.exit(1);
  }
  const config = loadConfig();
  const db = createDb(config.DATABASE_ADMIN_URL, 1);
  const tenant = await db.selectFrom('tenants').select(['id', 'name', 'status']).where('slug', '=', values.slug).executeTakeFirst();
  if (!tenant) {
    console.error(`No tenant with code ${values.slug}`);
    process.exit(1);
  }
  if (tenant.status === 'active') {
    console.error('Suspend or cancel the tenant in the admin console before purging.');
    process.exit(1);
  }
  const counts = await purgeTenant(db, tenant.id);
  console.log(`Purged ${tenant.name}:`, counts);
  await db.destroy();
}

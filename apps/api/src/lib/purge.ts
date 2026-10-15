import { sql } from 'kysely';
import type { Database } from '../db';

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

import { sql } from 'kysely';
import type { Database } from '../db';

/** Children before parents so foreign keys never block. */
export const PURGE_ORDER = [
  'support_messages',
  'support_cases',
  'day_closes',
  'customer_rewards',
  'wallet_ledger',
  'channel_payout_lines',
  'channel_payouts',
  'golive_checks',
  'golive_rehearsals',
  'bank_credits',
  'bank_statements',
  'loyalty_ledger',
  'comps',
  'stock_movements',
  'recipes',
  'modifier_recipes',
  'ingredients',
  'reservations',
  'waitlist_entries',
  'otp_codes',
  'bill_lines',
  'wallet_topups',
  'payments',
  'outside_bills',
  'sales_imports',
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
  'screens',
  'audit_log',
  'idempotency_keys',
  'outlet_events',
  'push_subscriptions',
  'counters',
  'cameras',
  'devices',
  'customer_memberships',
  'membership_plans',
  'loyalty_programs',
  'wallet_packs',
  'customers',
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
    await trx.updateTable('outlets').set({ hub_device_id: null }).where('tenant_id', '=', tenantId).execute();
    await trx.updateTable('tables').set({ camera_id: null }).where('tenant_id', '=', tenantId).execute();
    for (const table of PURGE_ORDER) {
      const res = await sql`delete from ${sql.table(table)} where tenant_id = ${tenantId}`.execute(trx);
      counts[table] = Number(res.numAffectedRows ?? 0);
    }
    await trx.deleteFrom('tenants').where('id', '=', tenantId).execute();
    return counts;
  });
}

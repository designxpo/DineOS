// Database-level tenant isolation (spec §3): as dineos_app, tenant B's context must not read,
// update, delete or insert any row belonging to tenant A, on every table that has tenant_id.

import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Database } from '../src/db';
import { getOrCreateSession } from '../src/modules/tables/sessions';
import { createMenu, createTable, createTenant, startApp, type TestApp, type TestTenant } from './helpers';
import { testUrls } from './env';

let t: TestApp;
let a: TestTenant;
let b: TestTenant;
let appDb: Database;
let tenantTables: string[];

beforeAll(async () => {
  t = await startApp();
  a = await createTenant(t);
  b = await createTenant(t);
  await createMenu(t, a);
  const tableId = await createTable(t, a);
  await t.ctx.tx(a.tenantId, (tx) => getOrCreateSession(tx, tableId));
  appDb = createDb(testUrls.app, 2);
  const rows = await sql<{ table_name: string }>`
    select c.table_name from information_schema.columns c
    join information_schema.tables tb on tb.table_name = c.table_name and tb.table_schema = c.table_schema
    where c.table_schema = 'public' and c.column_name = 'tenant_id' and tb.table_type = 'BASE TABLE'
    order by 1`.execute(t.ctx.adminDb);
  tenantTables = rows.rows.map((r) => r.table_name);
});
afterAll(async () => {
  await appDb.destroy();
  await t.close();
});

async function asTenant<T>(tenantId: string | null, fn: (db: Database) => Promise<T>): Promise<T> {
  return appDb.transaction().execute(async (trx) => {
    if (tenantId) await sql`select set_config('app.tenant_id', ${tenantId}, true)`.execute(trx);
    return fn(trx as unknown as Database);
  });
}

describe('row-level security', () => {
  it('covers every table that has tenant_id', async () => {
    const rows = await sql<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>`
      select relname, relrowsecurity, relforcerowsecurity from pg_class
      where relname = any(${tenantTables}) and relkind = 'r'`.execute(t.ctx.adminDb);
    expect(rows.rows).toHaveLength(tenantTables.length);
    for (const r of rows.rows) {
      expect(r.relrowsecurity, r.relname).toBe(true);
      expect(r.relforcerowsecurity, r.relname).toBe(true);
    }
  });

  it('shows nothing when no tenant context is set', async () => {
    for (const table of [...tenantTables, 'tenants']) {
      const { rows } = await asTenant(null, (db) => sql<{ n: number }>`select count(*)::int as n from ${sql.table(table)}`.execute(db));
      expect(rows[0]!.n, table).toBe(0);
    }
  });

  it("never lets tenant B read, change or delete tenant A's rows", async () => {
    for (const table of tenantTables) {
      const owned = await sql<{ n: number }>`select count(*)::int as n from ${sql.table(table)} where tenant_id = ${a.tenantId}`.execute(
        t.ctx.adminDb,
      );
      const visible = await asTenant(b.tenantId, (db) =>
        sql<{ n: number }>`select count(*)::int as n from ${sql.table(table)} where tenant_id = ${a.tenantId}`.execute(db),
      );
      expect(visible.rows[0]!.n, `${table} read`).toBe(0);
      // Tables the app role may only read (subscriptions, platform_invoices) refuse writes outright.
      const updated = await asTenant(b.tenantId, (db) =>
        sql`update ${sql.table(table)} set tenant_id = tenant_id where tenant_id = ${a.tenantId}`.execute(db),
      ).catch((e: Error) => {
        if (/permission denied/.test(e.message)) return { numAffectedRows: 0n };
        throw e;
      });
      expect(Number(updated.numAffectedRows ?? 0), `${table} update`).toBe(0);
      const deleted = await asTenant(b.tenantId, async (db) => {
        const r = await sql`delete from ${sql.table(table)} where tenant_id = ${a.tenantId}`.execute(db).catch(() => null);
        // roll back anything in case of a policy bug; the assertion below catches it
        throw Object.assign(new Error('rollback'), { result: r });
      }).catch((e) => e.result);
      expect(Number(deleted?.numAffectedRows ?? 0), `${table} delete`).toBe(0);
      // Tenant A still owns everything it owned.
      const after = await sql<{ n: number }>`select count(*)::int as n from ${sql.table(table)} where tenant_id = ${a.tenantId}`.execute(
        t.ctx.adminDb,
      );
      expect(after.rows[0]!.n, table).toBe(owned.rows[0]!.n);
    }
  });

  it("refuses inserts stamped with another tenant's id", async () => {
    await expect(
      asTenant(b.tenantId, (db) =>
        db.insertInto('menu_categories').values({ tenant_id: a.tenantId, outlet_id: a.outletId, name: 'Injected' }).execute(),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('cannot see another tenant record even via the tenants table', async () => {
    const { rows } = await asTenant(b.tenantId, (db) => sql<{ id: string }>`select id from tenants`.execute(db));
    expect(rows.map((r) => r.id)).toEqual([b.tenantId]);
  });
});

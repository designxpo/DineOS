import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMaintenance } from '../src/lib/maintenance';
import { getOrCreateSession } from '../src/modules/tables/sessions';
import { createTable, createTenant, startApp, type TestApp, type TestTenant } from './helpers';

let t: TestApp;
let tenant: TestTenant;

beforeAll(async () => {
  t = await startApp();
  tenant = await createTenant(t);
});
afterAll(() => t.close());

describe('maintenance', () => {
  it('releases tables whose guests browsed hours ago but never ordered', async () => {
    const tableId = await createTable(t, tenant, 'M1');
    // The updated_at trigger fires on UPDATE only, so insert a session that is already old.
    const session = await t.ctx.adminDb
      .insertInto('table_sessions')
      .values({ tenant_id: tenant.tenantId, outlet_id: tenant.outletId, table_id: tableId, status: 'pending', created_at: sql`now() - interval '7 hours'`, updated_at: sql`now() - interval '7 hours'` })
      .returning('id')
      .executeTakeFirstOrThrow();
    await t.ctx.adminDb.updateTable('tables').set({ current_session_id: session.id }).where('id', '=', tableId).execute();
    const freshTable = await createTable(t, tenant, 'M2');
    const fresh = await t.ctx.tx(tenant.tenantId, (tx) => getOrCreateSession(tx, freshTable));

    const result = await runMaintenance(t.ctx.adminDb);
    expect(result?.pending_sessions_closed).toBeGreaterThanOrEqual(1);
    const stale = await t.ctx.adminDb.selectFrom('table_sessions').select('status').where('id', '=', session.id).executeTakeFirstOrThrow();
    expect(stale.status).toBe('closed');
    const table = await t.ctx.adminDb.selectFrom('tables').select('current_session_id').where('id', '=', tableId).executeTakeFirstOrThrow();
    expect(table.current_session_id).toBeNull();
    const kept = await t.ctx.adminDb.selectFrom('table_sessions').select('status').where('id', '=', fresh.id).executeTakeFirstOrThrow();
    expect(kept.status).toBe('pending');
  });

  it('prunes old events and idempotency keys but keeps recent ones', async () => {
    await sql`insert into outlet_events (tenant_id, outlet_id, seq, type, channels, payload, created_at)
      values (${tenant.tenantId}, ${tenant.outletId}, 900001, 'menu.updated', '{outlet}', '{}', now() - interval '4 days'),
             (${tenant.tenantId}, ${tenant.outletId}, 900002, 'menu.updated', '{outlet}', '{}', now())`.execute(t.ctx.adminDb);
    await runMaintenance(t.ctx.adminDb);
    const left = await t.ctx.adminDb.selectFrom('outlet_events').select('seq').where('outlet_id', '=', tenant.outletId).where('seq', '>', 900000).execute();
    expect(left.map((r) => r.seq)).toEqual([900002]);
  });
});

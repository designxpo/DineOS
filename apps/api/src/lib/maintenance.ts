import { sql } from 'kysely';
import type { Database } from '../db';

const LOCK_KEY = 7_340_001;

/**
 * Housekeeping across all tenants (admin connection). Safe to run on every API node: an advisory
 * lock lets only one node do the work per run.
 */
export async function runMaintenance(adminDb: Database): Promise<Record<string, number> | null> {
  return adminDb.transaction().execute(async (trx) => {
    const { rows } = await sql<{ locked: boolean }>`select pg_try_advisory_xact_lock(${LOCK_KEY}) as locked`.execute(trx);
    if (!rows[0]?.locked) return null;
    const count = (r: { numAffectedRows?: bigint } | { numDeletedRows?: bigint; numUpdatedRows?: bigint }) =>
      Number(('numDeletedRows' in r ? r.numDeletedRows : 'numUpdatedRows' in r ? r.numUpdatedRows : 0) ?? 0);

    const out: Record<string, number> = {};
    // Reconnect replay only needs recent events; screens refetch when they are further behind.
    out.events = count(await trx.deleteFrom('outlet_events').where('created_at', '<', sql<Date>`now() - interval '3 days'`).executeTakeFirst());
    out.idempotency_keys = count(await trx.deleteFrom('idempotency_keys').where('created_at', '<', sql<Date>`now() - interval '2 days'`).executeTakeFirst());
    out.user_sessions = count(await trx.deleteFrom('user_sessions').where('expires_at', '<', sql<Date>`now()`).executeTakeFirst());
    out.admin_sessions = count(await trx.deleteFrom('admin_sessions').where('expires_at', '<', sql<Date>`now()`).executeTakeFirst());
    out.otp_codes = count(await trx.deleteFrom('otp_codes').where('created_at', '<', sql<Date>`now() - interval '1 day'`).executeTakeFirst());
    out.approval_tokens = count(await trx.deleteFrom('approval_tokens').where('expires_at', '<', sql<Date>`now() - interval '1 day'`).executeTakeFirst());
    out.print_jobs_expired = count(
      await trx
        .updateTable('print_jobs')
        .set({ status: 'failed', last_error: 'expired: not printed within a day' })
        .where('status', 'in', ['queued', 'sent'])
        .where('created_at', '<', sql<Date>`now() - interval '1 day'`)
        .executeTakeFirst(),
    );
    out.print_jobs_deleted = count(await trx.deleteFrom('print_jobs').where('created_at', '<', sql<Date>`now() - interval '30 days'`).executeTakeFirst());

    // Someone scanned and browsed but never ordered: release the table after a few hours so the
    // next party does not inherit an old cart.
    const stale = await trx
      .selectFrom('table_sessions')
      .select('id')
      .where('status', '=', 'pending')
      .where('updated_at', '<', sql<Date>`now() - interval '6 hours'`)
      .execute();
    if (stale.length) {
      const ids = stale.map((s) => s.id);
      await trx.updateTable('tables').set({ current_session_id: null }).where('current_session_id', 'in', ids).execute();
      await trx.updateTable('table_sessions').set({ status: 'closed', closed_at: new Date(), cart: sql`'[]'::jsonb`, cart_version: 0 }).where('id', 'in', ids).execute();
    }
    out.pending_sessions_closed = stale.length;

    // Bookings nobody turned up for, once the outlet's grace period has passed.
    out.reservations_no_show = count(
      await trx
        .updateTable('reservations')
        .set({ status: 'no_show' })
        .where('status', '=', 'booked')
        .where(({ eb, selectFrom }) =>
          eb(
            'slot_start',
            '<',
            selectFrom('outlets')
              .select(sql<Date>`now() - make_interval(mins => outlets.reservation_grace_minutes)`.as('cutoff'))
              .whereRef('outlets.id', '=', 'reservations.outlet_id'),
          ),
        )
        .executeTakeFirst(),
    );
    // Camera stills exist only to draw zones; they may show guests, so they do not linger.
    out.camera_snapshots_deleted = count(
      await trx
        .updateTable('cameras')
        .set({ snapshot: null, snapshot_at: null })
        .where('snapshot_at', '<', sql<Date>`now() - interval '1 day'`)
        .executeTakeFirst(),
    );
    out.waitlist_closed = count(
      await trx
        .updateTable('waitlist_entries')
        .set({ status: 'left' })
        .where('status', 'in', ['waiting', 'notified'])
        .where('created_at', '<', sql<Date>`now() - interval '12 hours'`)
        .executeTakeFirst(),
    );
    return out;
  });
}

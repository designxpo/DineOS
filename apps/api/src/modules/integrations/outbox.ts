import { waitUntil } from '@vercel/functions';
import { sql } from 'kysely';
import { dayLabel, onlineBooking, slotLabel } from '@mezmitra/shared/booking';
import { formatPaise } from '@mezmitra/shared/money';
import { normalizePhone } from '@mezmitra/shared/phone';
import type { AppContext, Tx } from '../../context';
import { json } from '../../db';
import { decryptSecret } from '../../lib/crypto';
import { webOrigin } from '../../lib/links';
import { sendTalkoEvent } from '../../lib/talko';

// Events for Talko AI. Each is written inside the transaction that made it happen (a bill paid, a
// booking made), so it commits or rolls back with it; a dispatcher sends it afterwards with retries.
// Talko turns events into WhatsApp messages through the rules its owner set up there.

/** Event names as Talko sees them. Talko rules match on these, so renaming one breaks them. */
export const TALKO_EVENTS = {
  billPaid: 'mezmitra.bill.paid',
  reservationCreated: 'mezmitra.reservation.created',
  reservationCancelled: 'mezmitra.reservation.cancelled',
  reservationReminder: 'mezmitra.reservation.reminder',
  orderReady: 'mezmitra.order.ready',
} as const;

const SIX_HOURS = 6 * 3600_000;
const TWO_HOURS = 2 * 3600_000;

/** Runs a send for one tenant soon after a commit. Set by registerTalkoDispatch; null in scripts. */
let kick: ((tenantId: string) => void) | null = null;

async function liveLinkId(tx: Tx): Promise<string | null> {
  const link = await tx.db
    .selectFrom('integration_links')
    .select('id')
    .where('provider', '=', 'talko')
    .where('status', '=', 'active')
    .executeTakeFirst();
  return link?.id ?? null;
}

interface QueuedEvent {
  outletId: string;
  event: string;
  phone: string;
  name: string | null;
  payload: Record<string, unknown>;
  dedupeKey: string;
  expiresAt: Date | null;
}

/** Queues an event when the tenant has a live Talko link; otherwise does nothing. */
async function queue(tx: Tx, e: QueuedEvent): Promise<void> {
  const linkId = await liveLinkId(tx);
  if (!linkId) return;
  await tx.db
    .insertInto('integration_outbox')
    .values({
      tenant_id: tx.tenantId,
      link_id: linkId,
      outlet_id: e.outletId,
      event: e.event,
      phone: e.phone,
      name: e.name?.slice(0, 80) ?? null,
      payload: json(e.payload),
      dedupe_key: e.dedupeKey,
      expires_at: e.expiresAt,
    })
    .onConflict((oc) => oc.columns(['tenant_id', 'dedupe_key']).doNothing())
    .execute();
  tx.afterCommit(() => kick?.(tx.tenantId));
}

/**
 * A bill was paid in full. Only for a customer saved with consent; the guest is thanked once per
 * table visit, even when the table split the bill.
 */
export async function queueBillPaid(tx: Tx, billId: string): Promise<void> {
  const b = await tx.db
    .selectFrom('bills')
    .innerJoin('outlets', 'outlets.id', 'bills.outlet_id')
    .innerJoin('customers', 'customers.id', 'bills.customer_id')
    .select([
      'bills.id',
      'bills.outlet_id',
      'bills.invoice_no',
      'bills.total_paise',
      'bills.paid_at',
      'bills.table_session_id',
      'outlets.name as outlet_name',
      'outlets.google_review_url',
      'customers.phone',
      'customers.name',
      'customers.erased_at',
      'customers.marketing_opt_in',
      'customers.visits',
      'customers.points',
    ])
    .where('bills.id', '=', billId)
    .executeTakeFirst();
  if (!b || b.erased_at) return;
  const paidAt = b.paid_at ?? new Date();
  await queue(tx, {
    outletId: b.outlet_id,
    event: TALKO_EVENTS.billPaid,
    phone: b.phone,
    name: b.name,
    payload: {
      outlet_id: b.outlet_id,
      outlet_name: b.outlet_name,
      bill_id: b.id,
      invoice_no: b.invoice_no,
      total: formatPaise(b.total_paise),
      total_paise: b.total_paise,
      paid_at: paidAt.toISOString(),
      visit_count: b.visits,
      points_balance: b.points,
      marketing_opt_in: b.marketing_opt_in,
      review_url: b.google_review_url ?? '',
    },
    dedupeKey: b.table_session_id ? `bill.paid:session:${b.table_session_id}` : `bill.paid:${b.id}`,
    expiresAt: new Date(paidAt.getTime() + SIX_HOURS),
  });
}

/** A booking with a phone number was made or cancelled. */
export async function queueReservation(tx: Tx, reservationId: string, kind: 'created' | 'cancelled' | 'reminder'): Promise<void> {
  const r = await tx.db
    .selectFrom('reservations')
    .innerJoin('outlets', 'outlets.id', 'reservations.outlet_id')
    .select([
      'reservations.id',
      'reservations.outlet_id',
      'reservations.guest_name',
      'reservations.guest_phone',
      'reservations.party_size',
      'reservations.slot_start',
      'reservations.source',
      'reservations.public_ref',
      'outlets.name as outlet_name',
      'outlets.phone as outlet_phone',
      'outlets.timezone',
    ])
    .where('reservations.id', '=', reservationId)
    .executeTakeFirst();
  if (!r?.guest_phone) return;
  // A number typed into an Instagram, Messenger or website chat is not proven to be the guest's,
  // and WhatsApp may only message people who asked for it: those bookings are confirmed in the
  // chat they were made in, never by a WhatsApp message to the typed number.
  if (r.source === 'instagram' || r.source === 'messenger' || r.source === 'webchat') return;
  const event = kind === 'created' ? TALKO_EVENTS.reservationCreated : kind === 'cancelled' ? TALKO_EVENTS.reservationCancelled : TALKO_EVENTS.reservationReminder;
  await queue(tx, {
    outletId: r.outlet_id,
    event,
    phone: r.guest_phone,
    name: r.guest_name,
    payload: {
      outlet_id: r.outlet_id,
      outlet_name: r.outlet_name,
      outlet_phone: r.outlet_phone ?? '',
      booking_id: r.id,
      booking_ref: r.public_ref ?? '',
      date: dayLabel(r.slot_start, r.timezone),
      time: slotLabel(r.slot_start, r.timezone),
      slot_start: r.slot_start.toISOString(),
      party_size: r.party_size,
      source: r.source,
    },
    // A booking cancelled and made again is a new booking; the rest happen once per booking.
    dedupeKey: `reservation.${kind}:${r.id}${kind === 'created' ? `:${r.slot_start.getTime()}` : ''}`,
    expiresAt: r.slot_start,
  });
}

/**
 * A takeaway or counter order is ready to collect. Goes to the saved customer's number, or else to
 * the number the guest gave for this order: a message about their own order, never marketing.
 */
export async function queueOrderReady(tx: Tx, orderId: string): Promise<void> {
  const o = await tx.db
    .selectFrom('orders')
    .innerJoin('outlets', 'outlets.id', 'orders.outlet_id')
    .leftJoin('customers', (j) => j.onRef('customers.id', '=', 'orders.customer_id').on('customers.erased_at', 'is', null))
    .select([
      'orders.id',
      'orders.outlet_id',
      'orders.order_no',
      'orders.type',
      'orders.track_code',
      'orders.customer_phone',
      'orders.customer_name',
      'outlets.name as outlet_name',
      'customers.phone',
      'customers.name',
    ])
    .where('orders.id', '=', orderId)
    .executeTakeFirst();
  if (!o || (o.type !== 'takeaway' && o.type !== 'counter')) return;
  const given = o.customer_phone ? normalizePhone(o.customer_phone) : null;
  const phone = o.phone ?? (given && /^\+\d{10,15}$/.test(given) ? given : null);
  if (!phone) return;
  await queue(tx, {
    outletId: o.outlet_id,
    event: TALKO_EVENTS.orderReady,
    phone,
    name: o.name ?? o.customer_name,
    // track_url is added at send time, from the server's web address.
    payload: { outlet_id: o.outlet_id, outlet_name: o.outlet_name, order_no: o.order_no, track_code: o.track_code ?? '' },
    dedupeKey: `order.ready:${o.id}`,
    expiresAt: new Date(Date.now() + TWO_HOURS),
  });
}

// ---------------------------------------------------------------- sending

const MAX_ATTEMPTS = 6;
const BACKOFF_MINUTES = [1, 5, 15, 60, 180];
/** A row being sent is leased so overlapping runs (other servers, the kick and the sweep) skip it. */
const LEASE_MS = 2 * 60_000;
/** Undelivered after this long, a message is too late to be useful. */
const GIVE_UP_MS = 24 * 3600_000;

export interface DispatchResult {
  sent: number;
  retrying: number;
  dead: number;
  skipped: number;
}

/** Context string the Talko key is encrypted under; binds it to its link row and column. */
export const peerKeyContext = (linkId: string) => `link:${linkId}:peer_api_key`;
export const peerWebhookContext = (linkId: string) => `link:${linkId}:peer_webhook_secret`;

/**
 * Sends due outbox rows to Talko, oldest first. Background job on the admin connection, across
 * tenants or for one. Safe to run on several servers at once.
 */
export async function dispatchTalkoOutbox(ctx: AppContext, opts: { tenantId?: string; limit?: number; fetchFn?: typeof fetch } = {}): Promise<DispatchResult> {
  const out: DispatchResult = { sent: 0, retrying: 0, dead: 0, skipped: 0 };
  const encKey = ctx.config.INTEGRATION_ENC_KEY;
  if (!encKey || !ctx.config.TALKO_API_URL) return out;
  // Due-ness is judged by the database clock, which wrote next_attempt_at: servers' clocks drift.
  const rows = await ctx.adminDb.transaction().execute(async (trx) => {
    let q = trx
      .selectFrom('integration_outbox')
      .selectAll()
      .where('status', '=', 'pending')
      .where('next_attempt_at', '<=', sql<Date>`now()`);
    if (opts.tenantId) q = q.where('tenant_id', '=', opts.tenantId);
    const due = await q.orderBy('next_attempt_at').limit(opts.limit ?? 50).forUpdate().skipLocked().execute();
    if (due.length) {
      await trx
        .updateTable('integration_outbox')
        .set({ next_attempt_at: sql<Date>`now() + make_interval(secs => ${LEASE_MS / 1000})` })
        .where('id', 'in', due.map((r) => r.id))
        .execute();
    }
    return due;
  });
  if (!rows.length) return out;

  const links = new Map(
    (
      await ctx.adminDb
        .selectFrom('integration_links')
        .innerJoin('tenants', 'tenants.id', 'integration_links.tenant_id')
        .leftJoin('plans', 'plans.code', 'tenants.plan_code')
        .select([
          'integration_links.id',
          'integration_links.status',
          'integration_links.peer_api_key_enc',
          'tenants.status as tenant_status',
          sql<boolean>`coalesce((plans.features ->> 'talko_link')::boolean, false)`.as('plan_allows'),
        ])
        .where('integration_links.id', 'in', [...new Set(rows.map((r) => r.link_id))])
        .execute()
    ).map((l) => [l.id, l]),
  );
  const origin = webOrigin(ctx.config);

  const finish = (id: string, set: { status: 'sent' | 'dead' | 'skipped' | 'pending'; last_error?: string | null; attempts?: number; next_attempt_at?: Date; sent_at?: Date }) =>
    ctx.adminDb
      .updateTable('integration_outbox')
      .set({ ...set, ...(set.last_error !== undefined ? { last_error: set.last_error?.slice(0, 500) ?? null } : {}) })
      .where('id', '=', id)
      .execute();

  for (const row of rows) {
    const link = links.get(row.link_id);
    if (row.expires_at && row.expires_at.getTime() < Date.now()) {
      await finish(row.id, { status: 'skipped', last_error: 'Too late to be useful, so not sent' });
      out.skipped++;
      continue;
    }
    if (!link || link.status !== 'active' || !link.peer_api_key_enc) {
      await finish(row.id, { status: 'dead', last_error: 'The Talko AI link was disconnected' });
      out.dead++;
      continue;
    }
    if (link.tenant_status !== 'active' || !link.plan_allows) {
      await finish(row.id, { status: 'skipped', last_error: 'The plan or account does not include Talko AI messages' });
      out.skipped++;
      continue;
    }
    let apiKey: string;
    try {
      apiKey = decryptSecret(encKey, link.peer_api_key_enc, peerKeyContext(link.id));
    } catch {
      await finish(row.id, { status: 'dead', last_error: 'Could not read the stored Talko key: reconnect Talko AI' });
      out.dead++;
      continue;
    }
    const data = { ...(row.payload as Record<string, unknown>) };
    if (typeof data.track_code === 'string' && data.track_code && origin) data.track_url = `${origin}/o/${data.track_code}`;
    const result = await sendTalkoEvent(ctx.config, apiKey, row.id, { event: row.event, phone: row.phone, name: row.name, data }, opts.fetchFn);
    if (result.ok) {
      await finish(row.id, { status: 'sent', sent_at: new Date(), last_error: null, attempts: row.attempts + 1 });
      await ctx.adminDb.updateTable('integration_links').set({ last_error: null }).where('id', '=', link.id).where('last_error', 'is not', null).execute();
      out.sent++;
      continue;
    }
    const attempts = row.attempts + 1;
    if (result.rejected) {
      await ctx.adminDb.updateTable('integration_links').set({ last_error: result.error.slice(0, 500) }).where('id', '=', link.id).execute();
    }
    const tooOld = Date.now() - row.created_at.getTime() > GIVE_UP_MS;
    if (!result.retry || attempts >= MAX_ATTEMPTS || tooOld) {
      await finish(row.id, { status: 'dead', attempts, last_error: result.error });
      out.dead++;
    } else {
      const minutes = BACKOFF_MINUTES[Math.min(attempts - 1, BACKOFF_MINUTES.length - 1)]!;
      await finish(row.id, { status: 'pending', attempts, last_error: result.error, next_attempt_at: new Date(Date.now() + minutes * 60_000) });
      out.retrying++;
    }
  }
  return out;
}

/**
 * Queues the reminder for bookings starting within their outlet's reminder window, once each.
 * Only for tenants with a live link, and only bookings that kept a phone number with consent.
 */
export async function queueDueReminders(ctx: AppContext, now = new Date()): Promise<number> {
  const candidates = await ctx.adminDb
    .selectFrom('reservations')
    .innerJoin('outlets', 'outlets.id', 'reservations.outlet_id')
    .innerJoin('integration_links', (j) =>
      j.onRef('integration_links.tenant_id', '=', 'reservations.tenant_id').on('integration_links.provider', '=', 'talko').on('integration_links.status', '=', 'active'),
    )
    .select(['reservations.id', 'reservations.tenant_id', 'reservations.slot_start', 'outlets.online_booking'])
    .where('reservations.status', '=', 'booked')
    .where('reservations.reminder_sent_at', 'is', null)
    .where('reservations.guest_phone', 'is not', null)
    .where('reservations.slot_start', '>', now)
    .where('reservations.slot_start', '<=', new Date(now.getTime() + 24 * 3600_000))
    .limit(500)
    .execute();
  let queued = 0;
  for (const c of candidates) {
    const minutes = onlineBooking(c.online_booking).reminder_minutes;
    if (minutes === 0 || c.slot_start.getTime() - now.getTime() > minutes * 60_000) continue;
    const done = await ctx.tx(c.tenant_id, async (tx) => {
      const claimed = await tx.db
        .updateTable('reservations')
        .set({ reminder_sent_at: now })
        .where('id', '=', c.id)
        .where('reminder_sent_at', 'is', null)
        .where('status', '=', 'booked')
        .returning('id')
        .executeTakeFirst();
      if (claimed) await queueReservation(tx, c.id, 'reminder');
      return !!claimed;
    });
    if (done) queued++;
  }
  return queued;
}

/** Reminders, then sends: the periodic sweep that catches retries and anything a kick missed. */
export async function runTalkoJobs(ctx: AppContext): Promise<{ reminders: number } & DispatchResult> {
  if (!ctx.config.INTEGRATION_ENC_KEY || !ctx.config.TALKO_API_URL) return { reminders: 0, sent: 0, retrying: 0, dead: 0, skipped: 0 };
  const reminders = await queueDueReminders(ctx);
  return { reminders, ...(await dispatchTalkoOutbox(ctx, { limit: 200 })) };
}

/**
 * Sends a tenant's new events right after the commit that queued them. On Vercel, waitUntil keeps
 * the function alive until the send finishes. Returns the function that stops it.
 */
export function registerTalkoDispatch(ctx: AppContext): () => void {
  kick = (tenantId) => {
    waitUntil(dispatchTalkoOutbox(ctx, { tenantId }).catch((err) => ctx.log.warn({ err }, 'talko dispatch failed')));
  };
  return () => {
    kick = null;
  };
}

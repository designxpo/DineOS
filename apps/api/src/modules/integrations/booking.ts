import { randomInt } from 'node:crypto';
import { sql } from 'kysely';
import { bookableStarts, CHAT_CHANNELS, onlineBooking, slotLabel, type ChatChannel } from '@mezmitra/shared/booking';
import { businessDate } from '@mezmitra/shared/dates';
import type { ReservationDTO } from '@mezmitra/shared/dto';
import { normalizePhone } from '@mezmitra/shared/phone';
import type { Tx } from '../../context';
import { AppError, conflict, notFound } from '../../lib/errors';
import { cleanPhone, upsertCustomer } from '../customers/service';
import { announceReservations, loadReservations } from '../reservations/service';
import { queueReservation } from './outbox';

// Tables booked from a chat (Talko AI). Mezmitra alone decides what is free: Talko only offers
// the times this returns and books one of them, and a time that filled up meanwhile is refused.

/** Most upcoming chat bookings one phone number may hold, so a chat cannot fill the floor. */
const MAX_UPCOMING_PER_PHONE = 3;
/** Tables in use now are not offered for bookings starting sooner than this. */
const SOON_MS = 90 * 60_000;
const REF_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** Why no times are offered. The chat tells the guest; none of these is an error. */
export type NoSlotsReason = 'booking_off' | 'party_too_large';

export interface OpenSlot {
  start: Date;
  /** The smallest free table that fits, used when the guest books this time. */
  tableId: string;
}

export interface SlotsResult {
  outlet: { id: string; name: string; timezone: string };
  slots: OpenSlot[];
  reason: NoSlotsReason | null;
  max_party: number;
}

async function bookingOutlet(tx: Tx, outletId: string) {
  const o = await tx.db
    .selectFrom('outlets')
    .select(['id', 'name', 'status', 'timezone', 'opening_hours', 'online_booking', 'reservation_minutes'])
    .where('id', '=', outletId)
    .executeTakeFirst();
  if (!o || o.status !== 'active') throw notFound('Outlet');
  return o;
}

/** Times on `date` (outlet's calendar) a party of `partySize` can book, each with a free table. */
export async function openSlots(tx: Tx, outletId: string, date: string, partySize: number, now = new Date()): Promise<SlotsResult> {
  const o = await bookingOutlet(tx, outletId);
  const booking = onlineBooking(o.online_booking);
  const base = { outlet: { id: o.id, name: o.name, timezone: o.timezone }, max_party: booking.max_party };
  if (!booking.enabled || !o.opening_hours) return { ...base, slots: [], reason: 'booking_off' };
  if (partySize > booking.max_party) return { ...base, slots: [], reason: 'party_too_large' };
  const starts = bookableStarts({ hours: o.opening_hours as never, booking, date, timezone: o.timezone, now });
  const tables = await tx.db
    .selectFrom('tables')
    .select(['id', 'seats', 'state'])
    .where('outlet_id', '=', outletId)
    .where('is_active', '=', true)
    .where('seats', '>=', partySize)
    .orderBy('seats')
    .orderBy('label')
    .execute();
  if (!tables.length) return { ...base, slots: [], reason: 'party_too_large' };
  if (!starts.length) return { ...base, slots: [], reason: null };

  const lengthMs = o.reservation_minutes * 60_000;
  const from = starts[0]!;
  const to = new Date(starts.at(-1)!.getTime() + lengthMs);
  const booked = await tx.db
    .selectFrom('reservations')
    .select(['table_id', 'slot_start', 'slot_end'])
    .where('outlet_id', '=', outletId)
    .where('table_id', 'in', tables.map((t) => t.id))
    .where('status', 'in', ['booked', 'seated'])
    .where('slot_start', '<', to)
    .where('slot_end', '>', from)
    .execute();

  const slots: OpenSlot[] = [];
  for (const start of starts) {
    const end = start.getTime() + lengthMs;
    const soon = start.getTime() - now.getTime() < SOON_MS;
    const free = tables.find(
      (t) =>
        !(soon && !['vacant', 'needs_cleaning'].includes(t.state)) &&
        !booked.some((b) => b.table_id === t.id && b.slot_start.getTime() < end && b.slot_end.getTime() > start.getTime()),
    );
    if (free) slots.push({ start, tableId: free.id });
  }
  return { ...base, slots, reason: null };
}

async function newPublicRef(tx: Tx): Promise<string> {
  for (let i = 0; i < 8; i++) {
    let ref = 'BK';
    for (let j = 0; j < 6; j++) ref += REF_ALPHABET[randomInt(REF_ALPHABET.length)];
    const taken = await tx.db.selectFrom('reservations').select('id').where('public_ref', '=', ref).executeTakeFirst();
    if (!taken) return ref;
  }
  throw new AppError(503, 'busy', 'Try again in a moment');
}

export interface ChatBookingInput {
  outletId: string;
  slotStart: Date;
  partySize: number;
  guestName: string;
  phone: string;
  channel: ChatChannel;
  externalRef: string | null;
  notes: string | null;
}

/** Books one of the times openSlots offers. Refuses anything else, with a reason the chat can say. */
export async function createChatBooking(tx: Tx, input: ChatBookingInput, now = new Date()): Promise<ReservationDTO> {
  const phone = cleanPhone(input.phone);
  // One booking at a time per outlet, so two chats cannot both take the last table.
  await sql`select pg_advisory_xact_lock(7340002, hashtext(${input.outletId}))`.execute(tx.db);
  const o = await bookingOutlet(tx, input.outletId);
  // The same guest asking again for the same table (a resent message, a retried request) gets the
  // booking they already have, not a second one.
  const same = await tx.db
    .selectFrom('reservations')
    .select('id')
    .where('outlet_id', '=', input.outletId)
    .where('guest_phone', '=', phone)
    .where('slot_start', '=', input.slotStart)
    .where('party_size', '=', input.partySize)
    .where('status', '=', 'booked')
    .executeTakeFirst();
  if (same) return (await loadReservations(tx, { outletId: input.outletId, ids: [same.id] }))[0]!;
  const result = await openSlots(tx, input.outletId, businessDate(input.slotStart, o.timezone), input.partySize, now);
  if (result.reason === 'booking_off') throw conflict('booking_off', 'This outlet is not taking table bookings in chat');
  if (result.reason === 'party_too_large') throw conflict('party_too_large', `For more than ${result.max_party} guests, please call the restaurant`);
  const slot = result.slots.find((s) => s.start.getTime() === input.slotStart.getTime());
  if (!slot) throw conflict('slot_unavailable', 'That time is not available. Ask for the open times again.');

  const upcoming = await tx.db
    .selectFrom('reservations')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('guest_phone', '=', phone)
    .where('status', '=', 'booked')
    .where('slot_start', '>', now)
    .where('source', 'in', [...CHAT_CHANNELS])
    .executeTakeFirstOrThrow();
  if (Number(upcoming.n) >= MAX_UPCOMING_PER_PHONE) {
    throw conflict('too_many_bookings', 'This number already has several upcoming bookings. Please call the restaurant to book more.');
  }

  const customer = await upsertCustomer(tx, { phone, name: input.guestName, consentSource: 'chat' });
  const row = await tx.db
    .insertInto('reservations')
    .values({
      tenant_id: tx.tenantId,
      outlet_id: input.outletId,
      table_id: slot.tableId,
      customer_id: customer.id,
      guest_name: input.guestName,
      guest_phone: customer.phone,
      party_size: input.partySize,
      slot_start: slot.start,
      slot_end: new Date(slot.start.getTime() + o.reservation_minutes * 60_000),
      source: input.channel,
      public_ref: await newPublicRef(tx),
      external_ref: input.externalRef,
      notes: input.notes,
      created_by: null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await announceReservations(tx, input.outletId);
  await queueReservation(tx, row.id, 'created');
  return (await loadReservations(tx, { outletId: input.outletId, ids: [row.id] }))[0]!;
}

/** Upcoming bookings for a phone number, across the tenant's outlets. */
export async function upcomingBookings(tx: Tx, rawPhone: string, now = new Date()) {
  const phone = normalizePhone(rawPhone);
  const rows = await tx.db
    .selectFrom('reservations')
    .innerJoin('outlets', 'outlets.id', 'reservations.outlet_id')
    .select(['reservations.id', 'reservations.public_ref', 'reservations.slot_start', 'reservations.party_size', 'reservations.status', 'outlets.id as outlet_id', 'outlets.name as outlet_name', 'outlets.timezone'])
    .where('reservations.guest_phone', '=', phone)
    .where('reservations.status', '=', 'booked')
    .where('reservations.slot_start', '>', now)
    .orderBy('reservations.slot_start')
    .limit(10)
    .execute();
  return rows.map(bookingView);
}

/** What a chat may show of a booking: no table, staff or notes. */
export function bookingView(r: { id: string; public_ref: string | null; slot_start: Date; party_size: number; status: string; outlet_id: string; outlet_name: string; timezone: string }) {
  return {
    id: r.id,
    ref: r.public_ref,
    outlet_id: r.outlet_id,
    outlet_name: r.outlet_name,
    slot_start: r.slot_start.toISOString(),
    date: businessDate(r.slot_start, r.timezone),
    time: slotLabel(r.slot_start, r.timezone),
    party_size: r.party_size,
    status: r.status,
  };
}

/**
 * Cancels a chat booking by its code. The phone must match the booking's; a wrong code or phone
 * gets the same "not found", so neither can be guessed one at a time.
 */
export async function cancelChatBooking(tx: Tx, ref: string, rawPhone: string, now = new Date()) {
  const phone = normalizePhone(rawPhone);
  const r = await tx.db
    .selectFrom('reservations')
    .select(['id', 'outlet_id', 'status', 'slot_start', 'party_size'])
    .where('public_ref', '=', ref)
    .where('guest_phone', '=', phone)
    .forUpdate()
    .executeTakeFirst();
  if (!r || r.status !== 'booked') throw notFound('Booking');
  if (r.slot_start.getTime() <= now.getTime()) throw conflict('too_late', 'This booking has already started. Please call the restaurant.');
  await tx.db.updateTable('reservations').set({ status: 'cancelled' }).where('id', '=', r.id).execute();
  await announceReservations(tx, r.outlet_id);
  await queueReservation(tx, r.id, 'cancelled');
  const o = await tx.db.selectFrom('outlets').select(['name', 'timezone']).where('id', '=', r.outlet_id).executeTakeFirstOrThrow();
  return bookingView({ id: r.id, public_ref: ref, slot_start: r.slot_start, party_size: r.party_size, status: 'cancelled', outlet_id: r.outlet_id, outlet_name: o.name, timezone: o.timezone });
}

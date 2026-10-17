import type { ReservationDTO, ReservationStatus, WaitlistEntryDTO } from '@mezmitra/shared/dto';
import type { Tx } from '../../context';
import { conflict, notFound } from '../../lib/errors';
import { seatTable } from '../tables/floor';

export async function loadReservations(tx: Tx, where: { outletId: string; from?: Date; to?: Date; ids?: string[] }): Promise<ReservationDTO[]> {
  let q = tx.db
    .selectFrom('reservations')
    .leftJoin('tables', 'tables.id', 'reservations.table_id')
    .leftJoin('users', 'users.id', 'reservations.created_by')
    .selectAll('reservations')
    .select(['tables.label as table_label', 'users.name as created_by_name'])
    .where('reservations.outlet_id', '=', where.outletId);
  if (where.ids) q = q.where('reservations.id', 'in', where.ids);
  if (where.from) q = q.where('reservations.slot_start', '>=', where.from);
  if (where.to) q = q.where('reservations.slot_start', '<', where.to);
  const rows = await q.orderBy('reservations.slot_start').execute();
  return rows.map((r) => ({
    id: r.id,
    outlet_id: r.outlet_id,
    table_id: r.table_id,
    table_label: r.table_label,
    customer_id: r.customer_id,
    guest_name: r.guest_name,
    guest_phone: r.guest_phone,
    party_size: r.party_size,
    slot_start: r.slot_start.toISOString(),
    slot_end: r.slot_end.toISOString(),
    status: r.status as ReservationStatus,
    source: r.source as ReservationDTO['source'],
    notes: r.notes,
    created_by_name: r.created_by_name,
    created_at: r.created_at.toISOString(),
  }));
}

/** Another live booking on the same table that overlaps [start, end). */
export async function findClash(tx: Tx, tableId: string, start: Date, end: Date, excludeId?: string) {
  let q = tx.db
    .selectFrom('reservations')
    .select(['id', 'guest_name', 'slot_start'])
    .where('table_id', '=', tableId)
    .where('status', 'in', ['booked', 'seated'])
    .where('slot_start', '<', end)
    .where('slot_end', '>', start);
  if (excludeId) q = q.where('id', '<>', excludeId);
  return q.executeTakeFirst();
}

export async function assertNoClash(tx: Tx, tableId: string | null, start: Date, end: Date, excludeId?: string): Promise<void> {
  if (!tableId) return;
  const clash = await findClash(tx, tableId, start, end, excludeId);
  if (clash) {
    throw conflict('table_booked', `That table is already booked for ${clash.guest_name} at ${clash.slot_start.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' })}`);
  }
}

/**
 * Tables that fit the party and have no clashing booking. Smallest suitable tables first, so
 * a couple is not given the ten-seater. Tables in use right now are left out for near slots.
 */
export async function availableTables(tx: Tx, outletId: string, start: Date, end: Date, partySize: number) {
  const tables = await tx.db
    .selectFrom('tables')
    .select(['id', 'label', 'seats', 'zone', 'state'])
    .where('outlet_id', '=', outletId)
    .where('is_active', '=', true)
    .where('seats', '>=', partySize)
    .orderBy('seats')
    .orderBy('label')
    .execute();
  const soon = start.getTime() - Date.now() < 90 * 60_000;
  const out = [];
  for (const t of tables) {
    if (soon && !['vacant', 'needs_cleaning'].includes(t.state)) continue;
    if (await findClash(tx, t.id, start, end)) continue;
    out.push({ id: t.id, label: t.label, seats: t.seats, zone: t.zone });
  }
  return out;
}

export async function announceReservations(tx: Tx, outletId: string): Promise<void> {
  await tx.emit({ outletId, type: 'reservations.updated', channels: ['outlet'], payload: {} });
  await tx.emit({ outletId, type: 'tables.updated', channels: ['outlet'], payload: {} });
}

/** Seats a booked party: opens the table session and links the guest to it. */
export async function seatReservation(tx: Tx, reservationId: string, tableId: string | null, waiterId: string): Promise<void> {
  const r = await tx.db.selectFrom('reservations').selectAll().where('id', '=', reservationId).forUpdate().executeTakeFirst();
  if (!r) throw notFound('Reservation');
  if (r.status !== 'booked') throw conflict('not_booked', `This booking is ${r.status}`);
  const table = tableId ?? r.table_id;
  if (!table) throw conflict('table_required', 'Pick a table to seat them at');
  const sessionId = await seatTable(tx, table, { guestCount: r.party_size, waiterId });
  if (r.customer_id) {
    await tx.db.updateTable('table_sessions').set({ customer_id: r.customer_id }).where('id', '=', sessionId).execute();
  }
  await tx.db
    .updateTable('reservations')
    .set({ status: 'seated', table_id: table, table_session_id: sessionId })
    .where('id', '=', reservationId)
    .execute();
  await announceReservations(tx, r.outlet_id);
}

export async function loadWaitlist(tx: Tx, outletId: string, ids?: string[]): Promise<WaitlistEntryDTO[]> {
  let q = tx.db
    .selectFrom('waitlist_entries')
    .leftJoin('tables', 'tables.id', 'waitlist_entries.table_id')
    .selectAll('waitlist_entries')
    .select('tables.label as table_label')
    .where('waitlist_entries.outlet_id', '=', outletId);
  q = ids ? q.where('waitlist_entries.id', 'in', ids) : q.where('waitlist_entries.status', 'in', ['waiting', 'notified']);
  const rows = await q.orderBy('waitlist_entries.created_at').execute();
  return rows.map((w) => ({
    id: w.id,
    outlet_id: w.outlet_id,
    guest_name: w.guest_name,
    guest_phone: w.guest_phone,
    party_size: w.party_size,
    quoted_minutes: w.quoted_minutes,
    status: w.status as WaitlistEntryDTO['status'],
    notes: w.notes,
    table_label: w.table_label,
    created_at: w.created_at.toISOString(),
    notified_at: w.notified_at?.toISOString() ?? null,
    seated_at: w.seated_at?.toISOString() ?? null,
  }));
}

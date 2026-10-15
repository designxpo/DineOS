import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { AppContext, Tx } from '../../context';
import { assertCan, requireStaff, type StaffAuth } from '../../lib/auth';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { assertOutletExists } from '../../lib/outlet';
import { idParams, parse } from '../../lib/validate';
import { upsertCustomer } from '../customers/service';
import { seatTable } from '../tables/floor';
import { announceReservations, assertNoClash, availableTables, loadReservations, loadWaitlist, seatReservation } from './service';

const istDayStart = (date: string) => new Date(`${date}T00:00:00+05:30`);

const reservationFields = {
  guest_name: z.string().trim().min(1).max(80),
  guest_phone: z.string().trim().min(10).max(20).nullable().optional(),
  // Phone numbers are stored only when the guest agreed (spec §12).
  contact_consent: z.boolean().default(false),
  party_size: z.number().int().min(1).max(200),
  slot_start: z.iso.datetime({ offset: true }),
  duration_minutes: z.number().int().min(15).max(600).optional(),
  table_id: z.uuid().nullable().optional(),
  source: z.enum(['phone', 'walk_in', 'online', 'other']).default('phone'),
  notes: z.string().trim().max(500).nullable().optional(),
};

export default function routes(ctx: AppContext): FastifyPluginAsync {
  async function onReservation<T>(auth: StaffAuth, id: string, fn: (tx: Tx, r: { outlet_id: string }) => Promise<T>) {
    return ctx.tx(auth.tenantId, async (tx) => {
      const r = await tx.db.selectFrom('reservations').select(['outlet_id']).where('id', '=', id).executeTakeFirst();
      if (!r) throw notFound('Reservation');
      assertCan(auth, r.outlet_id, 'reservation.manage');
      return fn(tx, r);
    });
  }

  async function assertTable(tx: Tx, outletId: string, tableId: string | null | undefined) {
    if (!tableId) return;
    const t = await tx.db.selectFrom('tables').select('id').where('id', '=', tableId).where('outlet_id', '=', outletId).where('is_active', '=', true).executeTakeFirst();
    if (!t) throw badRequest('invalid_table', 'Table is not in this outlet');
  }

  return async (app) => {
    app.get('/reservations', async (req) => {
      const auth = requireStaff(req);
      const q = parse(z.object({ outlet_id: z.uuid(), date: z.iso.date().optional() }), req.query);
      assertCan(auth, q.outlet_id, 'reservation.manage');
      const date = q.date ?? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
      const from = istDayStart(date);
      return ctx.tx(auth.tenantId, (tx) => loadReservations(tx, { outletId: q.outlet_id, from, to: new Date(from.getTime() + 86_400_000) }));
    });

    app.get('/reservations/availability', async (req) => {
      const auth = requireStaff(req);
      const q = parse(
        z.object({ outlet_id: z.uuid(), slot_start: z.iso.datetime({ offset: true }), party_size: z.coerce.number().int().min(1), duration_minutes: z.coerce.number().int().min(15).max(600).optional() }),
        req.query,
      );
      assertCan(auth, q.outlet_id, 'reservation.manage');
      return ctx.tx(auth.tenantId, async (tx) => {
        const o = await tx.db.selectFrom('outlets').select('reservation_minutes').where('id', '=', q.outlet_id).executeTakeFirstOrThrow();
        const start = new Date(q.slot_start);
        return availableTables(tx, q.outlet_id, start, new Date(start.getTime() + (q.duration_minutes ?? o.reservation_minutes) * 60_000), q.party_size);
      });
    });

    app.post('/reservations', async (req, reply) => {
      const auth = requireStaff(req);
      const body = parse(z.object({ outlet_id: z.uuid(), ...reservationFields }), req.body);
      assertCan(auth, body.outlet_id, 'reservation.manage');
      const result = await ctx.tx(auth.tenantId, async (tx) => {
        const o = await tx.db.selectFrom('outlets').select('reservation_minutes').where('id', '=', body.outlet_id).executeTakeFirst();
        if (!o) throw notFound('Outlet');
        await assertTable(tx, body.outlet_id, body.table_id);
        const start = new Date(body.slot_start);
        const end = new Date(start.getTime() + (body.duration_minutes ?? o.reservation_minutes) * 60_000);
        await assertNoClash(tx, body.table_id ?? null, start, end);
        const phone = body.contact_consent ? (body.guest_phone ?? null) : null;
        const customer = phone ? await upsertCustomer(tx, { phone, name: body.guest_name, consentSource: 'staff' }) : null;
        const row = await tx.db
          .insertInto('reservations')
          .values({
            tenant_id: tx.tenantId,
            outlet_id: body.outlet_id,
            table_id: body.table_id ?? null,
            customer_id: customer?.id ?? null,
            guest_name: body.guest_name,
            guest_phone: customer?.phone ?? null,
            party_size: body.party_size,
            slot_start: start,
            slot_end: end,
            source: body.source,
            notes: body.notes ?? null,
            created_by: auth.userId,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        await announceReservations(tx, body.outlet_id);
        return (await loadReservations(tx, { outletId: body.outlet_id, ids: [row.id] }))[0];
      });
      return reply.status(201).send(result);
    });

    app.patch('/reservations/:id', async (req) => {
      const auth = requireStaff(req);
      const { id } = parse(idParams, req.params);
      const body = parse(z.object({ ...reservationFields, status: z.enum(['booked', 'cancelled', 'no_show']) }).partial(), req.body);
      return onReservation(auth, id, async (tx, r) => {
        const current = await tx.db.selectFrom('reservations').selectAll().where('id', '=', id).forUpdate().executeTakeFirstOrThrow();
        if (['seated', 'completed'].includes(current.status) && body.status) throw conflict('already_seated', 'This party is already seated');
        const o = await tx.db.selectFrom('outlets').select('reservation_minutes').where('id', '=', r.outlet_id).executeTakeFirstOrThrow();
        const start = body.slot_start ? new Date(body.slot_start) : current.slot_start;
        const end = body.slot_start || body.duration_minutes
          ? new Date(start.getTime() + (body.duration_minutes ?? Math.round((current.slot_end.getTime() - current.slot_start.getTime()) / 60_000) ?? o.reservation_minutes) * 60_000)
          : current.slot_end;
        const tableId = body.table_id !== undefined ? body.table_id : current.table_id;
        await assertTable(tx, r.outlet_id, tableId);
        if ((body.status ?? current.status) === 'booked') await assertNoClash(tx, tableId, start, end, id);
        let customerId = current.customer_id;
        let phone = current.guest_phone;
        if (body.guest_phone !== undefined || body.contact_consent !== undefined) {
          const consent = body.contact_consent ?? !!current.guest_phone;
          const raw = body.guest_phone !== undefined ? body.guest_phone : current.guest_phone;
          if (consent && raw) {
            const c = await upsertCustomer(tx, { phone: raw, name: body.guest_name ?? current.guest_name, consentSource: 'staff' });
            customerId = c.id;
            phone = c.phone;
          } else {
            phone = null;
          }
        }
        await tx.db
          .updateTable('reservations')
          .set({
            ...(body.guest_name ? { guest_name: body.guest_name } : {}),
            ...(body.party_size ? { party_size: body.party_size } : {}),
            ...(body.notes !== undefined ? { notes: body.notes } : {}),
            ...(body.source ? { source: body.source } : {}),
            ...(body.status ? { status: body.status } : {}),
            slot_start: start,
            slot_end: end,
            table_id: tableId,
            guest_phone: phone,
            customer_id: customerId,
          })
          .where('id', '=', id)
          .execute();
        await announceReservations(tx, r.outlet_id);
        return (await loadReservations(tx, { outletId: r.outlet_id, ids: [id] }))[0];
      });
    });

    app.post('/reservations/:id/seat', async (req) => {
      const auth = requireStaff(req);
      const { id } = parse(idParams, req.params);
      const body = parse(z.object({ table_id: z.uuid().optional() }), req.body ?? {});
      return onReservation(auth, id, async (tx, r) => {
        await assertTable(tx, r.outlet_id, body.table_id);
        await seatReservation(tx, id, body.table_id ?? null, auth.userId);
        return (await loadReservations(tx, { outletId: r.outlet_id, ids: [id] }))[0];
      });
    });

    // ---------------------------------------------------------------- waitlist

    app.get('/waitlist', async (req) => {
      const auth = requireStaff(req);
      const q = parse(z.object({ outlet_id: z.uuid() }), req.query);
      assertCan(auth, q.outlet_id, 'reservation.manage');
      return ctx.tx(auth.tenantId, (tx) => loadWaitlist(tx, q.outlet_id));
    });

    app.post('/waitlist', async (req, reply) => {
      const auth = requireStaff(req);
      const body = parse(
        z.object({
          outlet_id: z.uuid(),
          guest_name: z.string().trim().min(1).max(80),
          guest_phone: z.string().trim().min(10).max(20).nullable().optional(),
          contact_consent: z.boolean().default(false),
          party_size: z.number().int().min(1).max(200),
          quoted_minutes: z.number().int().min(0).max(600).nullable().optional(),
          notes: z.string().trim().max(300).nullable().optional(),
        }),
        req.body,
      );
      assertCan(auth, body.outlet_id, 'reservation.manage');
      const entry = await ctx.tx(auth.tenantId, async (tx) => {
        await assertOutletExists(tx, body.outlet_id);
        const row = await tx.db
          .insertInto('waitlist_entries')
          .values({
            tenant_id: tx.tenantId,
            outlet_id: body.outlet_id,
            guest_name: body.guest_name,
            guest_phone: body.contact_consent ? (body.guest_phone ?? null) : null,
            party_size: body.party_size,
            quoted_minutes: body.quoted_minutes ?? null,
            notes: body.notes ?? null,
            created_by: auth.userId,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        await tx.emit({ outletId: body.outlet_id, type: 'waitlist.updated', channels: ['outlet'], payload: {} });
        return (await loadWaitlist(tx, body.outlet_id, [row.id]))[0];
      });
      return reply.status(201).send(entry);
    });

    for (const action of ['notify', 'leave', 'seat'] as const) {
      app.post(`/waitlist/:id/${action}`, async (req) => {
        const auth = requireStaff(req);
        const { id } = parse(idParams, req.params);
        const body = parse(z.object({ table_id: z.uuid().optional() }), req.body ?? {});
        return ctx.tx(auth.tenantId, async (tx) => {
          const w = await tx.db.selectFrom('waitlist_entries').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
          if (!w) throw notFound('Waitlist entry');
          assertCan(auth, w.outlet_id, 'reservation.manage');
          if (!['waiting', 'notified'].includes(w.status)) throw conflict('waitlist_closed', `This party is already ${w.status}`);
          if (action === 'notify') {
            await tx.db.updateTable('waitlist_entries').set({ status: 'notified', notified_at: new Date() }).where('id', '=', id).execute();
          } else if (action === 'leave') {
            await tx.db.updateTable('waitlist_entries').set({ status: 'left' }).where('id', '=', id).execute();
          } else {
            if (!body.table_id) throw badRequest('table_required', 'Pick a table');
            await assertTable(tx, w.outlet_id, body.table_id);
            const sessionId = await seatTable(tx, body.table_id, { guestCount: w.party_size, waiterId: auth.userId });
            await tx.db
              .updateTable('waitlist_entries')
              .set({ status: 'seated', seated_at: new Date(), table_id: body.table_id, table_session_id: sessionId })
              .where('id', '=', id)
              .execute();
          }
          await tx.emit({ outletId: w.outlet_id, type: 'waitlist.updated', channels: ['outlet'], payload: {} });
          return (await loadWaitlist(tx, w.outlet_id, [id]))[0];
        });
      });
    }
  };
}

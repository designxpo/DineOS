import type { FastifyPluginAsync } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';
import type { LoyaltyEntryDTO } from '@dineos/shared/dto';
import type { AppContext } from '../../context';
import { audit } from '../../lib/audit';
import { assertCan, requireStaff } from '../../lib/auth';
import { badRequest, notFound } from '../../lib/errors';
import { assertOutletExists } from '../../lib/outlet';
import { idParams, parse } from '../../lib/validate';
import { toCsv } from '../reports/service';
import { CUSTOMER_COLUMNS, customerDto, upsertCustomer } from './service';

const outletParam = z.object({ outlet_id: z.uuid() });
const createBody = outletParam.extend({
  phone: z.string().min(10).max(20),
  name: z.string().trim().max(80).nullable().optional(),
  email: z.email().nullable().optional(),
  marketing_opt_in: z.boolean().optional(),
  // The person agreed to their number being stored. Without it, nothing is saved.
  consent: z.literal(true, { error: 'Ask the customer and tick consent before saving their number' }),
});

export default function routes(ctx: AppContext): FastifyPluginAsync {
  return async (app) => {
    app.get('/customers', async (req) => {
      const auth = requireStaff(req);
      const q = parse(outletParam.extend({ q: z.string().max(80).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }), req.query);
      assertCan(auth, q.outlet_id, 'customer.view');
      return ctx.tx(auth.tenantId, async (tx) => {
        await assertOutletExists(tx, q.outlet_id);
        let query = tx.db.selectFrom('customers').select(CUSTOMER_COLUMNS).where('erased_at', 'is', null);
        const term = q.q?.trim();
        if (term) {
          const digits = term.replace(/\D/g, '');
          query = query.where((eb) =>
            eb.or([eb(eb.fn('lower', ['name']), 'like', `%${term.toLowerCase()}%`), ...(digits.length >= 3 ? [eb('phone', 'like', `%${digits}%`)] : [])]),
          );
        }
        const rows = await query.orderBy('last_visit_at', sql`desc nulls last`).orderBy('created_at', 'desc').limit(q.limit).execute();
        return rows.map(customerDto);
      });
    });

    app.post('/customers', async (req, reply) => {
      const auth = requireStaff(req);
      const body = parse(createBody, req.body);
      assertCan(auth, body.outlet_id, 'customer.manage');
      const customer = await ctx.tx(auth.tenantId, async (tx) => {
        await assertOutletExists(tx, body.outlet_id);
        return upsertCustomer(tx, { phone: body.phone, name: body.name, email: body.email, consentSource: 'staff', marketingOptIn: body.marketing_opt_in });
      });
      return reply.status(201).send(customer);
    });

    app.get('/customers/:id', async (req) => {
      const auth = requireStaff(req);
      const { id } = parse(idParams, req.params);
      const q = parse(outletParam, req.query);
      assertCan(auth, q.outlet_id, 'customer.view');
      return ctx.tx(auth.tenantId, async (tx) => {
        await assertOutletExists(tx, q.outlet_id);
        const c = await tx.db.selectFrom('customers').select(CUSTOMER_COLUMNS).where('id', '=', id).where('erased_at', 'is', null).executeTakeFirst();
        if (!c) throw notFound('Customer');
        const ledger = await tx.db
          .selectFrom('loyalty_ledger')
          .leftJoin('bills', 'bills.id', 'loyalty_ledger.bill_id')
          .select(['loyalty_ledger.id', 'loyalty_ledger.kind', 'loyalty_ledger.points', 'loyalty_ledger.stamps', 'loyalty_ledger.note', 'loyalty_ledger.bill_id', 'bills.invoice_no', 'loyalty_ledger.created_at'])
          .where('loyalty_ledger.customer_id', '=', id)
          .orderBy('loyalty_ledger.created_at', 'desc')
          .limit(50)
          .execute();
        const bills = await tx.db
          .selectFrom('bills')
          .select(['id', 'invoice_no', 'invoice_date', 'total_paise', 'status'])
          .where('customer_id', '=', id)
          .where('status', 'in', ['finalised', 'paid'])
          .orderBy('finalised_at', 'desc')
          .limit(20)
          .execute();
        return {
          customer: customerDto(c),
          ledger: ledger.map((l): LoyaltyEntryDTO => ({ ...l, kind: l.kind as LoyaltyEntryDTO['kind'], created_at: l.created_at.toISOString() })),
          bills,
        };
      });
    });

    app.patch('/customers/:id', async (req) => {
      const auth = requireStaff(req);
      const { id } = parse(idParams, req.params);
      const body = parse(
        outletParam.extend({
          name: z.string().trim().max(80).nullable().optional(),
          email: z.email().nullable().optional(),
          birthday: z.iso.date().nullable().optional(),
          notes: z.string().max(500).nullable().optional(),
          marketing_opt_in: z.boolean().optional(),
        }),
        req.body,
      );
      assertCan(auth, body.outlet_id, 'customer.manage');
      const { outlet_id: _o, ...changes } = body;
      return ctx.tx(auth.tenantId, async (tx) => {
        await assertOutletExists(tx, body.outlet_id);
        const row = await tx.db
          .updateTable('customers')
          .set(Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined)))
          .where('id', '=', id)
          .where('erased_at', 'is', null)
          .returning(CUSTOMER_COLUMNS)
          .executeTakeFirst();
        if (!row) throw notFound('Customer');
        return customerDto(row);
      });
    });

    /** Manager correction of a balance, e.g. goodwill points. Written to the ledger and audit log. */
    app.post('/customers/:id/points', async (req) => {
      const auth = requireStaff(req);
      const { id } = parse(idParams, req.params);
      const body = parse(outletParam.extend({ points: z.number().int().min(-1_000_000).max(1_000_000).refine((p) => p !== 0), note: z.string().trim().min(3).max(200) }), req.body);
      assertCan(auth, body.outlet_id, 'customer.adjust');
      return ctx.tx(auth.tenantId, async (tx) => {
        await assertOutletExists(tx, body.outlet_id);
        const c = await tx.db.selectFrom('customers').select(['id', 'points']).where('id', '=', id).where('erased_at', 'is', null).forUpdate().executeTakeFirst();
        if (!c) throw notFound('Customer');
        if (c.points + body.points < 0) throw badRequest('not_enough_points', `The customer has ${c.points} points`);
        const row = await tx.db.updateTable('customers').set({ points: c.points + body.points }).where('id', '=', id).returning(CUSTOMER_COLUMNS).executeTakeFirstOrThrow();
        await tx.db
          .insertInto('loyalty_ledger')
          .values({ tenant_id: tx.tenantId, customer_id: id, outlet_id: body.outlet_id, kind: 'adjust', points: body.points, note: body.note, created_by: auth.userId })
          .execute();
        await audit(tx, auth, { outletId: body.outlet_id, action: 'customer.points_adjust', entity: 'customer', entityId: id, before: { points: c.points }, after: { points: row.points }, reason: body.note });
        return customerDto(row);
      });
    });

    /** Right to erasure: personal details are removed; anonymous visit counts stay for reports. */
    app.post('/customers/:id/erase', async (req, reply) => {
      const auth = requireStaff(req);
      const { id } = parse(idParams, req.params);
      const body = parse(outletParam, req.body);
      assertCan(auth, body.outlet_id, 'customer.adjust');
      await ctx.tx(auth.tenantId, async (tx) => {
        await assertOutletExists(tx, body.outlet_id);
        const row = await tx.db
          .updateTable('customers')
          .set({ phone: `erased-${id}`, name: null, email: null, birthday: null, notes: null, marketing_opt_in: false, points: 0, erased_at: new Date() })
          .where('id', '=', id)
          .where('erased_at', 'is', null)
          .returning('id')
          .executeTakeFirst();
        if (!row) throw notFound('Customer');
        await tx.db.updateTable('reservations').set({ guest_phone: null }).where('customer_id', '=', id).execute();
        await audit(tx, auth, { outletId: body.outlet_id, action: 'customer.erase', entity: 'customer', entityId: id });
      });
      return reply.status(204).send();
    });

    app.get('/customers/export.csv', async (req, reply) => {
      const auth = requireStaff(req);
      const q = parse(outletParam, req.query);
      assertCan(auth, q.outlet_id, 'customer.adjust');
      const rows = await ctx.tx(auth.tenantId, async (tx) => {
        await assertOutletExists(tx, q.outlet_id);
        await audit(tx, auth, { outletId: q.outlet_id, action: 'customer.export', entity: 'customer' });
        return tx.db
          .selectFrom('customers')
          .select(['name', 'phone', 'email', 'marketing_opt_in', 'visits', 'total_spend_paise', 'points', 'last_visit_at', 'consent_at', 'consent_source'])
          .where('erased_at', 'is', null)
          .orderBy('name')
          .execute();
      });
      reply.header('content-type', 'text/csv; charset=utf-8');
      reply.header('content-disposition', 'attachment; filename="customers.csv"');
      return toCsv(
        rows.map((r) => ({
          ...r,
          total_spend_inr: (r.total_spend_paise / 100).toFixed(2),
          total_spend_paise: undefined,
          last_visit_at: r.last_visit_at?.toISOString() ?? '',
          consent_at: r.consent_at.toISOString(),
        })).map(({ total_spend_paise: _t, ...rest }) => rest),
      );
    });
  };
}

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { BILL_STATUSES, PAYMENT_METHODS } from '@dineos/shared/enums';
import type { AppContext } from '../../context';
import { approvalHeader } from '../../lib/approvals';
import { assertCan, requireStaff } from '../../lib/auth';
import { badRequest, notFound } from '../../lib/errors';
import { idParams, outletQuery, parse } from '../../lib/validate';
import { loadBills, loadInvoice, upiUri } from './serialize';
import {
  createBill,
  discardDraft,
  finaliseBill,
  getBill,
  printBill,
  recordPayment,
  refundPayment,
  splitBill,
  updateBill,
  voidBill,
} from './service';

const discount = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('percent'), bp: z.number().int().min(1).max(10000) }),
  z.object({ kind: z.literal('amount'), paise: z.number().int().min(1).max(100_000_000) }),
]);

const updateBody = z.object({
  bill_discount: discount.nullable().optional(),
  discount_reason: z.string().max(200).nullable().optional(),
  service_charge_waived: z.boolean().optional(),
  item_discounts: z.record(z.uuid(), z.number().int().min(0).max(100_000_000)).optional(),
  customer_name: z.string().max(100).nullable().optional(),
  customer_gstin: z.string().max(15).nullable().optional(),
});

const splitBody = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('items'), groups: z.array(z.array(z.uuid()).max(200)).min(2).max(20) }),
  z.object({ mode: z.literal('seats') }),
  z.object({
    mode: z.literal('amount'),
    count: z.number().int().min(1).max(20).optional(),
    amounts: z.array(z.number().int().min(1)).min(2).max(20).optional(),
  }),
]);

const paymentBody = z.object({
  method: z.enum(PAYMENT_METHODS),
  amount_paise: z.number().int().min(1).max(100_000_000),
  tendered_paise: z.number().int().min(0).max(100_000_000).nullable().optional(),
  reference: z.string().max(100).nullable().optional(),
});

export default function routes(ctx: AppContext): FastifyPluginAsync {
  async function billOutlet(tenantId: string, billId: string) {
    const row = await ctx.tx(tenantId, (tx) => tx.db.selectFrom('bills').select('outlet_id').where('id', '=', billId).executeTakeFirst());
    if (!row) throw notFound('Bill');
    return row.outlet_id;
  }

  return async (app) => {
    app.get('/bills', async (req) => {
      const auth = requireStaff(req);
      const q = parse(
        outletQuery.extend({
          status: z.string().optional(),
          table_session_id: z.uuid().optional(),
          date: z.iso.date().optional(),
          limit: z.coerce.number().int().min(1).max(500).default(100),
        }),
        req.query,
      );
      assertCan(auth, q.outlet_id, 'bill.manage');
      const statuses = q.status?.split(',').filter(Boolean) ?? [];
      for (const s of statuses) if (!(BILL_STATUSES as readonly string[]).includes(s)) throw badRequest('invalid_status', `Unknown status ${s}`);
      return ctx.tx(auth.tenantId, async (tx) => {
        let query = tx.db.selectFrom('bills').select('id').where('outlet_id', '=', q.outlet_id);
        if (statuses.length) query = query.where('status', 'in', statuses);
        if (q.table_session_id) query = query.where('table_session_id', '=', q.table_session_id);
        if (q.date) query = query.where('invoice_date', '=', q.date);
        const rows = await query.orderBy('created_at', 'desc').limit(q.limit).execute();
        return loadBills(tx, rows.map((r) => r.id));
      });
    });

    app.post('/bills', async (req, reply) => {
      const auth = requireStaff(req);
      const body = parse(z.object({ table_session_id: z.uuid().optional(), order_id: z.uuid().optional() }), req.body);
      const bill = await ctx.tx(auth.tenantId, (tx) => createBill(tx, auth, body));
      return reply.status(201).send(bill);
    });

    app.get('/bills/:id', async (req) => {
      const auth = requireStaff(req);
      const { id } = parse(idParams, req.params);
      assertCan(auth, await billOutlet(auth.tenantId, id), 'bill.manage');
      return ctx.tx(auth.tenantId, (tx) => getBill(tx, id));
    });

    app.patch('/bills/:id', async (req) => {
      const auth = requireStaff(req);
      const { id } = parse(idParams, req.params);
      const body = parse(updateBody, req.body);
      return ctx.tx(auth.tenantId, (tx) => updateBill(tx, auth, id, body, approvalHeader(req.headers)));
    });

    app.delete('/bills/:id', async (req, reply) => {
      const auth = requireStaff(req);
      const { id } = parse(idParams, req.params);
      await ctx.tx(auth.tenantId, (tx) => discardDraft(tx, auth, id));
      return reply.status(204).send();
    });

    app.post('/bills/:id/split', async (req) => {
      const auth = requireStaff(req);
      const { id } = parse(idParams, req.params);
      const body = parse(splitBody, req.body);
      return ctx.tx(auth.tenantId, (tx) => splitBill(tx, auth, id, body));
    });

    app.post('/bills/:id/finalise', async (req) => {
      const auth = requireStaff(req);
      const { id } = parse(idParams, req.params);
      return ctx.tx(auth.tenantId, (tx) => finaliseBill(tx, auth, id));
    });

    app.post('/bills/:id/payments', async (req, reply) => {
      const auth = requireStaff(req);
      const { id } = parse(idParams, req.params);
      const body = parse(paymentBody, req.body);
      const bill = await ctx.tx(auth.tenantId, (tx) => recordPayment(tx, auth, id, body));
      return reply.status(201).send(bill);
    });

    app.post('/bills/:id/void', async (req) => {
      const auth = requireStaff(req);
      const { id } = parse(idParams, req.params);
      const body = parse(z.object({ reason: z.string().min(1).max(300) }), req.body);
      return ctx.tx(auth.tenantId, (tx) => voidBill(tx, auth, id, body.reason, approvalHeader(req.headers)));
    });

    app.post('/payments/:id/refund', async (req) => {
      const auth = requireStaff(req);
      const { id } = parse(idParams, req.params);
      const body = parse(z.object({ amount_paise: z.number().int().min(1), reason: z.string().min(1).max(300) }), req.body);
      return ctx.tx(auth.tenantId, (tx) => refundPayment(tx, auth, id, body, approvalHeader(req.headers)));
    });

    /** GST invoice data for screen and browser printing, plus the outlet's UPI payment link. */
    app.get('/bills/:id/invoice', async (req) => {
      const auth = requireStaff(req);
      const { id } = parse(idParams, req.params);
      const outletId = await billOutlet(auth.tenantId, id);
      assertCan(auth, outletId, 'bill.manage');
      return ctx.tx(auth.tenantId, async (tx) => {
        await getBill(tx, id);
        const invoice = (await loadInvoice(tx, id))!;
        const outlet = await tx.db.selectFrom('outlets').select(['upi_vpa', 'upi_payee_name', 'name']).where('id', '=', outletId).executeTakeFirstOrThrow();
        const due = invoice.bill.balance_paise;
        return {
          ...invoice,
          upi_uri: due > 0 ? upiUri(outlet.upi_vpa, outlet.upi_payee_name ?? outlet.name, due, invoice.bill.invoice_no ?? 'Bill') : null,
        };
      });
    });

    app.post('/bills/:id/print', async (req) => {
      const auth = requireStaff(req);
      const { id } = parse(idParams, req.params);
      assertCan(auth, await billOutlet(auth.tenantId, id), 'bill.manage');
      return ctx.tx(auth.tenantId, async (tx) => {
        const printed = await tx.db.selectFrom('print_jobs').select('id').where('ref_id', '=', id).where('kind', '=', 'bill').executeTakeFirst();
        return printBill(tx, id, !!printed);
      });
    });
  };
}

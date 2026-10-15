import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { AppContext, Tx } from '../../context';
import { audit } from '../../lib/audit';
import { assertCan, requireStaff, type StaffAuth } from '../../lib/auth';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { idParams, parse } from '../../lib/validate';
import { readGrid } from '../menu/import';
import { importStatement, listStatements, statementDetail } from './service';
import { parseStatement } from './statement';

const MAX_FILE = 5 * 1024 * 1024;

export default function routes(ctx: AppContext): FastifyPluginAsync {
  /** Loads a bank credit and checks the caller may reconcile its outlet. */
  async function onCredit<T>(auth: StaffAuth, id: string, fn: (tx: Tx, credit: { id: string; outlet_id: string; statement_id: string; amount_paise: number; payment_id: string | null; dismissed_reason: string | null }) => Promise<T>) {
    return ctx.tx(auth.tenantId, async (tx) => {
      const credit = await tx.db
        .selectFrom('bank_credits')
        .select(['id', 'outlet_id', 'statement_id', 'amount_paise', 'payment_id', 'dismissed_reason'])
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      if (!credit) throw notFound('Bank credit');
      assertCan(auth, credit.outlet_id, 'payment.reconcile');
      return fn(tx, credit);
    });
  }

  return async (app) => {
    /** The statement file comes as base64 in JSON: {outlet_id, file_name, data}. CSV or .xlsx. */
    app.post('/reconciliation/statements', { bodyLimit: Math.ceil(MAX_FILE * 1.4) }, async (req, reply) => {
      const auth = requireStaff(req);
      const body = parse(z.object({ outlet_id: z.uuid(), file_name: z.string().trim().min(1).max(120), data: z.base64() }), req.body);
      assertCan(auth, body.outlet_id, 'payment.reconcile');
      const buffer = Buffer.from(body.data, 'base64');
      if (buffer.length > MAX_FILE) throw badRequest('file_too_large', 'Statement files can be up to 5 MB');
      const parsed = parseStatement(await readGrid(body.file_name, buffer));
      const detail = await ctx.tx(auth.tenantId, async (tx) => {
        const outlet = await tx.db.selectFrom('outlets').select('id').where('id', '=', body.outlet_id).executeTakeFirst();
        if (!outlet) throw notFound('Outlet');
        const { id } = await importStatement(tx, body.outlet_id, auth.userId, body.file_name, parsed);
        const d = await statementDetail(tx, id);
        await audit(tx, auth, {
          outletId: body.outlet_id,
          action: 'reconciliation.import',
          entity: 'bank_statement',
          entityId: id,
          after: { file: body.file_name, from: parsed.period_from, to: parsed.period_to, ...d.statement.summary },
        });
        return d;
      });
      return reply.status(201).send(detail);
    });

    app.get('/reconciliation/statements', async (req) => {
      const auth = requireStaff(req);
      const q = parse(z.object({ outlet_id: z.uuid() }), req.query);
      assertCan(auth, q.outlet_id, 'payment.reconcile');
      return ctx.tx(auth.tenantId, (tx) => listStatements(tx, q.outlet_id));
    });

    app.get('/reconciliation/statements/:id', async (req) => {
      const auth = requireStaff(req);
      const { id } = parse(idParams, req.params);
      return ctx.tx(auth.tenantId, async (tx) => {
        const s = await tx.db.selectFrom('bank_statements').select('outlet_id').where('id', '=', id).executeTakeFirst();
        if (!s) throw notFound('Statement');
        assertCan(auth, s.outlet_id, 'payment.reconcile');
        return statementDetail(tx, id);
      });
    });

    /** Removes a wrong upload. Its credits go too; matches made from them are undone. */
    app.delete('/reconciliation/statements/:id', async (req, reply) => {
      const auth = requireStaff(req);
      const { id } = parse(idParams, req.params);
      await ctx.tx(auth.tenantId, async (tx) => {
        const s = await tx.db.selectFrom('bank_statements').select(['outlet_id', 'file_name']).where('id', '=', id).executeTakeFirst();
        if (!s) throw notFound('Statement');
        assertCan(auth, s.outlet_id, 'payment.reconcile');
        await tx.db.deleteFrom('bank_statements').where('id', '=', id).execute();
        await audit(tx, auth, { outletId: s.outlet_id, action: 'reconciliation.delete', entity: 'bank_statement', entityId: id, before: { file: s.file_name } });
      });
      return reply.status(204).send();
    });

    /** Staff tie a credit to a UPI payment by hand (e.g. the guest paid a different total). */
    app.post('/reconciliation/credits/:id/match', async (req) => {
      const auth = requireStaff(req);
      const { id } = parse(idParams, req.params);
      const body = parse(z.object({ payment_id: z.uuid() }), req.body);
      return onCredit(auth, id, async (tx, credit) => {
        if (credit.payment_id) throw conflict('already_matched', 'This credit is already matched');
        const payment = await tx.db
          .selectFrom('payments')
          .select(['id', 'amount_paise', 'method', 'kind', 'outlet_id'])
          .where('id', '=', body.payment_id)
          .executeTakeFirst();
        if (!payment || payment.outlet_id !== credit.outlet_id || payment.method !== 'upi' || payment.kind !== 'payment') throw badRequest('invalid_payment', 'Pick a UPI payment from this outlet');
        if (payment.amount_paise !== credit.amount_paise) throw badRequest('amount_mismatch', 'The amounts are different');
        const other = await tx.db.selectFrom('bank_credits').select('id').where('payment_id', '=', payment.id).executeTakeFirst();
        if (other) throw conflict('payment_matched', 'That payment is already matched to another credit');
        await tx.db
          .updateTable('bank_credits')
          .set({ payment_id: payment.id, match_kind: 'manual', matched_by: auth.userId, matched_at: new Date(), dismissed_reason: null, dismissed_by: null })
          .where('id', '=', id)
          .execute();
        await audit(tx, auth, { outletId: credit.outlet_id, action: 'reconciliation.match', entity: 'bank_credit', entityId: id, after: { payment_id: payment.id } });
        return statementDetail(tx, credit.statement_id);
      });
    });

    app.delete('/reconciliation/credits/:id/match', async (req) => {
      const auth = requireStaff(req);
      const { id } = parse(idParams, req.params);
      return onCredit(auth, id, async (tx, credit) => {
        if (!credit.payment_id) throw conflict('not_matched', 'This credit is not matched');
        await tx.db.updateTable('bank_credits').set({ payment_id: null, match_kind: null, matched_by: null, matched_at: null }).where('id', '=', id).execute();
        await audit(tx, auth, { outletId: credit.outlet_id, action: 'reconciliation.unmatch', entity: 'bank_credit', entityId: id, before: { payment_id: credit.payment_id } });
        return statementDetail(tx, credit.statement_id);
      });
    });

    /** Money that is not a sale (owner's transfer, supplier refund) stops being flagged. */
    app.post('/reconciliation/credits/:id/dismiss', async (req) => {
      const auth = requireStaff(req);
      const { id } = parse(idParams, req.params);
      const body = parse(z.object({ reason: z.string().trim().min(3).max(200) }), req.body);
      return onCredit(auth, id, async (tx, credit) => {
        if (credit.payment_id) throw conflict('already_matched', 'Unmatch it first');
        await tx.db.updateTable('bank_credits').set({ dismissed_reason: body.reason, dismissed_by: auth.userId }).where('id', '=', id).execute();
        await audit(tx, auth, { outletId: credit.outlet_id, action: 'reconciliation.dismiss', entity: 'bank_credit', entityId: id, reason: body.reason });
        return statementDetail(tx, credit.statement_id);
      });
    });

    app.delete('/reconciliation/credits/:id/dismiss', async (req) => {
      const auth = requireStaff(req);
      const { id } = parse(idParams, req.params);
      return onCredit(auth, id, async (tx, credit) => {
        await tx.db.updateTable('bank_credits').set({ dismissed_reason: null, dismissed_by: null }).where('id', '=', id).execute();
        return statementDetail(tx, credit.statement_id);
      });
    });
  };
}

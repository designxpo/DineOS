import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { AppContext, Tx } from '../../context';
import { audit } from '../../lib/audit';
import { assertCan, requireStaff, type StaffAuth } from '../../lib/auth';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { idParams, parse } from '../../lib/validate';
import { readGrid } from '../menu/import';
import { businessDate } from '@mezmitra/shared/dates';
import { importStatement, listStatements, statementDetail, upiCheck } from './service';
import { deleteSalesImport, importSales, listSalesImports, salesImport } from './sales';
import { parseSalesExport, SALES_ROLES } from './sales-export';
import { parseStatement } from './statement';
import { payoutViews } from './payouts';

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

    /** The dashboard's UPI reminder: by default the week up to yesterday (today's credits lag). */
    app.get('/reconciliation/upi-check', async (req) => {
      const auth = requireStaff(req);
      const q = parse(z.object({ outlet_id: z.uuid(), to: z.iso.date().optional(), days: z.coerce.number().int().min(1).max(31).default(7) }), req.query);
      assertCan(auth, q.outlet_id, 'payment.reconcile');
      return ctx.tx(auth.tenantId, async (tx) => {
        const outlet = await tx.db.selectFrom('outlets').select('timezone').where('id', '=', q.outlet_id).executeTakeFirstOrThrow();
        const yesterday = businessDate(new Date(Date.now() - 86_400_000), outlet.timezone);
        return upiCheck(tx, q.outlet_id, q.to ?? yesterday, q.days);
      });
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

    /**
     * A sales export from the billing system the outlet uses instead of Mezvaan, as base64 in
     * JSON: {outlet_id, file_name, data}, CSV or .xlsx. When its columns cannot be told from their
     * names the answer says so with the headers found, and `columns` names them on the next try.
     */
    app.post('/reconciliation/sales', { bodyLimit: Math.ceil(MAX_FILE * 1.4) }, async (req, reply) => {
      const auth = requireStaff(req);
      const body = parse(
        z.object({
          outlet_id: z.uuid(),
          file_name: z.string().trim().min(1).max(120),
          data: z.base64(),
          columns: z.partialRecord(z.enum(SALES_ROLES), z.string().trim().max(120)).optional(),
        }),
        req.body,
      );
      assertCan(auth, body.outlet_id, 'payment.reconcile');
      const buffer = Buffer.from(body.data, 'base64');
      if (buffer.length > MAX_FILE) throw badRequest('file_too_large', 'Sales files can be up to 5 MB');
      const parsed = parseSalesExport(await readGrid(body.file_name, buffer), body.columns);
      const result = await ctx.tx(auth.tenantId, async (tx) => {
        const outlet = await tx.db.selectFrom('outlets').select(['id', 'timezone', 'billing_elsewhere']).where('id', '=', body.outlet_id).executeTakeFirst();
        if (!outlet) throw notFound('Outlet');
        const id = await importSales(tx, outlet, auth.userId, body.file_name, parsed);
        const imported = await salesImport(tx, id);
        await audit(tx, auth, {
          outletId: body.outlet_id,
          action: 'reconciliation.sales_import',
          entity: 'sales_import',
          entityId: id,
          after: { file: body.file_name, from: parsed.period_from, to: parsed.period_to, bills: imported.bills, duplicates: imported.duplicates, skipped: imported.skipped },
        });
        return { import: imported, columns: parsed.columns, unsplit: parsed.unsplit };
      });
      return reply.status(201).send(result);
    });

    app.get('/reconciliation/sales', async (req) => {
      const auth = requireStaff(req);
      const q = parse(z.object({ outlet_id: z.uuid() }), req.query);
      assertCan(auth, q.outlet_id, 'payment.reconcile');
      return ctx.tx(auth.tenantId, (tx) => listSalesImports(tx, q.outlet_id));
    });

    /** Removes a wrong sales upload. Its bills go too; bank matches made to them are undone. */
    app.delete('/reconciliation/sales/:id', async (req, reply) => {
      const auth = requireStaff(req);
      const { id } = parse(idParams, req.params);
      await ctx.tx(auth.tenantId, async (tx) => {
        const s = await tx.db.selectFrom('sales_imports').select(['outlet_id', 'file_name']).where('id', '=', id).executeTakeFirst();
        if (!s) throw notFound('Sales upload');
        assertCan(auth, s.outlet_id, 'payment.reconcile');
        await deleteSalesImport(tx, id);
        await audit(tx, auth, { outletId: s.outlet_id, action: 'reconciliation.sales_delete', entity: 'sales_import', entityId: id, before: { file: s.file_name } });
      });
      return reply.status(204).send();
    });

    // ---------------------------------------------------------------- delivery payouts

    const outletOf = async (tx: Tx, outletId: string) => {
      const outlet = await tx.db.selectFrom('outlets').select(['id', 'timezone']).where('id', '=', outletId).executeTakeFirst();
      if (!outlet) throw notFound('Outlet');
      return outlet;
    };
    const DISMISS_PREFIX = 'Delivery payout';
    const paise = z.number().int().min(-100_000_000).max(100_000_000);

    /** Payouts recorded for the outlet, each set beside what was billed and what the bank received. */
    app.get('/reconciliation/payouts', async (req) => {
      const auth = requireStaff(req);
      const q = parse(z.object({ outlet_id: z.uuid() }), req.query);
      assertCan(auth, q.outlet_id, 'payment.reconcile');
      return ctx.tx(auth.tenantId, async (tx) => payoutViews(tx, await outletOf(tx, q.outlet_id)));
    });

    /** Records one payout cycle from the app's statement: gross, each deduction, and the net. */
    app.post('/reconciliation/payouts', async (req, reply) => {
      const auth = requireStaff(req);
      const body = parse(
        z.object({
          outlet_id: z.uuid(),
          channel: z.enum(['zomato', 'swiggy']),
          period_from: z.iso.date(),
          period_to: z.iso.date(),
          reference: z.string().trim().max(80).nullable().optional(),
          orders_claimed: z.number().int().min(0).max(1_000_000),
          gross_paise: z.number().int().min(0).max(1_000_000_000),
          net_paise: paise,
          lines: z.array(z.object({ kind: z.enum(['commission', 'ads', 'discount_funded', 'refund', 'tax', 'penalty', 'other']), amount_paise: paise, note: z.string().trim().max(200).nullable().optional() })).max(40),
          bank_credit_id: z.uuid().nullable().optional(),
        }),
        req.body,
      );
      assertCan(auth, body.outlet_id, 'payment.reconcile');
      if (body.period_to < body.period_from) throw badRequest('bad_period', 'The period ends before it starts');
      const view = await ctx.tx(auth.tenantId, async (tx) => {
        const outlet = await outletOf(tx, body.outlet_id);
        const dup = await tx.db
          .selectFrom('channel_payouts')
          .select('id')
          .where('outlet_id', '=', outlet.id)
          .where('channel', '=', body.channel)
          .where('period_from', '=', body.period_from)
          .where('period_to', '=', body.period_to)
          .executeTakeFirst();
        if (dup) throw conflict('payout_exists', 'That cycle is already recorded for this app');
        if (body.bank_credit_id) await assertLinkable(tx, outlet.id, body.bank_credit_id);
        const row = await tx.db
          .insertInto('channel_payouts')
          .values({
            tenant_id: tx.tenantId,
            outlet_id: outlet.id,
            channel: body.channel,
            period_from: body.period_from,
            period_to: body.period_to,
            reference: body.reference || null,
            orders_claimed: body.orders_claimed,
            gross_paise: body.gross_paise,
            net_paise: body.net_paise,
            bank_credit_id: body.bank_credit_id ?? null,
            created_by: auth.userId,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        if (body.lines.length) {
          await tx.db.insertInto('channel_payout_lines').values(body.lines.map((l) => ({ tenant_id: tx.tenantId, payout_id: row.id, kind: l.kind, amount_paise: l.amount_paise, note: l.note || null }))).execute();
        }
        if (body.bank_credit_id) await explainCredit(tx, auth, body.bank_credit_id, `${DISMISS_PREFIX}: ${body.channel} ${body.period_from} to ${body.period_to}`);
        await audit(tx, auth, { outletId: outlet.id, action: 'payout.record', entity: 'channel_payout', entityId: row.id, after: { channel: body.channel, from: body.period_from, to: body.period_to, gross_paise: body.gross_paise, net_paise: body.net_paise } });
        return (await payoutViews(tx, outlet, row.id))[0]!;
      });
      return reply.status(201).send(view);
    });

    /** Opens, updates or closes the dispute with the app over a shortfall. */
    app.patch('/reconciliation/payouts/:id/dispute', async (req) => {
      const auth = requireStaff(req);
      const { id } = parse(idParams, req.params);
      const body = parse(z.object({ status: z.enum(['open', 'recovered', 'written_off']).nullable(), note: z.string().trim().max(1000).nullable().optional(), recovered_paise: z.number().int().min(0).max(1_000_000_000).optional() }), req.body);
      return ctx.tx(auth.tenantId, async (tx) => {
        const p = await tx.db.selectFrom('channel_payouts').select(['id', 'outlet_id']).where('id', '=', id).forUpdate().executeTakeFirst();
        if (!p) throw notFound('Payout');
        assertCan(auth, p.outlet_id, 'payment.reconcile');
        await tx.db
          .updateTable('channel_payouts')
          .set({ dispute_status: body.status, dispute_note: body.status ? (body.note ?? null) : null, recovered_paise: body.status === 'recovered' ? (body.recovered_paise ?? 0) : 0 })
          .where('id', '=', id)
          .execute();
        await audit(tx, auth, { outletId: p.outlet_id, action: 'payout.dispute', entity: 'channel_payout', entityId: id, after: { status: body.status, recovered_paise: body.recovered_paise ?? 0 }, reason: body.note ?? undefined });
        return (await payoutViews(tx, await outletOf(tx, p.outlet_id), id))[0]!;
      });
    });

    app.delete('/reconciliation/payouts/:id', async (req, reply) => {
      const auth = requireStaff(req);
      const { id } = parse(idParams, req.params);
      await ctx.tx(auth.tenantId, async (tx) => {
        const p = await tx.db.selectFrom('channel_payouts').select(['id', 'outlet_id', 'channel', 'period_from', 'period_to', 'bank_credit_id']).where('id', '=', id).forUpdate().executeTakeFirst();
        if (!p) throw notFound('Payout');
        assertCan(auth, p.outlet_id, 'payment.reconcile');
        await tx.db.deleteFrom('channel_payouts').where('id', '=', id).execute();
        if (p.bank_credit_id) await tx.db.updateTable('bank_credits').set({ dismissed_reason: null, dismissed_by: null }).where('id', '=', p.bank_credit_id).where('dismissed_reason', 'like', `${DISMISS_PREFIX}%`).execute();
        await audit(tx, auth, { outletId: p.outlet_id, action: 'payout.delete', entity: 'channel_payout', entityId: id, before: { channel: p.channel, from: p.period_from, to: p.period_to } });
      });
      return reply.status(204).send();
    });

    /** A credit can be a payout's if it is this outlet's, not a UPI sale, and not another payout's. */
    async function assertLinkable(tx: Tx, outletId: string, creditId: string) {
      const credit = await tx.db.selectFrom('bank_credits').select(['id', 'outlet_id', 'payment_id']).where('id', '=', creditId).executeTakeFirst();
      if (!credit || credit.outlet_id !== outletId) throw badRequest('invalid_credit', 'Pick a credit from this outlet’s bank statement');
      if (credit.payment_id) throw badRequest('invalid_credit', 'That credit is already matched to a UPI payment');
      const taken = await tx.db.selectFrom('channel_payouts').select('id').where('bank_credit_id', '=', creditId).executeTakeFirst();
      if (taken) throw conflict('credit_taken', 'That credit already belongs to another payout');
    }
    /** The payout explains the credit, so it stops being flagged as money with no bill. */
    async function explainCredit(tx: Tx, auth: StaffAuth, creditId: string, reason: string) {
      await tx.db.updateTable('bank_credits').set({ dismissed_reason: reason, dismissed_by: auth.userId }).where('id', '=', creditId).where('dismissed_reason', 'is', null).execute();
    }

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

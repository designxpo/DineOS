import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { SUPPORT_SEVERITIES, type SupportSeverity, type SupportStatus } from '@mezmitra/shared/support';
import type { AppContext } from '../../context';
import { json } from '../../db';
import { assertOutletAccess, requireAdmin, requireStaff } from '../../lib/auth';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { idParams, parse } from '../../lib/validate';
import { addMessage, announce, assertOpen, listCases, loadCase, lockCase, messages, statusWords, supportQueue } from './service';

const outletBody = z.object({ outlet_id: z.uuid() });
const SEVERITY_WORDS: Record<SupportSeverity, string> = { stopped: 'Service stopped', degraded: 'Service degraded', question: 'Question or change' };

export default function routes(ctx: AppContext): FastifyPluginAsync {
  return async (app) => {
    // ---------------------------------------------------------------- outlet staff

    app.get('/support/cases', async (req) => {
      const auth = requireStaff(req);
      const q = parse(outletBody, req.query);
      assertOutletAccess(auth, q.outlet_id);
      return ctx.tx(auth.tenantId, (tx) => listCases(tx, q.outlet_id));
    });

    /** Anyone on the team can ask for help; the technical report is attached only with their say-so. */
    app.post('/support/cases', async (req, reply) => {
      const auth = requireStaff(req);
      const body = parse(
        outletBody.extend({
          severity: z.enum(SUPPORT_SEVERITIES),
          summary: z.string().trim().min(3).max(140),
          details: z.string().trim().max(4000).nullable().optional(),
          diagnostics: z.record(z.string(), z.unknown()).nullable().optional(),
        }),
        req.body,
      );
      assertOutletAccess(auth, body.outlet_id);
      if (body.diagnostics && JSON.stringify(body.diagnostics).length > 20_000) throw badRequest('report_too_large', 'The technical report is too large');
      const c = await ctx.tx(auth.tenantId, async (tx) => {
        const row = await tx.db
          .insertInto('support_cases')
          .values({ tenant_id: tx.tenantId, outlet_id: body.outlet_id, severity: body.severity, summary: body.summary, diagnostics: body.diagnostics ? json(body.diagnostics) : null, raised_by: auth.userId })
          .returning('id')
          .executeTakeFirstOrThrow();
        await addMessage(tx, row.id, 'system', `Case opened: ${SEVERITY_WORDS[body.severity]}.`);
        if (body.details) await addMessage(tx, row.id, 'outlet', body.details, { userId: auth.userId });
        await announce(tx, row.id);
        return loadCase(tx, row.id);
      });
      return reply.status(201).send(c);
    });

    app.get('/support/cases/:id', async (req) => {
      const auth = requireStaff(req);
      const { id } = parse(idParams, req.params);
      const q = parse(outletBody, req.query);
      assertOutletAccess(auth, q.outlet_id);
      return ctx.tx(auth.tenantId, (tx) => loadCase(tx, id, q.outlet_id));
    });

    /** The outlet answers or adds something; a case waiting on them goes back to support. */
    app.post('/support/cases/:id/messages', async (req) => {
      const auth = requireStaff(req);
      const { id } = parse(idParams, req.params);
      const body = parse(outletBody.extend({ body: z.string().trim().min(1).max(4000) }), req.body);
      assertOutletAccess(auth, body.outlet_id);
      return ctx.tx(auth.tenantId, async (tx) => {
        const c = await lockCase(tx, id);
        if (c.outlet_id !== body.outlet_id) throw notFound('Case');
        assertOpen(c.status);
        await addMessage(tx, id, 'outlet', body.body, { userId: auth.userId });
        if (c.status === 'waiting_on_outlet') await tx.db.updateTable('support_cases').set({ status: 'open' }).where('id', '=', id).execute();
        await announce(tx, id);
        return loadCase(tx, id);
      });
    });

    /** Service is running again, even if the cause is not fixed yet. */
    app.post('/support/cases/:id/resumed', async (req) => {
      const auth = requireStaff(req);
      const { id } = parse(idParams, req.params);
      const body = parse(outletBody, req.body);
      assertOutletAccess(auth, body.outlet_id);
      return ctx.tx(auth.tenantId, async (tx) => {
        const c = await lockCase(tx, id);
        if (c.outlet_id !== body.outlet_id) throw notFound('Case');
        if (c.resumed_at) throw conflict('already_resumed', 'Already marked as running again');
        await tx.db.updateTable('support_cases').set({ resumed_at: new Date() }).where('id', '=', id).execute();
        await addMessage(tx, id, 'system', 'The outlet says service is running again.');
        await announce(tx, id);
        return loadCase(tx, id);
      });
    });

    /** It works: only the outlet closes a case. */
    app.post('/support/cases/:id/close', async (req) => {
      const auth = requireStaff(req);
      const { id } = parse(idParams, req.params);
      const body = parse(outletBody, req.body);
      assertOutletAccess(auth, body.outlet_id);
      return ctx.tx(auth.tenantId, async (tx) => {
        const c = await lockCase(tx, id);
        if (c.outlet_id !== body.outlet_id) throw notFound('Case');
        assertOpen(c.status);
        const now = new Date();
        await tx.db
          .updateTable('support_cases')
          .set({ status: 'closed', closed_at: now, ...(c.resumed_at ? {} : { resumed_at: now }), ...(c.resolved_at ? {} : { resolved_at: now }) })
          .where('id', '=', id)
          .execute();
        await addMessage(tx, id, 'system', 'The outlet confirmed it works. Case closed.');
        await announce(tx, id);
        return loadCase(tx, id);
      });
    });

    /** The problem is back, or the fix did not hold. */
    app.post('/support/cases/:id/reopen', async (req) => {
      const auth = requireStaff(req);
      const { id } = parse(idParams, req.params);
      const body = parse(outletBody.extend({ body: z.string().trim().max(4000).nullable().optional() }), req.body);
      assertOutletAccess(auth, body.outlet_id);
      return ctx.tx(auth.tenantId, async (tx) => {
        const c = await lockCase(tx, id);
        if (c.outlet_id !== body.outlet_id) throw notFound('Case');
        if (c.status !== 'resolved' && c.status !== 'closed') throw conflict('not_resolved', 'This case is still being worked on');
        await tx.db.updateTable('support_cases').set({ status: 'open', resolved_at: null, closed_at: null, reopened: c.reopened + 1 }).where('id', '=', id).execute();
        if (body.body) await addMessage(tx, id, 'outlet', body.body, { userId: auth.userId });
        await addMessage(tx, id, 'system', 'The outlet says it is still not working. Case reopened.');
        await announce(tx, id);
        return loadCase(tx, id);
      });
    });

    // ---------------------------------------------------------------- Mezmitra support

    app.get('/admin/support/cases', async (req) => {
      requireAdmin(req);
      const q = parse(z.object({ include: z.enum(['open', 'all']).default('open') }), req.query);
      return supportQueue(ctx.adminDb, q.include);
    });

    app.get('/admin/support/cases/:id', async (req) => {
      requireAdmin(req);
      const { id } = parse(idParams, req.params);
      const [c] = (await supportQueue(ctx.adminDb, 'all')).filter((x) => x.id === id);
      if (!c) throw notFound('Case');
      return { ...c, messages: await messages(ctx.adminDb, id) };
    });

    /** Picks a case up: the outlet sees who owns it. */
    app.post('/admin/support/cases/:id/assign', async (req) => {
      const auth = requireAdmin(req);
      const { id } = parse(idParams, req.params);
      const tenant = await ctx.adminDb.selectFrom('support_cases').select('tenant_id').where('id', '=', id).executeTakeFirst();
      if (!tenant) throw notFound('Case');
      const admin = await ctx.adminDb.selectFrom('platform_admins').select('name').where('id', '=', auth.adminId).executeTakeFirstOrThrow();
      await ctx.tx(tenant.tenant_id, async (tx) => {
        const c = await lockCase(tx, id);
        assertOpen(c.status);
        await tx.db
          .updateTable('support_cases')
          .set({ assignee_admin_id: auth.adminId, ...(c.status === 'open' ? { status: 'in_progress' } : {}), ...(c.first_response_at ? {} : { first_response_at: new Date() }) })
          .where('id', '=', id)
          .execute();
        await addMessage(tx, id, 'system', `${admin.name} from Mezmitra support is handling this.`);
        await announce(tx, id, { notify: false });
      });
      return { ok: true };
    });

    /** Replies, and moves the case on: still working, waiting for the outlet, or fixed (the outlet confirms). */
    app.post('/admin/support/cases/:id/reply', async (req) => {
      const auth = requireAdmin(req);
      const { id } = parse(idParams, req.params);
      const body = parse(z.object({ body: z.string().trim().min(1).max(4000), status: z.enum(['in_progress', 'waiting_on_outlet', 'resolved']).optional() }), req.body);
      const tenant = await ctx.adminDb.selectFrom('support_cases').select('tenant_id').where('id', '=', id).executeTakeFirst();
      if (!tenant) throw notFound('Case');
      await ctx.tx(tenant.tenant_id, async (tx) => {
        const c = await lockCase(tx, id);
        assertOpen(c.status);
        const status: SupportStatus = body.status ?? (c.status === 'open' ? 'in_progress' : (c.status as SupportStatus));
        await tx.db
          .updateTable('support_cases')
          .set({
            status,
            ...(c.assignee_admin_id ? {} : { assignee_admin_id: auth.adminId }),
            ...(c.first_response_at ? {} : { first_response_at: new Date() }),
            ...(status === 'resolved' ? { resolved_at: new Date() } : {}),
          })
          .where('id', '=', id)
          .execute();
        await addMessage(tx, id, 'support', body.body, { adminId: auth.adminId });
        if (status !== c.status) await addMessage(tx, id, 'system', statusWords(status));
        await announce(tx, id, { notify: true });
      });
      return { ok: true };
    });

    /** Support records that the outlet is serving again (e.g. after a phone call). */
    app.post('/admin/support/cases/:id/resumed', async (req) => {
      requireAdmin(req);
      const { id } = parse(idParams, req.params);
      const tenant = await ctx.adminDb.selectFrom('support_cases').select('tenant_id').where('id', '=', id).executeTakeFirst();
      if (!tenant) throw notFound('Case');
      await ctx.tx(tenant.tenant_id, async (tx) => {
        const c = await lockCase(tx, id);
        if (c.resumed_at) throw conflict('already_resumed', 'Already marked as running again');
        await tx.db.updateTable('support_cases').set({ resumed_at: new Date() }).where('id', '=', id).execute();
        await addMessage(tx, id, 'system', 'Support recorded that service is running again.');
        await announce(tx, id);
      });
      return { ok: true };
    });
  };
}

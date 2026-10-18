// The go-live rehearsal and its acceptance sheet. Managers run and mark the scenarios; only the
// owner signs. Once signed, the sheet is kept as it was and full payment can start.

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { GOLIVE_RESULTS, GOLIVE_SCENARIOS } from '@mezmitra/shared/golive';
import type { GoliveRehearsalDTO } from '@mezmitra/shared/dto';
import type { AppContext, Tx } from '../../context';
import { json } from '../../db';
import { audit } from '../../lib/audit';
import { assertCan, requireStaff, type StaffAuth } from '../../lib/auth';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors';
import { idParams, parse } from '../../lib/validate';
import { rehearsalView } from './service';

const isOwner = (auth: StaffAuth) => auth.roles.some((r) => r.outletId === null && r.role === 'owner');

export default function routes(ctx: AppContext): FastifyPluginAsync {
  /** Loads an unsigned rehearsal for change, after checking the caller may run it. */
  async function openRehearsal(tx: Tx, auth: StaffAuth, id: string) {
    const r = await tx.db.selectFrom('golive_rehearsals').select(['id', 'outlet_id', 'signed_at']).where('id', '=', id).forUpdate().executeTakeFirst();
    if (!r) throw notFound('Rehearsal');
    assertCan(auth, r.outlet_id, 'outlet.settings');
    if (r.signed_at) throw conflict('already_signed', 'This acceptance sheet is signed. Start a new rehearsal to run it again.');
    return r;
  }

  return async (app) => {
    /** The rehearsal in progress at the outlet, or the last one signed; null before the first. */
    app.get('/golive', async (req): Promise<GoliveRehearsalDTO | null> => {
      const auth = requireStaff(req);
      const q = parse(z.object({ outlet_id: z.uuid() }), req.query);
      assertCan(auth, q.outlet_id, 'outlet.settings');
      return ctx.tx(auth.tenantId, async (tx) => {
        const r = await tx.db
          .selectFrom('golive_rehearsals')
          .select('id')
          .where('outlet_id', '=', q.outlet_id)
          .orderBy(({ eb }) => eb.case().when('signed_at', 'is', null).then(0).else(1).end())
          .orderBy('started_at', 'desc')
          .executeTakeFirst();
        return r ? rehearsalView(tx, r.id) : null;
      });
    });

    app.get('/golive/:id', async (req) => {
      const auth = requireStaff(req);
      const { id } = parse(idParams, req.params);
      return ctx.tx(auth.tenantId, async (tx) => {
        const view = await rehearsalView(tx, id);
        assertCan(auth, view.outlet_id, 'outlet.settings');
        return view;
      });
    });

    /** Starts a rehearsal: what Mezmitra counts as evidence happens from now on. */
    app.post('/golive', async (req, reply) => {
      const auth = requireStaff(req);
      const body = parse(z.object({ outlet_id: z.uuid() }), req.body);
      assertCan(auth, body.outlet_id, 'outlet.settings');
      const view = await ctx.tx(auth.tenantId, async (tx) => {
        const open = await tx.db.selectFrom('golive_rehearsals').select('id').where('outlet_id', '=', body.outlet_id).where('signed_at', 'is', null).executeTakeFirst();
        if (open) throw conflict('rehearsal_open', 'A rehearsal is already in progress here');
        const r = await tx.db
          .insertInto('golive_rehearsals')
          .values({ tenant_id: tx.tenantId, outlet_id: body.outlet_id, started_by: auth.userId })
          .returning('id')
          .executeTakeFirstOrThrow();
        await audit(tx, auth, { outletId: body.outlet_id, action: 'golive.start', entity: 'golive_rehearsal', entityId: r.id });
        return rehearsalView(tx, r.id);
      });
      return reply.status(201).send(view);
    });

    /** Marks one scenario. Failing it or leaving it out needs a note saying why. */
    app.put('/golive/:id/checks/:scenario', async (req) => {
      const auth = requireStaff(req);
      const p = parse(z.object({ id: z.uuid(), scenario: z.enum(GOLIVE_SCENARIOS) }), req.params);
      const body = parse(z.object({ result: z.enum(GOLIVE_RESULTS), note: z.string().trim().max(500).nullable().optional() }), req.body);
      const note = body.note || null;
      if (body.result !== 'passed' && !note) {
        throw badRequest('note_needed', body.result === 'failed' ? 'Say what went wrong' : 'Say why this is not part of this go-live');
      }
      return ctx.tx(auth.tenantId, async (tx) => {
        const r = await openRehearsal(tx, auth, p.id);
        const failed = body.result === 'failed' ? 1 : 0;
        await tx.db
          .insertInto('golive_checks')
          .values({ tenant_id: tx.tenantId, rehearsal_id: r.id, scenario: p.scenario, result: body.result, note, failures: failed, checked_by: auth.userId, checked_at: new Date() })
          .onConflict((oc) =>
            oc.columns(['rehearsal_id', 'scenario']).doUpdateSet((eb) => ({
              result: body.result,
              note,
              failures: eb('golive_checks.failures', '+', failed),
              checked_by: auth.userId,
              checked_at: new Date(),
            })),
          )
          .execute();
        await audit(tx, auth, { outletId: r.outlet_id, action: 'golive.check', entity: 'golive_rehearsal', entityId: r.id, after: { scenario: p.scenario, result: body.result, note } });
        return rehearsalView(tx, r.id);
      });
    });

    /**
     * The owner signs the acceptance sheet: every scenario passed or agreed out of scope. The sheet
     * is frozen as signed, with the screens and print computers used.
     */
    app.post('/golive/:id/sign', async (req) => {
      const auth = requireStaff(req);
      const { id } = parse(idParams, req.params);
      const body = parse(
        z.object({
          signer_name: z.string().trim().min(2).max(80),
          confirm: z.literal(true, { error: 'Tick the box to confirm the scenarios passed on your own devices' }),
        }),
        req.body,
      );
      if (!isOwner(auth)) throw forbidden('Only the owner signs the acceptance sheet');
      return ctx.tx(auth.tenantId, async (tx) => {
        const r = await openRehearsal(tx, auth, id);
        const view = await rehearsalView(tx, r.id);
        const failed = view.checks.filter((c) => c.result === 'failed');
        const unmarked = view.checks.filter((c) => !c.result);
        if (failed.length || unmarked.length) {
          throw conflict(
            'not_ready',
            failed.length ? 'Run the failed scenarios again until they pass, or agree to leave them out' : 'Mark every scenario first',
            { failed: failed.map((c) => c.scenario), unmarked: unmarked.map((c) => c.scenario) },
          );
        }
        const signedAt = new Date();
        await tx.db
          .updateTable('golive_rehearsals')
          .set({ signed_at: signedAt, signed_by: auth.userId, signer_name: body.signer_name, sheet: json({ checks: view.checks, devices: view.devices }) })
          .where('id', '=', r.id)
          .execute();
        await audit(tx, auth, {
          outletId: r.outlet_id,
          action: 'golive.sign',
          entity: 'golive_rehearsal',
          entityId: r.id,
          after: { signer_name: body.signer_name, passed: view.checks.filter((c) => c.result === 'passed').map((c) => c.scenario), out_of_scope: view.checks.filter((c) => c.result === 'out_of_scope').map((c) => c.scenario) },
        });
        return rehearsalView(tx, r.id);
      });
    });
  };
}

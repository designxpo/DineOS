import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { TOPUP_METHODS } from '@dineos/shared/enums';
import type { AppContext, Tx } from '../../context';
import { approvalHeader } from '../../lib/approvals';
import { assertCan, requireStaff } from '../../lib/auth';
import { AppError, badRequest, notFound, tooMany } from '../../lib/errors';
import { idParams, parse } from '../../lib/validate';
import { customerLoyalty } from './engine';
import { listPlans, planBody, savePlan, sellMembership } from './memberships';
import { currentProgram, programBody, programDto, saveProgram } from './program';
import { applyReward, billLoyalty, removeReward } from './rewards';
import { cashOut, listPacks, packBody, savePack, sendWalletCode, topUp, topupBody, verifyWalletCode, walletDetail } from './wallet';

const outletQuery = z.object({ outlet_id: z.uuid() });

async function liveCustomer(tx: Tx, id: string): Promise<void> {
  const c = await tx.db.selectFrom('customers').select('id').where('id', '=', id).where('erased_at', 'is', null).executeTakeFirst();
  if (!c) throw notFound('Customer');
}

export default function routes(ctx: AppContext): FastifyPluginAsync {
  return async (app) => {
    /** The programme for all of the tenant's outlets, or null before the owner sets one up. */
    app.get('/loyalty/program', async (req) => {
      const auth = requireStaff(req);
      const q = parse(outletQuery, req.query);
      assertCan(auth, q.outlet_id, 'outlet.settings');
      return ctx.tx(auth.tenantId, async (tx) => {
        const p = await currentProgram(tx);
        return { program: p ? await programDto(tx, p) : null };
      });
    });

    /** Saves it as a draft, puts it live, or pauses it. */
    app.put('/loyalty/program', async (req) => {
      const auth = requireStaff(req);
      const body = parse(programBody.extend(outletQuery.shape), req.body);
      assertCan(auth, body.outlet_id, 'outlet.settings');
      return ctx.tx(auth.tenantId, (tx) => saveProgram(tx, auth, body.outlet_id, body));
    });

    /** Menu categories at every outlet, for choosing what earns stamps and what can be free. */
    app.get('/loyalty/categories', async (req) => {
      const auth = requireStaff(req);
      const q = parse(outletQuery, req.query);
      assertCan(auth, q.outlet_id, 'outlet.settings');
      return ctx.tx(auth.tenantId, (tx) =>
        tx.db
          .selectFrom('menu_categories')
          .innerJoin('outlets', 'outlets.id', 'menu_categories.outlet_id')
          .select(['menu_categories.id', 'menu_categories.name', 'outlets.name as outlet_name', 'menu_categories.outlet_id'])
          .where('menu_categories.deleted_at', 'is', null)
          .orderBy('outlets.name')
          .orderBy('menu_categories.sort')
          .execute(),
      );
    });

    app.get('/customers/:id/loyalty', async (req) => {
      const auth = requireStaff(req);
      const { id } = parse(idParams, req.params);
      const q = parse(outletQuery, req.query);
      assertCan(auth, q.outlet_id, 'customer.view');
      return ctx.tx(auth.tenantId, async (tx) => {
        await liveCustomer(tx, id);
        return customerLoyalty(tx, id, q.outlet_id);
      });
    });

    /** The guest on the bill: standing, rewards, and the lines each free-dish reward fits. */
    app.get('/bills/:id/loyalty', async (req) => {
      const auth = requireStaff(req);
      const { id } = parse(idParams, req.params);
      return ctx.tx(auth.tenantId, async (tx) => ({ loyalty: await billLoyalty(tx, auth, id) }));
    });

    app.post('/bills/:id/rewards', async (req) => {
      const auth = requireStaff(req);
      const { id } = parse(idParams, req.params);
      const body = parse(z.object({ reward_id: z.uuid(), order_item_id: z.uuid().nullable().optional() }), req.body);
      return ctx.tx(auth.tenantId, (tx) => applyReward(tx, auth, id, body.reward_id, body.order_item_id ?? null));
    });

    app.delete('/bills/:id/rewards/:reward_id', async (req) => {
      const auth = requireStaff(req);
      const p = parse(z.object({ id: z.uuid(), reward_id: z.uuid() }), req.params);
      return ctx.tx(auth.tenantId, (tx) => removeReward(tx, auth, p.id, p.reward_id));
    });

    // ---------- Memberships ----------

    /** Plans, for the owner to edit and for staff to sell. */
    app.get('/memberships/plans', async (req) => {
      const auth = requireStaff(req);
      const q = parse(outletQuery, req.query);
      assertCan(auth, q.outlet_id, 'customer.view');
      return ctx.tx(auth.tenantId, (tx) => listPlans(tx));
    });

    app.post('/memberships/plans', async (req) => {
      const auth = requireStaff(req);
      const body = parse(planBody.extend(outletQuery.shape), req.body);
      assertCan(auth, body.outlet_id, 'outlet.settings');
      return ctx.tx(auth.tenantId, (tx) => savePlan(tx, auth, body.outlet_id, null, body));
    });

    app.put('/memberships/plans/:id', async (req) => {
      const auth = requireStaff(req);
      const { id } = parse(idParams, req.params);
      const body = parse(planBody.extend(outletQuery.shape), req.body);
      assertCan(auth, body.outlet_id, 'outlet.settings');
      return ctx.tx(auth.tenantId, (tx) => savePlan(tx, auth, body.outlet_id, id, body));
    });

    /** Sells a plan: returns the membership's own bill, to print and take payment on. */
    app.post('/customers/:id/memberships', async (req, reply) => {
      const auth = requireStaff(req);
      const { id } = parse(idParams, req.params);
      const body = parse(z.object({ outlet_id: z.uuid(), plan_id: z.uuid() }), req.body);
      const bill = await ctx.tx(auth.tenantId, (tx) => sellMembership(tx, auth, body.outlet_id, id, body.plan_id));
      return reply.status(201).send(bill);
    });

    // ---------- Wallet ----------

    app.get('/wallet/packs', async (req) => {
      const auth = requireStaff(req);
      const q = parse(outletQuery, req.query);
      assertCan(auth, q.outlet_id, 'customer.view');
      return ctx.tx(auth.tenantId, (tx) => listPacks(tx));
    });

    app.post('/wallet/packs', async (req) => {
      const auth = requireStaff(req);
      const body = parse(packBody.extend(outletQuery.shape), req.body);
      assertCan(auth, body.outlet_id, 'outlet.settings');
      return ctx.tx(auth.tenantId, (tx) => savePack(tx, auth, body.outlet_id, null, body));
    });

    app.put('/wallet/packs/:id', async (req) => {
      const auth = requireStaff(req);
      const { id } = parse(idParams, req.params);
      const body = parse(packBody.extend(outletQuery.shape), req.body);
      assertCan(auth, body.outlet_id, 'outlet.settings');
      return ctx.tx(auth.tenantId, (tx) => savePack(tx, auth, body.outlet_id, id, body));
    });

    app.get('/customers/:id/wallet', async (req) => {
      const auth = requireStaff(req);
      const { id } = parse(idParams, req.params);
      const q = parse(outletQuery, req.query);
      assertCan(auth, q.outlet_id, 'customer.view');
      return ctx.tx(auth.tenantId, async (tx) => {
        await liveCustomer(tx, id);
        return walletDetail(tx, id, q.outlet_id);
      });
    });

    app.post('/customers/:id/wallet/topups', async (req, reply) => {
      const auth = requireStaff(req);
      const { id } = parse(idParams, req.params);
      const body = parse(topupBody, req.body);
      const done = await ctx.tx(auth.tenantId, (tx) => topUp(tx, auth, id, body));
      return reply.status(201).send(done);
    });

    /** Texts the guest a code to read out, so their wallet can pay a bill. */
    app.post('/customers/:id/wallet/code', { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (req) => {
      const auth = requireStaff(req);
      const { id } = parse(idParams, req.params);
      const body = parse(outletQuery, req.body);
      const sender = ctx.otp;
      if (!sender) throw new AppError(404, 'otp_unavailable', 'Codes by SMS are not set up here');
      return ctx.tx(auth.tenantId, (tx) => sendWalletCode(tx, auth, body.outlet_id, id, ctx.config.TOKEN_SECRET, sender));
    });

    /** The code the guest read out: a proof to pay from their wallet for the next few minutes. */
    app.post('/customers/:id/wallet/code/verify', async (req) => {
      const auth = requireStaff(req);
      const { id } = parse(idParams, req.params);
      const body = parse(z.object({ outlet_id: z.uuid(), code: z.string().trim().regex(/^\d{6}$/, 'The code has 6 digits') }), req.body);
      const result = await ctx.tx(auth.tenantId, (tx) => verifyWalletCode(tx, auth, body.outlet_id, id, body.code, ctx.config.TOKEN_SECRET));
      if (result.ok) return { proof: result.proof };
      if (result.reason === 'locked') throw tooMany('Too many wrong codes. Send a new one.');
      if (result.reason === 'expired') throw badRequest('code_expired', 'This code has expired. Send a new one.');
      throw badRequest('wrong_code', `That code is not right. ${result.left} ${result.left === 1 ? 'try' : 'tries'} left.`, { left: result.left });
    });

    /** Gives a guest back money they paid in (a manager approves); the bonus with it is forfeited. */
    app.post('/customers/:id/wallet/cash-out', async (req) => {
      const auth = requireStaff(req);
      const { id } = parse(idParams, req.params);
      const body = parse(z.object({ outlet_id: z.uuid(), amount_paise: z.number().int().min(1).max(100_000_000), method: z.enum(TOPUP_METHODS), reason: z.string().max(200) }), req.body);
      return ctx.tx(auth.tenantId, (tx) => cashOut(tx, auth, id, body, approvalHeader(req.headers)));
    });
  };
}

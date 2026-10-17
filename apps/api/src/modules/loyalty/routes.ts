import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../context';
import { assertCan, requireStaff } from '../../lib/auth';
import { notFound } from '../../lib/errors';
import { idParams, parse } from '../../lib/validate';
import { customerLoyalty } from './engine';
import { currentProgram, programBody, programDto, saveProgram } from './program';
import { applyReward, billLoyalty, removeReward } from './rewards';

const outletQuery = z.object({ outlet_id: z.uuid() });

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
        const c = await tx.db.selectFrom('customers').select('id').where('id', '=', id).where('erased_at', 'is', null).executeTakeFirst();
        if (!c) throw notFound('Customer');
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
  };
}

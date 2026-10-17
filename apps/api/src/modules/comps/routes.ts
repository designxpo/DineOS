import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { COMP_REASONS } from '@dineos/shared/enums';
import type { AppContext } from '../../context';
import { approvalHeader } from '../../lib/approvals';
import { requireStaff } from '../../lib/auth';
import { idParams, parse } from '../../lib/validate';
import { compBill, compItem, removeComp } from './service';

const compBody = z.object({
  reason: z.enum(COMP_REASONS),
  note: z.string().max(300).nullable().optional(),
  customer_id: z.uuid().nullable().optional(),
});

export default function routes(ctx: AppContext): FastifyPluginAsync {
  return async (app) => {
    /** Gives some (by default all) of one dish free. Waiters need a manager's PIN (X-Approval-Token). */
    app.post('/order-items/:id/comp', async (req, reply) => {
      const auth = requireStaff(req);
      const { id } = parse(idParams, req.params);
      const body = parse(compBody.extend({ qty: z.number().int().min(1).max(99).optional() }), req.body);
      const comp = await ctx.tx(auth.tenantId, (tx) =>
        compItem(tx, auth, id, { qty: body.qty, reason: body.reason, note: body.note, customerId: body.customer_id }, approvalHeader(req.headers)),
      );
      return reply.status(201).send(comp);
    });

    /** Everything still charged on an unprinted bill, on the house. */
    app.post('/bills/:id/comp', async (req, reply) => {
      const auth = requireStaff(req);
      const { id } = parse(idParams, req.params);
      const body = parse(compBody, req.body);
      const comps = await ctx.tx(auth.tenantId, (tx) => compBill(tx, auth, id, { reason: body.reason, note: body.note, customerId: body.customer_id }, approvalHeader(req.headers)));
      return reply.status(201).send(comps);
    });

    /** Takes a free dish back before the bill prints; the record stays, marked undone. */
    app.delete('/comps/:id', async (req, reply) => {
      const auth = requireStaff(req);
      const { id } = parse(idParams, req.params);
      await ctx.tx(auth.tenantId, (tx) => removeComp(tx, auth, id));
      return reply.status(204).send();
    });
  };
}

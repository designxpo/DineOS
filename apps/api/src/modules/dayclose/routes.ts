// Closing the day: every open item at the outlet, and the owner's (or a manager's) sign-off,
// kept with the day as it stood, with the cash expected and the cash counted.

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { businessDate } from '@mezmitra/shared/dates';
import type { DayCloseDTO } from '@mezmitra/shared/dto';
import type { AppContext } from '../../context';
import { json } from '../../db';
import { audit } from '../../lib/audit';
import { assertCan, requireStaff, type StaffAuth } from '../../lib/auth';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors';
import { parse } from '../../lib/validate';
import { dayCloseView, openItems } from './service';

/** The owner, or a manager of this outlet (who closes when the owner is not there). */
const canSign = (auth: StaffAuth, outletId: string) => auth.roles.some((r) => (r.role === 'owner' && r.outletId === null) || (r.role === 'manager' && (r.outletId === null || r.outletId === outletId)));

export default function routes(ctx: AppContext): FastifyPluginAsync {
  return async (app) => {
    app.get('/day-close', async (req): Promise<DayCloseDTO> => {
      const auth = requireStaff(req);
      const q = parse(z.object({ outlet_id: z.uuid(), date: z.iso.date().optional() }), req.query);
      assertCan(auth, q.outlet_id, 'report.view');
      return ctx.tx(auth.tenantId, async (tx) => {
        const outlet = await tx.db.selectFrom('outlets').select(['id', 'timezone']).where('id', '=', q.outlet_id).executeTakeFirst();
        if (!outlet) throw notFound('Outlet');
        return dayCloseView(tx, outlet, q.date ?? businessDate(new Date(), outlet.timezone));
      });
    });

    /**
     * Signs the day off. Money still unsettled (a "must" item) may stay open, but only with a note
     * saying why; the list is kept as it stood, with the cash counted if given.
     */
    app.post('/day-close', async (req, reply) => {
      const auth = requireStaff(req);
      const body = parse(
        z.object({
          outlet_id: z.uuid(),
          date: z.iso.date(),
          counted_cash_paise: z.number().int().min(0).max(100_000_000).nullable().optional(),
          note: z.string().trim().max(1000).nullable().optional(),
        }),
        req.body,
      );
      assertCan(auth, body.outlet_id, 'report.view');
      if (!canSign(auth, body.outlet_id)) throw forbidden('The owner or a manager closes the day');
      const view = await ctx.tx(auth.tenantId, async (tx) => {
        const outlet = await tx.db.selectFrom('outlets').select(['id', 'timezone']).where('id', '=', body.outlet_id).executeTakeFirst();
        if (!outlet) throw notFound('Outlet');
        if (body.date > businessDate(new Date(), outlet.timezone)) throw badRequest('future_date', 'That day has not started yet');
        const done = await tx.db.selectFrom('day_closes').select('id').where('outlet_id', '=', outlet.id).where('business_date', '=', body.date).executeTakeFirst();
        if (done) throw conflict('already_closed', 'This day is already signed off');
        const open = await openItems(tx, outlet, body.date);
        const must = open.items.filter((i) => i.severity === 'must');
        const note = body.note || null;
        if (must.length && !note) throw badRequest('note_needed', `${must.length} item${must.length === 1 ? ' is' : 's are'} still open: settle ${must.length === 1 ? 'it' : 'them'}, or say why you are closing anyway`);
        await tx.db
          .insertInto('day_closes')
          .values({
            tenant_id: tx.tenantId,
            outlet_id: outlet.id,
            business_date: body.date,
            signed_by: auth.userId,
            note,
            expected_cash_paise: open.expected_cash_paise,
            counted_cash_paise: body.counted_cash_paise ?? null,
            net_sales_paise: open.net_sales_paise,
            items: json(open.items),
          })
          .execute();
        await audit(tx, auth, {
          outletId: outlet.id,
          action: 'day.close',
          entity: 'day_close',
          after: { date: body.date, open_must: must.length, open_check: open.items.length - must.length, expected_cash_paise: open.expected_cash_paise, counted_cash_paise: body.counted_cash_paise ?? null, note },
        });
        return dayCloseView(tx, outlet, body.date);
      });
      return reply.status(201).send(view);
    });
  };
}

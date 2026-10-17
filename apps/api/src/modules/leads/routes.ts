// Demo requests from the website: a restaurant leaves its details, DineOS follows up. The form is
// public, so it is rate limited and carries a hidden field that only bots fill.

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { DEMO_PAINS, DEMO_TABLES } from '@dineos/shared/leads';
import { normalizePhone } from '@dineos/shared/phone';
import type { AppContext } from '../../context';
import { requireAdmin } from '../../lib/auth';
import { badRequest, notFound } from '../../lib/errors';
import { idParams, parse } from '../../lib/validate';

const text = (max: number) => z.string().trim().max(max);

export default function routes(ctx: AppContext): FastifyPluginAsync {
  return async (app) => {
    app.post('/public/demo-requests', { config: { rateLimit: { max: 5, timeWindow: '10 minutes', keyGenerator: (r) => r.ip } } }, async (req, reply) => {
      const body = parse(
        z.object({
          name: text(80).min(1),
          restaurant: text(120).min(1),
          phone: text(20).min(8),
          city: text(60).optional(),
          tables: z.enum(DEMO_TABLES).optional(),
          plan: text(40).optional(),
          pains: z.array(z.enum(DEMO_PAINS)).max(DEMO_PAINS.length).optional(),
          note: text(1000).optional(),
          // Hidden on the page: a person never fills it.
          website: z.string().max(200).optional(),
        }),
        req.body,
      );
      if (body.website) return reply.status(201).send({ ok: true });
      const phone = normalizePhone(body.phone);
      if (!/^\+\d{10,15}$/.test(phone)) throw badRequest('invalid_phone', 'Enter a phone number we can call or WhatsApp');
      await ctx.adminDb
        .insertInto('demo_requests')
        .values({
          name: body.name,
          restaurant: body.restaurant,
          phone,
          city: body.city || null,
          tables: body.tables ?? null,
          plan: body.plan || null,
          pains: [...new Set(body.pains ?? [])],
          note: body.note || null,
        })
        .execute();
      return reply.status(201).send({ ok: true });
    });

    app.get('/admin/demo-requests', async (req) => {
      requireAdmin(req);
      return ctx.adminDb.selectFrom('demo_requests').selectAll().orderBy('created_at', 'desc').limit(500).execute();
    });

    app.patch('/admin/demo-requests/:id', async (req) => {
      requireAdmin(req);
      const { id } = parse(idParams, req.params);
      const { status } = parse(z.object({ status: z.enum(['new', 'contacted', 'won', 'lost']) }), req.body);
      const row = await ctx.adminDb
        .updateTable('demo_requests')
        .set((eb) => ({ status, contacted_at: status === 'new' ? null : eb.fn.coalesce('contacted_at', eb.val(new Date())) }))
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirst();
      if (!row) throw notFound('Demo request');
      return row;
    });
  };
}

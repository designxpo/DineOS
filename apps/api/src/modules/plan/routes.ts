import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { PlanCheckoutDTO, PlansPageDTO } from '@mezmitra/shared/dto';
import type { AppContext } from '../../context';
import { assertTenantOwner, requireStaff } from '../../lib/auth';
import { AppError, badRequest, conflict, notFound, unauthorized } from '../../lib/errors';
import { createOrder, razorpayConfigured, verifyCheckoutSignature, verifyWebhookSignature } from '../../lib/razorpay';
import { parse } from '../../lib/validate';
import { applyPaidPlanOrder, plansPage, settledPayment } from './service';

// Plans and self-serve upgrades, paid online with Razorpay. The owner sees every plan and what it
// includes; an upgrade is charged at a price we compute, and the plan changes only once Razorpay
// confirms the payment to our server (the checkout's signature, a lookup of the payment, or
// Razorpay's signed webhook if the browser closed first). Moving to a smaller plan stays with
// support, so no paid period is cut short by a tap.

/** A second tap on Upgrade within this window reuses the order instead of making another. */
const REUSE_ORDER_MS = 30 * 60_000;

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: string;
  }
}

export default function routes(ctx: AppContext): FastifyPluginAsync {
  async function checkoutFor(tenantId: string, order: { razorpay_order_id: string; amount_paise: number; plan_name: string }, userId: string): Promise<PlanCheckoutDTO> {
    const who = await ctx.tx(tenantId, async (tx) => ({
      tenant: await tx.db.selectFrom('tenants').select('name').where('id', '=', tenantId).executeTakeFirstOrThrow(),
      user: await tx.db.selectFrom('users').select(['name', 'email', 'phone']).where('id', '=', userId).executeTakeFirst(),
    }));
    return {
      order_id: order.razorpay_order_id,
      key_id: ctx.config.RAZORPAY_KEY_ID!,
      amount_paise: order.amount_paise,
      currency: 'INR',
      plan_name: order.plan_name,
      business_name: who.tenant.name,
      prefill: { name: who.user?.name ?? null, email: who.user?.email ?? null, contact: who.user?.phone ?? null },
    };
  }

  return async (app) => {
    // Razorpay signs its webhook over the exact bytes, so this module keeps the raw JSON body.
    const parseJson = app.getDefaultJsonParser('error', 'error');
    app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
      (req as FastifyRequest).rawBody = body as string;
      parseJson(req, body as string, done);
    });

    app.get('/plans', async (req): Promise<PlansPageDTO> => {
      const auth = requireStaff(req);
      assertTenantOwner(auth);
      return ctx.tx(auth.tenantId, (tx) => plansPage(ctx, tx));
    });

    /** Starts paying for an upgrade: a Razorpay order for the amount we work out here. */
    app.post('/plan/checkout', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req): Promise<PlanCheckoutDTO> => {
      const auth = requireStaff(req);
      assertTenantOwner(auth);
      const body = parse(z.object({ plan_code: z.string().trim().min(1).max(40) }), req.body);
      if (!razorpayConfigured(ctx.config)) throw conflict('not_configured', 'Online payment is not set up yet. Contact support to upgrade.');

      const prepared = await ctx.tx(auth.tenantId, async (tx) => {
        const page = await plansPage(ctx, tx);
        const offer = page.plans.find((p) => p.code === body.plan_code);
        if (!offer) throw notFound('Plan');
        if (!offer.upgrade) throw conflict('not_an_upgrade', 'Pick a plan above your current one. To move to a smaller plan, contact support.');
        const reusable = await tx.db
          .selectFrom('plan_orders')
          .select(['id', 'razorpay_order_id', 'amount_paise'])
          .where('plan_code', '=', offer.code)
          .where('amount_paise', '=', offer.upgrade.amount_paise)
          .where('status', '=', 'created')
          .where('razorpay_order_id', 'is not', null)
          .where('created_at', '>', new Date(Date.now() - REUSE_ORDER_MS))
          .orderBy('created_at', 'desc')
          .executeTakeFirst();
        if (reusable) return { offer, reuse: reusable, created: null };
        const row = await tx.db
          .insertInto('plan_orders')
          .values({
            tenant_id: tx.tenantId,
            from_plan_code: page.current.code,
            plan_code: offer.code,
            amount_paise: offer.upgrade.amount_paise,
            credit_paise: offer.upgrade.credit_paise,
            created_by: auth.userId,
          })
          .returning(['id', 'amount_paise'])
          .executeTakeFirstOrThrow();
        return { offer, reuse: null, created: row };
      });

      if (prepared.reuse) {
        return checkoutFor(auth.tenantId, { razorpay_order_id: prepared.reuse.razorpay_order_id!, amount_paise: prepared.reuse.amount_paise, plan_name: prepared.offer.name }, auth.userId);
      }
      const row = prepared.created;
      if (!row) throw conflict('busy', 'Try again in a moment');
      let razorpayOrderId: string;
      try {
        const order = await createOrder(ctx.config, {
          amountPaise: row.amount_paise,
          receipt: row.id,
          // product: one Razorpay account can serve several of our products (Talko AI too); this
          // tells the payments apart in the dashboard and in reports.
          notes: { product: 'mezmitra', tenant_id: auth.tenantId, plan_code: prepared.offer.code, plan_order_id: row.id },
        });
        razorpayOrderId = order.id;
      } catch (err) {
        const message = err instanceof AppError ? err.message : 'Could not start the payment';
        await ctx.tx(auth.tenantId, (tx) => tx.db.updateTable('plan_orders').set({ status: 'failed', last_error: message.slice(0, 500) }).where('id', '=', row.id).execute());
        throw err;
      }
      await ctx.tx(auth.tenantId, (tx) => tx.db.updateTable('plan_orders').set({ razorpay_order_id: razorpayOrderId }).where('id', '=', row.id).execute());
      return checkoutFor(auth.tenantId, { razorpay_order_id: razorpayOrderId, amount_paise: row.amount_paise, plan_name: prepared.offer.name }, auth.userId);
    });

    /** Checkout's success callback, sent on by the browser. Trusted only after we check it. */
    app.post('/plan/confirm', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req): Promise<PlansPageDTO> => {
      const auth = requireStaff(req);
      assertTenantOwner(auth);
      const body = parse(
        z.object({
          razorpay_order_id: z.string().regex(/^order_[A-Za-z0-9]{6,40}$/),
          razorpay_payment_id: z.string().regex(/^pay_[A-Za-z0-9]{6,40}$/),
          razorpay_signature: z.string().regex(/^[0-9a-f]{64}$/),
        }),
        req.body,
      );
      const secret = ctx.config.RAZORPAY_KEY_SECRET;
      if (!secret || !razorpayConfigured(ctx.config)) throw conflict('not_configured', 'Online payment is not set up yet');
      if (!verifyCheckoutSignature(secret, body.razorpay_order_id, body.razorpay_payment_id, body.razorpay_signature)) {
        throw badRequest('payment_unverified', 'This payment could not be verified');
      }
      // Row-level security: another restaurant's order is simply not found.
      const order = await ctx.tx(auth.tenantId, (tx) =>
        tx.db.selectFrom('plan_orders').select(['id', 'status', 'razorpay_order_id', 'amount_paise']).where('razorpay_order_id', '=', body.razorpay_order_id).executeTakeFirst(),
      );
      if (!order) throw notFound('Order');
      if (order.status !== 'paid') {
        const payment = await settledPayment(ctx, order, body.razorpay_payment_id);
        await applyPaidPlanOrder(ctx, order.id, payment.id, payment.amount);
      }
      return ctx.tx(auth.tenantId, (tx) => plansPage(ctx, tx));
    });

    /**
     * Razorpay's webhook (payment.captured, order.paid, payment.failed), for payments whose
     * browser closed before the success callback. Signed with RAZORPAY_WEBHOOK_SECRET; the route
     * does not exist without it. Always 200 once the signature checks, so Razorpay stops retrying
     * events that are not ours (another product on the same account) or already applied.
     */
    app.post('/plan/razorpay/webhook', async (req) => {
      const secret = ctx.config.RAZORPAY_WEBHOOK_SECRET;
      if (!secret) throw notFound('Route');
      const signature = req.headers['x-razorpay-signature'];
      if (typeof signature !== 'string' || !req.rawBody || !verifyWebhookSignature(secret, req.rawBody, signature)) throw unauthorized();
      const body = parse(
        z.object({
          event: z.string().max(60),
          payload: z
            .object({
              payment: z
                .object({
                  entity: z.object({ id: z.string(), order_id: z.string().nullable().optional(), amount: z.number(), currency: z.string(), status: z.string(), error_description: z.string().nullable().optional() }),
                })
                .optional(),
            })
            .optional(),
        }),
        req.body,
      );
      const payment = body.payload?.payment?.entity;
      if (!payment?.order_id) return { ok: true };
      // Auth bootstrap: no tenant is known until the order is found.
      const order = await ctx.adminDb
        .selectFrom('plan_orders')
        .select(['id', 'tenant_id', 'status', 'amount_paise'])
        .where('razorpay_order_id', '=', payment.order_id)
        .executeTakeFirst();
      if (!order || order.status === 'paid') return { ok: true };

      if (body.event === 'payment.failed') {
        await ctx.adminDb
          .updateTable('plan_orders')
          .set({ last_error: (payment.error_description || 'The payment failed').slice(0, 500) })
          .where('id', '=', order.id)
          .execute();
        return { ok: true };
      }
      if ((body.event === 'payment.captured' || body.event === 'order.paid') && payment.status === 'captured') {
        if (payment.amount !== order.amount_paise || payment.currency !== 'INR') {
          await ctx.adminDb.updateTable('plan_orders').set({ last_error: 'Paid amount did not match: contact support' }).where('id', '=', order.id).execute();
          return { ok: true };
        }
        await applyPaidPlanOrder(ctx, order.id, payment.id, payment.amount);
      }
      return { ok: true };
    });
  };
}

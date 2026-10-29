import { businessDate } from '@mezmitra/shared/dates';
import type { PlanOfferDTO, PlansPageDTO } from '@mezmitra/shared/dto';
import { periodEnd, planFeatures, upgradeQuote } from '@mezmitra/shared/plans';
import type { AppContext, Tx } from '../../context';
import { json } from '../../db';
import { clearAuthCache } from '../../lib/auth';
import { conflict, notFound } from '../../lib/errors';
import { nextPlatformInvoiceNumber } from '../../lib/platform-invoices';
import { capturePayment, fetchPayment, razorpayConfigured, type RazorpayPayment } from '../../lib/razorpay';

/** Our own billing runs on India time, like the invoice series. */
const BILLING_TZ = 'Asia/Kolkata';
export const billingToday = (now = new Date()) => businessDate(now, BILLING_TZ);

const period = (p: string): 'monthly' | 'yearly' => (p === 'yearly' ? 'yearly' : 'monthly');

/** The plans the tenant can see, with what each upgrade costs today. Runs as the tenant. */
export async function plansPage(ctx: AppContext, tx: Tx, today = billingToday()): Promise<PlansPageDTO> {
  const tenant = await tx.db
    .selectFrom('tenants')
    .innerJoin('plans', 'plans.code', 'tenants.plan_code')
    .select(['plans.code', 'plans.name', 'plans.price_paise', 'plans.billing_period', 'plans.features'])
    .where('tenants.id', '=', tx.tenantId)
    .executeTakeFirstOrThrow();
  const sub = await tx.db.selectFrom('subscriptions').selectAll().where('status', '=', 'active').orderBy('period_end', 'desc').executeTakeFirst();
  const paid = sub
    ? await tx.db
        .selectFrom('platform_invoices')
        .select((eb) => eb.fn.coalesce(eb.fn.sum<string>('amount_paise'), eb.lit(0)).as('paid'))
        .where('subscription_id', '=', sub.id)
        .where('status', '=', 'paid')
        .executeTakeFirstOrThrow()
    : { paid: 0 };
  const current = sub ? { periodStart: String(sub.period_start), periodEnd: String(sub.period_end), paidPaise: Number(paid.paid) } : null;

  const plans = await tx.db
    .selectFrom('plans')
    .select(['code', 'name', 'price_paise', 'billing_period', 'features'])
    .where((eb) => eb.or([eb('is_active', '=', true), eb('code', '=', tenant.code)]))
    .orderBy('price_paise')
    .execute();
  const offers: PlanOfferDTO[] = plans
    // A free plan is only for starting out: it is shown to the restaurant that is on it.
    .filter((p) => p.price_paise > 0 || p.code === tenant.code)
    .map((p) => ({
      code: p.code,
      name: p.name,
      price_paise: p.price_paise,
      billing_period: period(p.billing_period),
      features: planFeatures(p.features),
      current: p.code === tenant.code,
      upgrade:
        p.code !== tenant.code && p.price_paise > tenant.price_paise
          ? upgradeQuote({ pricePaise: p.price_paise, billingPeriod: p.billing_period, today, current })
          : null,
    }));

  const outlets = await tx.db.selectFrom('outlets').select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirstOrThrow();
  const tables = await tx.db.selectFrom('tables').select((eb) => eb.fn.countAll<string>().as('n')).where('is_active', '=', true).executeTakeFirstOrThrow();
  const failed = await tx.db
    .selectFrom('plan_orders')
    .innerJoin('plans', 'plans.code', 'plan_orders.plan_code')
    .select(['plans.name', 'plan_orders.last_error', 'plan_orders.updated_at'])
    .where('plan_orders.last_error', 'is not', null)
    .where('plan_orders.status', '<>', 'paid')
    .where('plan_orders.updated_at', '>', new Date(Date.now() - 24 * 3600_000))
    .orderBy('plan_orders.updated_at', 'desc')
    .executeTakeFirst();

  return {
    current: {
      code: tenant.code,
      name: tenant.name,
      price_paise: tenant.price_paise,
      billing_period: period(tenant.billing_period),
      features: planFeatures(tenant.features),
      period_start: current?.periodStart ?? null,
      period_end: current?.periodEnd ?? null,
      usage: { outlets: Number(outlets.n), tables: Number(tables.n) },
    },
    plans: offers,
    online_payment: razorpayConfigured(ctx.config),
    last_failed: failed ? { plan_name: failed.name, error: failed.last_error!, at: failed.updated_at.toISOString() } : null,
  };
}

interface OrderForPayment {
  id: string;
  razorpay_order_id: string | null;
  amount_paise: number;
}

/**
 * Asks Razorpay about a payment and checks it is for this order, for exactly its amount, in
 * rupees, and captured (capturing it when the account leaves that to us). Anything else throws.
 */
export async function settledPayment(ctx: AppContext, order: OrderForPayment, paymentId: string): Promise<RazorpayPayment> {
  let payment = await fetchPayment(ctx.config, paymentId);
  if (payment.order_id !== order.razorpay_order_id || payment.amount !== order.amount_paise || payment.currency !== 'INR') {
    throw conflict('payment_mismatch', 'That payment is not for this upgrade');
  }
  if (payment.status === 'authorized') payment = await capturePayment(ctx.config, payment.id, order.amount_paise);
  if (payment.status !== 'captured') throw conflict('payment_pending', 'Razorpay has not confirmed the payment yet. It will apply as soon as it does.');
  return payment;
}

/**
 * Moves the tenant to the paid plan: a new period from today, a paid invoice, the plan itself.
 * Admin connection (our billing tables are not the tenant's to write). Safe to call twice for
 * the same order; the second call changes nothing. Returns whether this call applied it.
 */
export async function applyPaidPlanOrder(ctx: AppContext, orderId: string, paymentId: string, amountPaise: number): Promise<boolean> {
  const applied = await ctx.adminDb.transaction().execute(async (trx) => {
    const order = await trx.selectFrom('plan_orders').selectAll().where('id', '=', orderId).forUpdate().executeTakeFirst();
    if (!order) throw notFound('Order');
    if (order.status === 'paid') return false;
    if (amountPaise !== order.amount_paise) throw conflict('payment_mismatch', 'That payment is not for this upgrade');
    const plan = await trx.selectFrom('plans').select(['code', 'billing_period']).where('code', '=', order.plan_code).executeTakeFirstOrThrow();
    const tenant = await trx.selectFrom('tenants').select('plan_code').where('id', '=', order.tenant_id).forUpdate().executeTakeFirstOrThrow();
    const today = billingToday();
    const end = periodEnd(today, plan.billing_period);

    await trx.updateTable('subscriptions').set({ status: 'replaced' }).where('tenant_id', '=', order.tenant_id).where('status', '=', 'active').execute();
    const sub = await trx
      .insertInto('subscriptions')
      .values({ tenant_id: order.tenant_id, plan_code: order.plan_code, period_start: today, period_end: end })
      .returning('id')
      .executeTakeFirstOrThrow();
    const invoice = await trx
      .insertInto('platform_invoices')
      .values({
        tenant_id: order.tenant_id,
        subscription_id: sub.id,
        number: await nextPlatformInvoiceNumber(trx),
        amount_paise: order.amount_paise,
        period_start: today,
        period_end: end,
        due_date: today,
        status: 'paid',
        paid_reference: `Razorpay ${paymentId}`,
        paid_at: new Date(),
      })
      .returning(['id', 'number'])
      .executeTakeFirstOrThrow();
    await trx.updateTable('tenants').set({ plan_code: order.plan_code }).where('id', '=', order.tenant_id).execute();
    await trx
      .updateTable('plan_orders')
      .set({ status: 'paid', razorpay_payment_id: paymentId, invoice_id: invoice.id, paid_at: new Date(), last_error: null })
      .where('id', '=', order.id)
      .execute();
    await trx
      .insertInto('audit_log')
      .values({
        tenant_id: order.tenant_id,
        actor_user_id: order.created_by,
        action: 'plan.upgrade',
        entity: 'tenant',
        entity_id: order.tenant_id,
        before: json({ plan_code: tenant.plan_code }),
        after: json({ plan_code: order.plan_code, invoice: invoice.number, amount_paise: order.amount_paise, credit_paise: order.credit_paise, payment: paymentId }),
      })
      .execute();
    return true;
  });
  // Plan features ride along with cached sign-ins (the Talko AI link checks them).
  if (applied) clearAuthCache();
  return applied;
}

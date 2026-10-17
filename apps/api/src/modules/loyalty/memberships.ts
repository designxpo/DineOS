// Paid memberships: plans the owner sells (from a template or their own), each sold on its own GST
// invoice. Paying that bill starts the membership; voiding it ends it.

import { sql } from 'kysely';
import { z } from 'zod';
import type { BillDTO, MembershipPlanDTO } from '@dineos/shared/dto';
import { checkMembership, MEMBERSHIP_TEMPLATE_KEYS, type MembershipBenefits, type MembershipPlanInput, type MembershipTemplateKey } from '@dineos/shared/loyalty';
import type { Tx } from '../../context';
import { json } from '../../db';
import { audit } from '../../lib/audit';
import { assertCan, type StaffAuth } from '../../lib/auth';
import { badRequest, notFound } from '../../lib/errors';
import { announceBill, getBill } from '../billing/service';
import type { SoldPlan } from './membership-state';

const money = z.number().int().min(0).max(100_000_000);
const ids = z.array(z.uuid()).max(100);

export const planBody = z.object({
  name: z.string().trim().min(1).max(60),
  template: z.enum(MEMBERSHIP_TEMPLATE_KEYS).nullable(),
  price_paise: money,
  duration_days: z.number().int().min(1).max(1095),
  tax_rate_bp: z.number().int().min(0).max(2800),
  hsn_sac: z.string().trim().max(10).nullable(),
  benefits: z.object({
    discount: z.object({ bp: z.number().int().min(0).max(10_000), category_ids: ids, max_paise: money.nullable() }).nullable(),
    daily_item: z.object({ category_ids: ids, max_value_paise: money.nullable() }).nullable(),
    multiplier_bp: z.number().int().min(0).max(100_000),
  }),
  is_active: z.boolean(),
});

export async function listPlans(tx: Tx): Promise<MembershipPlanDTO[]> {
  const now = new Date();
  const rows = await tx.db
    .selectFrom('membership_plans')
    .select((eb) => [
      'id',
      'name',
      'template',
      'price_paise',
      'duration_days',
      'tax_rate_bp',
      'hsn_sac',
      'benefits',
      'is_active',
      eb
        .selectFrom('customer_memberships')
        .select(sql<number>`count(distinct customer_id)`.as('n'))
        .whereRef('customer_memberships.plan_id', '=', 'membership_plans.id')
        .where('status', '=', 'active')
        .where('starts_at', '<=', now)
        .where('ends_at', '>', now)
        .as('members'),
    ])
    .orderBy('is_active', 'desc')
    .orderBy('sort')
    .orderBy('price_paise')
    .execute();
  return rows.map((r) => ({ ...r, template: r.template as MembershipTemplateKey | null, benefits: r.benefits as unknown as MembershipBenefits, members: Number(r.members ?? 0) }));
}

/** Adds or changes a plan. Guests who bought it keep what they bought. */
export async function savePlan(tx: Tx, auth: StaffAuth, outletId: string, id: string | null, input: z.infer<typeof planBody>): Promise<MembershipPlanDTO[]> {
  const problem = checkMembership(input as MembershipPlanInput);
  if (problem) throw badRequest('invalid_membership', problem);
  const values = {
    name: input.name,
    template: input.template,
    price_paise: input.price_paise,
    duration_days: input.duration_days,
    tax_rate_bp: input.tax_rate_bp,
    hsn_sac: input.hsn_sac || null,
    benefits: json(input.benefits),
    is_active: input.is_active,
  };
  if (id) {
    const r = await tx.db.updateTable('membership_plans').set(values).where('id', '=', id).returning('id').executeTakeFirst();
    if (!r) throw notFound('Membership');
  } else {
    await tx.db.insertInto('membership_plans').values({ tenant_id: tx.tenantId, ...values }).execute();
  }
  await audit(tx, auth, { outletId, action: 'membership.plan', entity: 'membership_plan', entityId: id, after: input });
  return listPlans(tx);
}

/** Sells a plan to a guest: a bill of its own, with the plan as its one line, to print and take payment on. */
export async function sellMembership(tx: Tx, auth: StaffAuth, outletId: string, customerId: string, planId: string): Promise<BillDTO> {
  assertCan(auth, outletId, 'bill.manage');
  assertCan(auth, outletId, 'customer.manage');
  const plan = await tx.db.selectFrom('membership_plans').selectAll().where('id', '=', planId).executeTakeFirst();
  if (!plan || !plan.is_active) throw notFound('Membership');
  const c = await tx.db.selectFrom('customers').select('id').where('id', '=', customerId).where('erased_at', 'is', null).executeTakeFirst();
  if (!c) throw notFound('Customer');
  const outlet = await tx.db.selectFrom('outlets').select(['service_charge_tax_rate_bp']).where('id', '=', outletId).executeTakeFirstOrThrow();
  const snapshot: SoldPlan = {
    name: plan.name,
    price_paise: plan.price_paise,
    duration_days: plan.duration_days,
    tax_rate_bp: plan.tax_rate_bp,
    hsn_sac: plan.hsn_sac,
    benefits: plan.benefits as unknown as MembershipBenefits,
  };
  const m = await tx.db
    .insertInto('customer_memberships')
    .values({ tenant_id: tx.tenantId, customer_id: customerId, plan_id: plan.id, plan_snapshot: json(snapshot), sold_by: auth.userId })
    .returning('id')
    .executeTakeFirstOrThrow();
  const bill = await tx.db
    .insertInto('bills')
    .values({
      tenant_id: tx.tenantId,
      outlet_id: outletId,
      customer_id: customerId,
      membership_id: m.id,
      service_charge_bp: 0,
      service_charge_tax_rate_bp: outlet.service_charge_tax_rate_bp,
      created_by: auth.userId,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await audit(tx, auth, { outletId, action: 'membership.sell', entity: 'bill', entityId: bill.id, after: { plan: plan.name, price_paise: plan.price_paise, customer_id: customerId } });
  const dto = await getBill(tx, bill.id);
  await announceBill(tx, dto);
  return dto;
}

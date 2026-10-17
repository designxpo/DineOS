// Memberships a guest holds: what is running now and what it gives. Read by billing, the engine and
// the guest app; imports nothing from them.

import type { CustomerMembershipDTO } from '@mezmitra/shared/dto';
import type { MembershipBenefits } from '@mezmitra/shared/loyalty';
import type { Tx } from '../../context';

export interface SoldPlan {
  name: string;
  price_paise: number;
  duration_days: number;
  tax_rate_bp: number;
  hsn_sac: string | null;
  benefits: MembershipBenefits;
}

/** Memberships running for the guest at `at`, with what they give. */
export async function runningMemberships(tx: Tx, customerId: string, at = new Date()) {
  const rows = await tx.db
    .selectFrom('customer_memberships')
    .select(['id', 'plan_id', 'plan_snapshot', 'starts_at', 'ends_at'])
    .where('customer_id', '=', customerId)
    .where('status', '=', 'active')
    .where('starts_at', '<=', at)
    .where('ends_at', '>', at)
    .orderBy('ends_at', 'desc')
    .execute();
  return rows.map((r) => ({ ...r, plan: r.plan_snapshot as unknown as SoldPlan }));
}

/** Points or stamps multiplier from running memberships (the best one), 10000 when none. */
export async function membershipMultiplier(tx: Tx, customerId: string): Promise<number> {
  return Math.max(10_000, ...(await runningMemberships(tx, customerId)).map((m) => m.plan.benefits.multiplier_bp));
}

export function membershipDto(r: { id: string; plan_id: string; plan_snapshot: unknown; status: string; starts_at: Date | null; ends_at: Date | null; bill_id: string | null }): CustomerMembershipDTO {
  const plan = r.plan_snapshot as SoldPlan;
  return {
    id: r.id,
    plan_id: r.plan_id,
    name: plan.name,
    status: r.status as CustomerMembershipDTO['status'],
    starts_at: r.starts_at?.toISOString() ?? null,
    ends_at: r.ends_at?.toISOString() ?? null,
    benefits: plan.benefits,
    bill_id: r.bill_id,
  };
}

/** Running or still to start, and bought but not paid for yet. */
export async function customerMemberships(tx: Tx, customerId: string): Promise<CustomerMembershipDTO[]> {
  const rows = await tx.db
    .selectFrom('customer_memberships')
    .leftJoin('bills', 'bills.membership_id', 'customer_memberships.id')
    .select(['customer_memberships.id', 'customer_memberships.plan_id', 'customer_memberships.plan_snapshot', 'customer_memberships.status', 'customer_memberships.starts_at', 'customer_memberships.ends_at', 'bills.id as bill_id'])
    .where('customer_memberships.customer_id', '=', customerId)
    .where((eb) => eb.or([eb('customer_memberships.status', '=', 'pending'), eb.and([eb('customer_memberships.status', '=', 'active'), eb('customer_memberships.ends_at', '>', new Date())])]))
    .orderBy('customer_memberships.starts_at')
    .execute();
  return rows.map(membershipDto);
}


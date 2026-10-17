// Rewards on a bill, for billing to call: the money off they give, and what happens to them when
// the bill prints, is voided or loses its guest. Imports nothing from billing.

import type { Reward } from '@mezmitra/shared/loyalty';
import type { Tx } from '../../context';
import { runningMemberships, type SoldPlan } from './membership-state';

/** Money off from rewards on a bill: amounts as they are, percentages of `room`; never more than `room`. */
export async function rewardMoneyOff(tx: Tx, billId: string, room: number): Promise<number> {
  const rows = await tx.db
    .selectFrom('customer_rewards')
    .select('reward')
    .where('bill_id', '=', billId)
    .where('status', 'in', ['applied', 'used'])
    .where('comp_id', 'is', null)
    .orderBy('created_at')
    .execute();
  let off = 0;
  for (const { reward } of rows) {
    const r = reward as Reward;
    const left = room - off;
    if (left <= 0) break;
    if (r.kind === 'amount_off') off += Math.min(r.paise, left);
    if (r.kind === 'percent_off') off += Math.min(Math.round((room * r.bp) / 10_000), r.max_paise ?? Infinity, left);
  }
  return off;
}

/** The bill printed: money-off rewards on it are spent. */
export async function rewardsOnPrint(tx: Tx, billId: string): Promise<void> {
  await tx.db.updateTable('customer_rewards').set({ status: 'used', used_at: new Date() }).where('bill_id', '=', billId).where('status', '=', 'applied').execute();
}

/**
 * The bill was voided: money-off rewards go back to the guest. A free dish stays free on its order
 * (as other free items do), so its reward stays used.
 */
export async function rewardsOnVoid(tx: Tx, billId: string): Promise<void> {
  await tx.db
    .updateTable('customer_rewards')
    .set({ status: 'available', bill_id: null, used_at: null })
    .where('bill_id', '=', billId)
    .where('comp_id', 'is', null)
    .where('status', 'in', ['applied', 'used'])
    .execute();
}

/** The draft is discarded: money-off rewards go back; free dishes stay free on their orders. */
export async function detachRewards(tx: Tx, billId: string): Promise<void> {
  await tx.db.updateTable('customer_rewards').set({ status: 'available' }).where('bill_id', '=', billId).where('status', '=', 'applied').execute();
  await tx.db.updateTable('customer_rewards').set({ bill_id: null }).where('bill_id', '=', billId).execute();
}

/**
 * The draft lost its guest (removed, changed, or the draft discarded): money-off rewards go back.
 * With `freeDishes`, free dishes given as their rewards are taken back too, so another guest's bill
 * does not keep them.
 */
export async function releaseRewards(tx: Tx, billId: string, userId: string, opts: { freeDishes: boolean }): Promise<void> {
  await tx.db
    .updateTable('customer_rewards')
    .set({ status: 'available', bill_id: null })
    .where('bill_id', '=', billId)
    .where('status', '=', 'applied')
    .where('comp_id', 'is', null)
    .execute();
  if (!opts.freeDishes) return;
  const dishes = await tx.db.selectFrom('customer_rewards').select(['id', 'comp_id']).where('bill_id', '=', billId).where('comp_id', 'is not', null).execute();
  for (const d of dishes) {
    await tx.db.updateTable('comps').set({ removed_at: new Date(), removed_by: userId }).where('id', '=', d.comp_id!).where('removed_at', 'is', null).execute();
    await tx.db.updateTable('customer_rewards').set({ status: 'available', bill_id: null, comp_id: null, used_at: null }).where('id', '=', d.id).execute();
  }
}

// ---------- Memberships on bills ----------

const DAY = 86_400_000;

/** The one line of a membership sale, from the plan as sold. */
export async function membershipLine(tx: Tx, membershipId: string): Promise<SoldPlan> {
  const m = await tx.db.selectFrom('customer_memberships').select('plan_snapshot').where('id', '=', membershipId).executeTakeFirstOrThrow();
  return m.plan_snapshot as unknown as SoldPlan;
}

/**
 * Money off a bill from the guest's running membership: its percentage of the eligible lines (after
 * dish discounts and free items), up to its cap and `room`. With several, the best one counts.
 */
export async function memberDiscount(tx: Tx, customerId: string, lines: readonly { item_id: string; value_paise: number }[], room: number): Promise<number> {
  const running = (await runningMemberships(tx, customerId)).filter((m) => m.plan.benefits.discount);
  if (!running.length || !lines.length) return 0;
  const cats = await tx.db.selectFrom('menu_items').select(['id', 'category_id']).where('id', 'in', [...new Set(lines.map((l) => l.item_id))]).execute();
  const category = new Map(cats.map((c) => [c.id, c.category_id]));
  let best = 0;
  for (const m of running) {
    const d = m.plan.benefits.discount!;
    const base = lines.filter((l) => !d.category_ids.length || d.category_ids.includes(category.get(l.item_id) ?? '')).reduce((a, l) => a + l.value_paise, 0);
    best = Math.max(best, Math.min(Math.round((base * d.bp) / 10_000), d.max_paise ?? Infinity));
  }
  return Math.min(best, room);
}

/** The sale bill is paid: the membership starts now, or when the same plan still running ends. */
export async function activateMembership(tx: Tx, billId: string): Promise<void> {
  const bill = await tx.db.selectFrom('bills').select(['membership_id']).where('id', '=', billId).executeTakeFirstOrThrow();
  if (!bill.membership_id) return;
  const m = await tx.db.selectFrom('customer_memberships').select(['id', 'customer_id', 'plan_id', 'plan_snapshot', 'status']).where('id', '=', bill.membership_id).forUpdate().executeTakeFirstOrThrow();
  if (m.status !== 'pending') return;
  const now = new Date();
  const until = await tx.db
    .selectFrom('customer_memberships')
    .select((eb) => eb.fn.max('ends_at').as('ends'))
    .where('customer_id', '=', m.customer_id)
    .where('plan_id', '=', m.plan_id)
    .where('status', '=', 'active')
    .where('ends_at', '>', now)
    .executeTakeFirst();
  const starts = until?.ends ? new Date(until.ends as unknown as string) : now;
  const days = (m.plan_snapshot as unknown as SoldPlan).duration_days;
  await tx.db.updateTable('customer_memberships').set({ status: 'active', starts_at: starts, ends_at: new Date(starts.getTime() + days * DAY) }).where('id', '=', m.id).execute();
}

/** The sale bill was voided or discarded: the membership never runs (or stops). */
export async function cancelMembership(tx: Tx, billId: string): Promise<void> {
  const bill = await tx.db.selectFrom('bills').select(['membership_id']).where('id', '=', billId).executeTakeFirstOrThrow();
  if (!bill.membership_id) return;
  await tx.db.updateTable('customer_memberships').set({ status: 'cancelled', cancelled_at: new Date() }).where('id', '=', bill.membership_id).execute();
}

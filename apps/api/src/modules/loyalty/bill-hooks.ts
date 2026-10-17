// Rewards on a bill, for billing to call: the money off they give, and what happens to them when
// the bill prints, is voided or loses its guest. Imports nothing from billing.

import type { Reward } from '@dineos/shared/loyalty';
import type { Tx } from '../../context';

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

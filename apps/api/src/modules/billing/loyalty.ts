// Loyalty points (spec Phase 2): earned on paid bills, redeemed as a discount at billing.
// Points are tenant-wide; the earn rate and point value are outlet settings.

import { sql } from 'kysely';
import type { Tx } from '../../context';
import { badRequest, conflict } from '../../lib/errors';

/** Visits closer together than this count as one (split bills, a second round of drinks). */
const VISIT_WINDOW_MS = 3 * 3600_000;

export async function loyaltySettings(tx: Tx, outletId: string) {
  return tx.db
    .selectFrom('outlets')
    .select(['loyalty_enabled', 'loyalty_earn_bp', 'loyalty_point_value_paise', 'loyalty_min_redeem_points'])
    .where('id', '=', outletId)
    .executeTakeFirstOrThrow();
}

export async function lockCustomer(tx: Tx, customerId: string) {
  const c = await tx.db
    .selectFrom('customers')
    .select(['id', 'points', 'erased_at', 'last_visit_at'])
    .where('id', '=', customerId)
    .forUpdate()
    .executeTakeFirst();
  if (!c || c.erased_at) throw badRequest('invalid_customer', 'Customer not found');
  return c;
}

/** Checks a redemption request against the customer's balance and the outlet's rules. */
export async function validateRedemption(tx: Tx, outletId: string, customerId: string | null, points: number): Promise<void> {
  if (points === 0) return;
  if (!customerId) throw badRequest('customer_required', 'Attach the customer before redeeming points');
  const s = await loyaltySettings(tx, outletId);
  if (!s.loyalty_enabled) throw badRequest('loyalty_disabled', 'Loyalty is switched off for this outlet');
  if (points < s.loyalty_min_redeem_points) throw badRequest('below_minimum', `Redeem at least ${s.loyalty_min_redeem_points} points`);
  const c = await lockCustomer(tx, customerId);
  if (c.points < points) throw badRequest('not_enough_points', `The customer has ${c.points} points`, { points: c.points });
}

/** At finalisation the redeemed points leave the customer's balance. */
export async function redeemOnFinalise(
  tx: Tx,
  bill: { id: string; outlet_id: string; customer_id: string | null; loyalty_points_redeemed: number },
  userId: string,
): Promise<void> {
  if (!bill.customer_id || bill.loyalty_points_redeemed === 0) return;
  const c = await lockCustomer(tx, bill.customer_id);
  if (c.points < bill.loyalty_points_redeemed) {
    throw conflict('not_enough_points', `The customer now has only ${c.points} points; change the redemption`);
  }
  await tx.db.updateTable('customers').set({ points: c.points - bill.loyalty_points_redeemed }).where('id', '=', c.id).execute();
  await tx.db
    .insertInto('loyalty_ledger')
    .values({ tenant_id: tx.tenantId, customer_id: c.id, outlet_id: bill.outlet_id, bill_id: bill.id, kind: 'redeem', points: -bill.loyalty_points_redeemed, created_by: userId })
    .execute();
}

/** A voided bill gives the redeemed points back. */
export async function reverseOnVoid(
  tx: Tx,
  bill: { id: string; outlet_id: string; customer_id: string | null; loyalty_points_redeemed: number },
  userId: string,
): Promise<void> {
  if (!bill.customer_id || bill.loyalty_points_redeemed === 0) return;
  await lockCustomer(tx, bill.customer_id);
  await tx.db
    .updateTable('customers')
    .set({ points: sql`points + ${bill.loyalty_points_redeemed}` })
    .where('id', '=', bill.customer_id)
    .execute();
  await tx.db
    .insertInto('loyalty_ledger')
    .values({ tenant_id: tx.tenantId, customer_id: bill.customer_id, outlet_id: bill.outlet_id, bill_id: bill.id, kind: 'reverse', points: bill.loyalty_points_redeemed, note: 'Bill voided', created_by: userId })
    .execute();
}

/** Once paid: count the visit and spend, and award points if the outlet runs loyalty. */
export async function earnOnPaid(tx: Tx, billId: string, userId: string | null): Promise<void> {
  const bill = await tx.db.selectFrom('bills').select(['id', 'outlet_id', 'customer_id', 'total_paise']).where('id', '=', billId).executeTakeFirstOrThrow();
  if (!bill.customer_id) return;
  const s = await loyaltySettings(tx, bill.outlet_id);
  const c = await lockCustomer(tx, bill.customer_id);
  const now = new Date();
  const newVisit = !c.last_visit_at || now.getTime() - c.last_visit_at.getTime() > VISIT_WINDOW_MS;
  const earned = s.loyalty_enabled ? Math.floor((bill.total_paise * s.loyalty_earn_bp) / 10000 / s.loyalty_point_value_paise) : 0;
  await tx.db
    .updateTable('customers')
    .set({
      points: c.points + earned,
      total_spend_paise: sql`total_spend_paise + ${bill.total_paise}`,
      visits: newVisit ? sql`visits + 1` : sql`visits`,
      last_visit_at: now,
    })
    .where('id', '=', c.id)
    .execute();
  if (earned > 0) {
    await tx.db
      .insertInto('loyalty_ledger')
      .values({ tenant_id: tx.tenantId, customer_id: c.id, outlet_id: bill.outlet_id, bill_id: bill.id, kind: 'earn', points: earned, created_by: userId })
      .execute();
    await tx.db.updateTable('bills').set({ loyalty_points_earned: earned }).where('id', '=', bill.id).execute();
  }
}

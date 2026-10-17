// Points redeemed at billing: a discount on the draft, taken off the balance when the bill prints
// and given back if it is voided. Points are tenant-wide; the running programme sets their value.

import { sql } from 'kysely';
import type { Tx } from '../../context';
import { badRequest, conflict } from '../../lib/errors';
import { lockCustomer } from '../loyalty/engine';
import { pointsRule } from '../loyalty/program';

/** Checks a redemption request against the customer's balance and the programme's rules. */
export async function validateRedemption(tx: Tx, customerId: string | null, points: number): Promise<void> {
  if (points === 0) return;
  if (!customerId) throw badRequest('customer_required', 'Attach the customer before redeeming points');
  const rule = await pointsRule(tx);
  if (!rule) throw badRequest('loyalty_disabled', 'The loyalty programme does not run on points now');
  if (points < rule.min_redeem_points) throw badRequest('below_minimum', `Redeem at least ${rule.min_redeem_points} points`);
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

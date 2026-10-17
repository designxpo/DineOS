// Using a guest's reward on their bill: money off waits on the draft until it prints; a free dish
// is given as a free item (reason 'loyalty') on a line it fits.

import type { BillDTO, BillLoyaltyDTO, RewardDTO } from '@dineos/shared/dto';
import type { Reward } from '@dineos/shared/loyalty';
import type { Tx } from '../../context';
import { audit } from '../../lib/audit';
import { assertCan, type StaffAuth } from '../../lib/auth';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { announceBill, billableItems, compQtyByItem, syncDraft } from '../billing/service';
import { loadBill } from '../billing/serialize';
import { compForReward, removeComp } from '../comps/service';
import { customerLoyalty, rewardDto } from './engine';

async function draftBill(tx: Tx, auth: StaffAuth, billId: string) {
  const bill = await tx.db.selectFrom('bills').selectAll().where('id', '=', billId).forUpdate().executeTakeFirst();
  if (!bill) throw notFound('Bill');
  assertCan(auth, bill.outlet_id, 'bill.manage');
  if (bill.status !== 'draft') throw conflict('bill_finalised', 'This bill is already printed');
  if (!bill.customer_id) throw badRequest('customer_required', 'Attach the guest to the bill first');
  return bill as typeof bill & { customer_id: string };
}

/** For each free-dish reward, the lines on the bill it can make free: the right category, within the cap, not free already. */
async function eligibleLines(tx: Tx, bill: Parameters<typeof billableItems>[1], rewards: readonly RewardDTO[]): Promise<Record<string, string[]>> {
  const dishes = rewards.filter((r) => r.reward.kind === 'free_item' && r.status === 'available');
  if (!dishes.length) return {};
  const items = await billableItems(tx, bill);
  const free = await compQtyByItem(tx, items.map((i) => i.id));
  const menu = items.length ? await tx.db.selectFrom('menu_items').select(['id', 'category_id']).where('id', 'in', [...new Set(items.map((i) => i.item_id))]).execute() : [];
  const category = new Map(menu.map((m) => [m.id, m.category_id]));
  const out: Record<string, string[]> = {};
  for (const r of dishes) {
    const rule = r.reward as Extract<Reward, { kind: 'free_item' }>;
    out[r.id] = items
      .filter((i) => i.qty - (free.get(i.id) ?? 0) > 0)
      .filter((i) => !rule.category_ids.length || rule.category_ids.includes(category.get(i.item_id) ?? ''))
      .filter((i) => rule.max_value_paise === null || i.unit_price_paise <= rule.max_value_paise)
      .map((i) => i.id);
  }
  return out;
}

export async function billLoyalty(tx: Tx, auth: StaffAuth, billId: string): Promise<BillLoyaltyDTO | null> {
  const bill = await tx.db.selectFrom('bills').selectAll().where('id', '=', billId).executeTakeFirst();
  if (!bill) throw notFound('Bill');
  assertCan(auth, bill.outlet_id, 'customer.view');
  if (!bill.customer_id) return null;
  const state = await customerLoyalty(tx, bill.customer_id, bill.outlet_id);
  // Free dishes given on this bill are already used, but staff can still take them back here.
  const onBill = await tx.db
    .selectFrom('customer_rewards')
    .select(['id', 'source', 'label', 'reward', 'valid_from', 'valid_to', 'status', 'bill_id'])
    .where('bill_id', '=', bill.id)
    .where('status', '=', 'used')
    .where('comp_id', 'is not', null)
    .execute();
  const rewards = [...state.rewards.filter((r) => r.status === 'available' || r.bill_id === bill.id), ...(bill.status === 'draft' ? onBill.map(rewardDto) : [])];
  return { ...state, rewards, eligible: bill.status === 'draft' ? await eligibleLines(tx, bill, rewards) : {} };
}

/** Uses a reward on the guest's draft: money off (one per bill), or a free dish on `orderItemId`. */
export async function applyReward(tx: Tx, auth: StaffAuth, billId: string, rewardId: string, orderItemId: string | null): Promise<BillDTO> {
  const bill = await draftBill(tx, auth, billId);
  const row = await tx.db
    .selectFrom('customer_rewards')
    .select(['id', 'customer_id', 'status', 'label', 'reward', 'valid_from', 'valid_to'])
    .where('id', '=', rewardId)
    .forUpdate()
    .executeTakeFirst();
  if (!row || row.customer_id !== bill.customer_id) throw notFound('Reward');
  const now = new Date();
  if (row.status !== 'available' || row.valid_from > now || (row.valid_to && row.valid_to <= now)) throw conflict('reward_unavailable', 'This reward cannot be used now');
  const reward = row.reward as Reward;

  if (reward.kind === 'free_item') {
    if (!orderItemId) throw badRequest('item_required', 'Choose the dish to give free');
    const fits = await eligibleLines(tx, bill, [{ id: row.id, reward, status: 'available' } as RewardDTO]);
    if (!fits[row.id]!.includes(orderItemId)) throw badRequest('item_not_eligible', 'That dish is not covered by this reward');
    const compId = await compForReward(tx, auth, orderItemId, row.label, bill.customer_id);
    await tx.db.updateTable('customer_rewards').set({ status: 'used', bill_id: bill.id, comp_id: compId, used_at: now }).where('id', '=', row.id).execute();
  } else {
    const other = await tx.db
      .selectFrom('customer_rewards')
      .select('id')
      .where('bill_id', '=', bill.id)
      .where('comp_id', 'is', null)
      .where('status', 'in', ['applied', 'used'])
      .executeTakeFirst();
    if (other) throw conflict('one_reward', 'One money-off reward per bill');
    await tx.db.updateTable('customer_rewards').set({ status: 'applied', bill_id: bill.id }).where('id', '=', row.id).execute();
    await syncDraft(tx, bill.id);
  }
  await audit(tx, auth, { outletId: bill.outlet_id, action: 'loyalty.reward_use', entity: 'bill', entityId: bill.id, after: { reward_id: row.id, label: row.label, order_item_id: orderItemId } });
  const dto = (await loadBill(tx, bill.id))!;
  await announceBill(tx, dto);
  return dto;
}

/** Takes a reward back off the draft; the guest keeps it for another time. */
export async function removeReward(tx: Tx, auth: StaffAuth, billId: string, rewardId: string): Promise<BillDTO> {
  const bill = await draftBill(tx, auth, billId);
  const row = await tx.db.selectFrom('customer_rewards').select(['id', 'comp_id', 'label']).where('id', '=', rewardId).where('bill_id', '=', bill.id).forUpdate().executeTakeFirst();
  if (!row) throw notFound('Reward');
  // Taking the free dish back releases its reward (see removeComp).
  if (row.comp_id) await removeComp(tx, auth, row.comp_id);
  else {
    await tx.db.updateTable('customer_rewards').set({ status: 'available', bill_id: null }).where('id', '=', row.id).execute();
    await syncDraft(tx, bill.id);
  }
  await audit(tx, auth, { outletId: bill.outlet_id, action: 'loyalty.reward_undo', entity: 'bill', entityId: bill.id, before: { reward_id: row.id, label: row.label } });
  const dto = (await loadBill(tx, bill.id))!;
  await announceBill(tx, dto);
  return dto;
}

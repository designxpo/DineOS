// What guests earn and what waits for them. Points and stamps are earned once a bill is paid;
// rewards (a full stamp card, a level's monthly perk, a welcome gift, birthday and comeback
// offers) wait on the guest until staff use them on a bill. Moments need no messages: they are
// found when the guest is next attached to a bill or signs in at a table.

import { sql } from 'kysely';
import type { CustomerLoyaltyDTO, RewardDTO } from '@dineos/shared/dto';
import type { RewardSource } from '@dineos/shared/enums';
import { describeProgram, describeReward, inHappyHours, levelIndex, type CategoryNames, type LoyaltyConfig, type Reward } from '@dineos/shared/loyalty';
import type { Tx } from '../../context';
import { json } from '../../db';
import { badRequest } from '../../lib/errors';
import { activeProgram, categoryNames, type Program } from './program';

const DAY = 86_400_000;
/** Visits closer together than this count as one (split bills, a second round of drinks). */
export const VISIT_WINDOW_MS = 3 * 3600_000;

const SOURCE_LABEL: Record<RewardSource, string> = {
  stamps: 'Stamp card',
  level: 'Level perk',
  welcome: 'Welcome gift',
  birthday: 'Birthday treat',
  comeback: 'Welcome back',
};

export async function lockCustomer(tx: Tx, customerId: string) {
  const c = await tx.db
    .selectFrom('customers')
    .select(['id', 'points', 'stamps', 'level', 'visits', 'birthday', 'erased_at', 'last_visit_at'])
    .where('id', '=', customerId)
    .forUpdate()
    .executeTakeFirst();
  if (!c || c.erased_at) throw badRequest('invalid_customer', 'Customer not found');
  return c;
}

async function timezone(tx: Tx, outletId: string): Promise<string> {
  return (await tx.db.selectFrom('outlets').select('timezone').where('id', '=', outletId).executeTakeFirstOrThrow()).timezone;
}

/** Midnight at the start of the day after `at`, in the outlet's time zone, as an instant. */
function endOfLocalDay(at: Date, timeZone: string, plusDays = 0): Date {
  const local = new Date(at.toLocaleString('en-US', { timeZone }));
  const offset = local.getTime() - at.getTime();
  const end = new Date(local.getFullYear(), local.getMonth(), local.getDate() + 1 + plusDays);
  return new Date(end.getTime() - offset);
}

async function grant(
  tx: Tx,
  program: Program,
  names: CategoryNames,
  customerId: string,
  source: RewardSource,
  reward: Reward,
  validFrom: Date,
  validTo: Date | null,
): Promise<void> {
  const what = describeReward(reward, names);
  await tx.db
    .insertInto('customer_rewards')
    .values({
      tenant_id: tx.tenantId,
      customer_id: customerId,
      program_id: program.id,
      source,
      label: `${SOURCE_LABEL[source]}: ${what}`,
      reward: json(reward),
      valid_from: validFrom,
      valid_to: validTo,
    })
    .execute();
}

/** Visits (distinct days with a paid bill) and spend over the last 12 months. */
async function yearStats(tx: Tx, customerId: string): Promise<{ visits: number; spend: number }> {
  const r = await tx.db
    .selectFrom('bills')
    .select([sql<number>`count(distinct invoice_date)`.as('visits'), sql<number>`coalesce(sum(total_paise), 0)`.as('spend')])
    .where('customer_id', '=', customerId)
    .where('status', '=', 'paid')
    .where('paid_at', '>', new Date(Date.now() - 365 * DAY))
    .executeTakeFirstOrThrow();
  return { visits: Number(r.visits), spend: Number(r.spend) };
}

/** Stamps a paid bill earns: one per visit, or one per item from the stamp categories not given free. */
async function stampsFor(tx: Tx, config: LoyaltyConfig, billId: string, totalPaise: number, newVisit: boolean): Promise<number> {
  const e = config.earn;
  if (e.kind !== 'stamps') return 0;
  if (e.per === 'visit') return newVisit && totalPaise >= e.min_bill_paise ? 1 : 0;
  let q = tx.db
    .selectFrom('bill_lines')
    .innerJoin('order_items', 'order_items.id', 'bill_lines.order_item_id')
    .innerJoin('menu_items', 'menu_items.id', 'order_items.item_id')
    .select(sql<number>`coalesce(sum(bill_lines.qty - bill_lines.comp_qty), 0)`.as('n'))
    .where('bill_lines.bill_id', '=', billId);
  if (e.category_ids.length) q = q.where('menu_items.category_id', 'in', e.category_ids);
  return Number((await q.executeTakeFirstOrThrow()).n);
}

/**
 * Once a bill is paid: count the visit and spend, and, while a programme runs, give points or
 * stamps (times the guest's level and happy hours), fill stamp cards, move levels, and give a
 * first-time guest the welcome gift for next time.
 */
export async function earnOnPaid(tx: Tx, billId: string, userId: string | null): Promise<void> {
  const bill = await tx.db.selectFrom('bills').select(['id', 'outlet_id', 'customer_id', 'total_paise']).where('id', '=', billId).executeTakeFirstOrThrow();
  if (!bill.customer_id) return;
  const program = await activeProgram(tx);
  const c = await lockCustomer(tx, bill.customer_id);
  const now = new Date();
  const newVisit = !c.last_visit_at || now.getTime() - c.last_visit_at.getTime() > VISIT_WINDOW_MS;
  const firstVisit = c.visits === 0 && newVisit;
  await tx.db
    .updateTable('customers')
    .set({ total_spend_paise: sql`total_spend_paise + ${bill.total_paise}`, visits: newVisit ? sql`visits + 1` : sql`visits`, last_visit_at: now })
    .where('id', '=', c.id)
    .execute();
  if (!program) return;

  const config = program.config;
  const tz = await timezone(tx, bill.outlet_id);
  const names = await categoryNames(tx, config);
  const levelAt = Math.max(0, config.levels.findIndex((l) => l.name === c.level));
  const multiplier = ((config.levels[levelAt]?.multiplier_bp ?? 10_000) * (inHappyHours(config.happy_hours, now, tz) ? config.happy_hours!.multiplier_bp : 10_000)) / 10_000;
  const e = config.earn;
  const points = e.kind === 'points' ? Math.floor((bill.total_paise * e.earn_bp * multiplier) / 10_000 / 10_000 / e.point_value_paise) : 0;
  const stamps = Math.floor(((await stampsFor(tx, config, bill.id, bill.total_paise, newVisit)) * multiplier) / 10_000);

  let card = c.stamps + stamps;
  if (e.kind === 'stamps') {
    for (; card >= e.goal; card -= e.goal) await grant(tx, program, names, c.id, 'stamps', e.reward, now, new Date(now.getTime() + config.reward_days * DAY));
  }
  await tx.db.updateTable('customers').set({ points: c.points + points, stamps: card }).where('id', '=', c.id).execute();
  if (points || stamps) {
    await tx.db
      .insertInto('loyalty_ledger')
      .values({ tenant_id: tx.tenantId, customer_id: c.id, outlet_id: bill.outlet_id, bill_id: bill.id, kind: 'earn', points, stamps, created_by: userId })
      .execute();
  }
  if (points) await tx.db.updateTable('bills').set({ loyalty_points_earned: points }).where('id', '=', bill.id).execute();

  if (firstVisit && config.welcome) {
    // For the next visit, so a made-up number at the counter gets nothing today.
    if (config.welcome.kind === 'points') {
      await tx.db.updateTable('customers').set({ points: sql`points + ${config.welcome.points}` }).where('id', '=', c.id).execute();
      await tx.db
        .insertInto('loyalty_ledger')
        .values({ tenant_id: tx.tenantId, customer_id: c.id, outlet_id: bill.outlet_id, kind: 'bonus', points: config.welcome.points, note: 'Welcome gift', created_by: userId })
        .execute();
    } else {
      await grant(tx, program, names, c.id, 'welcome', config.welcome, new Date(now.getTime() + VISIT_WINDOW_MS), new Date(now.getTime() + config.reward_days * DAY));
    }
  }

  if (config.levels.length) {
    const { visits, spend } = await yearStats(tx, c.id);
    const level = config.levels[levelIndex(config.levels, visits, spend)]!;
    if (level.name !== c.level) {
      await tx.db.updateTable('customers').set({ level: level.name }).where('id', '=', c.id).execute();
      // A guest who moves up gets this month's perk straight away.
      if (level.perk) await levelPerk(tx, program, names, c.id, level.perk, now, tz);
    }
  }
}

/** The level's perk for this calendar month, once. */
async function levelPerk(tx: Tx, program: Program, names: CategoryNames, customerId: string, perk: Reward, now: Date, tz: string): Promise<void> {
  const local = new Date(now.toLocaleString('en-US', { timeZone: tz }));
  const monthStart = endOfLocalDay(now, tz, -local.getDate());
  const had = await tx.db
    .selectFrom('customer_rewards')
    .select('id')
    .where('customer_id', '=', customerId)
    .where('source', '=', 'level')
    .where('created_at', '>=', monthStart)
    .executeTakeFirst();
  if (had) return;
  const daysLeft = new Date(local.getFullYear(), local.getMonth() + 1, 0).getDate() - local.getDate();
  await grant(tx, program, names, customerId, 'level', perk, now, endOfLocalDay(now, tz, daysLeft));
}

/**
 * Brings a guest up to date when they turn up: points and stamps lapse after a long absence, and
 * the birthday treat, the comeback offer and this month's level perk appear when due.
 */
export async function refreshCustomer(tx: Tx, customerId: string, outletId: string, now = new Date()): Promise<void> {
  const program = await activeProgram(tx);
  if (!program) return;
  const config = program.config;
  const c = await lockCustomer(tx, customerId);
  const tz = await timezone(tx, outletId);
  const names = await categoryNames(tx, config);
  const away = c.last_visit_at ? now.getTime() - c.last_visit_at.getTime() : 0;

  if (config.expiry_days && away > config.expiry_days * DAY && (c.points > 0 || c.stamps > 0)) {
    await tx.db.updateTable('customers').set({ points: 0, stamps: 0 }).where('id', '=', c.id).execute();
    await tx.db
      .insertInto('loyalty_ledger')
      .values({ tenant_id: tx.tenantId, customer_id: c.id, outlet_id: outletId, kind: 'expire', points: -c.points, stamps: -c.stamps, note: `No visit for ${config.expiry_days} days` })
      .execute();
  }

  if (config.birthday && c.birthday) {
    const today = new Date(now.toLocaleString('en-US', { timeZone: tz }));
    const [, m, d] = c.birthday.split('-').map(Number) as [number, number, number];
    // This year's birthday, or last or next year's when the window crosses New Year.
    const near = [-1, 0, 1]
      .map((y) => new Date(today.getFullYear() + y, m - 1, d))
      .find((b) => Math.abs(b.getTime() - new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()) <= config.birthday!.days * DAY);
    if (near) {
      const had = await tx.db
        .selectFrom('customer_rewards')
        .select('id')
        .where('customer_id', '=', c.id)
        .where('source', '=', 'birthday')
        .where('created_at', '>', new Date(now.getTime() - 300 * DAY))
        .executeTakeFirst();
      if (!had) {
        const daysLeft = Math.round((near.getTime() - new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()) / DAY) + config.birthday.days;
        await grant(tx, program, names, c.id, 'birthday', config.birthday.reward, now, endOfLocalDay(now, tz, daysLeft));
      }
    }
  }

  if (config.comeback && c.last_visit_at && away >= config.comeback.after_days * DAY) {
    const had = await tx.db
      .selectFrom('customer_rewards')
      .select('id')
      .where('customer_id', '=', c.id)
      .where('source', '=', 'comeback')
      .where('created_at', '>', c.last_visit_at)
      .executeTakeFirst();
    if (!had) await grant(tx, program, names, c.id, 'comeback', config.comeback.reward, now, new Date(now.getTime() + config.reward_days * DAY));
  }

  const level = config.levels.find((l) => l.name === c.level);
  if (level?.perk) await levelPerk(tx, program, names, c.id, level.perk, now, tz);
}

export function rewardDto(r: { id: string; source: string; label: string; reward: unknown; valid_from: Date; valid_to: Date | null; status: string; bill_id: string | null }): RewardDTO {
  return {
    id: r.id,
    source: r.source as RewardSource,
    label: r.label,
    reward: r.reward as Reward,
    valid_from: r.valid_from.toISOString(),
    valid_to: r.valid_to?.toISOString() ?? null,
    status: r.status as RewardDTO['status'],
    bill_id: r.bill_id,
  };
}

/** Rewards ready to use now, and ones already on a draft bill. */
export async function openRewards(tx: Tx, customerId: string, now = new Date()): Promise<RewardDTO[]> {
  const rows = await tx.db
    .selectFrom('customer_rewards')
    .select(['id', 'source', 'label', 'reward', 'valid_from', 'valid_to', 'status', 'bill_id'])
    .where('customer_id', '=', customerId)
    .where((eb) =>
      eb.or([
        eb.and([eb('status', '=', 'available'), eb('valid_from', '<=', now), eb.or([eb('valid_to', 'is', null), eb('valid_to', '>', now)])]),
        eb('status', '=', 'applied'),
      ]),
    )
    .orderBy('valid_to')
    .execute();
  return rows.map(rewardDto);
}

/** Where a guest stands, after bringing them up to date. */
export async function customerLoyalty(tx: Tx, customerId: string, outletId: string): Promise<CustomerLoyaltyDTO> {
  await refreshCustomer(tx, customerId, outletId);
  const program = await activeProgram(tx);
  const c = await lockCustomer(tx, customerId);
  const config = program?.config;
  let level: CustomerLoyaltyDTO['level'] = null;
  if (config?.levels.length) {
    const { visits, spend } = await yearStats(tx, c.id);
    const at = levelIndex(config.levels, visits, spend);
    const next = config.levels[at + 1];
    level = {
      name: config.levels[at]!.name,
      next: next
        ? { name: next.name, visits: next.min_visits ? Math.max(0, next.min_visits - visits) : null, spend_paise: next.min_spend_paise ? Math.max(0, next.min_spend_paise - spend) : null }
        : null,
    };
  }
  const e = config?.earn;
  const names = await categoryNames(tx, config ?? null);
  return {
    program: program
      ? {
          name: program.name,
          earn: e!.kind,
          point_value_paise: e!.kind === 'points' ? e!.point_value_paise : null,
          min_redeem_points: e!.kind === 'points' ? e!.min_redeem_points : null,
          stamp_goal: e!.kind === 'stamps' ? e!.goal : null,
          stamp_reward: e!.kind === 'stamps' ? describeReward(e!.reward, names) : null,
        }
      : null,
    points: c.points,
    stamps: c.stamps,
    level,
    rewards: await openRewards(tx, c.id),
  };
}

/** The programme in one sentence for the guest's phone, spoken to them. */
export async function programSummary(tx: Tx, program: Program): Promise<string> {
  return describeProgram(program.config, await categoryNames(tx, program.config))[0]!.replace(/^Guests get/, 'You get').replace(/^No points or stamps: guests get the moments below\.$/, 'Treats on your next visits, your birthday and more.');
}

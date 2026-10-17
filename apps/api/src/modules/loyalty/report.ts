// What the loyalty programme does for the outlet: who joined and came back, what members spend
// against other guests, points earned and owed, and what rewards cost.

import { sql } from 'kysely';
import type { LoyaltyReportDTO } from '@dineos/shared/dto';
import { REWARD_SOURCES, type RewardSource } from '@dineos/shared/enums';
import type { Tx } from '../../context';
import type { Range } from '../reports/service';
import { currentProgram } from './program';

const n = (v: unknown) => Number(v ?? 0);

export async function loyaltyReport(tx: Tx, r: Range): Promise<LoyaltyReportDTO> {
  const localDay = (col: string) => sql<string>`(${sql.ref(col)} at time zone ${r.timezone})::date`;
  const bills = tx.db
    .selectFrom('bills')
    .where('outlet_id', '=', r.outletId)
    .where('status', 'in', ['finalised', 'paid'])
    .where('invoice_date', '>=', r.from)
    .where('invoice_date', '<=', r.to);

  const share = await bills
    .select([
      sql<number>`count(*)`.as('bills'),
      sql<number>`count(*) filter (where customer_id is not null)`.as('member_bills'),
      sql<number>`coalesce(avg(total_paise) filter (where customer_id is not null), 0)`.as('member_avg'),
      sql<number>`coalesce(avg(total_paise) filter (where customer_id is null), 0)`.as('guest_avg'),
    ])
    .executeTakeFirstOrThrow();
  const visits = await bills
    .select(['customer_id', sql<number>`count(distinct invoice_date)`.as('days')])
    .where('customer_id', 'is not', null)
    .groupBy('customer_id')
    .execute();
  const members = await tx.db
    .selectFrom('customers')
    .select([
      sql<number>`count(*)`.as('total'),
      sql<number>`count(*) filter (where ${localDay('created_at')} between ${r.from} and ${r.to})`.as('new'),
    ])
    .where('erased_at', 'is', null)
    .executeTakeFirstOrThrow();

  const ledger = await tx.db
    .selectFrom('loyalty_ledger')
    .select([
      sql<number>`coalesce(sum(points) filter (where kind in ('earn', 'bonus')), 0)`.as('earned'),
      sql<number>`coalesce(-sum(points) filter (where kind = 'redeem'), 0) - coalesce(sum(points) filter (where kind = 'reverse'), 0)`.as('redeemed'),
    ])
    .where('outlet_id', '=', r.outletId)
    .where(localDay('created_at'), '>=', r.from)
    .where(localDay('created_at'), '<=', r.to)
    .executeTakeFirstOrThrow();
  const owed = await tx.db.selectFrom('customers').select(sql<number>`coalesce(sum(points), 0)`.as('points')).where('erased_at', 'is', null).executeTakeFirstOrThrow();
  const program = await currentProgram(tx);
  const pointValue = program?.config.earn.kind === 'points' ? program.config.earn.point_value_paise : null;

  // Issued: earned in the dates. Used: spent in the dates; money off is worth what came off the
  // bill, a free dish its menu price, and costs its ingredients.
  const issued = await tx.db
    .selectFrom('customer_rewards')
    .select(['source', sql<number>`count(*)`.as('n')])
    .where(localDay('created_at'), '>=', r.from)
    .where(localDay('created_at'), '<=', r.to)
    .groupBy('source')
    .execute();
  const used = await tx.db
    .selectFrom('customer_rewards')
    .leftJoin('comps', 'comps.id', 'customer_rewards.comp_id')
    .leftJoin('bills', 'bills.id', 'customer_rewards.bill_id')
    .select([
      'customer_rewards.source',
      sql<number>`count(*)`.as('n'),
      sql<number>`coalesce(sum(case when customer_rewards.comp_id is null then bills.reward_discount_paise else comps.value_paise end), 0)`.as('value'),
      sql<number>`coalesce(sum(case when customer_rewards.comp_id is null then bills.reward_discount_paise else coalesce(comps.cost_paise, 0) end), 0)`.as('cost'),
    ])
    .where('customer_rewards.status', '=', 'used')
    .where(localDay('customer_rewards.used_at'), '>=', r.from)
    .where(localDay('customer_rewards.used_at'), '<=', r.to)
    .where((eb) => eb.or([eb('bills.outlet_id', '=', r.outletId), eb('comps.outlet_id', '=', r.outletId)]))
    .groupBy('customer_rewards.source')
    .execute();
  const levels = await tx.db
    .selectFrom('customers')
    .select(['level', sql<number>`count(*)`.as('n')])
    .where('erased_at', 'is', null)
    .where('level', 'is not', null)
    .groupBy('level')
    .execute();
  const order = program?.config.levels.map((l) => l.name) ?? [];

  // Memberships sold (paid for) in the dates, and running now, by plan.
  const now = new Date();
  const sold = await tx.db
    .selectFrom('bills')
    .innerJoin('customer_memberships', 'customer_memberships.id', 'bills.membership_id')
    .select([sql<string>`customer_memberships.plan_snapshot->>'name'`.as('plan'), sql<number>`count(*)`.as('n'), sql<number>`coalesce(sum(bills.total_paise), 0)`.as('revenue')])
    .where('bills.outlet_id', '=', r.outletId)
    .where('bills.status', '=', 'paid')
    .where(localDay('bills.paid_at'), '>=', r.from)
    .where(localDay('bills.paid_at'), '<=', r.to)
    .groupBy(sql`1`)
    .execute();
  const running = await tx.db
    .selectFrom('customer_memberships')
    .select([sql<string>`plan_snapshot->>'name'`.as('plan'), sql<number>`count(distinct customer_id)`.as('n')])
    .where('status', '=', 'active')
    .where('starts_at', '<=', now)
    .where('ends_at', '>', now)
    .groupBy(sql`1`)
    .execute();
  const plans = [...new Set([...sold.map((x) => x.plan), ...running.map((x) => x.plan)])];

  const flows = await tx.db
    .selectFrom('wallet_ledger')
    .select([
      sql<number>`coalesce(sum(paid_paise) filter (where kind = 'topup'), 0)`.as('topped_up'),
      sql<number>`coalesce(sum(bonus_paise) filter (where kind = 'topup'), 0)`.as('bonus'),
      sql<number>`coalesce(-sum(paid_paise + bonus_paise) filter (where kind = 'spend'), 0) - coalesce(sum(paid_paise + bonus_paise) filter (where kind = 'refund'), 0)`.as('spent'),
    ])
    .where('outlet_id', '=', r.outletId)
    .where(localDay('created_at'), '>=', r.from)
    .where(localDay('created_at'), '<=', r.to)
    .executeTakeFirstOrThrow();
  const held = await tx.db
    .selectFrom('customers')
    .select([sql<number>`coalesce(sum(wallet_paid_paise), 0)`.as('paid'), sql<number>`coalesce(sum(wallet_bonus_paise), 0)`.as('bonus')])
    .where('erased_at', 'is', null)
    .executeTakeFirstOrThrow();

  return {
    from: r.from,
    to: r.to,
    members: { total: n(members.total), new: n(members.new), visited: visits.length, repeat: visits.filter((v) => n(v.days) >= 2).length },
    member_bill_share_bp: n(share.bills) ? Math.round((n(share.member_bills) / n(share.bills)) * 10_000) : 0,
    member_avg_bill_paise: Math.round(n(share.member_avg)),
    guest_avg_bill_paise: Math.round(n(share.guest_avg)),
    points: { earned: n(ledger.earned), redeemed: n(ledger.redeemed), outstanding: n(owed.points), outstanding_paise: pointValue === null ? null : n(owed.points) * pointValue },
    rewards: REWARD_SOURCES.map((source: RewardSource) => {
      const u = used.find((x) => x.source === source);
      return { source, issued: n(issued.find((x) => x.source === source)?.n), used: n(u?.n), value_paise: n(u?.value), cost_paise: n(u?.cost) };
    }).filter((x) => x.issued || x.used),
    levels: levels
      .map((l) => ({ name: l.level!, guests: n(l.n) }))
      .sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name)),
    memberships: plans.map((plan) => {
      const s = sold.find((x) => x.plan === plan);
      return { plan, sold: n(s?.n), revenue_paise: n(s?.revenue), active: n(running.find((x) => x.plan === plan)?.n) };
    }),
    wallet: {
      topped_up_paise: n(flows.topped_up),
      bonus_given_paise: n(flows.bonus),
      spent_paise: n(flows.spent),
      outstanding_paid_paise: n(held.paid),
      outstanding_bonus_paise: n(held.bonus),
    },
  };
}

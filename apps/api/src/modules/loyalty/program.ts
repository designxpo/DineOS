// The tenant's loyalty programme (one for all its outlets): read by billing and the guest app,
// saved by the owner from a template or from scratch.

import { sql } from 'kysely';
import { z } from 'zod';
import type { LoyaltyProgramDTO, ProgramStatus } from '@dineos/shared/dto';
import { checkProgram, EMPTY_PROGRAM, PROGRAM_TEMPLATE_KEYS, type CategoryNames, type EarnRule, type LoyaltyConfig, type ProgramTemplateKey } from '@dineos/shared/loyalty';
import type { Tx } from '../../context';
import { json } from '../../db';
import { audit } from '../../lib/audit';
import type { StaffAuth } from '../../lib/auth';
import { badRequest } from '../../lib/errors';

export interface Program {
  id: string;
  name: string;
  template: ProgramTemplateKey | null;
  status: ProgramStatus;
  config: LoyaltyConfig;
  activated_at: Date | null;
  updated_at: Date;
}

const COLUMNS = ['id', 'name', 'template', 'status', 'config', 'activated_at', 'updated_at'] as const;

/**
 * The programme being set up or run. An outlet that ran points before programmes existed gets a
 * Cashback programme with the same numbers the first time anything asks.
 */
export async function currentProgram(tx: Tx): Promise<Program | null> {
  const row = await tx.db.selectFrom('loyalty_programs').select(COLUMNS).where('status', '<>', 'archived').executeTakeFirst();
  if (row) return { ...row, template: row.template as ProgramTemplateKey | null, status: row.status as ProgramStatus, config: row.config as unknown as LoyaltyConfig };
  const legacy = await tx.db
    .selectFrom('outlets')
    .select(['loyalty_earn_bp', 'loyalty_point_value_paise', 'loyalty_min_redeem_points'])
    .where('loyalty_enabled', '=', true)
    .orderBy('created_at')
    .executeTakeFirst();
  if (!legacy) return null;
  const config: LoyaltyConfig = {
    ...EMPTY_PROGRAM,
    earn: { kind: 'points', earn_bp: legacy.loyalty_earn_bp, point_value_paise: legacy.loyalty_point_value_paise, min_redeem_points: legacy.loyalty_min_redeem_points },
  };
  await tx.db
    .insertInto('loyalty_programs')
    .values({ tenant_id: tx.tenantId, name: 'Cashback points', template: 'cashback', status: 'active', config: json(config), activated_at: new Date() })
    .onConflict((oc) => oc.column('tenant_id').where('status', '<>', 'archived').doNothing())
    .execute();
  return currentProgram(tx);
}

/** The programme guests earn in now: none while it is a draft or paused. */
export async function activeProgram(tx: Tx): Promise<Program | null> {
  const p = await currentProgram(tx);
  return p?.status === 'active' ? p : null;
}

/** Points maths, when the running programme gives points. */
export async function pointsRule(tx: Tx): Promise<Extract<EarnRule, { kind: 'points' }> | null> {
  const p = await activeProgram(tx);
  return p?.config.earn.kind === 'points' ? p.config.earn : null;
}

/** Names of menu categories across the tenant's outlets, for describing rewards. */
export async function categoryNames(tx: Tx, config: LoyaltyConfig | null): Promise<CategoryNames> {
  const ids = config ? programCategoryIds(config) : [];
  const rows = ids.length ? await tx.db.selectFrom('menu_categories').select(['id', 'name']).where('id', 'in', ids).execute() : [];
  const byId = new Map(rows.map((r) => [r.id, r.name]));
  return (list) => {
    const names = [...new Set(list.map((id) => byId.get(id)).filter((n): n is string => !!n))];
    return names.length ? names.join(', ') : null;
  };
}

export function programCategoryIds(c: LoyaltyConfig): string[] {
  const rewards = [c.earn.kind === 'stamps' ? c.earn.reward : null, c.welcome, c.birthday?.reward, c.comeback?.reward, ...c.levels.map((l) => l.perk)];
  const ids = [
    ...(c.earn.kind === 'stamps' ? c.earn.category_ids : []),
    ...rewards.flatMap((r) => (r && r.kind === 'free_item' ? r.category_ids : [])),
  ];
  return [...new Set(ids)];
}

const money = z.number().int().min(0).max(100_000_000);
const ids = z.array(z.uuid()).max(100);
const rewardOptions = [
  z.object({ kind: z.literal('free_item'), category_ids: ids, max_value_paise: money.nullable() }),
  z.object({ kind: z.literal('amount_off'), paise: money }),
  z.object({ kind: z.literal('percent_off'), bp: z.number().int().min(0).max(10_000), max_paise: money.nullable() }),
] as const;
const reward = z.discriminatedUnion('kind', [...rewardOptions]);

export const configSchema = z.object({
  earn: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('none') }),
    z.object({ kind: z.literal('points'), earn_bp: z.number().int().min(0).max(5000), point_value_paise: z.number().int().min(1).max(100_000), min_redeem_points: z.number().int().min(0).max(1_000_000) }),
    z.object({ kind: z.literal('stamps'), per: z.enum(['visit', 'item']), category_ids: ids, min_bill_paise: money, goal: z.number().int().min(1).max(100), reward }),
  ]),
  levels: z
    .array(z.object({ name: z.string().trim().max(30), min_visits: z.number().int().min(0).max(1000), min_spend_paise: money, multiplier_bp: z.number().int().min(0).max(100_000), perk: reward.nullable() }))
    .max(10),
  welcome: z.discriminatedUnion('kind', [...rewardOptions, z.object({ kind: z.literal('points'), points: z.number().int().min(0).max(1_000_000) })]).nullable(),
  birthday: z.object({ reward, days: z.number().int().min(0).max(31) }).nullable(),
  comeback: z.object({ after_days: z.number().int().min(1).max(1000), reward }).nullable(),
  happy_hours: z
    .object({ days: z.array(z.number().int().min(0).max(6)).max(7), from: z.string().max(5), to: z.string().max(5), multiplier_bp: z.number().int().min(0).max(100_000) })
    .nullable(),
  expiry_days: z.number().int().min(1).max(5000).nullable(),
  reward_days: z.number().int().min(1).max(1000),
});

export const programBody = z.object({
  name: z.string().trim().min(1).max(60),
  template: z.enum(PROGRAM_TEMPLATE_KEYS).nullable(),
  status: z.enum(['draft', 'active', 'paused']),
  config: configSchema,
});

export async function programDto(tx: Tx, p: Program): Promise<LoyaltyProgramDTO> {
  const h = await tx.db
    .selectFrom('customers')
    .select([
      sql<number>`count(*) filter (where points > 0)`.as('points_guests'),
      sql<number>`coalesce(sum(points), 0)`.as('points'),
      sql<number>`count(*) filter (where stamps > 0)`.as('stamps_guests'),
    ])
    .where('erased_at', 'is', null)
    .executeTakeFirstOrThrow();
  return {
    id: p.id,
    name: p.name,
    template: p.template,
    status: p.status,
    config: p.config,
    activated_at: p.activated_at?.toISOString() ?? null,
    updated_at: p.updated_at.toISOString(),
    holders: { points_guests: Number(h.points_guests), points: Number(h.points), stamps_guests: Number(h.stamps_guests) },
  };
}

/**
 * Saves the programme. It can be kept as a draft while half-built; going live (or staying live)
 * needs it to make sense, and every free-dish category to be on the tenant's menu.
 */
export async function saveProgram(tx: Tx, auth: StaffAuth, outletId: string, input: z.infer<typeof programBody>): Promise<LoyaltyProgramDTO> {
  const config = input.config as LoyaltyConfig;
  if (input.status !== 'draft') {
    const problem = checkProgram(config);
    if (problem) throw badRequest('invalid_program', problem);
  }
  const wanted = programCategoryIds(config);
  if (wanted.length) {
    const found = await tx.db.selectFrom('menu_categories').select('id').where('id', 'in', wanted).where('deleted_at', 'is', null).execute();
    if (found.length !== wanted.length) throw badRequest('unknown_category', 'A chosen menu category no longer exists');
  }
  const before = await currentProgram(tx);
  const goesLive = input.status === 'active' && before?.status !== 'active';
  const values = { name: input.name, template: input.template, status: input.status, config: json(config), ...(goesLive ? { activated_at: new Date() } : {}) };
  if (before) await tx.db.updateTable('loyalty_programs').set(values).where('id', '=', before.id).execute();
  else await tx.db.insertInto('loyalty_programs').values({ tenant_id: tx.tenantId, created_by: auth.userId, ...values }).execute();
  await audit(tx, auth, {
    outletId,
    action: 'loyalty.program',
    entity: 'loyalty_program',
    entityId: before?.id ?? null,
    before: before ? { status: before.status, name: before.name, config: before.config } : undefined,
    after: { status: input.status, name: input.name, template: input.template, config },
  });
  return programDto(tx, (await currentProgram(tx))!);
}

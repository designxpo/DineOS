// Loyalty programmes: one engine, many shapes. A programme is how guests earn (points, stamps or
// nothing), optional levels, and moments (welcome, birthday, comeback, happy hours). A template is
// a filled-in programme an owner starts from; starting from scratch is the same form, empty.
// Pure functions so the owner's preview and the server agree.

import { formatPrice, formatRate } from './money';

export type Reward =
  /** A dish or drink from these categories (any, when empty), worth up to the cap. */
  | { kind: 'free_item'; category_ids: string[]; max_value_paise: number | null }
  | { kind: 'amount_off'; paise: number }
  | { kind: 'percent_off'; bp: number; max_paise: number | null };

export type EarnRule =
  | { kind: 'none' }
  /** A share of each paid bill back as points, spent as money off a later bill. */
  | { kind: 'points'; earn_bp: number; point_value_paise: number; min_redeem_points: number }
  /** A stamp per visit (bills from `min_bill_paise`) or per item from the categories; `goal` stamps earn the reward. */
  | { kind: 'stamps'; per: 'visit' | 'item'; category_ids: string[]; min_bill_paise: number; goal: number; reward: Reward };

export interface Level {
  name: string;
  /** Reached with this many visits, or this much spend, in the last 12 months. 0 means not used. */
  min_visits: number;
  min_spend_paise: number;
  /** Earning at this level, as basis points of the normal rate: 15000 is 1.5×. */
  multiplier_bp: number;
  /** Given once every calendar month while at this level. */
  perk: Reward | null;
}

export type WelcomeGift = Reward | { kind: 'points'; points: number };

export interface HappyHours {
  /** 0 is Sunday. */
  days: number[];
  from: string;
  to: string;
  multiplier_bp: number;
}

export interface LoyaltyConfig {
  earn: EarnRule;
  /** Empty, or the starting level first. */
  levels: Level[];
  /** For a new member's next visit (not the one they join on). */
  welcome: WelcomeGift | null;
  /** Valid from `days` before the birthday to `days` after. */
  birthday: { reward: Reward; days: number } | null;
  /** Waiting for a guest who returns after `after_days` away. */
  comeback: { after_days: number; reward: Reward } | null;
  happy_hours: HappyHours | null;
  /** Points and stamps lapse after this many days without a visit; null keeps them. */
  expiry_days: number | null;
  /** How long an earned reward stays valid. */
  reward_days: number;
}

export const EMPTY_PROGRAM: LoyaltyConfig = {
  earn: { kind: 'none' },
  levels: [],
  welcome: null,
  birthday: null,
  comeback: null,
  happy_hours: null,
  expiry_days: null,
  reward_days: 60,
};

export const PROGRAM_TEMPLATE_KEYS = ['stamp_card', 'cashback', 'regulars_club', 'birthday_comeback', 'happy_hours'] as const;
export type ProgramTemplateKey = (typeof PROGRAM_TEMPLATE_KEYS)[number];

export interface ProgramTemplate {
  key: ProgramTemplateKey;
  name: string;
  /** One line on the gallery card: what guests get. */
  pitch: string;
  best_for: string;
  config: LoyaltyConfig;
}

const points = { kind: 'points', earn_bp: 500, point_value_paise: 100, min_redeem_points: 100 } as const;

export const PROGRAM_TEMPLATES: readonly ProgramTemplate[] = [
  {
    key: 'stamp_card',
    name: 'Coffee stamp card',
    pitch: 'Every coffee earns a stamp; 10 stamps get a free coffee.',
    best_for: 'Cafés, bakeries, juice bars',
    config: {
      ...EMPTY_PROGRAM,
      earn: { kind: 'stamps', per: 'item', category_ids: [], min_bill_paise: 0, goal: 10, reward: { kind: 'free_item', category_ids: [], max_value_paise: 25_000 } },
      expiry_days: 180,
    },
  },
  {
    key: 'cashback',
    name: 'Cashback points',
    pitch: '5% of every bill comes back as points to spend next time.',
    best_for: 'Any outlet',
    config: { ...EMPTY_PROGRAM, earn: { ...points }, expiry_days: 365 },
  },
  {
    key: 'regulars_club',
    name: "Regulars' club",
    pitch: 'Guests move up from Member to Regular to VIP, earning faster as they go.',
    best_for: 'Casual dining, café groups',
    config: {
      ...EMPTY_PROGRAM,
      earn: { ...points },
      levels: [
        { name: 'Member', min_visits: 0, min_spend_paise: 0, multiplier_bp: 10_000, perk: null },
        { name: 'Regular', min_visits: 6, min_spend_paise: 600_000, multiplier_bp: 15_000, perk: null },
        { name: 'VIP', min_visits: 15, min_spend_paise: 1_500_000, multiplier_bp: 20_000, perk: { kind: 'free_item', category_ids: [], max_value_paise: 20_000 } },
      ],
      expiry_days: 365,
    },
  },
  {
    key: 'birthday_comeback',
    name: 'Birthday and comeback',
    pitch: 'A treat in their birthday week, and an offer when they come back after a month away.',
    best_for: 'Everyone; needs no points at all',
    config: {
      ...EMPTY_PROGRAM,
      welcome: { kind: 'percent_off', bp: 1000, max_paise: 20_000 },
      birthday: { reward: { kind: 'free_item', category_ids: [], max_value_paise: 25_000 }, days: 3 },
      comeback: { after_days: 30, reward: { kind: 'percent_off', bp: 1000, max_paise: 30_000 } },
    },
  },
  {
    key: 'happy_hours',
    name: 'Happy-hour points',
    pitch: 'Points on every bill, doubled on weekday afternoons to fill the quiet hours.',
    best_for: 'Outlets with a slow afternoon',
    config: { ...EMPTY_PROGRAM, earn: { ...points }, happy_hours: { days: [1, 2, 3, 4, 5], from: '15:00', to: '18:00', multiplier_bp: 20_000 }, expiry_days: 365 },
  },
];

/** Category names for ids, joined ("Coffee, Tea"); null when the list is empty (anything counts). */
export type CategoryNames = (ids: readonly string[]) => string | null;
const noNames: CategoryNames = () => null;

export function describeReward(r: Reward, names: CategoryNames = noNames): string {
  if (r.kind === 'amount_off') return `${formatPrice(r.paise)} off the bill`;
  if (r.kind === 'percent_off') return `${formatRate(r.bp)} off the bill${r.max_paise ? ` (up to ${formatPrice(r.max_paise)})` : ''}`;
  const from = names(r.category_ids);
  return `a free ${from ? `item from ${from}` : 'dish or drink'}${r.max_value_paise ? ` (up to ${formatPrice(r.max_value_paise)})` : ''}`;
}

export function describeGift(g: WelcomeGift, names: CategoryNames = noNames): string {
  return g.kind === 'points' ? `${g.points} points` : describeReward(g, names);
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const times = (x: number) => `${Number((x / 10_000).toFixed(2))}×`;

/** "Mon–Fri", "Sat, Sun", "Every day" */
export function describeDays(days: readonly number[]): string {
  const d = [...new Set(days)].sort();
  if (d.length === 7) return 'Every day';
  const run = d.length > 2 && d.every((x, i) => i === 0 || x === d[i - 1]! + 1);
  return run ? `${DAY_NAMES[d[0]!]}–${DAY_NAMES[d.at(-1)!]}` : d.map((x) => DAY_NAMES[x]).join(', ');
}

/** The programme in plain sentences, as guests would have it explained. */
export function describeProgram(c: LoyaltyConfig, names: CategoryNames = noNames): string[] {
  const out: string[] = [];
  const e = c.earn;
  if (e.kind === 'points') {
    out.push(
      `Guests get ${formatRate(e.earn_bp)} of every paid bill back as points (1 point = ${formatPrice(e.point_value_paise)}), and can spend them from ${e.min_redeem_points} points.`,
    );
  } else if (e.kind === 'stamps') {
    const what = e.per === 'visit' ? `each visit${e.min_bill_paise ? ` with a bill of ${formatPrice(e.min_bill_paise)} or more` : ''}` : `every item ${names(e.category_ids) ? `from ${names(e.category_ids)}` : 'they buy'}`;
    out.push(`Guests get a stamp for ${what}. ${e.goal} stamps earn ${describeReward(e.reward, names)}.`);
  } else {
    out.push('No points or stamps: guests get the moments below.');
  }
  if (c.levels.length) {
    const unit = e.kind === 'stamps' ? 'stamps' : 'points';
    const parts = c.levels.map((l, i) => {
      if (i === 0) return `${l.name} to start`;
      const reach = [l.min_visits ? `${l.min_visits} visits` : null, l.min_spend_paise ? `${formatPrice(l.min_spend_paise)} spent` : null].filter(Boolean).join(' or ');
      const gets = [l.multiplier_bp !== 10_000 && e.kind !== 'none' ? `${times(l.multiplier_bp)} ${unit}` : null, l.perk ? `${describeReward(l.perk, names)} every month` : null].filter(Boolean).join(', ');
      return `${l.name} at ${reach} in a year${gets ? ` (${gets})` : ''}`;
    });
    out.push(`Levels: ${parts.join('; ')}.`);
  }
  if (c.welcome) out.push(`New members get ${describeGift(c.welcome, names)} on their next visit.`);
  if (c.birthday) out.push(`Birthday: ${describeReward(c.birthday.reward, names)}, from ${c.birthday.days} days before to ${c.birthday.days} days after.`);
  if (c.comeback) out.push(`Back after ${c.comeback.after_days} days away: ${describeReward(c.comeback.reward, names)}.`);
  if (c.happy_hours) {
    const h = c.happy_hours;
    out.push(`${describeDays(h.days)}, ${h.from}–${h.to}: ${times(h.multiplier_bp)} ${e.kind === 'stamps' ? 'stamps' : 'points'}.`);
  }
  if (c.expiry_days && e.kind !== 'none') out.push(`${e.kind === 'stamps' ? 'Stamps' : 'Points'} lapse after ${c.expiry_days} days without a visit.`);
  out.push(`Rewards are valid for ${c.reward_days} days once earned.`);
  return out;
}

/** The first problem with a programme, for the owner to fix; null when it can run. */
export function checkProgram(c: LoyaltyConfig): string | null {
  const reward = (r: Reward, what: string): string | null => {
    if (r.kind === 'amount_off' && r.paise < 100) return `${what}: the money off must be at least ₹1`;
    if (r.kind === 'percent_off' && (r.bp < 100 || r.bp > 10_000)) return `${what}: the percentage must be between 1% and 100%`;
    if (r.kind === 'free_item' && r.max_value_paise !== null && r.max_value_paise < 100) return `${what}: the free item's cap must be at least ₹1`;
    return null;
  };
  const e = c.earn;
  if (e.kind === 'points') {
    if (e.earn_bp < 10 || e.earn_bp > 5000) return 'Points back must be between 0.1% and 50% of the bill';
    if (e.point_value_paise < 1) return 'A point must be worth something';
    if (e.min_redeem_points < 0) return 'The minimum to spend cannot be negative';
  }
  if (e.kind === 'stamps') {
    if (e.goal < 2 || e.goal > 50) return 'The stamp card needs between 2 and 50 stamps';
    const bad = reward(e.reward, 'Stamp card reward');
    if (bad) return bad;
  }
  if (c.levels.length === 1) return 'Add a second level, or remove levels';
  if (c.levels.length > 6) return 'Use at most 6 levels';
  const seen = new Set<string>();
  for (const [i, l] of c.levels.entries()) {
    const name = l.name.trim().toLowerCase();
    if (!name) return 'Every level needs a name';
    if (seen.has(name)) return `Two levels are called ${l.name}`;
    seen.add(name);
    if (l.multiplier_bp < 10_000 || l.multiplier_bp > 50_000) return `${l.name}: earning must be between 1× and 5×`;
    if (i > 0) {
      if (!l.min_visits && !l.min_spend_paise) return `${l.name}: say how many visits or how much spend reaches it`;
      const prev = c.levels[i - 1]!;
      if ((l.min_visits && l.min_visits <= prev.min_visits) || (l.min_spend_paise && l.min_spend_paise <= prev.min_spend_paise)) {
        return `${l.name} must need more than ${prev.name}`;
      }
    }
    const bad = l.perk && reward(l.perk, `${l.name} perk`);
    if (bad) return bad;
  }
  if (c.welcome) {
    if (c.welcome.kind === 'points' && e.kind !== 'points') return 'Welcome points need a points programme';
    if (c.welcome.kind === 'points' && (c.welcome.points < 1 || c.welcome.points > 100_000)) return 'Welcome points must be between 1 and 100,000';
    const bad = c.welcome.kind !== 'points' && reward(c.welcome, 'Welcome gift');
    if (bad) return bad;
  }
  if (c.birthday) {
    if (c.birthday.days < 0 || c.birthday.days > 15) return 'The birthday window must be up to 15 days either side';
    const bad = reward(c.birthday.reward, 'Birthday treat');
    if (bad) return bad;
  }
  if (c.comeback) {
    if (c.comeback.after_days < 7 || c.comeback.after_days > 365) return 'Comeback must be between 7 and 365 days away';
    const bad = reward(c.comeback.reward, 'Comeback offer');
    if (bad) return bad;
  }
  const h = c.happy_hours;
  if (h) {
    if (e.kind === 'none') return 'Happy hours multiply points or stamps; choose one first';
    if (!h.days.length || h.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) return 'Pick the days for happy hours';
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(h.from) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(h.to) || h.from >= h.to) return 'Happy hours must start before they end, on the same day';
    if (h.multiplier_bp <= 10_000 || h.multiplier_bp > 50_000) return 'Happy hours must earn more than 1× and at most 5×';
  }
  if (c.expiry_days !== null && (c.expiry_days < 30 || c.expiry_days > 1095)) return 'Lapse after between 30 days and 3 years, or never';
  if (c.reward_days < 7 || c.reward_days > 365) return 'Rewards must stay valid between 7 and 365 days';
  if (e.kind === 'none' && !c.levels.some((l) => l.perk) && !c.welcome && !c.birthday && !c.comeback) return 'Give guests something: points, stamps or a moment';
  return null;
}

/** The highest level reached with these visits and spend in the last 12 months (0 with no levels). */
export function levelIndex(levels: readonly Level[], visits: number, spendPaise: number): number {
  let at = 0;
  levels.forEach((l, i) => {
    if (i > 0 && ((l.min_visits > 0 && visits >= l.min_visits) || (l.min_spend_paise > 0 && spendPaise >= l.min_spend_paise))) at = i;
  });
  return at;
}

/** Whether `at` falls in the happy hours, in the outlet's time zone. */
export function inHappyHours(h: HappyHours | null, at: Date, timeZone: string): boolean {
  if (!h) return false;
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const day = DAY_NAMES.indexOf(get('weekday'));
  const time = `${get('hour')}:${get('minute')}`;
  return h.days.includes(day) && time >= h.from && time < h.to;
}

export interface GuestProfile {
  avg_bill_paise: number;
  visits_per_month: number;
  /** Items from the stamp categories on a typical bill. */
  stamp_items_per_visit: number;
  /** A typical item price, for free items with no cap. */
  avg_item_paise: number;
}

export interface GiveBackEstimate {
  spend_per_year_paise: number;
  given_per_year_paise: number;
  /** What a guest like this gets back, in basis points of what they spend. */
  give_back_bp: number;
  lines: { label: string; paise: number }[];
}

/**
 * What a regular guest like this would get back in a year, if they used everything they earned.
 * Ignores happy hours (a bonus on top) and the welcome gift (once only).
 */
export function estimateGiveBack(c: LoyaltyConfig, g: GuestProfile, names: CategoryNames = noNames): GiveBackEstimate {
  const visits = Math.max(0, g.visits_per_month) * 12;
  const spend = visits * Math.max(0, g.avg_bill_paise);
  const level = c.levels[levelIndex(c.levels, visits, spend)];
  const mult = (level?.multiplier_bp ?? 10_000) / 10_000;
  const worth = (r: Reward) =>
    r.kind === 'amount_off' ? r.paise : r.kind === 'percent_off' ? Math.min(Math.round((g.avg_bill_paise * r.bp) / 10_000), r.max_paise ?? Infinity) : (r.max_value_paise ?? g.avg_item_paise);
  const lines: { label: string; paise: number }[] = [];
  const e = c.earn;
  if (e.kind === 'points') lines.push({ label: `Points (${formatRate(Math.round(e.earn_bp * mult))} back)`, paise: Math.round((spend * e.earn_bp * mult) / 10_000) });
  if (e.kind === 'stamps') {
    const perVisit = e.per === 'visit' ? (g.avg_bill_paise >= e.min_bill_paise ? 1 : 0) : g.stamp_items_per_visit;
    const rewards = Math.floor((visits * perVisit * mult) / e.goal);
    lines.push({ label: `${rewards} × ${describeReward(e.reward, names)}`, paise: rewards * worth(e.reward) });
  }
  if (level?.perk) lines.push({ label: `${level.name} perk, 12 a year`, paise: 12 * worth(level.perk) });
  if (c.birthday) lines.push({ label: 'Birthday treat', paise: worth(c.birthday.reward) });
  const given = lines.reduce((a, l) => a + l.paise, 0);
  return { spend_per_year_paise: spend, given_per_year_paise: given, give_back_bp: spend ? Math.round((given / spend) * 10_000) : 0, lines };
}

// ---------- Paid memberships ----------

export interface MembershipBenefits {
  /** A percentage off eligible dishes on every bill while it runs, capped per bill. */
  discount: { bp: number; category_ids: string[]; max_paise: number | null } | null;
  /** One free item a day, waiting as a reward. */
  daily_item: { category_ids: string[]; max_value_paise: number | null } | null;
  /** Points or stamps earned while it runs, as basis points of the normal rate. */
  multiplier_bp: number;
}

export interface MembershipPlanInput {
  name: string;
  price_paise: number;
  duration_days: number;
  /** GST on the membership itself: set what the outlet's accountant advises. */
  tax_rate_bp: number;
  hsn_sac: string | null;
  benefits: MembershipBenefits;
}

export const MEMBERSHIP_TEMPLATE_KEYS = ['coffee_a_day', 'diners_club', 'vip_year'] as const;
export type MembershipTemplateKey = (typeof MEMBERSHIP_TEMPLATE_KEYS)[number];

export const MEMBERSHIP_TEMPLATES: readonly { key: MembershipTemplateKey; pitch: string; best_for: string; plan: MembershipPlanInput }[] = [
  {
    key: 'coffee_a_day',
    pitch: 'A coffee every day for a month, paid up front.',
    best_for: 'Cafés with daily regulars',
    plan: { name: 'Coffee a day', price_paise: 99_900, duration_days: 30, tax_rate_bp: 1800, hsn_sac: null, benefits: { discount: null, daily_item: { category_ids: [], max_value_paise: 20_000 }, multiplier_bp: 10_000 } },
  },
  {
    key: 'diners_club',
    pitch: '15% off every bill for three months.',
    best_for: 'Casual dining with weekly regulars',
    plan: { name: "Diners' club", price_paise: 149_900, duration_days: 90, tax_rate_bp: 1800, hsn_sac: null, benefits: { discount: { bp: 1500, category_ids: [], max_paise: 50_000 }, daily_item: null, multiplier_bp: 10_000 } },
  },
  {
    key: 'vip_year',
    pitch: '10% off and double points for a whole year.',
    best_for: 'Your best guests',
    plan: { name: 'VIP year', price_paise: 499_900, duration_days: 365, tax_rate_bp: 1800, hsn_sac: null, benefits: { discount: { bp: 1000, category_ids: [], max_paise: 100_000 }, daily_item: null, multiplier_bp: 20_000 } },
  },
];

/** "30 days", "3 months", "1 year" */
export function describeDuration(days: number): string {
  if (days % 365 === 0) return days === 365 ? '1 year' : `${days / 365} years`;
  if (days % 30 === 0 && days >= 60) return `${days / 30} months`;
  return `${days} days`;
}

export function describeMembership(p: MembershipPlanInput, names: CategoryNames = noNames): string[] {
  const b = p.benefits;
  const out = [`${formatPrice(p.price_paise)} for ${describeDuration(p.duration_days)}, plus ${formatRate(p.tax_rate_bp)} GST.`];
  if (b.discount) {
    const on = names(b.discount.category_ids);
    out.push(`${formatRate(b.discount.bp)} off ${on ? `items from ${on}` : 'every bill'}${b.discount.max_paise ? ` (up to ${formatPrice(b.discount.max_paise)} a bill)` : ''}.`);
  }
  if (b.daily_item) out.push(`Every day: ${describeReward({ kind: 'free_item', ...b.daily_item }, names)}.`);
  if (b.multiplier_bp > 10_000) out.push(`${times(b.multiplier_bp)} points or stamps.`);
  return out;
}

export function checkMembership(p: MembershipPlanInput): string | null {
  if (!p.name.trim()) return 'Give the membership a name';
  if (p.price_paise < 100) return 'The price must be at least ₹1';
  if (p.duration_days < 1 || p.duration_days > 1095) return 'A membership lasts between 1 day and 3 years';
  if (p.tax_rate_bp < 0 || p.tax_rate_bp > 2800) return 'GST must be between 0% and 28%';
  const b = p.benefits;
  if (b.discount && (b.discount.bp < 100 || b.discount.bp > 10_000)) return 'The discount must be between 1% and 100%';
  if (b.multiplier_bp < 10_000 || b.multiplier_bp > 50_000) return 'Points must be between 1× and 5×';
  if (!b.discount && !b.daily_item && b.multiplier_bp === 10_000) return 'Give members something: a discount, a daily item or faster points';
  return null;
}

// ---------- Prepaid wallet ----------

export interface WalletPackInput {
  name: string;
  pay_paise: number;
  bonus_paise: number;
  validity_days: number;
}

export const WALLET_PACK_TEMPLATES: readonly WalletPackInput[] = [
  { name: 'Silver', pay_paise: 200_000, bonus_paise: 20_000, validity_days: 365 },
  { name: 'Gold', pay_paise: 500_000, bonus_paise: 75_000, validity_days: 365 },
  { name: 'Platinum', pay_paise: 1_000_000, bonus_paise: 200_000, validity_days: 365 },
];

export function describePack(p: WalletPackInput): string {
  const extra = p.bonus_paise ? ` (${formatRate(Math.round((p.bonus_paise / p.pay_paise) * 10_000))} extra)` : '';
  return `Pay ${formatPrice(p.pay_paise)}, get ${formatPrice(p.pay_paise + p.bonus_paise)} to spend${extra}, for ${describeDuration(p.validity_days)}.`;
}

export function checkPack(p: WalletPackInput): string | null {
  if (!p.name.trim()) return 'Give the pack a name';
  if (p.pay_paise < 10_000) return 'A top-up is at least ₹100';
  if (p.bonus_paise < 0 || p.bonus_paise > p.pay_paise) return 'The bonus cannot be more than what the guest pays';
  if (p.validity_days < 30 || p.validity_days > 1095) return 'Balances last between 30 days and 3 years';
  return null;
}

/**
 * How spending `amount` from a wallet splits between what the guest paid and the bonus: in the same
 * proportion as the balance, so every rupee spent carries its share of the bonus.
 */
export function splitSpend(paidPaise: number, bonusPaise: number, amount: number): { paid: number; bonus: number } {
  const total = paidPaise + bonusPaise;
  if (amount <= 0 || total <= 0) return { paid: 0, bonus: 0 };
  const take = Math.min(amount, total);
  const bonus = Math.min(bonusPaise, Math.round((take * bonusPaise) / total));
  return { paid: take - bonus, bonus };
}

import { describe, expect, it } from 'vitest';
import {
  checkMembership,
  checkPack,
  checkProgram,
  describeDays,
  describeMembership,
  describePack,
  describeProgram,
  EMPTY_PROGRAM,
  estimateGiveBack,
  inHappyHours,
  levelIndex,
  MEMBERSHIP_TEMPLATES,
  PROGRAM_TEMPLATES,
  splitSpend,
  WALLET_PACK_TEMPLATES,
  type LoyaltyConfig,
} from './loyalty';

const template = (key: string) => PROGRAM_TEMPLATES.find((t) => t.key === key)!.config;
const regular = { avg_bill_paise: 40_000, visits_per_month: 4, stamp_items_per_visit: 1, avg_item_paise: 20_000 };

describe('programme templates', () => {
  it('are all ready to run as they are', () => {
    for (const t of PROGRAM_TEMPLATES) expect(checkProgram(t.config), t.key).toBeNull();
  });

  it('explain themselves in plain sentences', () => {
    const names = (ids: readonly string[]) => (ids.length ? 'Coffee' : null);
    const stamps: LoyaltyConfig = { ...template('stamp_card'), earn: { kind: 'stamps', per: 'item', category_ids: ['c1'], min_bill_paise: 0, goal: 10, reward: { kind: 'free_item', category_ids: ['c1'], max_value_paise: 25_000 } } };
    expect(describeProgram(stamps, names)[0]).toBe('Guests get a stamp for every item from Coffee. 10 stamps earn a free item from Coffee (up to ₹250).');
    expect(describeProgram(template('cashback'))[0]).toBe('Guests get 5% of every paid bill back as points (1 point = ₹1), and can spend them from 100 points.');
    expect(describeProgram(template('regulars_club'))[1]).toBe(
      'Levels: Member to start; Regular at 6 visits or ₹6,000 spent in a year (1.5× points); VIP at 15 visits or ₹15,000 spent in a year (2× points, a free dish or drink (up to ₹200) every month).',
    );
    expect(describeProgram(template('happy_hours'))).toContain('Mon–Fri, 15:00–18:00: 2× points.');
    expect(describeProgram(template('birthday_comeback'))).toContain('Back after 30 days away: 10% off the bill (up to ₹300).');
  });
});

describe('checking a programme', () => {
  it('says what to fix', () => {
    expect(checkProgram(EMPTY_PROGRAM)).toBe('Give guests something: points, stamps or a moment');
    const club = template('regulars_club');
    expect(checkProgram({ ...club, levels: [club.levels[0]!, { ...club.levels[2]!, min_visits: 0, min_spend_paise: 0 }] })).toBe('VIP: say how many visits or how much spend reaches it');
    expect(checkProgram({ ...club, levels: [club.levels[0]!, club.levels[2]!, club.levels[1]!] })).toBe('Regular must need more than VIP');
    expect(checkProgram({ ...template('birthday_comeback'), happy_hours: { days: [1], from: '15:00', to: '18:00', multiplier_bp: 20_000 } })).toBe('Happy hours multiply points or stamps; choose one first');
    expect(checkProgram({ ...template('cashback'), happy_hours: { days: [1], from: '18:00', to: '15:00', multiplier_bp: 20_000 } })).toBe('Happy hours must start before they end, on the same day');
    expect(checkProgram({ ...template('stamp_card'), welcome: { kind: 'points', points: 50 } })).toBe('Welcome points need a points programme');
  });
});

describe('levels and happy hours', () => {
  it('reach a level by visits or by spend', () => {
    const levels = template('regulars_club').levels;
    expect(levelIndex(levels, 0, 0)).toBe(0);
    expect(levelIndex(levels, 6, 0)).toBe(1);
    expect(levelIndex(levels, 2, 1_500_000)).toBe(2);
    expect(levelIndex([], 50, 0)).toBe(0);
  });

  it('read the clock in the outlet time zone', () => {
    const h = template('happy_hours').happy_hours;
    // Wednesday 14 October 2026, 4 pm in India is 10:30 UTC.
    expect(inHappyHours(h, new Date('2026-10-14T10:30:00Z'), 'Asia/Kolkata')).toBe(true);
    expect(inHappyHours(h, new Date('2026-10-14T13:00:00Z'), 'Asia/Kolkata')).toBe(false);
    expect(inHappyHours(h, new Date('2026-10-17T10:30:00Z'), 'Asia/Kolkata')).toBe(false);
    expect(describeDays([0, 6])).toBe('Sun, Sat');
    expect(describeDays([0, 1, 2, 3, 4, 5, 6])).toBe('Every day');
  });
});

describe('what a regular gets back', () => {
  it('works it out per year', () => {
    expect(estimateGiveBack(template('cashback'), regular).give_back_bp).toBe(500);
    // 48 coffees a year: 4 free ones at up to ₹250 on ₹19,200 spent.
    const stamps = estimateGiveBack(template('stamp_card'), regular);
    expect(stamps.given_per_year_paise).toBe(100_000);
    expect(stamps.give_back_bp).toBe(521);
    // 48 visits make a VIP: 2× points plus a monthly free item up to ₹200.
    const club = estimateGiveBack(template('regulars_club'), regular);
    expect(club.lines.map((l) => l.paise)).toEqual([192_000, 240_000]);
  });
});

describe('memberships and wallet packs', () => {
  it('ship templates that are ready to sell, and say what members get', () => {
    for (const t of MEMBERSHIP_TEMPLATES) expect(checkMembership(t.plan), t.key).toBeNull();
    for (const p of WALLET_PACK_TEMPLATES) expect(checkPack(p), p.name).toBeNull();
    const coffee = MEMBERSHIP_TEMPLATES.find((t) => t.key === 'coffee_a_day')!.plan;
    expect(describeMembership(coffee, () => 'Coffee')).toEqual(['₹999 for 30 days, plus 18% GST.', 'Every day: a free item from Coffee (up to ₹200).']);
    expect(describeMembership(MEMBERSHIP_TEMPLATES.find((t) => t.key === 'vip_year')!.plan)).toEqual([
      '₹4,999 for 1 year, plus 18% GST.',
      '10% off every bill (up to ₹1,000 a bill).',
      '2× points or stamps.',
    ]);
    expect(describePack(WALLET_PACK_TEMPLATES[1]!)).toBe('Pay ₹5,000, get ₹5,750 to spend (15% extra), for 1 year.');
    expect(checkPack({ name: 'Too good', pay_paise: 100_000, bonus_paise: 150_000, validity_days: 365 })).toBe('The bonus cannot be more than what the guest pays');
  });

  it('spends paid and bonus money in the proportion they are held', () => {
    expect(splitSpend(200_000, 20_000, 52_500)).toEqual({ paid: 47_727, bonus: 4_773 });
    expect(splitSpend(100, 0, 50)).toEqual({ paid: 50, bonus: 0 });
    // Never more than the balance, never a negative share.
    expect(splitSpend(1000, 500, 5000)).toEqual({ paid: 1000, bonus: 500 });
    expect(splitSpend(0, 0, 100)).toEqual({ paid: 0, bonus: 0 });
  });
});


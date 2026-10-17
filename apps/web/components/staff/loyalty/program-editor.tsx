'use client';

import { AlertTriangle, Plus, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { LoyaltyProgramDTO, ProgramStatus } from '@mezmitra/shared/dto';
import {
  checkProgram,
  describeProgram,
  estimateGiveBack,
  type CategoryNames,
  type EarnRule,
  type Level,
  type LoyaltyConfig,
  type ProgramTemplateKey,
  type Reward,
} from '@mezmitra/shared/loyalty';
import { formatPaise, formatRate } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';
import { Badge, Card, Input, Segmented, Switch } from '@/components/ui/primitives';
import { CategoryPicker, NumberInput, PercentInput, RewardEditor, RupeeInput, TimesInput, type LoyaltyCategory } from './fields';

export interface ProgramDraft {
  name: string;
  template: ProgramTemplateKey | null;
  config: LoyaltyConfig;
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const freeDish: Reward = { kind: 'free_item', category_ids: [], max_value_paise: 25_000 };
const STATUS_LABEL: Record<ProgramStatus, string> = { draft: 'Draft', active: 'Live', paused: 'Paused' };

function earnFor(kind: EarnRule['kind']): EarnRule {
  if (kind === 'points') return { kind, earn_bp: 500, point_value_paise: 100, min_redeem_points: 100 };
  if (kind === 'stamps') return { kind, per: 'item', category_ids: [], min_bill_paise: 0, goal: 10, reward: freeDish };
  return { kind: 'none' };
}

const STARTER_LEVELS: Level[] = [
  { name: 'Member', min_visits: 0, min_spend_paise: 0, multiplier_bp: 10_000, perk: null },
  { name: 'Regular', min_visits: 6, min_spend_paise: 600_000, multiplier_bp: 15_000, perk: null },
  { name: 'VIP', min_visits: 15, min_spend_paise: 1_500_000, multiplier_bp: 20_000, perk: freeDish },
];

function Section({ title, hint, on, onToggle, children, disabled }: { title: string; hint: string; on?: boolean; onToggle?: (on: boolean) => void; children?: React.ReactNode; disabled?: boolean }) {
  return (
    <Card className="space-y-4 p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold">{title}</h2>
          <p className="text-sm text-ink-faint">{hint}</p>
        </div>
        {onToggle && <Switch label={title} checked={!!on} disabled={disabled} onChange={onToggle} />}
      </div>
      {(on ?? true) && children}
    </Card>
  );
}

function Labelled({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('space-y-1.5', className)}>
      <p className="text-sm font-medium">{label}</p>
      {children}
    </div>
  );
}

/**
 * The owner's programme form: the same blocks whether it started from a template or from scratch.
 * A live preview says, in plain words, what guests get and what a regular would get back.
 */
export function ProgramEditor({
  initial,
  saved,
  categories,
  busy,
  onSave,
  onRestart,
}: {
  initial: ProgramDraft;
  /** The programme as stored, or null while it has never been saved. */
  saved: LoyaltyProgramDTO | null;
  categories: LoyaltyCategory[];
  busy: boolean;
  onSave: (status: ProgramStatus, draft: ProgramDraft) => void;
  onRestart: () => void;
}) {
  const [name, setName] = useState(initial.name);
  const [config, setConfig] = useState<LoyaltyConfig>(initial.config);
  const [guest, setGuest] = useState({ avg_bill_paise: 60_000, visits_per_month: 4, stamp_items_per_visit: 1, avg_item_paise: 20_000 });
  const set = (patch: Partial<LoyaltyConfig>) => setConfig((c) => ({ ...c, ...patch }));
  const names: CategoryNames = useMemo(() => {
    const byId = new Map(categories.map((c) => [c.id, c.name]));
    return (ids) => [...new Set(ids.map((id) => byId.get(id)).filter(Boolean))].join(', ') || null;
  }, [categories]);
  const problem = checkProgram(config);
  const lines = describeProgram(config, names);
  const estimate = estimateGiveBack(config, guest, names);
  const e = config.earn;
  const unit = e.kind === 'stamps' ? 'stamps' : 'points';
  const status = saved?.status ?? null;
  // Switching how guests earn leaves what they hold behind; say so before it goes live.
  const stranded = saved && saved.config.earn.kind !== e.kind ? (saved.config.earn.kind === 'points' ? saved.holders.points_guests : saved.config.earn.kind === 'stamps' ? saved.holders.stamps_guests : 0) : 0;
  const draft = { name, template: initial.template, config };
  const setLevel = (i: number, patch: Partial<Level>) => set({ levels: config.levels.map((l, j) => (j === i ? { ...l, ...patch } : l)) });

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px] lg:items-start">
      <div className="space-y-4">
        <Card className="flex flex-wrap items-end gap-3 p-4 sm:p-5">
          <label className="w-full min-w-0 space-y-1.5 sm:w-auto sm:flex-1">
            <span className="text-sm font-medium">Programme name</span>
            <Input value={name} maxLength={60} onChange={(ev) => setName(ev.target.value)} placeholder="e.g. Coffee Club" />
          </label>
          {status && <Badge tone={status === 'active' ? 'green' : 'neutral'}>{STATUS_LABEL[status]}</Badge>}
          <Button variant="ghost" onClick={onRestart}>
            Start from a template
          </Button>
        </Card>

        <Section title="How guests earn" hint="Points come back as money off; stamps fill a card that earns a reward.">
          <Segmented
            value={e.kind}
            onChange={(k) => set({ earn: earnFor(k), ...(k === 'none' ? { happy_hours: null } : {}), ...(k !== 'points' && config.welcome?.kind === 'points' ? { welcome: null } : {}) })}
            options={[
              { value: 'points', label: 'Points' },
              { value: 'stamps', label: 'Stamps' },
              { value: 'none', label: 'Nothing' },
            ]}
          />
          {e.kind === 'points' && (
            <div className="grid gap-3 sm:grid-cols-3">
              <Labelled label="Back on every bill">
                <PercentInput label="Back on every bill" bp={e.earn_bp} onChange={(earn_bp) => set({ earn: { ...e, earn_bp } })} />
              </Labelled>
              <Labelled label="1 point is worth">
                <RupeeInput label="1 point is worth" paise={e.point_value_paise} onChange={(v) => set({ earn: { ...e, point_value_paise: Math.max(100, v ?? 100) } })} />
              </Labelled>
              <Labelled label="Spend from">
                <NumberInput label="Spend from" unit="points" value={e.min_redeem_points} onChange={(min_redeem_points) => set({ earn: { ...e, min_redeem_points } })} />
              </Labelled>
            </div>
          )}
          {e.kind === 'stamps' && (
            <div className="space-y-4">
              <Segmented
                size="sm"
                value={e.per}
                onChange={(per) => set({ earn: { ...e, per } })}
                options={[
                  { value: 'item', label: 'A stamp per item' },
                  { value: 'visit', label: 'A stamp per visit' },
                ]}
              />
              {e.per === 'item' ? (
                <Labelled label="Items that earn a stamp">
                  <CategoryPicker categories={categories} value={e.category_ids} onChange={(category_ids) => set({ earn: { ...e, category_ids } })} />
                </Labelled>
              ) : (
                <Labelled label="Bills from">
                  <RupeeInput className="w-36" label="Bills from" paise={e.min_bill_paise} onChange={(v) => set({ earn: { ...e, min_bill_paise: v ?? 0 } })} />
                </Labelled>
              )}
              <Labelled label="A full card">
                <NumberInput className="w-36" label="Stamps on a full card" unit="stamps" min={1} value={e.goal} onChange={(goal) => set({ earn: { ...e, goal } })} />
              </Labelled>
              <Labelled label="A full card earns">
                <RewardEditor value={e.reward} categories={categories} onChange={(reward) => set({ earn: { ...e, reward } })} />
              </Labelled>
            </div>
          )}
          {stranded > 0 && (
            <p className="flex items-start gap-2 rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-900">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              {stranded} guest{stranded === 1 ? ' holds' : 's hold'} {saved!.config.earn.kind}. Under this programme they cannot use them; switching back brings them back.
            </p>
          )}
        </Section>

        <Section title="Levels" hint="Guests move up by visits or spend in the last 12 months, and earn faster as they go." on={config.levels.length > 0} onToggle={(on) => set({ levels: on ? STARTER_LEVELS : [] })}>
          <div className="space-y-3">
            {config.levels.map((l, i) => (
              <div key={i} className="space-y-3 rounded-xl border border-line p-3">
                <div className="flex items-center gap-2">
                  <Input aria-label={`Level ${i + 1} name`} value={l.name} maxLength={30} onChange={(ev) => setLevel(i, { name: ev.target.value })} className="h-10 flex-1 font-medium" />
                  {i > 0 && config.levels.length > 2 && (
                    <button type="button" aria-label={`Remove ${l.name}`} onClick={() => set({ levels: config.levels.filter((_, j) => j !== i) })} className="grid size-10 cursor-pointer place-items-center rounded-xl text-ink-faint hover:bg-stone-100">
                      <Trash2 className="size-4" />
                    </button>
                  )}
                </div>
                {i === 0 ? (
                  <p className="text-xs text-ink-faint">Every guest starts here.</p>
                ) : (
                  <div className="grid gap-3 sm:grid-cols-3">
                    <Labelled label="Visits in a year">
                      <NumberInput label="Visits in a year" unit="visits" value={l.min_visits} onChange={(min_visits) => setLevel(i, { min_visits })} />
                    </Labelled>
                    <Labelled label="or spend in a year">
                      <RupeeInput label="Spend in a year" optional placeholder="Not used" paise={l.min_spend_paise || null} onChange={(v) => setLevel(i, { min_spend_paise: v ?? 0 })} />
                    </Labelled>
                    {e.kind !== 'none' && (
                      <Labelled label={`Earns ${unit}`}>
                        <TimesInput label={`${l.name} earns`} bp={l.multiplier_bp} onChange={(multiplier_bp) => setLevel(i, { multiplier_bp })} />
                      </Labelled>
                    )}
                  </div>
                )}
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm">A reward every month</span>
                  <Switch label={`${l.name} monthly reward`} checked={!!l.perk} onChange={(on) => setLevel(i, { perk: on ? freeDish : null })} />
                </div>
                {l.perk && <RewardEditor value={l.perk} categories={categories} onChange={(perk) => setLevel(i, { perk })} />}
              </div>
            ))}
            {config.levels.length < 6 && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  const last = config.levels.at(-1)!;
                  set({ levels: [...config.levels, { name: '', min_visits: last.min_visits + 10, min_spend_paise: last.min_spend_paise ? last.min_spend_paise + 1_000_000 : 0, multiplier_bp: last.multiplier_bp + 5000, perk: null }] });
                }}
              >
                <Plus className="size-4" /> Add a level
              </Button>
            )}
          </div>
        </Section>

        <Section title="Welcome gift" hint="For a new member's next visit, so it brings them back." on={!!config.welcome} onToggle={(on) => set({ welcome: on ? (e.kind === 'points' ? { kind: 'points', points: 50 } : { kind: 'amount_off', paise: 10_000 }) : null })}>
          {config.welcome && (
            <div className="space-y-3">
              {e.kind === 'points' && (
                <Segmented
                  size="sm"
                  value={config.welcome.kind === 'points' ? 'points' : 'reward'}
                  onChange={(v) => set({ welcome: v === 'points' ? { kind: 'points', points: 50 } : { kind: 'amount_off', paise: 10_000 } })}
                  options={[
                    { value: 'points', label: 'Points' },
                    { value: 'reward', label: 'A reward' },
                  ]}
                />
              )}
              {config.welcome.kind === 'points' ? (
                <NumberInput className="w-36" label="Welcome points" unit="points" value={config.welcome.points} onChange={(points) => set({ welcome: { kind: 'points', points } })} />
              ) : (
                <RewardEditor value={config.welcome} categories={categories} onChange={(welcome) => set({ welcome })} />
              )}
            </div>
          )}
        </Section>

        <Section title="Birthday treat" hint="Waiting for them around their birthday, if they gave you the date." on={!!config.birthday} onToggle={(on) => set({ birthday: on ? { reward: freeDish, days: 3 } : null })}>
          {config.birthday && (
            <div className="space-y-3">
              <Labelled label="Days either side of the birthday">
                <NumberInput className="w-36" label="Days either side" unit="days" value={config.birthday.days} onChange={(days) => set({ birthday: { ...config.birthday!, days } })} />
              </Labelled>
              <RewardEditor value={config.birthday.reward} categories={categories} onChange={(reward) => set({ birthday: { ...config.birthday!, reward } })} />
            </div>
          )}
        </Section>

        <Section title="Welcome back" hint="An offer for a guest who returns after a long gap." on={!!config.comeback} onToggle={(on) => set({ comeback: on ? { after_days: 30, reward: { kind: 'percent_off', bp: 1000, max_paise: 30_000 } } : null })}>
          {config.comeback && (
            <div className="space-y-3">
              <Labelled label="After this long away">
                <NumberInput className="w-36" label="Days away" unit="days" min={1} value={config.comeback.after_days} onChange={(after_days) => set({ comeback: { ...config.comeback!, after_days } })} />
              </Labelled>
              <RewardEditor value={config.comeback.reward} categories={categories} onChange={(reward) => set({ comeback: { ...config.comeback!, reward } })} />
            </div>
          )}
        </Section>

        <Section
          title="Happy hours"
          hint={e.kind === 'none' ? 'Choose points or stamps first: happy hours multiply them.' : `Extra ${unit} at quiet times, to fill them.`}
          on={!!config.happy_hours}
          disabled={e.kind === 'none'}
          onToggle={(on) => set({ happy_hours: on ? { days: [1, 2, 3, 4, 5], from: '15:00', to: '18:00', multiplier_bp: 20_000 } : null })}
        >
          {config.happy_hours && (
            <div className="space-y-3">
              <div className="flex flex-wrap gap-1.5">
                {DAYS.map((d, i) => {
                  const h = config.happy_hours!;
                  const on = h.days.includes(i);
                  return (
                    <button
                      key={d}
                      type="button"
                      aria-pressed={on}
                      onClick={() => set({ happy_hours: { ...h, days: on ? h.days.filter((x) => x !== i) : [...h.days, i].sort() } })}
                      className={cn('min-h-9 min-w-11 cursor-pointer rounded-full border px-3 text-sm', on ? 'border-[var(--brand)] bg-brand-50 font-medium text-brand-700' : 'border-line text-ink-soft')}
                    >
                      {d}
                    </button>
                  );
                })}
              </div>
              <div className="flex flex-wrap items-center gap-2 text-sm text-ink-soft">
                <Input type="time" aria-label="From" value={config.happy_hours.from} onChange={(ev) => set({ happy_hours: { ...config.happy_hours!, from: ev.target.value } })} className="h-10 w-36" />
                to
                <Input type="time" aria-label="To" value={config.happy_hours.to} onChange={(ev) => set({ happy_hours: { ...config.happy_hours!, to: ev.target.value } })} className="h-10 w-36" />
                <TimesInput className="w-24" label={`Happy-hour ${unit}`} bp={config.happy_hours.multiplier_bp} onChange={(multiplier_bp) => set({ happy_hours: { ...config.happy_hours!, multiplier_bp } })} />
              </div>
            </div>
          )}
        </Section>

        <Section title="Rules" hint="How long things last.">
          <div className="grid gap-3 sm:grid-cols-2">
            {e.kind !== 'none' && (
              <Labelled label={`${unit === 'stamps' ? 'Stamps' : 'Points'} lapse after no visit for`}>
                <div className="flex items-center gap-2">
                  <Switch label="Lapse" checked={config.expiry_days !== null} onChange={(on) => set({ expiry_days: on ? 365 : null })} />
                  {config.expiry_days !== null ? (
                    <NumberInput className="flex-1" label="Lapse after" unit="days" value={config.expiry_days} onChange={(expiry_days) => set({ expiry_days })} />
                  ) : (
                    <span className="text-sm text-ink-faint">Never</span>
                  )}
                </div>
              </Labelled>
            )}
            <Labelled label="Rewards stay valid for">
              <NumberInput label="Rewards valid for" unit="days" value={config.reward_days} onChange={(reward_days) => set({ reward_days })} />
            </Labelled>
          </div>
        </Section>
      </div>

      <div className="space-y-4 lg:sticky lg:top-4">
        <Card className="space-y-3 p-4 sm:p-5">
          <h2 className="font-semibold">What guests get</h2>
          <ul className="space-y-2 text-sm">
            {lines.map((l) => (
              <li key={l} className="flex gap-2">
                <span className="mt-2 size-1.5 shrink-0 rounded-full bg-[var(--brand)]" />
                {l}
              </li>
            ))}
          </ul>
          {problem && (
            <p className="flex items-start gap-2 rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-800" role="alert">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" /> {problem}
            </p>
          )}
        </Card>

        <Card className="space-y-3 p-4 sm:p-5">
          <h2 className="font-semibold">What it costs</h2>
          <p className="text-sm text-ink-faint">For a regular like this, if they use everything they earn.</p>
          <div className="grid grid-cols-2 gap-2">
            <Labelled label="Average bill">
              <RupeeInput label="Average bill" paise={guest.avg_bill_paise} onChange={(v) => setGuest({ ...guest, avg_bill_paise: v ?? 0 })} />
            </Labelled>
            <Labelled label="Visits a month">
              <NumberInput label="Visits a month" value={guest.visits_per_month} onChange={(visits_per_month) => setGuest({ ...guest, visits_per_month })} />
            </Labelled>
            {e.kind === 'stamps' && e.per === 'item' && (
              <Labelled label="Stamp items a visit">
                <NumberInput label="Stamp items a visit" value={guest.stamp_items_per_visit} onChange={(stamp_items_per_visit) => setGuest({ ...guest, stamp_items_per_visit })} />
              </Labelled>
            )}
          </div>
          <div className="rounded-xl bg-stone-50 px-3 py-3">
            <p className="font-display text-3xl font-semibold tabular">{formatRate(estimate.give_back_bp)}</p>
            <p className="text-sm text-ink-soft">
              back: {formatPaise(estimate.given_per_year_paise)} a year on {formatPaise(estimate.spend_per_year_paise)} spent
            </p>
          </div>
          {estimate.lines.length > 0 && (
            <ul className="space-y-1 text-sm">
              {estimate.lines.map((l) => (
                <li key={l.label} className="flex justify-between gap-3">
                  <span className="text-ink-soft">{l.label}</span>
                  <span className="tabular">{formatPaise(l.paise)}</span>
                </li>
              ))}
            </ul>
          )}
          {config.happy_hours && <p className="text-xs text-ink-faint">Happy hours add more for visits in those hours.</p>}
        </Card>

        <Card className="space-y-2 p-4 sm:p-5">
          {status === 'active' ? (
            <>
              <Button block size="lg" disabled={!!problem || !name.trim()} loading={busy} onClick={() => onSave('active', draft)}>
                Save changes
              </Button>
              <Button block variant="outline" disabled={busy} onClick={() => onSave('paused', draft)}>
                Pause the programme
              </Button>
              <p className="text-center text-xs text-ink-faint">Changes apply from the next bill. What guests already hold stays.</p>
            </>
          ) : (
            <>
              <Button block size="lg" disabled={!!problem || !name.trim()} loading={busy} onClick={() => onSave('active', draft)}>
                {status === 'paused' ? 'Resume' : 'Go live'}
              </Button>
              <Button block variant="outline" disabled={busy || !name.trim()} onClick={() => onSave(status === 'paused' ? 'paused' : 'draft', draft)}>
                Save {status === 'paused' ? 'changes' : 'as a draft'}
              </Button>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}

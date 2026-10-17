'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Crown, PencilLine, PiggyBank, Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { MembershipPlanDTO, WalletPackDTO } from '@mezmitra/shared/dto';
import {
  checkMembership,
  checkPack,
  describeMembership,
  describePack,
  MEMBERSHIP_TEMPLATES,
  WALLET_PACK_TEMPLATES,
  type CategoryNames,
  type MembershipPlanInput,
  type MembershipTemplateKey,
  type WalletPackInput,
} from '@mezmitra/shared/loyalty';
import { errorMessage } from '@/lib/api';
import { formatPaise } from '@/lib/format';
import { useStaff } from '@/lib/staff';
import { Button } from '@/components/ui/button';
import { Sheet } from '@/components/ui/overlay';
import { Badge, Card, Input, Spinner, Switch } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/toast';
import { CategoryPicker, NumberInput, PercentInput, RupeeInput, TimesInput, type LoyaltyCategory } from './fields';

type Api = ReturnType<typeof useStaff>['api'];

function useNames(categories: LoyaltyCategory[]): CategoryNames {
  return useMemo(() => {
    const byId = new Map(categories.map((c) => [c.id, c.name]));
    return (ids) => [...new Set(ids.map((id) => byId.get(id)).filter(Boolean))].join(', ') || null;
  }, [categories]);
}

function Labelled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <p className="text-sm font-medium">{label}</p>
      {children}
    </div>
  );
}

function Problem({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <p className="flex items-start gap-2 rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-800" role="alert">
      <AlertTriangle className="mt-0.5 size-4 shrink-0" /> {text}
    </p>
  );
}

// ---------- Memberships ----------

type PlanDraft = MembershipPlanInput & { id: string | null; template: MembershipTemplateKey | null; is_active: boolean };

export function MembershipsTab({ api, outletId, categories }: { api: Api; outletId: string; categories: LoyaltyCategory[] }) {
  const qc = useQueryClient();
  const toast = useToast();
  const names = useNames(categories);
  const plans = useQuery({ queryKey: ['membership-plans', outletId], queryFn: () => api<MembershipPlanDTO[]>(`/memberships/plans?outlet_id=${outletId}`) });
  const [editing, setEditing] = useState<PlanDraft | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [busy, setBusy] = useState(false);

  const save = async (d: PlanDraft) => {
    setBusy(true);
    try {
      const { id, ...body } = d;
      const list = await api<MembershipPlanDTO[]>(id ? `/memberships/plans/${id}` : '/memberships/plans', { method: id ? 'PUT' : 'POST', body: { outlet_id: outletId, ...body } });
      qc.setQueryData(['membership-plans', outletId], list);
      setEditing(null);
      setChoosing(false);
      toast(`${d.name} saved`);
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  if (plans.isLoading) return <Spinner />;
  const list = plans.data ?? [];
  const gallery = choosing || !list.length;
  return (
    <div className="space-y-4">
      <p className="max-w-2xl text-sm text-ink-soft">
        Guests pay up front and get the benefits for a set time: money off, a free item every day, or faster points. Each sale is its own GST invoice, and the membership starts when it is paid.
      </p>
      {gallery ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {MEMBERSHIP_TEMPLATES.map((t) => (
            <Card key={t.key} className="flex flex-col gap-3 p-5">
              <span className="grid size-11 place-items-center rounded-xl bg-violet-100 text-violet-800">
                <Crown className="size-5" />
              </span>
              <div className="flex-1 space-y-1">
                <h2 className="font-display text-lg font-semibold">{t.plan.name}</h2>
                <p className="text-sm">{t.pitch}</p>
                <p className="text-xs text-ink-faint">Good for: {t.best_for}</p>
              </div>
              <Button variant="outline" onClick={() => setEditing({ ...structuredClone(t.plan), id: null, template: t.key, is_active: true })}>
                Use this template
              </Button>
            </Card>
          ))}
          <Card className="flex flex-col gap-3 border-dashed p-5">
            <span className="grid size-11 place-items-center rounded-xl bg-stone-100 text-ink-soft">
              <PencilLine className="size-5" />
            </span>
            <div className="flex-1 space-y-1">
              <h2 className="font-display text-lg font-semibold">Start from scratch</h2>
              <p className="text-sm">Your own price, length and benefits.</p>
            </div>
            <Button
              variant="outline"
              onClick={() =>
                setEditing({ id: null, template: null, is_active: true, name: '', price_paise: 99_900, duration_days: 30, tax_rate_bp: 1800, hsn_sac: null, benefits: { discount: { bp: 1000, category_ids: [], max_paise: null }, daily_item: null, multiplier_bp: 10_000 } })
              }
            >
              Build my own
            </Button>
          </Card>
          {list.length > 0 && (
            <Button variant="ghost" onClick={() => setChoosing(false)}>
              Back to my memberships
            </Button>
          )}
        </div>
      ) : (
        <>
          <div className="grid gap-3 lg:grid-cols-2">
            {list.map((p) => (
              <Card key={p.id} className="space-y-3 p-4">
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <h2 className="font-semibold">{p.name}</h2>
                    <p className="text-sm text-ink-faint">{p.members} running now</p>
                  </div>
                  {!p.is_active && <Badge tone="neutral">Not on sale</Badge>}
                  <Button size="sm" variant="ghost" onClick={() => setEditing({ ...p, id: p.id })}>
                    Edit
                  </Button>
                </div>
                <ul className="space-y-1 text-sm">
                  {describeMembership(p, names).map((l) => (
                    <li key={l}>{l}</li>
                  ))}
                </ul>
              </Card>
            ))}
          </div>
          <Button variant="outline" onClick={() => setChoosing(true)}>
            <Plus className="size-4" /> Add a membership
          </Button>
        </>
      )}
      {editing && <PlanEditor draft={editing} categories={categories} names={names} busy={busy} onClose={() => setEditing(null)} onSave={(d) => void save(d)} />}
    </div>
  );
}

function PlanEditor({ draft, categories, names, busy, onClose, onSave }: { draft: PlanDraft; categories: LoyaltyCategory[]; names: CategoryNames; busy: boolean; onClose: () => void; onSave: (d: PlanDraft) => void }) {
  const [d, setD] = useState(draft);
  const b = d.benefits;
  const setB = (patch: Partial<typeof b>) => setD({ ...d, benefits: { ...b, ...patch } });
  const problem = checkMembership(d);
  return (
    <Sheet
      open
      onClose={onClose}
      title={draft.id ? `Edit ${draft.name}` : 'New membership'}
      wide
      footer={
        <Button block size="lg" disabled={!!problem} loading={busy} onClick={() => onSave(d)}>
          Save
        </Button>
      }
    >
      <div className="space-y-5">
        <Labelled label="Name">
          <Input value={d.name} maxLength={60} onChange={(e) => setD({ ...d, name: e.target.value })} placeholder="e.g. Coffee Club" />
        </Labelled>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Labelled label="Price">
            <RupeeInput label="Price" paise={d.price_paise} onChange={(v) => setD({ ...d, price_paise: v ?? 0 })} />
          </Labelled>
          <Labelled label="Lasts">
            <NumberInput label="Lasts" unit="days" min={1} value={d.duration_days} onChange={(duration_days) => setD({ ...d, duration_days })} />
          </Labelled>
          <Labelled label="GST">
            <PercentInput label="GST" bp={d.tax_rate_bp} onChange={(tax_rate_bp) => setD({ ...d, tax_rate_bp })} />
          </Labelled>
          <Labelled label="HSN/SAC">
            <Input value={d.hsn_sac ?? ''} maxLength={10} onChange={(e) => setD({ ...d, hsn_sac: e.target.value.trim() || null })} className="h-10" placeholder="Optional" />
          </Labelled>
        </div>
        <p className="-mt-2 text-xs text-ink-faint">Set the GST rate and code your accountant advises for memberships.</p>

        <div className="space-y-3 rounded-xl border border-line p-3">
          <div className="flex items-center justify-between gap-3">
            <span className="font-medium">Money off every bill</span>
            <Switch label="Money off every bill" checked={!!b.discount} onChange={(on) => setB({ discount: on ? { bp: 1000, category_ids: [], max_paise: null } : null })} />
          </div>
          {b.discount && (
            <>
              <div className="flex flex-wrap items-center gap-2 text-sm text-ink-soft">
                <PercentInput className="w-24" label="Discount" bp={b.discount.bp} onChange={(bp) => setB({ discount: { ...b.discount!, bp } })} />
                off, up to
                <RupeeInput className="w-28" label="Up to a bill" optional placeholder="No cap" paise={b.discount.max_paise} onChange={(max_paise) => setB({ discount: { ...b.discount!, max_paise } })} />
                a bill, on
              </div>
              <CategoryPicker categories={categories} value={b.discount.category_ids} onChange={(category_ids) => setB({ discount: { ...b.discount!, category_ids } })} anyLabel="Everything" />
            </>
          )}
        </div>

        <div className="space-y-3 rounded-xl border border-line p-3">
          <div className="flex items-center justify-between gap-3">
            <span className="font-medium">A free item every day</span>
            <Switch label="A free item every day" checked={!!b.daily_item} onChange={(on) => setB({ daily_item: on ? { category_ids: [], max_value_paise: 20_000 } : null })} />
          </div>
          {b.daily_item && (
            <>
              <CategoryPicker categories={categories} value={b.daily_item.category_ids} onChange={(category_ids) => setB({ daily_item: { ...b.daily_item!, category_ids } })} anyLabel="Any dish or drink" />
              <label className="flex items-center gap-2 text-sm text-ink-soft">
                Worth up to
                <RupeeInput className="w-28" label="Worth up to" optional placeholder="Any" paise={b.daily_item.max_value_paise} onChange={(max_value_paise) => setB({ daily_item: { ...b.daily_item!, max_value_paise } })} />
              </label>
            </>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 rounded-xl border border-line p-3">
          <span className="font-medium">Points or stamps while it runs</span>
          <TimesInput className="w-24" label="Points multiplier" bp={b.multiplier_bp} onChange={(multiplier_bp) => setB({ multiplier_bp })} />
        </div>

        <div className="flex items-center justify-between gap-3">
          <span className="text-sm">On sale at the till</span>
          <Switch label="On sale" checked={d.is_active} onChange={(is_active) => setD({ ...d, is_active })} />
        </div>

        <Card className="space-y-1 bg-stone-50 p-3 text-sm">
          {describeMembership(d, names).map((l) => (
            <p key={l}>{l}</p>
          ))}
        </Card>
        <Problem text={problem} />
      </div>
    </Sheet>
  );
}

// ---------- Wallet ----------

type PackDraft = WalletPackInput & { id: string | null; is_active: boolean };

export function WalletTab({ api, outletId }: { api: Api; outletId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const packs = useQuery({ queryKey: ['wallet-packs', outletId], queryFn: () => api<WalletPackDTO[]>(`/wallet/packs?outlet_id=${outletId}`) });
  const [editing, setEditing] = useState<PackDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async (d: PackDraft) => {
    setBusy(true);
    try {
      const { id, ...body } = d;
      const list = await api<WalletPackDTO[]>(id ? `/wallet/packs/${id}` : '/wallet/packs', { method: id ? 'PUT' : 'POST', body: { outlet_id: outletId, ...body } });
      qc.setQueryData(['wallet-packs', outletId], list);
      setEditing(null);
      toast(`${d.name} saved`);
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  };
  if (packs.isLoading) return <Spinner />;
  const list = packs.data ?? [];
  const missing = WALLET_PACK_TEMPLATES.filter((t) => !list.some((p) => p.name === t.name));
  return (
    <div className="space-y-4">
      <p className="max-w-2xl text-sm text-ink-soft">Guests pay in advance, often for a bonus, and spend it on bills at any of your outlets. Staff top up and take wallet payments from the bill or the customer page.</p>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {list.map((p) => (
          <Card key={p.id} className="space-y-2 p-4">
            <div className="flex items-start gap-3">
              <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-emerald-100 text-emerald-800">
                <PiggyBank className="size-5" />
              </span>
              <div className="min-w-0 flex-1">
                <h2 className="font-semibold">{p.name}</h2>
                <p className="text-sm text-ink-soft">{describePack(p)}</p>
              </div>
            </div>
            <div className="flex items-center justify-between">
              {p.is_active ? <Badge tone="green">On sale</Badge> : <Badge tone="neutral">Not on sale</Badge>}
              <Button size="sm" variant="ghost" onClick={() => setEditing({ ...p })}>
                Edit
              </Button>
            </div>
          </Card>
        ))}
        {missing.map((t) => (
          <Card key={t.name} className="space-y-2 border-dashed p-4">
            <h2 className="font-semibold">{t.name}</h2>
            <p className="text-sm text-ink-soft">{describePack(t)}</p>
            <Button size="sm" variant="outline" onClick={() => setEditing({ ...t, id: null, is_active: true })}>
              Use this pack
            </Button>
          </Card>
        ))}
        <Card className="flex flex-col justify-between gap-2 border-dashed p-4">
          <p className="text-sm text-ink-soft">Your own amount, bonus and validity.</p>
          <Button size="sm" variant="outline" onClick={() => setEditing({ id: null, is_active: true, name: '', pay_paise: 100_000, bonus_paise: 0, validity_days: 365 })}>
            <Plus className="size-4" /> New pack
          </Button>
        </Card>
      </div>
      <Card className="space-y-1.5 bg-stone-50 p-4 text-sm text-ink-soft">
        <p className="font-medium text-ink">How the money is treated</p>
        <p>A top-up is not a sale: it gets a receipt (not a GST invoice), and bills paid from the wallet are taxed in full as usual. Top-ups count in the day-end cash and the UPI check.</p>
        <p>Refunds give back only what the guest paid in; the bonus that came with it is forfeited. A balance lapses after its validity with no top-up.</p>
        <p>Check this treatment with your accountant before you sell packs.</p>
      </Card>
      {editing && <PackEditor draft={editing} busy={busy} onClose={() => setEditing(null)} onSave={(d) => void save(d)} />}
    </div>
  );
}

function PackEditor({ draft, busy, onClose, onSave }: { draft: PackDraft; busy: boolean; onClose: () => void; onSave: (d: PackDraft) => void }) {
  const [d, setD] = useState(draft);
  const problem = checkPack(d);
  return (
    <Sheet
      open
      onClose={onClose}
      title={draft.id ? `Edit ${draft.name}` : 'New pack'}
      footer={
        <Button block size="lg" disabled={!!problem} loading={busy} onClick={() => onSave(d)}>
          Save
        </Button>
      }
    >
      <div className="space-y-4">
        <Labelled label="Name">
          <Input value={d.name} maxLength={60} onChange={(e) => setD({ ...d, name: e.target.value })} placeholder="e.g. Gold" />
        </Labelled>
        <div className="grid grid-cols-3 gap-3">
          <Labelled label="Guest pays">
            <RupeeInput label="Guest pays" paise={d.pay_paise} onChange={(v) => setD({ ...d, pay_paise: v ?? 0 })} />
          </Labelled>
          <Labelled label="Bonus">
            <RupeeInput label="Bonus" paise={d.bonus_paise} onChange={(v) => setD({ ...d, bonus_paise: v ?? 0 })} />
          </Labelled>
          <Labelled label="Valid for">
            <NumberInput label="Valid for" unit="days" value={d.validity_days} onChange={(validity_days) => setD({ ...d, validity_days })} />
          </Labelled>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm">On sale at the till</span>
          <Switch label="On sale" checked={d.is_active} onChange={(is_active) => setD({ ...d, is_active })} />
        </div>
        <p className="rounded-xl bg-stone-50 px-3 py-2 text-sm">{describePack(d)}</p>
        <Problem text={problem} />
      </div>
    </Sheet>
  );
}

/** Membership and wallet figures for the loyalty report. */
export function MoneyReport({ memberships, wallet }: { memberships: { plan: string; sold: number; revenue_paise: number; active: number }[]; wallet: { topped_up_paise: number; bonus_given_paise: number; spent_paise: number; outstanding_paid_paise: number; outstanding_bonus_paise: number } }) {
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <Card className="overflow-x-auto">
        <table className="w-full min-w-[360px] text-sm">
          <thead className="border-b border-line text-left text-xs text-ink-faint">
            <tr>
              <th className="px-4 py-2.5 font-medium">Memberships</th>
              <th className="px-2 py-2.5 text-right font-medium">Sold</th>
              <th className="px-2 py-2.5 text-right font-medium">Revenue</th>
              <th className="px-4 py-2.5 text-right font-medium">Running</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {memberships.length ? (
              memberships.map((m) => (
                <tr key={m.plan}>
                  <td className="px-4 py-2.5">{m.plan}</td>
                  <td className="px-2 py-2.5 text-right tabular">{m.sold}</td>
                  <td className="px-2 py-2.5 text-right tabular">{formatPaise(m.revenue_paise)}</td>
                  <td className="px-4 py-2.5 text-right tabular">{m.active}</td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-ink-faint">
                  No memberships sold yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
      <Card className="space-y-3 p-4">
        <h2 className="font-semibold">Wallet</h2>
        <dl className="grid grid-cols-3 gap-2 text-sm">
          <div>
            <dt className="text-ink-faint">Paid in</dt>
            <dd className="font-semibold tabular">{formatPaise(wallet.topped_up_paise)}</dd>
          </div>
          <div>
            <dt className="text-ink-faint">Bonus given</dt>
            <dd className="font-semibold tabular">{formatPaise(wallet.bonus_given_paise)}</dd>
          </div>
          <div>
            <dt className="text-ink-faint">Spent on bills</dt>
            <dd className="font-semibold tabular">{formatPaise(wallet.spent_paise)}</dd>
          </div>
        </dl>
        <p className="text-sm text-ink-soft">
          Guests hold {formatPaise(wallet.outstanding_paid_paise + wallet.outstanding_bonus_paise)} now: {formatPaise(wallet.outstanding_paid_paise)} they paid in, and {formatPaise(wallet.outstanding_bonus_paise)} of bonus.
        </p>
      </Card>
    </div>
  );
}

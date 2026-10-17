'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Cake, Coffee, Crown, Gift, PencilLine, Sparkles, Sun } from 'lucide-react';
import { useState } from 'react';
import type { LoyaltyProgramDTO, LoyaltyReportDTO, ProgramStatus } from '@mezmitra/shared/dto';
import type { RewardSource } from '@mezmitra/shared/enums';
import { EMPTY_PROGRAM, PROGRAM_TEMPLATES, type ProgramTemplateKey } from '@mezmitra/shared/loyalty';
import { errorMessage } from '@/lib/api';
import { formatPaise, formatRate, todayIst } from '@/lib/format';
import { useStaff } from '@/lib/staff';
import { Button } from '@/components/ui/button';
import { Card, Segmented, Spinner, Stat } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/toast';
import type { LoyaltyCategory } from '@/components/staff/loyalty/fields';
import { MembershipsTab, MoneyReport, WalletTab } from '@/components/staff/loyalty/memberships-wallet';
import { ProgramEditor, type ProgramDraft } from '@/components/staff/loyalty/program-editor';
import { Forbidden, PageHeader } from '@/components/staff/shell';

type Tab = 'program' | 'memberships' | 'wallet' | 'report';

const ICONS: Record<ProgramTemplateKey, React.ComponentType<{ className?: string }>> = {
  stamp_card: Coffee,
  cashback: Gift,
  regulars_club: Crown,
  birthday_comeback: Cake,
  happy_hours: Sun,
};

export default function LoyaltyPage() {
  const { api, outletId, can } = useStaff();
  const [tab, setTab] = useState<Tab>('program');
  const categories = useQuery({ queryKey: ['loyalty-categories', outletId], enabled: can('outlet.settings'), queryFn: () => api<LoyaltyCategory[]>(`/loyalty/categories?outlet_id=${outletId}`) });
  if (!can('outlet.settings')) return <Forbidden />;
  return (
    <div className="pb-12">
      <PageHeader title="Loyalty" subtitle="One programme for all your outlets. Start from a template, or build your own." />
      <div className="px-4 pb-4 lg:px-8">
        <Segmented
          value={tab}
          onChange={setTab}
          className="max-w-full overflow-x-auto"
          options={[
            { value: 'program', label: 'Programme' },
            { value: 'memberships', label: 'Memberships' },
            { value: 'wallet', label: 'Wallet' },
            { value: 'report', label: 'How it is doing' },
          ]}
        />
      </div>
      <div className="px-4 lg:px-8">
        {tab === 'program' ? (
          <ProgramTab api={api} outletId={outletId!} />
        ) : tab === 'memberships' ? (
          <MembershipsTab api={api} outletId={outletId!} categories={categories.data ?? []} />
        ) : tab === 'wallet' ? (
          <WalletTab api={api} outletId={outletId!} />
        ) : (
          <ReportTab api={api} outletId={outletId!} />
        )}
      </div>
    </div>
  );
}

type Api = ReturnType<typeof useStaff>['api'];

function ProgramTab({ api, outletId }: { api: Api; outletId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const program = useQuery({ queryKey: ['loyalty-program', outletId], queryFn: () => api<{ program: LoyaltyProgramDTO | null }>(`/loyalty/program?outlet_id=${outletId}`) });
  const categories = useQuery({ queryKey: ['loyalty-categories', outletId], queryFn: () => api<LoyaltyCategory[]>(`/loyalty/categories?outlet_id=${outletId}`) });
  // What the editor starts from: the saved programme, or a template the owner just picked.
  const [picked, setPicked] = useState<ProgramDraft | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [busy, setBusy] = useState(false);

  if (program.isLoading || categories.isLoading) {
    return (
      <div className="grid place-items-center py-16">
        <Spinner />
      </div>
    );
  }
  const saved = program.data?.program ?? null;
  const start: ProgramDraft | null = picked ?? (saved && !choosing ? { name: saved.name, template: saved.template, config: saved.config } : null);

  const save = async (status: ProgramStatus, draft: ProgramDraft) => {
    setBusy(true);
    try {
      const next = await api<LoyaltyProgramDTO>('/loyalty/program', { method: 'PUT', body: { outlet_id: outletId, status, ...draft } });
      qc.setQueryData(['loyalty-program', outletId], { program: next });
      setPicked(null);
      toast(status === 'active' ? (saved?.status === 'active' ? 'Changes saved' : `${draft.name} is live`) : status === 'paused' ? 'Programme paused' : 'Draft saved');
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  if (!start) {
    return (
      <Gallery
        replacing={!!saved}
        onPick={(draft) => {
          setPicked(draft);
          setChoosing(false);
        }}
        onCancel={saved ? () => setChoosing(false) : undefined}
      />
    );
  }
  return (
    <ProgramEditor
      // A new starting point is a new form.
      key={`${start.template ?? 'scratch'}-${picked ? 'picked' : saved?.updated_at}`}
      initial={start}
      saved={saved}
      categories={categories.data ?? []}
      busy={busy}
      onSave={(status, draft) => void save(status, draft)}
      onRestart={() => {
        setPicked(null);
        setChoosing(true);
      }}
    />
  );
}

function Gallery({ replacing, onPick, onCancel }: { replacing: boolean; onPick: (d: ProgramDraft) => void; onCancel?: () => void }) {
  return (
    <div className="space-y-4">
      {replacing && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900">
          Picking a template replaces your programme's settings once you save. What guests already hold stays with them.
          {onCancel && (
            <Button size="sm" variant="outline" onClick={onCancel}>
              Keep my programme
            </Button>
          )}
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {PROGRAM_TEMPLATES.map((t) => {
          const Icon = ICONS[t.key];
          return (
            <Card key={t.key} className="flex flex-col gap-3 p-5">
              <span className="grid size-11 place-items-center rounded-xl bg-brand-50 text-brand-700">
                <Icon className="size-5" />
              </span>
              <div className="flex-1 space-y-1">
                <h2 className="font-display text-lg font-semibold">{t.name}</h2>
                <p className="text-sm">{t.pitch}</p>
                <p className="text-xs text-ink-faint">Good for: {t.best_for}</p>
              </div>
              <Button variant="outline" onClick={() => onPick({ name: t.name, template: t.key, config: structuredClone(t.config) })}>
                <Sparkles className="size-4" /> Use this template
              </Button>
            </Card>
          );
        })}
        <Card className="flex flex-col gap-3 border-dashed p-5">
          <span className="grid size-11 place-items-center rounded-xl bg-stone-100 text-ink-soft">
            <PencilLine className="size-5" />
          </span>
          <div className="flex-1 space-y-1">
            <h2 className="font-display text-lg font-semibold">Start from scratch</h2>
            <p className="text-sm">The same building blocks, empty: points or stamps, levels, birthday, comeback and happy hours.</p>
          </div>
          <Button variant="outline" onClick={() => onPick({ name: '', template: null, config: structuredClone(EMPTY_PROGRAM) })}>
            Build my own
          </Button>
        </Card>
      </div>
    </div>
  );
}

const SOURCE_LABEL: Record<RewardSource, string> = { stamps: 'Full stamp cards', level: 'Level perks', welcome: 'Welcome gifts', birthday: 'Birthday treats', comeback: 'Welcome back', membership: 'Member treats' };

function ReportTab({ api, outletId }: { api: Api; outletId: string }) {
  const today = todayIst();
  const [days, setDays] = useState<'7' | '30' | '90'>('30');
  const from = new Date(Date.parse(`${today}T00:00:00Z`) - (Number(days) - 1) * 86_400_000).toISOString().slice(0, 10);
  const q = useQuery({ queryKey: ['loyalty-report', outletId, from, today], queryFn: () => api<LoyaltyReportDTO>(`/reports/loyalty?outlet_id=${outletId}&from=${from}&to=${today}`) });
  const r = q.data;
  return (
    <div className="space-y-4">
      <Segmented
        size="sm"
        value={days}
        onChange={setDays}
        options={[
          { value: '7', label: '7 days' },
          { value: '30', label: '30 days' },
          { value: '90', label: '90 days' },
        ]}
      />
      {!r ? (
        <div className="grid place-items-center py-16">
          <Spinner />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Members" value={r.members.total} sub={`${r.members.new} joined in these days`} />
            <Stat label="Came in" value={r.members.visited} sub={`${r.members.repeat} came back on another day`} />
            <Stat label="Bills with a member" value={formatRate(r.member_bill_share_bp)} sub="of paid bills" />
            <Stat label="Average bill" value={formatPaise(r.member_avg_bill_paise)} sub={`members; others ${formatPaise(r.guest_avg_bill_paise)}`} />
          </div>
          <div className="grid gap-3 lg:grid-cols-2">
            <Card className="space-y-3 p-4">
              <h2 className="font-semibold">Points</h2>
              <dl className="grid grid-cols-3 gap-2 text-sm">
                <div>
                  <dt className="text-ink-faint">Earned</dt>
                  <dd className="text-lg font-semibold tabular">{r.points.earned}</dd>
                </div>
                <div>
                  <dt className="text-ink-faint">Spent</dt>
                  <dd className="text-lg font-semibold tabular">{r.points.redeemed}</dd>
                </div>
                <div>
                  <dt className="text-ink-faint">Still held</dt>
                  <dd className="text-lg font-semibold tabular">{r.points.outstanding}</dd>
                </div>
              </dl>
              {r.points.outstanding_paise !== null && <p className="text-sm text-ink-soft">Guests could spend {formatPaise(r.points.outstanding_paise)} of points not yet used.</p>}
            </Card>
            <Card className="space-y-3 p-4">
              <h2 className="font-semibold">Levels</h2>
              {r.levels.length ? (
                <ul className="space-y-1.5 text-sm">
                  {r.levels.map((l) => (
                    <li key={l.name} className="flex justify-between">
                      <span>{l.name}</span>
                      <span className="tabular">{l.guests}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-ink-faint">No levels yet.</p>
              )}
            </Card>
          </div>
          <Card className="overflow-x-auto">
            <table className="w-full min-w-[520px] text-sm">
              <thead className="border-b border-line text-left text-xs text-ink-faint">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Rewards</th>
                  <th className="px-2 py-2.5 text-right font-medium">Earned</th>
                  <th className="px-2 py-2.5 text-right font-medium">Used</th>
                  <th className="px-2 py-2.5 text-right font-medium">Worth</th>
                  <th className="px-4 py-2.5 text-right font-medium">Cost to you</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {r.rewards.length ? (
                  r.rewards.map((x) => (
                    <tr key={x.source}>
                      <td className="px-4 py-2.5">{SOURCE_LABEL[x.source]}</td>
                      <td className="px-2 py-2.5 text-right tabular">{x.issued}</td>
                      <td className="px-2 py-2.5 text-right tabular">{x.used}</td>
                      <td className="px-2 py-2.5 text-right tabular">{formatPaise(x.value_paise)}</td>
                      <td className="px-4 py-2.5 text-right tabular">{formatPaise(x.cost_paise)}</td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={5} className="px-4 py-6 text-center text-ink-faint">
                      No rewards earned or used in these days.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
            <p className="border-t border-line px-4 py-2.5 text-xs text-ink-faint">A free dish costs its ingredients (from recipes); money off costs what came off the bill.</p>
          </Card>
          <MoneyReport memberships={r.memberships} wallet={r.wallet} />
        </>
      )}
    </div>
  );
}

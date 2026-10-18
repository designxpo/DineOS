'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowRight, CheckCircle2, Eye, MoonStar } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { rupeesToPaise } from '@mezmitra/shared/money';
import type { DayCloseDTO, DayCloseItemDTO } from '@mezmitra/shared/dto';
import { errorMessage } from '@/lib/api';
import { date as fmtDate, dateTime, formatPaise, todayIst } from '@/lib/format';
import { useStaff } from '@/lib/staff';
import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';
import { Card, Field, Input, Spinner, Stat, Textarea } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/toast';
import { Forbidden, PageHeader } from '@/components/staff/shell';

/**
 * Closing the day: every loose end in one list, each with a way to act on it, then the owner's
 * (or a manager's) sign-off with the cash counted. Signed days keep the list as it stood.
 */
export default function ClosePage() {
  const { api, outletId, can, me } = useStaff();
  const [day, setDay] = useState(todayIst());
  const allowed = can('report.view');
  const { data, isLoading } = useQuery({
    queryKey: ['day-close', outletId, day],
    enabled: allowed,
    queryFn: () => api<DayCloseDTO>(`/day-close?outlet_id=${outletId}&date=${day}`),
    refetchInterval: (q) => (q.state.data && !q.state.data.signed ? 30_000 : false),
  });
  if (!allowed) return <Forbidden />;
  const signer = me.tenant_roles.includes('owner') || me.outlets.find((o) => o.id === outletId)?.roles.includes('manager');
  const must = data?.items.filter((i) => i.severity === 'must') ?? [];
  const check = data?.items.filter((i) => i.severity === 'check') ?? [];

  return (
    <div className="pb-12">
      <PageHeader
        title="Close the day"
        subtitle="Everything still open, and where to settle it. Sign the day off once you have been through the list."
        actions={<Input type="date" value={day} max={todayIst()} onChange={(e) => e.target.value && setDay(e.target.value)} aria-label="Day" className="w-44" />}
      />
      <div className="max-w-4xl space-y-4 px-4 lg:px-8">
        {isLoading || !data ? (
          <Spinner />
        ) : (
          <>
            {data.signed && (
              <Card className="flex items-start gap-3 border-emerald-200 bg-emerald-50 p-4 text-emerald-950">
                <CheckCircle2 className="mt-0.5 size-5 shrink-0" />
                <div className="text-sm">
                  <p className="font-semibold">
                    {fmtDate(data.date)} signed off by {data.signed.signed_by_name ?? 'staff'} at {dateTime(data.signed.signed_at)}
                  </p>
                  {data.signed.counted_cash_paise !== null && <p className="mt-0.5">{cashLine(data.expected_cash_paise, data.signed.counted_cash_paise)}</p>}
                  {data.signed.note && <p className="mt-0.5 italic">“{data.signed.note}”</p>}
                  <p className="mt-1 text-xs opacity-80">The list below is as it stood when signed.</p>
                </div>
              </Card>
            )}
            <div className="grid grid-cols-3 gap-3">
              <Stat label="Net sales" value={formatPaise(data.net_sales_paise)} sub={`${data.bills} bills`} />
              <Stat label="Cash expected" value={formatPaise(data.expected_cash_paise)} sub="in the drawer" />
              <Stat label="Still open" value={<span className={must.length ? 'text-rose-700' : 'text-emerald-700'}>{must.length}</span>} sub={`${check.length} to look over`} />
            </div>
            <ItemList
              tone="must"
              title="Settle before you close"
              hint="Money not settled: bills unpaid or unfinished, food never billed, UPI the bank never received."
              empty="Nothing unsettled. Every bill is paid and everything served was billed."
              items={must}
              signed={!!data.signed}
            />
            <ItemList tone="check" title="Look over" hint="For the owner’s eyes: free dishes, large discounts, voids, refunds, stock differences, UPI not checked yet." empty="Nothing unusual today." items={check} signed={!!data.signed} />
            {!data.signed && (signer ? <SignCard d={data} openMust={must.length} /> : <Card className="p-4 text-sm text-ink-soft">The owner or a manager signs the day off.</Card>)}
          </>
        )}
      </div>
    </div>
  );
}

const cashLine = (expected: number, counted: number) => {
  const diff = counted - expected;
  return `Cash counted ${formatPaise(counted)} against ${formatPaise(expected)} expected${diff === 0 ? ': exact.' : `: ${formatPaise(Math.abs(diff))} ${diff < 0 ? 'short' : 'over'}.`}`;
};

function ItemList({ tone, title, hint, empty, items, signed }: { tone: 'must' | 'check'; title: string; hint: string; empty: string; items: DayCloseItemDTO[]; signed: boolean }) {
  return (
    <Card className="overflow-hidden">
      <div className={cn('flex items-start gap-2 border-b border-line px-4 py-3', tone === 'must' && items.length ? 'bg-rose-50/60' : 'bg-stone-50')}>
        {tone === 'must' ? <AlertTriangle className={cn('mt-0.5 size-4 shrink-0', items.length ? 'text-rose-700' : 'text-ink-faint')} /> : <Eye className="mt-0.5 size-4 shrink-0 text-ink-faint" />}
        <div>
          <h2 className="text-sm font-semibold">
            {title} <span className="font-normal text-ink-faint">({items.length})</span>
          </h2>
          <p className="text-xs text-ink-faint">{hint}</p>
        </div>
      </div>
      {items.length ? (
        <ul className="divide-y divide-line">
          {items.map((i, n) => (
            <li key={`${i.kind}-${n}`} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
              <div className="min-w-0 flex-1">
                <p className="font-medium">{i.title}</p>
                {i.detail && <p className="text-xs text-ink-faint">{i.detail}</p>}
              </div>
              {i.amount_paise !== null && <span className="w-24 text-right font-semibold tabular">{formatPaise(i.amount_paise)}</span>}
              {!signed && (
                <Link href={i.href} className="inline-flex h-9 items-center gap-1 rounded-lg border border-line px-3 text-sm font-medium hover:bg-stone-50">
                  Open <ArrowRight className="size-3.5" />
                </Link>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="flex items-center gap-2 px-4 py-4 text-sm text-emerald-700">
          <CheckCircle2 className="size-4" /> {empty}
        </p>
      )}
    </Card>
  );
}

function SignCard({ d, openMust }: { d: DayCloseDTO; openMust: number }) {
  const { api, outletId } = useStaff();
  const qc = useQueryClient();
  const toast = useToast();
  const [counted, setCounted] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  let countedPaise: number | null = null;
  try {
    countedPaise = counted.trim() ? rupeesToPaise(counted.trim()) : null;
  } catch {
    countedPaise = null;
  }
  const badCash = counted.trim() !== '' && (countedPaise === null || countedPaise < 0);
  const sign = async () => {
    setBusy(true);
    try {
      const signed = await api<DayCloseDTO>('/day-close', { method: 'POST', body: { outlet_id: outletId, date: d.date, counted_cash_paise: countedPaise, note: note.trim() || null } });
      qc.setQueryData(['day-close', outletId, d.date], signed);
      toast('Day signed off');
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="space-y-4 p-5">
      <h2 className="flex items-center gap-2 font-semibold">
        <MoonStar className="size-4" /> Sign the day off
      </h2>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Cash counted in the drawer (₹)" hint={countedPaise !== null && !badCash ? cashLine(d.expected_cash_paise, countedPaise) : `Expected ${formatPaise(d.expected_cash_paise)}. Optional.`} error={badCash ? 'Enter an amount like 4250 or 4250.50' : null}>
          {(id) => <Input id={id} value={counted} onChange={(e) => setCounted(e.target.value)} inputMode="decimal" placeholder="0.00" />}
        </Field>
      </div>
      <Field label={openMust ? `Why close with ${openMust} item${openMust === 1 ? '' : 's'} still open?` : 'Note (optional)'} hint={openMust ? 'Kept with the day, for whoever looks back.' : undefined}>
        {(id) => <Textarea id={id} value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} placeholder={openMust ? 'Table 4 settles tomorrow; the draft is a staff meal…' : ''} />}
      </Field>
      <Button onClick={() => void sign()} disabled={badCash || (openMust > 0 && !note.trim())} loading={busy}>
        Sign off {fmtDate(d.date)}
      </Button>
    </Card>
  );
}

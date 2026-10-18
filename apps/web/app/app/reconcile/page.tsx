'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, FileSpreadsheet, Landmark, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import type { BankCreditDTO, BankStatementDTO, ReconPaymentDTO, StatementDetailDTO } from '@mezmitra/shared/dto';
import { errorMessage } from '@/lib/api';
import { readBase64 } from '@/lib/files';
import { date, dateTime, formatPaise } from '@/lib/format';
import { missingNote, paymentLabel } from '@/lib/reconcile';
import { useStaff } from '@/lib/staff';
import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';
import { Sheet } from '@/components/ui/overlay';
import { Badge, Card, EmptyState, Field, Input, Select, Spinner, Stat } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/toast';
import { SalesImports, useSalesUpload } from '@/components/staff/sales-imports';
import { Forbidden, PageHeader } from '@/components/staff/shell';

const KIND: Record<NonNullable<BankCreditDTO['match_kind']>, string> = { utr: 'UTR', amount_date: 'Amount and date', manual: 'By hand' };

export default function ReconcilePage() {
  const { api, outletId, can, outlet } = useStaff();
  const toast = useToast();
  // An outlet billing on another system checks that system's bills: the money check.
  const system = outlet?.billing_elsewhere ?? null;
  const sales = useSalesUpload(system ?? '');
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const allowed = can('payment.reconcile');
  const list = useQuery({ queryKey: ['reconcile', outletId], enabled: allowed, queryFn: () => api<BankStatementDTO[]>(`/reconciliation/statements?outlet_id=${outletId}`) });
  const current = selected ?? list.data?.[0]?.id ?? null;
  const detail = useQuery({
    queryKey: ['reconcile', outletId, current],
    enabled: allowed && !!current,
    queryFn: () => api<StatementDetailDTO>(`/reconciliation/statements/${current}`),
  });

  if (!allowed) return <Forbidden />;

  const upload = async (file: File) => {
    setUploading(true);
    try {
      const d = await api<StatementDetailDTO>('/reconciliation/statements', { method: 'POST', body: { outlet_id: outletId, file_name: file.name, data: await readBase64(file) } });
      await qc.invalidateQueries({ queryKey: ['reconcile'] });
      setSelected(d.statement.id);
      toast(d.statement.credits ? `Read ${d.statement.credits} credits; matched ${d.statement.summary.matched}` : 'Nothing new in this file: every credit was already imported');
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setUploading(false);
      if (input.current) input.current.value = '';
    }
  };
  const update = (d: StatementDetailDTO) => {
    qc.setQueryData(['reconcile', outletId, current], d);
    void qc.invalidateQueries({ queryKey: ['reconcile', outletId], exact: true });
  };

  return (
    <div className="pb-12">
      <PageHeader
        title={system ? 'Money check' : 'UPI check'}
        subtitle={
          system
            ? `Upload ${system}'s sales export and your bank statement: every UPI payment its bills claim is checked against the bank.`
            : 'Staff confirm UPI payments by eye. Import your bank statement to check that every one reached the bank.'
        }
        actions={
          <>
            <input ref={input} type="file" accept=".csv,.xlsx" className="hidden" onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])} />
            {system && (
              <Button variant="outline" onClick={sales.pick} loading={sales.busy}>
                <FileSpreadsheet className="size-4" /> Upload {system} sales
              </Button>
            )}
            <Button onClick={() => input.current?.click()} loading={uploading}>
              <Upload className="size-4" /> Import statement
            </Button>
          </>
        }
      />
      {sales.element}
      <div className="space-y-4 px-4 lg:px-8">
        {system && (
          <>
            <SalesImports system={system} onPick={sales.pick} busy={sales.busy} />
            <h2 className="pt-2 text-sm font-semibold text-ink-soft">Bank statements</h2>
          </>
        )}
        {list.isLoading ? (
          <Spinner />
        ) : !list.data?.length ? (
          <Card>
            <EmptyState
              icon={<Landmark className="size-5" />}
              title="No statements yet"
              hint="In net banking, download the account statement for the days to check as CSV or Excel (HDFC, ICICI, SBI, Axis, Kotak and most others work), then import it here. Nothing is sent to your bank."
              action={
                <Button onClick={() => input.current?.click()} loading={uploading}>
                  <FileSpreadsheet className="size-4" /> Choose file
                </Button>
              }
            />
          </Card>
        ) : (
          <>
            {list.data.length > 1 && (
              <Select value={current ?? ''} onChange={(e) => setSelected(e.target.value)} className="max-w-md" aria-label="Statement">
                {list.data.map((s) => (
                  <option key={s.id} value={s.id}>
                    {date(s.period_from)} to {date(s.period_to)} · {s.file_name}
                  </option>
                ))}
              </Select>
            )}
            {detail.data ? <Detail d={detail.data} onChange={update} elsewhere={!!system} /> : <Spinner />}
          </>
        )}
      </div>
    </div>
  );
}

function Detail({ d, onChange, elsewhere }: { d: StatementDetailDTO; onChange: (d: StatementDetailDTO) => void; elsewhere: boolean }) {
  const { api } = useStaff();
  const toast = useToast();
  const [matching, setMatching] = useState<{ credit?: BankCreditDTO; payment?: ReconPaymentDTO } | null>(null);
  const [dismissing, setDismissing] = useState<BankCreditDTO | null>(null);
  const s = d.statement.summary;
  const open = d.credits.filter((c) => !c.payment && !c.dismissed_reason);
  const unrecorded = open.filter((c) => c.is_upi);
  const other = open.filter((c) => !c.is_upi);
  const matched = d.credits.filter((c) => c.payment);
  const act = async (path: string, method: 'POST' | 'DELETE', body?: object, done?: string) => {
    try {
      onChange(await api<StatementDetailDTO>(path, { method, body }));
      if (done) toast(done);
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-ink-faint">
        {date(d.statement.period_from)} to {date(d.statement.period_to)} · {d.statement.file_name} · imported {dateTime(d.statement.created_at)}
        {d.statement.uploaded_by_name && ` by ${d.statement.uploaded_by_name}`}
      </p>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Matched" value={formatPaise(s.matched_paise)} sub={`${s.matched} payments`} />
        <Stat label="Not in the bank" value={<span className={s.missing ? 'text-rose-700' : ''}>{formatPaise(s.missing_paise)}</span>} sub={`${s.missing} UPI payment${s.missing === 1 ? '' : 's'} ${elsewhere ? 'on bills' : 'confirmed by staff'}`} />
        <Stat label="Not billed" value={<span className={s.unrecorded_upi ? 'text-amber-700' : ''}>{formatPaise(s.unrecorded_upi_paise)}</span>} sub={`${s.unrecorded_upi} UPI credit${s.unrecorded_upi === 1 ? '' : 's'} with no payment`} />
        <Stat label="Other money in" value={s.other_credits} sub={`Cash deposits, card settlements${s.dismissed ? ` · ${s.dismissed} set aside` : ''}`} />
      </div>

      <Section
        tone="rose"
        title="UPI payments the bank did not receive"
        hint={`${elsewhere ? 'The bills say these were paid by UPI' : 'Staff marked these paid by UPI'}, but no matching credit is on the statement. Check the guest's payment screen or the UTR with the cashier.`}
        empty="Every UPI payment in these dates reached the bank."
      >
        {d.missing.map((m) => (
          <Row key={m.id} amount={m.amount_paise} note={missingNote(m)} title={paymentLabel(m)} sub={[dateTime(m.created_at), m.confirmed_by_name && `confirmed by ${m.confirmed_by_name}`, m.reference && `ref ${m.reference}`].filter(Boolean).join(' · ')}>
            {m.late_possible && <Badge tone="neutral">May post on the next statement</Badge>}
            <Button size="sm" variant="outline" onClick={() => setMatching({ payment: m })} disabled={!unrecorded.some((c) => c.amount_paise === m.amount_paise)}>
              Match…
            </Button>
          </Row>
        ))}
      </Section>

      <Section tone="amber" title="UPI money in the bank with no bill" hint="A guest paid but no payment was recorded (a missed bill), or it is not a sale." empty="Every UPI credit is matched to a bill.">
        {unrecorded.map((c) => (
          <CreditRow key={c.id} c={c}>
            <Button size="sm" variant="outline" onClick={() => setMatching({ credit: c })} disabled={!d.missing.some((m) => m.amount_paise === c.amount_paise)}>
              Match…
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setDismissing(c)}>
              Not a sale
            </Button>
          </CreditRow>
        ))}
      </Section>

      {other.length > 0 && (
        <Section tone="neutral" title="Other money in" hint="Not UPI: cash deposits, card settlements, transfers. Shown for completeness." empty="">
          {other.map((c) => (
            <CreditRow key={c.id} c={c}>
              <Button size="sm" variant="ghost" onClick={() => setDismissing(c)}>
                Set aside
              </Button>
            </CreditRow>
          ))}
        </Section>
      )}

      <details className="group rounded-[var(--radius-card)] border border-line bg-surface">
        <summary className="flex cursor-pointer items-center gap-2 px-4 py-3 text-sm font-semibold">
          <CheckCircle2 className="size-4 text-emerald-600" /> Matched ({matched.length})
        </summary>
        <ul className="divide-y divide-line border-t border-line">
          {matched.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-sm">
              <span className="w-24 text-ink-faint">{date(c.txn_date)}</span>
              <span className="min-w-0 flex-1 truncate">
                {paymentLabel(c.payment!)}
              </span>
              <Badge tone={c.match_kind === 'utr' ? 'green' : c.match_kind === 'manual' ? 'violet' : 'blue'}>{KIND[c.match_kind!]}</Badge>
              <span className="w-24 text-right font-semibold tabular">{formatPaise(c.amount_paise)}</span>
              <Button size="sm" variant="ghost" onClick={() => void act(`/reconciliation/credits/${c.id}/match`, 'DELETE', undefined, 'Match undone')}>
                Undo
              </Button>
            </li>
          ))}
        </ul>
      </details>

      {matching && (
        <MatchSheet
          d={d}
          from={matching}
          onClose={() => setMatching(null)}
          onMatch={(creditId, paymentId) => void act(`/reconciliation/credits/${creditId}/match`, 'POST', { payment_id: paymentId }, 'Matched').then(() => setMatching(null))}
        />
      )}
      {dismissing && (
        <DismissSheet
          credit={dismissing}
          onClose={() => setDismissing(null)}
          onDismiss={(reason) => void act(`/reconciliation/credits/${dismissing.id}/dismiss`, 'POST', { reason }, 'Set aside').then(() => setDismissing(null))}
        />
      )}
    </div>
  );
}

function Section({ tone, title, hint, empty, children }: { tone: 'rose' | 'amber' | 'neutral'; title: string; hint: string; empty: string; children: React.ReactNode[] }) {
  return (
    <Card className="overflow-hidden">
      <div className={cn('flex items-start gap-2 border-b border-line px-4 py-3', tone === 'rose' ? 'bg-rose-50/60' : tone === 'amber' ? 'bg-amber-50/60' : 'bg-stone-50')}>
        {tone !== 'neutral' && <AlertTriangle className={cn('mt-0.5 size-4 shrink-0', tone === 'rose' ? 'text-rose-700' : 'text-amber-700')} />}
        <div>
          <h2 className="text-sm font-semibold">
            {title} <span className="font-normal text-ink-faint">({children.length})</span>
          </h2>
          <p className="text-xs text-ink-faint">{hint}</p>
        </div>
      </div>
      {children.length ? <ul className="divide-y divide-line">{children}</ul> : <p className="flex items-center gap-2 px-4 py-4 text-sm text-emerald-700"><CheckCircle2 className="size-4" /> {empty}</p>}
    </Card>
  );
}

function Row({ title, sub, note, amount, children }: { title: string; sub: string; note?: string | null; amount: number; children?: React.ReactNode }) {
  return (
    <li className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">{title}</p>
        <p className="truncate text-xs text-ink-faint">{sub}</p>
        {note && <p className="mt-0.5 text-xs text-rose-700">{note}</p>}
      </div>
      <span className="w-24 text-right font-semibold tabular">{formatPaise(amount)}</span>
      <div className="flex items-center gap-2">{children}</div>
    </li>
  );
}

function CreditRow({ c, children }: { c: BankCreditDTO; children: React.ReactNode }) {
  return (
    <Row title={c.narration || 'Credit'} sub={[date(c.txn_date), c.utr && `UTR ${c.utr}`].filter(Boolean).join(' · ')} amount={c.amount_paise}>
      {children}
    </Row>
  );
}

function MatchSheet({ d, from, onClose, onMatch }: { d: StatementDetailDTO; from: { credit?: BankCreditDTO; payment?: ReconPaymentDTO }; onClose: () => void; onMatch: (creditId: string, paymentId: string) => void }) {
  const amount = from.credit?.amount_paise ?? from.payment!.amount_paise;
  const options = from.credit
    ? d.missing.filter((m) => m.amount_paise === amount).map((m) => ({ id: m.id, title: paymentLabel(m), sub: dateTime(m.created_at) }))
    : d.credits.filter((c) => !c.payment && !c.dismissed_reason && c.amount_paise === amount).map((c) => ({ id: c.id, title: c.narration, sub: `${date(c.txn_date)}${c.utr ? ` · UTR ${c.utr}` : ''}` }));
  return (
    <Sheet open onClose={onClose} title={`Match ${formatPaise(amount)}`}>
      <p className="mb-3 text-sm text-ink-soft">{from.credit ? 'Which bill was this bank credit for?' : 'Which bank credit is this payment?'}</p>
      <ul className="space-y-2">
        {options.map((o) => (
          <li key={o.id}>
            <button
              className="flex w-full cursor-pointer items-center gap-3 rounded-xl border border-line px-3 py-2.5 text-left text-sm hover:bg-stone-50"
              onClick={() => (from.credit ? onMatch(from.credit.id, o.id) : onMatch(o.id, from.payment!.id))}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{o.title}</span>
                <span className="text-xs text-ink-faint">{o.sub}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Sheet>
  );
}

function DismissSheet({ credit, onClose, onDismiss }: { credit: BankCreditDTO; onClose: () => void; onDismiss: (reason: string) => void }) {
  const [reason, setReason] = useState('');
  const quick = ['Owner transfer', 'Cash deposit', 'Card settlement', 'Supplier refund', 'Room bill paid at the front desk'];
  return (
    <Sheet open onClose={onClose} title={`Set aside ${formatPaise(credit.amount_paise)}`} footer={<Button block onClick={() => onDismiss(reason)} disabled={reason.trim().length < 3}>Set aside</Button>}>
      <p className="mb-3 text-sm text-ink-soft">{credit.narration}</p>
      <div className="mb-3 flex flex-wrap gap-2">
        {quick.map((q) => (
          <button key={q} onClick={() => setReason(q)} className={cn('cursor-pointer rounded-full border px-3 py-1 text-xs', reason === q ? 'border-[var(--brand)] bg-brand-50' : 'border-line')}>
            {q}
          </button>
        ))}
      </div>
      <Field label="Why this is not a sale">{(id) => <Input id={id} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
    </Sheet>
  );
}

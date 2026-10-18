'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bike, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { rupeesToPaise } from '@mezmitra/shared/money';
import type { BankCreditDTO, ChannelPayoutDTO, PayoutLineKind } from '@mezmitra/shared/dto';
import { errorMessage } from '@/lib/api';
import { date, formatPaise, todayIst } from '@/lib/format';
import { useStaff } from '@/lib/staff';
import { Button } from '@/components/ui/button';
import { Sheet } from '@/components/ui/overlay';
import { Badge, Card, EmptyState, Field, Input, Select, Spinner } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/toast';

const KINDS: Record<PayoutLineKind, string> = { commission: 'Commission', ads: 'Ads', discount_funded: 'Discount the app funded', refund: 'Refunds', tax: 'Tax collected', penalty: 'Penalty', other: 'Other' };
const CHANNEL = { zomato: 'Zomato', swiggy: 'Swiggy' } as const;

/**
 * What a delivery app paid for a cycle, against what the outlet billed and what reached the bank.
 * The owner types the app's statement (gross, each deduction, net); the screen says where the
 * money went and keeps a dispute with the app until the shortfall is credited back.
 */
export function DeliveryPayouts({ credits }: { credits: BankCreditDTO[] }) {
  const { api, outletId } = useStaff();
  const toast = useToast();
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const key = ['payouts', outletId];
  const { data, isLoading } = useQuery({ queryKey: key, queryFn: () => api<ChannelPayoutDTO[]>(`/reconciliation/payouts?outlet_id=${outletId}`) });
  const refresh = () => qc.invalidateQueries({ queryKey: key });

  const dispute = async (p: ChannelPayoutDTO, status: 'open' | 'recovered' | 'written_off' | null) => {
    let note: string | null | undefined;
    let recovered: number | undefined;
    if (status === 'open') {
      note = window.prompt('What are you taking up with the app? (orders missing, deductions you did not agree…)')?.trim();
      if (!note) return;
    }
    if (status === 'recovered') {
      const v = window.prompt('How much did the app credit back (₹)?')?.trim();
      if (!v) return;
      try {
        recovered = rupeesToPaise(v);
      } catch {
        return toast('Enter an amount like 450 or 450.50', 'error');
      }
    }
    try {
      await api(`/reconciliation/payouts/${p.id}/dispute`, { method: 'PATCH', body: { status, note: note ?? p.dispute?.note ?? null, recovered_paise: recovered } });
      await refresh();
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };
  const remove = async (p: ChannelPayoutDTO) => {
    if (!window.confirm(`Delete the ${CHANNEL[p.channel]} payout for ${date(p.period_from)} to ${date(p.period_to)}?`)) return;
    try {
      await api(`/reconciliation/payouts/${p.id}`, { method: 'DELETE' });
      await Promise.all([refresh(), qc.invalidateQueries({ queryKey: ['reconcile'] })]);
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  return (
    <section className="space-y-3 pt-4" aria-label="Delivery payouts">
      <div className="flex items-center gap-2">
        <h2 className="flex-1 text-sm font-semibold text-ink-soft">Delivery payouts</h2>
        <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
          <Plus className="size-4" /> Record a payout
        </Button>
      </div>
      {isLoading ? (
        <Spinner />
      ) : !data?.length ? (
        <Card>
          <EmptyState icon={<Bike className="size-5" />} title="No payouts recorded" hint="Copy a cycle from the Zomato or Swiggy payout statement. Mezmitra sets it beside your own bills and the bank, and shows what is missing or taken off." />
        </Card>
      ) : (
        data.map((p) => <PayoutCard key={p.id} p={p} onDispute={dispute} onDelete={remove} />)
      )}
      {adding && <RecordSheet credits={credits} onClose={() => setAdding(false)} onSaved={() => { setAdding(false); void refresh(); void qc.invalidateQueries({ queryKey: ['reconcile'] }); }} />}
    </section>
  );
}

function PayoutCard({ p, onDispute, onDelete }: { p: ChannelPayoutDTO; onDispute: (p: ChannelPayoutDTO, s: 'open' | 'recovered' | 'written_off' | null) => void; onDelete: (p: ChannelPayoutDTO) => void }) {
  const short = p.vs_expected_paise < 0 || p.missing_paise > 0 || p.unexplained_paise > 1;
  const row = (label: string, value: string, tone?: 'bad') => (
    <div className="flex justify-between gap-3 py-1">
      <dt className="text-ink-soft">{label}</dt>
      <dd className={tone === 'bad' ? 'font-semibold text-rose-700 tabular' : 'tabular'}>{value}</dd>
    </div>
  );
  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-semibold">
          {CHANNEL[p.channel]} · {date(p.period_from)} to {date(p.period_to)}
        </h3>
        {p.reference && <span className="text-xs text-ink-faint">{p.reference}</span>}
        <span className="flex-1" />
        {p.dispute ? <Badge tone={p.dispute.status === 'open' ? 'amber' : p.dispute.status === 'recovered' ? 'green' : 'neutral'}>{{ open: 'Dispute open', recovered: `Credited back ${formatPaise(p.dispute.recovered_paise)}`, written_off: 'Let go' }[p.dispute.status]}</Badge> : short ? <Badge tone="rose">Does not add up</Badge> : <Badge tone="green">Adds up</Badge>}
      </div>
      <dl className="mt-3 grid gap-x-8 text-sm sm:grid-cols-2">
        <div>
          <p className="text-xs font-semibold tracking-wide text-ink-faint uppercase">The app says</p>
          {row(`Gross (${p.orders_claimed} orders)`, formatPaise(p.gross_paise))}
          {p.lines.map((l) => row(`− ${KINDS[l.kind]}${l.note ? ` (${l.note})` : ''}`, formatPaise(l.amount_paise)))}
          {row('Net payout', formatPaise(p.net_paise))}
          {p.unexplained_paise > 1 && row('Not explained by its own statement', formatPaise(p.unexplained_paise), 'bad')}
        </div>
        <div>
          <p className="text-xs font-semibold tracking-wide text-ink-faint uppercase">Your books</p>
          {row(`Billed (${p.ours.orders} orders)`, formatPaise(p.ours.sales_paise))}
          {p.missing_paise !== 0 && row(p.missing_paise > 0 ? 'Billed but not on the statement' : 'On the statement, not billed', formatPaise(Math.abs(p.missing_paise)), p.missing_paise > 0 ? 'bad' : undefined)}
          {row(`Expected after ${(p.ours.commission_bp / 100).toFixed(1)}% commission`, formatPaise(p.ours.expected_net_paise))}
          {row(p.vs_expected_paise < 0 ? 'Paid less than expected' : 'Paid against expected', formatPaise(Math.abs(p.vs_expected_paise)), p.vs_expected_paise < 0 ? 'bad' : undefined)}
          {p.bank ? row(`In the bank, ${date(p.bank.txn_date)}`, formatPaise(p.bank.amount_paise)) : row('In the bank', 'not linked')}
          {p.bank_gap_paise !== null && Math.abs(p.bank_gap_paise) > 1 && row('Statement says more than the bank got', formatPaise(p.bank_gap_paise), 'bad')}
        </div>
      </dl>
      {p.dispute?.note && <p className="mt-2 text-sm italic text-ink-soft">“{p.dispute.note}”</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        {!p.dispute ? (
          <Button size="sm" variant="outline" onClick={() => onDispute(p, 'open')}>Take it up with the app</Button>
        ) : p.dispute.status === 'open' ? (
          <>
            <Button size="sm" variant="outline" onClick={() => onDispute(p, 'recovered')}>Credited back</Button>
            <Button size="sm" variant="ghost" onClick={() => onDispute(p, 'written_off')}>Let it go</Button>
          </>
        ) : (
          <Button size="sm" variant="ghost" onClick={() => onDispute(p, null)}>Reopen</Button>
        )}
        <Button size="sm" variant="ghost" onClick={() => onDelete(p)} aria-label="Delete payout">
          <Trash2 className="size-4" />
        </Button>
      </div>
    </Card>
  );
}

function RecordSheet({ credits, onClose, onSaved }: { credits: BankCreditDTO[]; onClose: () => void; onSaved: () => void }) {
  const { api, outletId } = useStaff();
  const toast = useToast();
  const [channel, setChannel] = useState<'zomato' | 'swiggy'>('zomato');
  const [from, setFrom] = useState(todayIst());
  const [to, setTo] = useState(todayIst());
  const [reference, setReference] = useState('');
  const [orders, setOrders] = useState('');
  const [gross, setGross] = useState('');
  const [net, setNet] = useState('');
  const [lines, setLines] = useState<{ kind: PayoutLineKind; amount: string; note: string }[]>([{ kind: 'commission', amount: '', note: '' }]);
  const [creditId, setCreditId] = useState('');
  const [busy, setBusy] = useState(false);
  // Money in that is not a UPI sale and has not been explained yet.
  const candidates = credits.filter((c) => !c.is_upi && !c.payment && !c.dismissed_reason);

  const save = async () => {
    let body;
    try {
      body = {
        outlet_id: outletId,
        channel,
        period_from: from,
        period_to: to,
        reference: reference.trim() || null,
        orders_claimed: Number(orders || 0),
        gross_paise: rupeesToPaise(gross),
        net_paise: rupeesToPaise(net),
        lines: lines.filter((l) => l.amount.trim()).map((l) => ({ kind: l.kind, amount_paise: rupeesToPaise(l.amount), note: l.note.trim() || null })),
        bank_credit_id: creditId || null,
      };
    } catch {
      return toast('Enter amounts like 4250 or 4250.50', 'error');
    }
    setBusy(true);
    try {
      await api('/reconciliation/payouts', { method: 'POST', body });
      toast('Payout recorded');
      onSaved();
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open onClose={onClose} title="Record a payout" footer={<Button onClick={() => void save()} loading={busy} disabled={!gross || !net || !Number.isInteger(Number(orders || 0))}>Save payout</Button>}>
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="App">{(id) => <Select id={id} value={channel} onChange={(e) => setChannel(e.target.value as 'zomato' | 'swiggy')}><option value="zomato">Zomato</option><option value="swiggy">Swiggy</option></Select>}</Field>
          <Field label="Payout reference">{(id) => <Input id={id} value={reference} onChange={(e) => setReference(e.target.value)} maxLength={80} />}</Field>
          <Field label="From">{(id) => <Input id={id} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />}</Field>
          <Field label="To">{(id) => <Input id={id} type="date" value={to} onChange={(e) => setTo(e.target.value)} />}</Field>
          <Field label="Orders on its statement">{(id) => <Input id={id} inputMode="numeric" value={orders} onChange={(e) => setOrders(e.target.value)} />}</Field>
          <Field label="Gross sales on its statement (₹)">{(id) => <Input id={id} inputMode="decimal" value={gross} onChange={(e) => setGross(e.target.value)} />}</Field>
        </div>
        <div className="space-y-2">
          <p className="text-sm font-medium">Taken off by the app (₹)</p>
          {lines.map((l, i) => (
            <div key={i} className="grid grid-cols-[1fr_6rem] gap-2 sm:grid-cols-[10rem_6rem_1fr]">
              <Select aria-label="Kind" value={l.kind} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, kind: e.target.value as PayoutLineKind } : x)))}>
                {Object.entries(KINDS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
              </Select>
              <Input aria-label="Amount" inputMode="decimal" value={l.amount} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} placeholder="0.00" />
              <Input aria-label="Note" className="col-span-2 sm:col-span-1" value={l.note} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, note: e.target.value } : x)))} maxLength={200} placeholder="Note" />
            </div>
          ))}
          <Button size="sm" variant="ghost" onClick={() => setLines([...lines, { kind: 'ads', amount: '', note: '' }])}><Plus className="size-4" /> Add a deduction</Button>
        </div>
        <Field label="Net payout it says it sent (₹)">{(id) => <Input id={id} inputMode="decimal" value={net} onChange={(e) => setNet(e.target.value)} />}</Field>
        <Field label="Credit in the bank statement" hint={candidates.length ? 'Money in that is not a UPI sale. Linking it stops it showing as unexplained.' : 'Import the bank statement first to link the credit.'}>
          {(id) => (
            <Select id={id} value={creditId} onChange={(e) => setCreditId(e.target.value)}>
              <option value="">Not linked</option>
              {candidates.map((c) => <option key={c.id} value={c.id}>{date(c.txn_date)} · {formatPaise(c.amount_paise)} · {c.narration.slice(0, 40)}</option>)}
            </Select>
          )}
        </Field>
      </div>
    </Sheet>
  );
}

'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Banknote, CreditCard, FileText, Percent, Printer, Scissors, Smartphone, Trash2, Undo2, Wallet } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { rupeesToPaise } from '@dineos/shared/money';
import type { BillDTO, InvoiceDTO, PaymentDTO } from '@dineos/shared/dto';
import type { PaymentMethod } from '@dineos/shared/enums';
import { errorMessage } from '@/lib/api';
import { formatPaise, formatRate, rupeesInput, time } from '@/lib/format';
import { send } from '@/lib/outbox';
import { useStaff } from '@/lib/staff';
import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';
import { ConfirmDialog, Sheet } from '@/components/ui/overlay';
import { Badge, Card, Field, Input, Segmented, Spinner, Switch } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/toast';
import { useWithApproval } from '@/components/staff/approval';
import { ReasonPicker } from '@/components/staff/orders';

type Invoice = InvoiceDTO & { upi_uri: string | null };

const METHODS: { value: PaymentMethod; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { value: 'cash', label: 'Cash', icon: Banknote },
  { value: 'upi', label: 'UPI', icon: Smartphone },
  { value: 'card_slip', label: 'Card', icon: CreditCard },
  { value: 'other', label: 'Other', icon: Wallet },
];

export default function BillPage() {
  const { id } = useParams<{ id: string }>();
  const { api, can } = useStaff();
  const qc = useQueryClient();
  const toast = useToast();
  const router = useRouter();
  const withApproval = useWithApproval();
  const [sheet, setSheet] = useState<null | 'discount' | 'split' | 'customer' | 'void'>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const q = useQuery({ queryKey: ['bill', id], queryFn: () => api<Invoice>(`/bills/${id}/invoice`) });
  const inv = q.data;
  const bill = inv?.bill;

  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ['bill', id] });
    await qc.invalidateQueries({ queryKey: ['bills'] });
  };

  const act = async (label: string, fn: (approval: string | null) => Promise<unknown>, done?: string) => {
    setBusy(label);
    try {
      const res = await withApproval(fn);
      if (res === undefined) return false;
      await refresh();
      if (done) toast(done);
      return true;
    } catch (err) {
      toast(errorMessage(err), 'error');
      return false;
    } finally {
      setBusy(null);
    }
  };

  if (q.isLoading) {
    return (
      <div className="grid place-items-center py-24">
        <Spinner />
      </div>
    );
  }
  if (!bill || !inv) return <p className="p-8 text-ink-faint">This bill no longer exists (it may have been split or discarded).</p>;

  const draft = bill.status === 'draft';
  const finalised = bill.status === 'finalised';
  const discount = bill.item_discount_paise + bill.bill_discount_paise;

  return (
    <div className="mx-auto max-w-6xl px-4 pt-6 pb-16 lg:px-8">
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <Link href="/app/bills" className="grid size-10 place-items-center rounded-xl text-ink-soft hover:bg-stone-100" aria-label="Back to bills">
          <ArrowLeft className="size-5" />
        </Link>
        <div className="min-w-0 flex-1">
          <h1 className="font-display text-2xl font-semibold">
            {bill.table_label ? `Table ${bill.table_label}` : 'Counter / takeaway'}
            {bill.split_label && <span className="ml-2 text-base font-normal text-ink-faint">{bill.split_label}</span>}
          </h1>
          <p className="text-sm text-ink-faint">{bill.invoice_no ? `${bill.invoice_no} · ${bill.invoice_date}` : 'Draft: not yet a tax invoice'}</p>
        </div>
        <Badge tone={draft ? 'amber' : finalised ? 'blue' : bill.status === 'paid' ? 'green' : 'rose'} className="px-3 py-1 text-sm">
          {draft ? 'Draft' : finalised ? 'Awaiting payment' : bill.status === 'paid' ? 'Paid' : 'Void'}
        </Badge>
      </div>

      <div className="grid gap-5 lg:grid-cols-[1fr_380px]">
        <Card className="overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-stone-50 text-left text-xs text-ink-faint uppercase">
              <tr>
                <th className="px-4 py-2.5 font-semibold">Item</th>
                <th className="px-2 py-2.5 text-right font-semibold">Qty</th>
                <th className="px-2 py-2.5 text-right font-semibold">Rate</th>
                <th className="px-2 py-2.5 text-right font-semibold">GST</th>
                <th className="px-4 py-2.5 text-right font-semibold">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {bill.lines.map((l) => (
                <tr key={l.id}>
                  <td className="px-4 py-2.5">
                    {l.name}
                    {l.seat_no && <span className="ml-1 text-xs text-ink-faint">seat {l.seat_no}</span>}
                    {l.item_discount_paise > 0 && <span className="block text-xs text-emerald-700">− {formatPaise(l.item_discount_paise)} off</span>}
                  </td>
                  <td className="px-2 py-2.5 text-right tabular">{l.qty}</td>
                  <td className="px-2 py-2.5 text-right tabular">{formatPaise(l.unit_price_paise)}</td>
                  <td className="px-2 py-2.5 text-right text-ink-faint tabular">{formatRate(l.tax_rate_bp)}</td>
                  <td className="px-4 py-2.5 text-right font-medium tabular">{formatPaise(l.gross_paise)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <dl className="space-y-1.5 border-t border-line bg-stone-50/60 px-4 py-4 text-sm">
            <Row label="Subtotal" value={formatPaise(bill.subtotal_paise)} />
            {discount > 0 && <Row label={`Discount${bill.discount_reason ? ` (${bill.discount_reason})` : ''}`} value={`− ${formatPaise(discount)}`} tone="text-emerald-700" />}
            {(bill.service_charge_paise > 0 || bill.service_charge_bp > 0) && (
              <Row label={`Service charge ${bill.service_charge_waived ? '(removed)' : `(${formatRate(bill.service_charge_bp)})`}`} value={formatPaise(bill.service_charge_paise)} />
            )}
            {inv.tax_summary.map((t) => (
              <Row key={t.tax_rate_bp} label={`CGST ${formatRate(t.tax_rate_bp / 2)} + SGST ${formatRate(t.tax_rate_bp / 2)} on ${formatPaise(t.taxable_paise)}`} value={formatPaise(t.cgst_paise + t.sgst_paise)} />
            ))}
            {bill.round_off_paise !== 0 && <Row label="Round off" value={formatPaise(bill.round_off_paise)} />}
            <div className="flex items-baseline justify-between border-t border-line pt-2">
              <dt className="font-semibold">Total</dt>
              <dd className="font-display text-3xl font-semibold tabular">{formatPaise(bill.total_paise)}</dd>
            </div>
          </dl>
        </Card>

        <div className="space-y-4">
          {draft && can('bill.manage') && (
            <Card className="space-y-3 p-4">
              <div className="grid grid-cols-2 gap-2">
                <Button variant="outline" onClick={() => setSheet('discount')}>
                  <Percent className="size-4" /> Discount
                </Button>
                <Button variant="outline" onClick={() => setSheet('split')}>
                  <Scissors className="size-4" /> Split
                </Button>
                <Button variant="outline" onClick={() => setSheet('customer')}>
                  <FileText className="size-4" /> Business GSTIN
                </Button>
                <Button
                  variant="ghost"
                  loading={busy === 'discard'}
                  onClick={() => void act('discard', () => api(`/bills/${id}`, { method: 'DELETE' })).then((ok) => ok && router.push('/app/bills'))}
                >
                  <Trash2 className="size-4" /> Discard
                </Button>
              </div>
              {bill.service_charge_bp > 0 && (
                <div className="flex items-center justify-between rounded-xl bg-stone-50 px-3 py-2">
                  <span className="text-sm">Service charge {formatRate(bill.service_charge_bp)}</span>
                  <Switch
                    label="Service charge"
                    checked={!bill.service_charge_waived}
                    onChange={(on) => void act('sc', () => api(`/bills/${id}`, { method: 'PATCH', body: { service_charge_waived: !on } }))}
                  />
                </div>
              )}
              {bill.amount_shares && <p className="rounded-xl bg-sky-50 px-3 py-2 text-sm text-sky-900">Split {bill.amount_shares.length} ways: {bill.amount_shares.map(formatPaise).join(' / ')}</p>}
              <Button
                size="xl"
                block
                loading={busy === 'finalise'}
                onClick={() => void act('finalise', () => api<BillDTO>(`/bills/${id}/finalise`, { method: 'POST' }), 'Bill printed: invoice number assigned')}
              >
                <Printer className="size-5" /> Print bill · {formatPaise(bill.total_paise)}
              </Button>
              <p className="text-center text-xs text-ink-faint">Printing assigns the GST invoice number. After that, changes need a void.</p>
            </Card>
          )}

          {finalised && can('payment.record') && <PaymentPanel bill={bill} upiUri={inv.upi_uri} onPaid={refresh} />}

          {bill.payments.length > 0 && <PaymentList payments={bill.payments} canRefund={can('payment.record')} onRefund={(p, amount, reason) => act('refund', (approval) => api(`/payments/${p.id}/refund`, { method: 'POST', body: { amount_paise: amount, reason }, approvalToken: approval }), 'Refund recorded')} />}

          {!draft && (
            <Card className="flex flex-wrap gap-2 p-4">
              <Button variant="outline" onClick={() => void act('print', () => api(`/bills/${id}/print`, { method: 'POST' }), 'Sent to the bill printer')}>
                <Printer className="size-4" /> Print again
              </Button>
              <Button variant="ghost" onClick={() => window.open(`/print/bill/${id}`, '_blank')}>
                <FileText className="size-4" /> Browser print
              </Button>
              {bill.status === 'finalised' && bill.paid_paise === 0 && (
                <Button variant="ghost" className="text-rose-700" onClick={() => setSheet('void')}>
                  <Undo2 className="size-4" /> Void
                </Button>
              )}
            </Card>
          )}
          {bill.status === 'void' && <p className="rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-800">Voided: {bill.void_reason}. The invoice number stays in the series as cancelled.</p>}
        </div>
      </div>

      <DiscountSheet bill={bill} open={sheet === 'discount'} onClose={() => setSheet(null)} onSave={(body) => act('discount', (approval) => api(`/bills/${id}`, { method: 'PATCH', body, approvalToken: approval }), 'Discount applied').then((ok) => ok && setSheet(null))} />
      <SplitSheet bill={bill} open={sheet === 'split'} onClose={() => setSheet(null)} onSplit={async (body) => {
        setBusy('split');
        try {
          const parts = await api<BillDTO[]>(`/bills/${id}/split`, { method: 'POST', body });
          await qc.invalidateQueries({ queryKey: ['bills'] });
          setSheet(null);
          if (parts[0]!.id !== id) router.replace(`/app/bills/${parts[0]!.id}`);
          else await refresh();
          toast(parts.length > 1 ? `Split into ${parts.length} bills` : 'Split saved');
        } catch (err) {
          toast(errorMessage(err), 'error');
        } finally {
          setBusy(null);
        }
      }} />
      <CustomerSheet bill={bill} open={sheet === 'customer'} onClose={() => setSheet(null)} onSave={(body) => act('customer', () => api(`/bills/${id}`, { method: 'PATCH', body }), 'Customer details saved').then((ok) => ok && setSheet(null))} />
      <VoidDialog open={sheet === 'void'} onClose={() => setSheet(null)} busy={busy === 'void'} onConfirm={(reason) => void act('void', (approval) => api(`/bills/${id}/void`, { method: 'POST', body: { reason }, approvalToken: approval }), 'Bill voided').then((ok) => ok && setSheet(null))} />
    </div>
  );
}

function Row({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-ink-soft">{label}</dt>
      <dd className={cn('tabular', tone)}>{value}</dd>
    </div>
  );
}

function PaymentPanel({ bill, upiUri, onPaid }: { bill: BillDTO; upiUri: string | null; onPaid: () => Promise<void> }) {
  const { token } = useStaff();
  const toast = useToast();
  const [method, setMethod] = useState<PaymentMethod>('cash');
  const shares = bill.amount_shares;
  const paidShares = shares ? countPaidShares(shares, bill.paid_paise) : 0;
  const suggested = shares && paidShares < shares.length ? shares[paidShares]! : bill.balance_paise;
  const [amount, setAmount] = useState(rupeesInput(suggested));
  const [tendered, setTendered] = useState('');
  const [reference, setReference] = useState('');
  const [busy, setBusy] = useState(false);
  const [qr, setQr] = useState<string | null>(null);

  useEffect(() => setAmount(rupeesInput(suggested)), [suggested]);
  useEffect(() => {
    if (method === 'upi' && upiUri) QRCode.toDataURL(upiUri, { margin: 1, width: 320 }).then(setQr).catch(() => setQr(null));
  }, [method, upiUri]);

  let amountPaise = 0;
  let tenderedPaise: number | null = null;
  try {
    amountPaise = rupeesToPaise(amount || '0');
    tenderedPaise = tendered ? rupeesToPaise(tendered) : null;
  } catch {
    amountPaise = -1;
  }
  const change = tenderedPaise !== null ? tenderedPaise - amountPaise : null;

  const pay = async () => {
    if (amountPaise <= 0) return toast('Enter an amount', 'error');
    setBusy(true);
    try {
      const res = await send<BillDTO>(token, `/bills/${bill.id}/payments`, {
        method: 'POST',
        body: { method, amount_paise: amountPaise, tendered_paise: method === 'cash' ? tenderedPaise : null, reference: reference.trim() || null },
        label: `${method} payment ${formatPaise(amountPaise)}`,
      });
      if (res.queued) toast('Saved offline: payment will sync when the connection returns', 'info');
      else toast(res.data.status === 'paid' ? 'Bill fully paid. Table released for cleaning.' : 'Payment recorded');
      setTendered('');
      setReference('');
      await onPaid();
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="space-y-3 p-4">
      <div className="flex items-baseline justify-between">
        <h2 className="font-semibold">Take payment</h2>
        <p className="text-sm text-ink-soft">
          Due <span className="font-semibold text-ink tabular">{formatPaise(bill.balance_paise)}</span>
        </p>
      </div>
      {shares && (
        <div className="flex flex-wrap gap-2">
          {shares.map((s, i) => (
            <span key={i} className={cn('rounded-lg px-2.5 py-1 text-xs font-medium', i < paidShares ? 'bg-emerald-100 text-emerald-800 line-through' : i === paidShares ? 'bg-sky-100 text-sky-900' : 'bg-stone-100 text-ink-soft')}>
              Share {i + 1}: {formatPaise(s)}
            </span>
          ))}
        </div>
      )}
      <div className="grid grid-cols-4 gap-2">
        {METHODS.map((m) => (
          <button
            key={m.value}
            onClick={() => setMethod(m.value)}
            aria-pressed={method === m.value}
            className={cn('flex h-16 cursor-pointer flex-col items-center justify-center gap-1 rounded-xl border text-xs font-semibold', method === m.value ? 'border-[var(--brand)] bg-brand-50 text-brand-700' : 'border-line text-ink-soft hover:bg-stone-50')}
          >
            <m.icon className="size-5" /> {m.label}
          </button>
        ))}
      </div>
      <Field label="Amount (₹)">{(fid) => <Input id={fid} value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" className="text-lg font-semibold tabular" />}</Field>
      {method === 'cash' && (
        <Field label="Cash received (₹)" hint={change !== null && change >= 0 ? `Return ${formatPaise(change)}` : 'Optional, to work out the change'}>
          {(fid) => <Input id={fid} value={tendered} onChange={(e) => setTendered(e.target.value)} inputMode="decimal" />}
        </Field>
      )}
      {method === 'upi' && (
        <div className="space-y-2 rounded-xl bg-stone-50 p-3">
          {qr ? (
            <div className="flex items-center gap-3">
              <img src={qr} alt="UPI QR for the guest to scan" className="size-28 rounded-lg border border-line bg-white" />
              <p className="text-xs text-ink-soft">Guest scans with any UPI app. Confirm only after you see the payment arrive in your UPI app.</p>
            </div>
          ) : (
            <p className="text-xs text-ink-soft">Add the outlet UPI ID in Settings to show a QR here.</p>
          )}
          <Input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="UTR / reference (last 4 digits is fine)" aria-label="UPI reference" />
        </div>
      )}
      {(method === 'card_slip' || method === 'other') && (
        <Input value={reference} onChange={(e) => setReference(e.target.value)} placeholder={method === 'card_slip' ? 'Card slip number' : 'Reference, e.g. room 412'} aria-label="Reference" />
      )}
      <Button size="lg" block variant="success" loading={busy} onClick={() => void pay()}>
        Confirm {formatPaise(Math.max(0, amountPaise))} received
      </Button>
    </Card>
  );
}

function countPaidShares(shares: number[], paid: number): number {
  let sum = 0;
  let n = 0;
  for (const s of shares) {
    if (sum + s <= paid) {
      sum += s;
      n++;
    } else break;
  }
  return n;
}

function PaymentList({ payments, canRefund, onRefund }: { payments: PaymentDTO[]; canRefund: boolean; onRefund: (p: PaymentDTO, amount: number, reason: string) => Promise<boolean> }) {
  const [refunding, setRefunding] = useState<PaymentDTO | null>(null);
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  return (
    <Card className="p-4">
      <h2 className="mb-2 font-semibold">Payments</h2>
      <ul className="divide-y divide-line text-sm">
        {payments.map((p) => (
          <li key={p.id} className="flex items-center gap-3 py-2">
            <span className={cn('flex-1', p.kind === 'refund' && 'text-rose-700')}>
              {p.kind === 'refund' ? 'Refund' : METHODS.find((m) => m.value === p.method)?.label} · {time(p.created_at)}
              {p.reference && p.kind === 'payment' && <span className="block text-xs text-ink-faint">{p.reference}</span>}
              {p.change_paise ? <span className="block text-xs text-ink-faint">change {formatPaise(p.change_paise)}</span> : null}
            </span>
            <span className="font-medium tabular">
              {p.kind === 'refund' ? '−' : ''}
              {formatPaise(p.amount_paise)}
            </span>
            {canRefund && p.kind === 'payment' && (
              <button
                onClick={() => {
                  setRefunding(p);
                  setAmount(rupeesInput(p.amount_paise));
                }}
                className="cursor-pointer text-xs font-medium text-ink-faint underline"
              >
                Refund
              </button>
            )}
          </li>
        ))}
      </ul>
      <ConfirmDialog
        open={!!refunding}
        onClose={() => setRefunding(null)}
        title="Refund payment"
        description="Needs manager approval and is written to the audit log."
        confirmLabel="Refund"
        onConfirm={async () => {
          if (!refunding || !reason.trim()) return;
          if (await onRefund(refunding, rupeesToPaise(amount), reason.trim())) setRefunding(null);
        }}
      >
        <div className="mt-3">
          <Field label="Amount (₹)">{(fid) => <Input id={fid} value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />}</Field>
        </div>
        <ReasonPicker reasons={['Overcharged', 'Item not served', 'Guest complaint']} value={reason} onChange={setReason} />
      </ConfirmDialog>
    </Card>
  );
}

function DiscountSheet({ bill, open, onClose, onSave }: { bill: BillDTO; open: boolean; onClose: () => void; onSave: (body: object) => void }) {
  const [kind, setKind] = useState<'percent' | 'amount'>(bill.bill_discount?.kind ?? 'percent');
  const [value, setValue] = useState(bill.bill_discount ? (bill.bill_discount.kind === 'percent' ? String(bill.bill_discount.bp / 100) : rupeesInput(bill.bill_discount.paise)) : '');
  const [reason, setReason] = useState(bill.discount_reason ?? '');
  const save = () => {
    const n = Number(value);
    if (!value || n <= 0) return onSave({ bill_discount: null, discount_reason: reason || null });
    onSave({
      bill_discount: kind === 'percent' ? { kind, bp: Math.round(n * 100) } : { kind, paise: rupeesToPaise(value) },
      discount_reason: reason.trim(),
    });
  };
  return (
    <Sheet open={open} onClose={onClose} title="Discount" footer={<Button block onClick={save}>Apply discount</Button>}>
      <Segmented value={kind} onChange={setKind} options={[{ value: 'percent', label: 'Percent' }, { value: 'amount', label: 'Amount (₹)' }]} />
      <div className="mt-3 flex flex-wrap gap-2">
        {(kind === 'percent' ? ['5', '10', '15', '20'] : ['50', '100', '200', '500']).map((v) => (
          <button key={v} onClick={() => setValue(v)} className={cn('h-10 cursor-pointer rounded-xl border px-4 text-sm font-medium', value === v ? 'border-[var(--brand)] bg-brand-50 text-brand-700' : 'border-line')}>
            {kind === 'percent' ? `${v}%` : `₹${v}`}
          </button>
        ))}
      </div>
      <Input className="mt-3" value={value} onChange={(e) => setValue(e.target.value)} inputMode="decimal" placeholder={kind === 'percent' ? 'Percent' : 'Rupees'} aria-label="Discount value" />
      <p className="mt-2 text-xs text-ink-faint">Above 10% a manager approves with their PIN.</p>
      <ReasonPicker reasons={['Regular guest', 'Hotel resident', 'Staff meal', 'Service recovery']} value={reason} onChange={setReason} />
    </Sheet>
  );
}

function SplitSheet({ bill, open, onClose, onSplit }: { bill: BillDTO; open: boolean; onClose: () => void; onSplit: (body: object) => void }) {
  const [mode, setMode] = useState<'amount' | 'items' | 'seats'>('amount');
  const [count, setCount] = useState(2);
  const [groups, setGroups] = useState<Record<string, number>>({});
  const n = Math.max(2, ...Object.values(groups).map((g) => g + 1), 2);
  const submit = () => {
    if (mode === 'amount') return onSplit({ mode, count });
    if (mode === 'seats') return onSplit({ mode });
    const buckets: string[][] = Array.from({ length: n }, () => []);
    for (const l of bill.lines) buckets[groups[l.order_item_id!] ?? 0]!.push(l.order_item_id!);
    onSplit({ mode, groups: buckets.filter((b) => b.length) });
  };
  return (
    <Sheet open={open} onClose={onClose} title="Split bill" footer={<Button block onClick={submit}>Split</Button>}>
      <Segmented value={mode} onChange={setMode} options={[{ value: 'amount', label: 'Equally' }, { value: 'items', label: 'By item' }, { value: 'seats', label: 'By seat' }]} />
      {mode === 'amount' && (
        <div className="mt-4">
          <p className="text-sm text-ink-soft">One invoice, paid in equal shares. Each share can use a different payment method.</p>
          <div className="mt-3 flex gap-2">
            {[2, 3, 4, 5, 6].map((c) => (
              <button key={c} onClick={() => setCount(c)} className={cn('h-12 w-12 cursor-pointer rounded-xl border text-lg font-semibold', count === c ? 'border-[var(--brand)] bg-brand-50 text-brand-700' : 'border-line')}>
                {c}
              </button>
            ))}
          </div>
          <p className="mt-3 text-sm">≈ {formatPaise(Math.ceil(bill.total_paise / count))} each</p>
        </div>
      )}
      {mode === 'items' && (
        <div className="mt-4 space-y-2">
          <p className="text-sm text-ink-soft">Each bill gets its own GST invoice. Tap to move an item to the next bill.</p>
          {bill.lines.map((l) => {
            const g = groups[l.order_item_id!] ?? 0;
            return (
              <button
                key={l.id}
                onClick={() => setGroups({ ...groups, [l.order_item_id!]: (g + 1) % Math.min(n + 1, 8) })}
                className="flex w-full cursor-pointer items-center justify-between rounded-xl border border-line px-3 py-2.5 text-left text-sm"
              >
                <span>
                  {l.qty}× {l.name}
                </span>
                <span className="rounded-lg bg-stone-100 px-2 py-1 text-xs font-semibold">Bill {g + 1}</span>
              </button>
            );
          })}
        </div>
      )}
      {mode === 'seats' && <p className="mt-4 text-sm text-ink-soft">One bill per seat, using the seat numbers on each item. Items without a seat go on a shared bill.</p>}
    </Sheet>
  );
}

function CustomerSheet({ bill, open, onClose, onSave }: { bill: BillDTO; open: boolean; onClose: () => void; onSave: (body: object) => void }) {
  const [name, setName] = useState(bill.customer_name ?? '');
  const [gstin, setGstin] = useState(bill.customer_gstin ?? '');
  return (
    <Sheet open={open} onClose={onClose} title="Business customer" footer={<Button block onClick={() => onSave({ customer_name: name || null, customer_gstin: gstin || null })}>Save</Button>}>
      <div className="space-y-3">
        <Field label="Business name">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
        <Field label="GSTIN" hint="Printed on the invoice for input tax credit">
          {(id) => <Input id={id} value={gstin} onChange={(e) => setGstin(e.target.value.toUpperCase())} maxLength={15} />}
        </Field>
      </div>
    </Sheet>
  );
}

function VoidDialog({ open, onClose, onConfirm, busy }: { open: boolean; onClose: () => void; onConfirm: (reason: string) => void; busy: boolean }) {
  const [reason, setReason] = useState('');
  return (
    <ConfirmDialog open={open} onClose={onClose} title="Void this bill?" description="The invoice number is kept and shown as cancelled. A manager must approve." confirmLabel="Void bill" busy={busy} onConfirm={() => reason.trim() && onConfirm(reason.trim())}>
      <ReasonPicker reasons={['Wrong table', 'Items billed twice', 'Guest disputed bill']} value={reason} onChange={setReason} />
    </ConfirmDialog>
  );
}

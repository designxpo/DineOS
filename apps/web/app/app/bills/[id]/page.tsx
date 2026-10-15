'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Banknote, CreditCard, FileText, Gift, Percent, Printer, Scissors, Search, Smartphone, Trash2, Undo2, UserRound, Wallet, X } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { rupeesToPaise } from '@dineos/shared/money';
import type { BillDTO, BillLineDTO, CustomerDTO, InvoiceDTO, PaymentDTO } from '@dineos/shared/dto';
import type { PaymentMethod } from '@dineos/shared/enums';
import { errorMessage } from '@/lib/api';
import { formatPaise, formatRate, rupeesInput, time } from '@/lib/format';
import { send } from '@/lib/outbox';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { useStaff } from '@/lib/staff';
import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';
import { ConfirmDialog, Sheet } from '@/components/ui/overlay';
import { Badge, Card, Field, Input, Segmented, Spinner, Switch } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/toast';
import { useWithApproval } from '@/components/staff/approval';
import { NewCustomerSheet } from '@/components/staff/customer-sheet';
import { ReasonPicker } from '@/components/staff/orders';

type Invoice = InvoiceDTO & { upi_uri: string | null };

const METHODS: { value: PaymentMethod; label: I18nKey; icon: React.ComponentType<{ className?: string }> }[] = [
  { value: 'cash', label: 'pay.cash', icon: Banknote },
  { value: 'upi', label: 'pay.upi', icon: Smartphone },
  { value: 'card_slip', label: 'pay.card', icon: CreditCard },
  { value: 'other', label: 'pay.other', icon: Wallet },
];

export default function BillPage() {
  const { id } = useParams<{ id: string }>();
  const { api, can } = useStaff();
  const { t } = useI18n();
  const qc = useQueryClient();
  const toast = useToast();
  const router = useRouter();
  const withApproval = useWithApproval();
  const [sheet, setSheet] = useState<null | 'discount' | 'split' | 'customer' | 'void'>(null);
  const [lineDiscount, setLineDiscount] = useState<BillLineDTO | null>(null);
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
                    {draft && can('bill.manage') && l.order_item_id ? (
                      <button className="cursor-pointer text-left underline-offset-2 hover:underline" onClick={() => setLineDiscount(l)} title="Discount this dish">
                        {l.name}
                      </button>
                    ) : (
                      l.name
                    )}
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
            {bill.loyalty_discount_paise > 0 && <Row label={`Points redeemed (${bill.loyalty_points_redeemed})`} value={`− ${formatPaise(bill.loyalty_discount_paise)}`} tone="text-emerald-700" />}
            {(bill.service_charge_paise > 0 || bill.service_charge_bp > 0) && (
              <Row label={`Service charge ${bill.service_charge_waived ? '(removed)' : `(${formatRate(bill.service_charge_bp)})`}`} value={formatPaise(bill.service_charge_paise)} />
            )}
            {inv.tax_summary.map((t) => (
              <Row key={t.tax_rate_bp} label={`CGST ${formatRate(t.tax_rate_bp / 2)} + SGST ${formatRate(t.tax_rate_bp / 2)} on ${formatPaise(t.taxable_paise)}`} value={formatPaise(t.cgst_paise + t.sgst_paise)} />
            ))}
            {bill.round_off_paise !== 0 && <Row label="Round off" value={formatPaise(bill.round_off_paise)} />}
            <div className="flex items-baseline justify-between border-t border-line pt-2">
              <dt className="font-semibold">{t('bill.total')}</dt>
              <dd className="font-display text-3xl font-semibold tabular">{formatPaise(bill.total_paise)}</dd>
            </div>
          </dl>
        </Card>

        <div className="space-y-4">
          {draft && can('bill.manage') && (
            <Card className="space-y-3 p-4">
              <div className="grid grid-cols-2 gap-2">
                <Button variant="outline" onClick={() => setSheet('discount')}>
                  <Percent className="size-4" /> {t('bill.discount')}
                </Button>
                <Button variant="outline" onClick={() => setSheet('split')}>
                  <Scissors className="size-4" /> {t('bill.split')}
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
                <Printer className="size-5" /> {t('bill.print')} · {formatPaise(bill.total_paise)}
              </Button>
              <p className="text-center text-xs text-ink-faint">Printing assigns the GST invoice number. After that, changes need a void.</p>
            </Card>
          )}

          {can('customer.view') && (draft || bill.customer) && bill.status !== 'void' && (
            <LoyaltyCard
              bill={bill}
              editable={draft && can('customer.manage')}
              onUpdate={(body, done) => act('loyalty', () => api(`/bills/${id}`, { method: 'PATCH', body }), done)}
            />
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
      {lineDiscount && (
        <LineDiscountSheet
          bill={bill}
          line={lineDiscount}
          onClose={() => setLineDiscount(null)}
          onSave={(body) => act('discount', (approval) => api(`/bills/${id}`, { method: 'PATCH', body, approvalToken: approval }), 'Dish discount applied').then((ok) => ok && setLineDiscount(null))}
        />
      )}
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

/** Member on the bill: attach by phone, redeem points while the bill is a draft. */
function LoyaltyCard({ bill, editable, onUpdate }: { bill: BillDTO; editable: boolean; onUpdate: (body: object, done: string) => Promise<boolean> }) {
  const { api, outletId, outlet } = useStaff();
  const [phone, setPhone] = useState('');
  const [adding, setAdding] = useState(false);
  const [points, setPoints] = useState('');
  const digits = phone.replace(/\D/g, '');
  const matches = useQuery({
    queryKey: ['customers', outletId, 'bill-search', digits],
    enabled: editable && !bill.customer && digits.length >= 4,
    queryFn: () => api<CustomerDTO[]>(`/customers?outlet_id=${outletId}&q=${digits}&limit=5`),
  });
  const loyalty = outlet?.loyalty_enabled;
  const value = outlet?.loyalty_point_value_paise ?? 100;
  const c = bill.customer;
  // Points cannot take the bill below zero; the API caps it the same way.
  const room = bill.subtotal_paise - bill.item_discount_paise - bill.bill_discount_paise;
  const max = c ? Math.min(c.points, Math.floor(room / value)) : 0;
  const canRedeem = loyalty && c && max >= (outlet?.loyalty_min_redeem_points ?? 0) && max > 0;

  return (
    <Card className="space-y-3 p-4">
      <p className="flex items-center gap-2 text-sm font-semibold">
        <Gift className="size-4 text-[var(--brand)]" /> {loyalty ? 'Loyalty' : 'Customer'}
      </p>
      {c ? (
        <>
          <div className="flex items-center gap-3 rounded-xl bg-stone-50 px-3 py-2.5">
            <UserRound className="size-5 shrink-0 text-ink-faint" />
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">{c.name ?? 'Guest'}</p>
              <p className="text-xs text-ink-faint tabular">
                {c.phone}
                {loyalty && ` · ${c.points} points`}
              </p>
            </div>
            {editable && (
              <button className="grid size-8 cursor-pointer place-items-center rounded-lg text-ink-faint hover:bg-stone-200" aria-label="Remove customer" onClick={() => void onUpdate({ customer_id: null }, 'Customer removed')}>
                <X className="size-4" />
              </button>
            )}
          </div>
          {bill.loyalty_points_redeemed > 0 && (
            <div className="flex items-center justify-between text-sm">
              <span>
                Using {bill.loyalty_points_redeemed} points ({formatPaise(bill.loyalty_discount_paise)})
              </span>
              {editable && (
                <Button size="sm" variant="ghost" onClick={() => void onUpdate({ redeem_points: 0 }, 'Points no longer used')}>
                  Undo
                </Button>
              )}
            </div>
          )}
          {editable && canRedeem && bill.loyalty_points_redeemed === 0 && (
            <div className="flex gap-2">
              <Input value={points} onChange={(e) => setPoints(e.target.value.replace(/\D/g, ''))} inputMode="numeric" placeholder={`Up to ${max}`} aria-label="Points to redeem" className="h-9" />
              <Button size="sm" variant="outline" onClick={() => setPoints(String(max))}>
                Max
              </Button>
              <Button size="sm" disabled={!Number(points)} onClick={() => void onUpdate({ redeem_points: Number(points) }, 'Points applied').then((ok) => ok && setPoints(''))}>
                Redeem
              </Button>
            </div>
          )}
          {editable && loyalty && !canRedeem && bill.loyalty_points_redeemed === 0 && c.points > 0 && (
            <p className="text-xs text-ink-faint">Points can be used from {outlet?.loyalty_min_redeem_points} upwards.</p>
          )}
          {bill.loyalty_points_earned > 0 && <p className="text-sm text-emerald-700">Earned {bill.loyalty_points_earned} points on this bill</p>}
          {loyalty && bill.status === 'draft' && <p className="text-xs text-ink-faint">Points are earned when the bill is paid.</p>}
        </>
      ) : editable ? (
        <>
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-faint" />
            <Input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" placeholder="Customer's phone" className="h-10 pl-9" aria-label="Find customer by phone" />
          </div>
          {matches.data?.map((m) => (
            <button
              key={m.id}
              onClick={() => void onUpdate({ customer_id: m.id }, `${m.name ?? 'Customer'} added to the bill`)}
              className="flex w-full cursor-pointer items-center gap-3 rounded-xl border border-line px-3 py-2 text-left text-sm hover:bg-stone-50"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{m.name ?? 'Guest'}</span>
                <span className="text-xs text-ink-faint tabular">{m.phone}</span>
              </span>
              {loyalty && <span className="text-xs font-semibold tabular">{m.points} pts</span>}
            </button>
          ))}
          {digits.length >= 10 && matches.data && !matches.data.length && (
            <Button size="sm" variant="outline" block onClick={() => setAdding(true)}>
              Save as new customer
            </Button>
          )}
          {digits.length < 10 && <p className="text-xs text-ink-faint">Add the guest to give them {loyalty ? 'points' : 'a visit history'}. Only with their consent.</p>}
        </>
      ) : null}
      {adding && (
        <NewCustomerSheet
          initialPhone={phone}
          onClose={() => setAdding(false)}
          onCreated={(cid, created) => {
            setAdding(false);
            setPhone('');
            void onUpdate({ customer_id: cid }, `${created.name ?? 'Customer'} added to the bill`);
          }}
        />
      )}
    </Card>
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
  const { t } = useI18n();
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
        <h2 className="font-semibold">{t('bill.take_payment')}</h2>
        <p className="text-sm text-ink-soft">
          {t('bill.due')} <span className="font-semibold text-ink tabular">{formatPaise(bill.balance_paise)}</span>
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
            <m.icon className="size-5" /> {t(m.label)}
          </button>
        ))}
      </div>
      <Field label={t('bill.amount')}>{(fid) => <Input id={fid} value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" className="text-lg font-semibold tabular" />}</Field>
      {method === 'cash' && (
        <Field label={t('bill.cash_received')} hint={change !== null && change >= 0 ? t('bill.return', { amount: formatPaise(change) }) : 'Optional, to work out the change'}>
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
        {t('bill.confirm', { amount: formatPaise(Math.max(0, amountPaise)) })}
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
              {p.kind === 'refund' ? 'Refund' : <MethodLabel method={p.method} />} · {time(p.created_at)}
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

/** Discount one dish (spec §8 per-item discount). Larger than 10% of the bill in total needs a manager. */
function LineDiscountSheet({ bill, line, onClose, onSave }: { bill: BillDTO; line: BillLineDTO; onClose: () => void; onSave: (body: object) => void }) {
  const [kind, setKind] = useState<'percent' | 'amount'>('percent');
  const [value, setValue] = useState(line.item_discount_paise ? rupeesInput(line.item_discount_paise) : '');
  const [reason, setReason] = useState(bill.discount_reason ?? '');
  useEffect(() => {
    if (line.item_discount_paise) setKind('amount');
  }, [line.item_discount_paise]);
  const existing = Object.fromEntries(bill.lines.filter((l) => l.item_discount_paise > 0 && l.order_item_id).map((l) => [l.order_item_id!, l.item_discount_paise]));
  let paise = 0;
  try {
    paise = !value ? 0 : kind === 'percent' ? Math.round((line.gross_paise * Math.min(100, Number(value))) / 100) : Math.min(line.gross_paise, rupeesToPaise(value));
  } catch {
    paise = 0;
  }
  const save = () => {
    const item_discounts = { ...existing, [line.order_item_id!]: paise };
    if (!paise) delete item_discounts[line.order_item_id!];
    onSave({ item_discounts, discount_reason: reason.trim() || null });
  };
  return (
    <Sheet open onClose={onClose} title={`Discount: ${line.name}`} footer={<Button block onClick={save}>{paise ? `Take ${formatPaise(paise)} off` : 'Remove discount'}</Button>}>
      <p className="mb-3 text-sm text-ink-soft">
        {line.qty} × {formatPaise(line.unit_price_paise)} = {formatPaise(line.gross_paise)}
      </p>
      <Segmented value={kind} onChange={setKind} options={[{ value: 'percent', label: 'Percent' }, { value: 'amount', label: 'Amount (₹)' }]} />
      <div className="mt-3 flex flex-wrap gap-2">
        {(kind === 'percent' ? ['10', '25', '50', '100'] : ['20', '50', '100']).map((v) => (
          <button key={v} onClick={() => setValue(v)} className={cn('h-10 cursor-pointer rounded-xl border px-4 text-sm font-medium', value === v ? 'border-[var(--brand)] bg-brand-50 text-brand-700' : 'border-line')}>
            {kind === 'percent' ? (v === '100' ? 'On the house' : `${v}%`) : `₹${v}`}
          </button>
        ))}
      </div>
      <Input className="mt-3" value={value} onChange={(e) => setValue(e.target.value)} inputMode="decimal" aria-label="Discount value" />
      <ReasonPicker reasons={['Dish was late', 'Not to taste', 'Complimentary', 'Staff meal']} value={reason} onChange={setReason} />
    </Sheet>
  );
}

function MethodLabel({ method }: { method: PaymentMethod }) {
  const { t } = useI18n();
  const m = METHODS.find((x) => x.value === method);
  return <>{m ? t(m.label) : method}</>;
}

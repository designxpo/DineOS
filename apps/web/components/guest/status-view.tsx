'use client';

import { BellRing, Check, ChefHat, CircleX, Clock, Gift, HandPlatter, Plus, ReceiptIndianRupee } from 'lucide-react';
import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import type { GuestOrderDTO } from '@dineos/shared/dto';
import type { OrderStatus } from '@dineos/shared/enums';
import { errorMessage } from '@/lib/api';
import { time } from '@/lib/format';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';
import { Input, VegMark } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/toast';
import { formatRupee } from './guest-app';
import type { GuestApi } from './use-guest';

const STEPS: { status: OrderStatus; icon: React.ComponentType<{ className?: string }> }[] = [
  { status: 'accepted', icon: Check },
  { status: 'preparing', icon: ChefHat },
  { status: 'ready', icon: BellRing },
  { status: 'served', icon: HandPlatter },
];
const RANK: Record<string, number> = { placed: 0, accepted: 1, preparing: 2, ready: 3, served: 4, billed: 5 };

export function StatusView({ g, onAddMore }: { g: GuestApi; onAddMore: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const [called, setCalled] = useState(false);
  const orders = [...(g.session?.orders ?? [])].reverse();
  const billRequested = !!g.session?.session.bill_requested_at;
  const bill = g.session?.bill;

  return (
    <div className="space-y-4 px-4 pt-4">
      <div className="grid grid-cols-3 gap-2">
        <ActionTile icon={<Plus className="size-5" />} label={t('guest.add_more')} onClick={onAddMore} />
        <ActionTile
          icon={<BellRing className="size-5" />}
          label={called ? t('guest.waiter_coming') : t('guest.call_waiter')}
          active={called}
          onClick={() =>
            g.callWaiter.mutate(undefined, {
              onSuccess: () => {
                setCalled(true);
                toast(t('guest.waiter_coming'));
              },
              onError: (e) => toast(errorMessage(e), 'error'),
            })
          }
        />
        <ActionTile
          icon={<ReceiptIndianRupee className="size-5" />}
          label={billRequested ? t('guest.bill_requested') : t('guest.request_bill')}
          active={billRequested}
          onClick={() => g.requestBill.mutate(undefined, { onError: (e) => toast(errorMessage(e), 'error') })}
        />
      </div>

      {bill && <BillCard g={g} total={bill.total_paise} paid={bill.paid_paise} />}

      {g.session?.loyalty.enabled && <LoyaltyCard g={g} />}

      {orders.map((order) => (
        <OrderCard key={order.id} order={order} />
      ))}
      {orders.length > 0 && <p className="pb-4 text-center text-xs text-ink-faint">{t('guest.status')}</p>}
    </div>
  );
}

function ActionTile({ icon, label, onClick, active }: { icon: React.ReactNode; label: string; onClick: () => void; active?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex min-h-20 cursor-pointer flex-col items-center justify-center gap-1.5 rounded-2xl border px-2 py-3 text-center text-xs font-semibold transition active:scale-[0.98]',
        active ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-line bg-surface text-ink hover:bg-stone-50',
      )}
    >
      <span className={active ? 'text-emerald-700' : 'text-[var(--brand)]'}>{icon}</span>
      {label}
    </button>
  );
}

function OrderCard({ order }: { order: GuestOrderDTO }) {
  const { t } = useI18n();
  const rank = RANK[order.status] ?? -1;
  const failed = order.status === 'rejected' || order.status === 'cancelled';
  return (
    <article className="rounded-2xl border border-line bg-surface p-4">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-ink">{t('guest.order_n', { n: order.order_no })}</h3>
        <span className="flex items-center gap-1 text-xs text-ink-faint">
          <Clock className="size-3.5" /> {time(order.placed_at)}
        </span>
      </div>

      {failed ? (
        <div className="mt-3 flex items-start gap-2 rounded-xl bg-rose-50 p-3 text-sm text-rose-800" role="status">
          <CircleX className="mt-0.5 size-4 shrink-0" />
          <div>
            <p className="font-semibold">{t(`status.${order.status}` as I18nKey)}</p>
            {order.rejected_reason && <p className="mt-0.5">{order.rejected_reason}</p>}
          </div>
        </div>
      ) : (
        <>
          {order.status === 'placed' && (
            <p className="mt-2 flex items-center gap-2 text-sm font-medium text-amber-800">
              <span className="size-2 animate-pulse rounded-full bg-amber-500" /> {t('status.placed')}
            </p>
          )}
          <ol className="mt-3 grid grid-cols-4 gap-1" aria-label={t(`status.${order.status}` as I18nKey)}>
            {STEPS.map(({ status, icon: Icon }) => {
              const done = rank >= RANK[status]!;
              const current = rank === RANK[status];
              return (
                <li key={status} className="flex flex-col items-center gap-1.5 text-center">
                  <span
                    className={cn(
                      'grid size-9 place-items-center rounded-full transition',
                      done ? 'bg-[var(--brand)] text-white' : 'bg-stone-100 text-ink-faint',
                      current && 'ring-4 ring-brand-100',
                    )}
                  >
                    <Icon className="size-4" />
                  </span>
                  <span className={cn('text-[11px] leading-tight', done ? 'font-semibold text-ink' : 'text-ink-faint')}>{t(`status.${status}` as I18nKey)}</span>
                </li>
              );
            })}
          </ol>
        </>
      )}

      <ul className="mt-4 space-y-2 border-t border-line pt-3">
        {order.items.map((i) => (
          <li key={i.id} className={cn('flex items-start gap-2.5 text-sm', i.status === 'cancelled' && 'text-ink-faint line-through')}>
            <VegMark veg={i.is_veg} className="mt-0.5" />
            <span className="flex-1">
              <span className="font-medium">{i.qty} × </span>
              {i.name}
              {i.modifiers.length > 0 && <span className="block text-xs text-ink-faint">{i.modifiers.join(', ')}</span>}
            </span>
            {!failed && i.status !== 'cancelled' && order.status !== 'placed' && (
              <span className={cn('rounded-md px-1.5 py-0.5 text-[11px] font-semibold', i.status === 'ready' ? 'bg-emerald-50 text-emerald-700' : 'bg-stone-100 text-ink-soft')}>
                {t(`item.${i.status}` as I18nKey)}
              </span>
            )}
          </li>
        ))}
      </ul>
    </article>
  );
}

/** Guests share their number with explicit consent; nothing about an existing member is shown. */
function LoyaltyCard({ g }: { g: GuestApi }) {
  const { t } = useI18n();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [consent, setConsent] = useState(false);
  const [offers, setOffers] = useState(false);
  const member = g.session?.customer;
  const pct = ((g.session?.loyalty.earn_bp ?? 0) / 100).toString();
  const restaurant = g.context?.outlet.name ?? '';

  if (member) {
    return (
      <section className="flex items-start gap-3 rounded-2xl border border-emerald-200 bg-emerald-50/70 p-4">
        <Gift className="mt-0.5 size-5 shrink-0 text-emerald-700" />
        <div>
          <p className="font-medium text-ink">{t('guest.loyalty_member', { last4: member.phone_last4 })}</p>
          <p className="mt-0.5 text-sm text-ink-soft">{t('guest.loyalty_member_hint')}</p>
        </div>
      </section>
    );
  }

  return (
    <section className="rounded-2xl border border-line bg-surface p-4">
      <button className="flex w-full cursor-pointer items-start gap-3 text-left" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <Gift className="mt-0.5 size-5 shrink-0 text-[var(--brand)]" />
        <span>
          <span className="block font-semibold text-ink">{t('guest.loyalty_title', { pct })}</span>
          <span className="mt-0.5 block text-sm text-ink-soft">{t('guest.loyalty_hint')}</span>
        </span>
      </button>
      {open && (
        <form
          className="mt-4 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            g.joinLoyalty.mutate({ phone, name: name.trim() || null, marketing_opt_in: offers }, { onError: (err) => toast(errorMessage(err), 'error') });
          }}
        >
          <Input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" autoComplete="tel" placeholder={t('guest.loyalty_phone')} aria-label={t('guest.loyalty_phone')} />
          <Input value={name} onChange={(e) => setName(e.target.value)} autoComplete="given-name" placeholder={t('guest.loyalty_name')} aria-label={t('guest.loyalty_name')} />
          <label className="flex cursor-pointer items-start gap-3 text-sm text-ink-soft">
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-0.5 size-4 shrink-0 accent-[var(--brand)]" />
            {t('guest.loyalty_consent', { name: restaurant })}
          </label>
          <label className="flex cursor-pointer items-center gap-3 text-sm text-ink-soft">
            <input type="checkbox" checked={offers} onChange={(e) => setOffers(e.target.checked)} className="size-4 shrink-0 accent-[var(--brand)]" />
            {t('guest.loyalty_offers')}
          </label>
          <Button type="submit" block disabled={!consent || phone.replace(/\D/g, '').length < 10} loading={g.joinLoyalty.isPending}>
            {t('guest.loyalty_join')}
          </Button>
        </form>
      )}
    </section>
  );
}

function BillCard({ g, total, paid }: { g: GuestApi; total: number; paid: number }) {
  const { t } = useI18n();
  const balance = Math.max(0, total - paid);
  const vpa = g.context?.outlet.upi_vpa;
  const payee = g.context?.outlet.upi_payee_name ?? g.context?.outlet.name ?? '';
  const uri = vpa && balance > 0 ? `upi://pay?${new URLSearchParams({ pa: vpa, pn: payee, am: (balance / 100).toFixed(2), cu: 'INR', tn: `Table ${g.context?.table.label}` })}` : null;
  const [qr, setQr] = useState<string | null>(null);
  useEffect(() => {
    if (uri) QRCode.toDataURL(uri, { margin: 1, width: 360 }).then(setQr).catch(() => setQr(null));
  }, [uri]);

  return (
    <section className="rounded-2xl border border-violet-200 bg-violet-50/60 p-4">
      <div className="flex items-baseline justify-between">
        <h3 className="font-semibold text-ink">{t('guest.bill_total')}</h3>
        <p className="font-display text-2xl font-semibold tabular">{formatRupee(total)}</p>
      </div>
      {paid > 0 && (
        <p className="mt-1 text-sm text-ink-soft">
          {t('guest.paid')} {formatRupee(paid)} · {t('guest.balance')} <span className="font-semibold text-ink">{formatRupee(balance)}</span>
        </p>
      )}
      {uri && (
        <div className="mt-3 rounded-xl bg-surface p-3">
          <p className="text-xs text-ink-soft">{t('guest.pay_upi_hint')}</p>
          <div className="mt-3 flex items-center gap-4">
            {qr && <img src={qr} alt="UPI payment QR code" className="size-28 rounded-lg border border-line" />}
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{vpa}</p>
              <a href={uri} className="mt-2 inline-flex h-11 items-center rounded-xl bg-[var(--brand)] px-4 text-sm font-semibold text-white">
                {t('guest.pay_upi')} · {formatRupee(balance)}
              </a>
            </div>
          </div>
        </div>
      )}
      {!uri && balance === 0 && <Button variant="secondary" className="mt-3" disabled>{t('guest.paid')}</Button>}
    </section>
  );
}

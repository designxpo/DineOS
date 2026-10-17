'use client';

import { useQuery } from '@tanstack/react-query';
import { Banknote, CreditCard, Smartphone, Wallet } from 'lucide-react';
import { useState } from 'react';
import type { BillDTO, MembershipPlanDTO, WalletPackDTO, WalletTopupDTO } from '@dineos/shared/dto';
import type { TopupMethod } from '@dineos/shared/enums';
import { describeMembership, describePack } from '@dineos/shared/loyalty';
import { rupeesToPaise } from '@dineos/shared/money';
import { errorMessage } from '@/lib/api';
import { formatPaise } from '@/lib/format';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { useStaff } from '@/lib/staff';
import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';
import { Sheet } from '@/components/ui/overlay';
import { Input, Spinner } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/toast';

const TOPUP_METHODS: { value: TopupMethod; label: I18nKey; icon: React.ComponentType<{ className?: string }> }[] = [
  { value: 'cash', label: 'pay.cash', icon: Banknote },
  { value: 'upi', label: 'pay.upi', icon: Smartphone },
  { value: 'card_slip', label: 'pay.card', icon: CreditCard },
  { value: 'other', label: 'pay.other', icon: Wallet },
];

function Choice({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      onClick={onClick}
      className={cn('w-full cursor-pointer rounded-xl border px-3 py-2.5 text-left text-sm transition active:scale-[0.99]', on ? 'border-[var(--brand)] bg-brand-50' : 'border-line hover:bg-stone-50')}
    >
      {children}
    </button>
  );
}

/** Takes the guest's money for a wallet pack (or any amount) and adds it, with the bonus. */
export function TopUpSheet({ customerId, onClose, onDone }: { customerId: string; onClose: () => void; onDone: () => void }) {
  const { api, outletId } = useStaff();
  const { t } = useI18n();
  const toast = useToast();
  const packs = useQuery({ queryKey: ['wallet-packs', outletId], queryFn: () => api<WalletPackDTO[]>(`/wallet/packs?outlet_id=${outletId}`) });
  const live = (packs.data ?? []).filter((p) => p.is_active);
  const [packId, setPackId] = useState<string | 'other' | null>(null);
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<TopupMethod>('cash');
  const [reference, setReference] = useState('');
  const [busy, setBusy] = useState(false);
  const pick = packId ?? live[0]?.id ?? 'other';
  let custom = 0;
  try {
    custom = amount ? rupeesToPaise(amount) : 0;
  } catch {
    custom = 0;
  }
  const ready = pick === 'other' ? custom >= 10_000 : true;
  const chosen = live.find((p) => p.id === pick);
  const collect = chosen ? chosen.pay_paise : custom;

  const add = async () => {
    setBusy(true);
    try {
      const done = await api<WalletTopupDTO>(`/customers/${customerId}/wallet/topups`, {
        method: 'POST',
        body: { outlet_id: outletId, method, reference: reference.trim() || null, ...(pick === 'other' ? { amount_paise: custom } : { pack_id: pick }) },
      });
      toast(t('topup.done', { amount: formatPaise(done.paid_paise + done.bonus_paise), receipt: done.receipt_no }));
      onDone();
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open
      onClose={onClose}
      title={t('topup.title')}
      footer={
        <Button block size="lg" disabled={!ready} loading={busy} onClick={() => void add()}>
          {collect > 0 ? t('topup.add_amount', { amount: formatPaise(collect) }) : t('topup.add')}
        </Button>
      }
    >
      {packs.isLoading ? (
        <Spinner />
      ) : (
        <div className="space-y-4">
          <div className="space-y-1.5" role="radiogroup" aria-label={t('topup.title')}>
            {live.map((p) => (
              <Choice key={p.id} on={pick === p.id} onClick={() => setPackId(p.id)}>
                <span className="block font-medium">{p.name}</span>
                <span className="text-xs text-ink-soft">{describePack(p)}</span>
              </Choice>
            ))}
            <Choice on={pick === 'other'} onClick={() => setPackId('other')}>
              <span className="block font-medium">{t('topup.other')}</span>
              {pick === 'other' && <Input className="mt-2 h-10" inputMode="decimal" autoFocus value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="₹" aria-label={t('topup.other')} />}
            </Choice>
          </div>
          <div className="grid grid-cols-4 gap-2">
            {TOPUP_METHODS.map((m) => (
              <button
                key={m.value}
                type="button"
                aria-pressed={method === m.value}
                onClick={() => setMethod(m.value)}
                className={cn('flex h-14 cursor-pointer flex-col items-center justify-center gap-1 rounded-xl border text-xs font-semibold', method === m.value ? 'border-[var(--brand)] bg-brand-50 text-brand-700' : 'border-line text-ink-soft')}
              >
                <m.icon className="size-4" /> {t(m.label)}
              </button>
            ))}
          </div>
          {method !== 'cash' && <Input value={reference} onChange={(e) => setReference(e.target.value)} placeholder={t('bill.upi_ref')} aria-label={t('bill.upi_ref_aria')} />}
          <p className="text-xs text-ink-faint">{t('topup.note')}</p>
        </div>
      )}
    </Sheet>
  );
}

/** Sells a membership: makes its bill, which staff then print and take payment on. */
export function SellMembershipSheet({ customerId, onClose, onSold }: { customerId: string; onClose: () => void; onSold: (bill: BillDTO) => void }) {
  const { api, outletId } = useStaff();
  const { t } = useI18n();
  const toast = useToast();
  const plans = useQuery({ queryKey: ['membership-plans', outletId], queryFn: () => api<MembershipPlanDTO[]>(`/memberships/plans?outlet_id=${outletId}`) });
  const live = (plans.data ?? []).filter((p) => p.is_active);
  const [planId, setPlanId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pick = planId ?? live[0]?.id ?? null;

  const sell = async () => {
    if (!pick) return;
    setBusy(true);
    try {
      onSold(await api<BillDTO>(`/customers/${customerId}/memberships`, { method: 'POST', body: { outlet_id: outletId, plan_id: pick } }));
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open
      onClose={onClose}
      title={t('sell.title')}
      footer={
        <Button block size="lg" disabled={!pick} loading={busy} onClick={() => void sell()}>
          {t('sell.go')}
        </Button>
      }
    >
      {plans.isLoading ? (
        <Spinner />
      ) : live.length ? (
        <div className="space-y-1.5" role="radiogroup" aria-label={t('sell.title')}>
          {live.map((p) => (
            <Choice key={p.id} on={pick === p.id} onClick={() => setPlanId(p.id)}>
              <span className="flex items-baseline justify-between gap-2">
                <span className="font-medium">{p.name}</span>
                <span className="font-semibold tabular">{formatPaise(p.price_paise)}</span>
              </span>
              {describeMembership(p).map((line) => (
                <span key={line} className="block text-xs text-ink-soft">
                  {line}
                </span>
              ))}
            </Choice>
          ))}
          <p className="pt-2 text-xs text-ink-faint">{t('sell.note')}</p>
        </div>
      ) : (
        <p className="py-6 text-center text-sm text-ink-faint">{t('sell.none')}</p>
      )}
    </Sheet>
  );
}

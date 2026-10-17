'use client';

import { useQuery } from '@tanstack/react-query';
import { Gift, Minus, Plus, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { CustomerDTO } from '@dineos/shared/dto';
import { COMP_REASONS, type CompReason } from '@dineos/shared/enums';
import { formatPaise } from '@/lib/format';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { useStaff } from '@/lib/staff';
import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';
import { Sheet } from '@/components/ui/overlay';
import { Input, Textarea } from '@/components/ui/primitives';

export const COMP_REASON_LABEL: Record<CompReason, I18nKey> = {
  mishap: 'comp.r.mishap',
  special_guest: 'comp.r.special_guest',
  owners_guest: 'comp.r.owners_guest',
  celebration: 'comp.r.celebration',
  staff_meal: 'comp.r.staff_meal',
  marketing: 'comp.r.marketing',
  other: 'comp.r.other',
};

/** A dish that can be given free: how many there are and how many are free already. */
export interface CompTarget {
  id: string;
  name: string;
  qty: number;
  free: number;
  unitPricePaise: number;
}

export interface CompRequest {
  itemId?: string;
  qty?: number;
  reason: CompReason;
  note: string | null;
  customerId: string | null;
}

/**
 * Gives a dish, part of a line, or a whole bill free, with why and for whom. Owners, managers and
 * cashiers give it directly; a waiter's request asks for a manager's PIN (the caller handles it).
 */
export function CompForm({
  items,
  wholeBillPaise,
  customer,
  onGive,
}: {
  /** Dishes to choose from; with one, it is already chosen. Not used for a whole bill. */
  items?: CompTarget[];
  wholeBillPaise?: number;
  /** The bill's guest, if one is attached. */
  customer?: { id: string; label: string } | null;
  onGive: (req: CompRequest) => Promise<boolean>;
}) {
  const { t } = useI18n();
  const open = (items ?? []).filter((i) => i.qty - i.free > 0);
  const [itemId, setItemId] = useState<string | null>(open.length === 1 ? open[0]!.id : null);
  const target = open.find((i) => i.id === itemId) ?? null;
  const left = target ? target.qty - target.free : 0;
  const [qty, setQty] = useState(left || 1);
  const [reason, setReason] = useState<CompReason | null>(null);
  const [note, setNote] = useState('');
  const [guest, setGuest] = useState(customer ?? null);
  const [busy, setBusy] = useState(false);
  useEffect(() => setQty(left || 1), [itemId, left]);

  const whole = wholeBillPaise !== undefined;
  const value = whole ? wholeBillPaise : target ? qty * target.unitPricePaise : 0;
  const ready = !!reason && (whole || !!target) && (reason !== 'other' || !!note.trim());
  const give = async () => {
    if (!ready) return;
    setBusy(true);
    try {
      await onGive({ itemId: target?.id, qty: whole ? undefined : qty, reason: reason!, note: note.trim() || null, customerId: guest?.id ?? null });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      {!whole && open.length > 1 && (
        <div>
          <p className="mb-2 text-sm font-medium">{t('comp.which')}</p>
          <div className="space-y-1.5" role="radiogroup" aria-label={t('comp.which')}>
            {open.map((i) => (
              <button
                key={i.id}
                type="button"
                role="radio"
                aria-checked={itemId === i.id}
                onClick={() => setItemId(i.id)}
                className={cn(
                  'flex w-full cursor-pointer items-center gap-3 rounded-xl border px-3 py-2.5 text-left text-sm transition active:scale-[0.99]',
                  itemId === i.id ? 'border-[var(--brand)] bg-brand-50' : 'border-line hover:bg-stone-50',
                )}
              >
                <span className="font-semibold tabular">{i.qty}×</span>
                <span className="flex-1">
                  {i.name}
                  {i.free > 0 && <span className="block text-xs text-emerald-700">{t('comp.already', { n: i.free })}</span>}
                </span>
                <span className="text-ink-faint tabular">{formatPaise(i.qty * i.unitPricePaise)}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {!whole && target && left > 1 && (
        <div className="flex items-center gap-3">
          <span className="text-sm font-medium">{t('comp.how_many')}</span>
          <div className="flex h-11 items-center rounded-xl border border-line bg-surface">
            <button className="grid h-full w-11 cursor-pointer place-items-center" aria-label="Fewer" onClick={() => setQty((q) => Math.max(1, q - 1))}>
              <Minus className="size-4" />
            </button>
            <span className="w-10 text-center font-semibold tabular">{qty}</span>
            <button className="grid h-full w-11 cursor-pointer place-items-center" aria-label="More" onClick={() => setQty((q) => Math.min(left, q + 1))}>
              <Plus className="size-4" />
            </button>
          </div>
          <span className="text-xs text-ink-faint">/ {left}</span>
        </div>
      )}

      <div>
        <p className="mb-2 text-sm font-medium">{t('comp.why')}</p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" role="radiogroup" aria-label={t('comp.why')}>
          {COMP_REASONS.map((r) => (
            <button
              key={r}
              type="button"
              role="radio"
              aria-checked={reason === r}
              onClick={() => setReason(r)}
              className={cn(
                'min-h-11 cursor-pointer rounded-xl border px-3 py-2 text-left text-sm font-medium transition active:scale-[0.98]',
                reason === r ? 'border-[var(--brand)] bg-brand-50 text-brand-700' : 'border-line text-ink-soft hover:bg-stone-50',
              )}
            >
              {t(COMP_REASON_LABEL[r])}
            </button>
          ))}
        </div>
      </div>

      <Textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        maxLength={300}
        aria-label={t('comp.note')}
        placeholder={t(reason === 'mishap' ? 'comp.note_mishap' : reason === 'other' ? 'comp.note_other' : 'comp.note_any')}
      />

      <GuestPicker guest={guest} onChange={setGuest} />

      <Button block size="lg" variant="success" disabled={!ready} loading={busy} onClick={() => void give()}>
        <Gift className="size-4" /> {t('comp.give', { amount: formatPaise(value) })}
      </Button>
    </div>
  );
}

/** Who it was for: a guest from the customer list, by phone; optional. */
function GuestPicker({ guest, onChange }: { guest: { id: string; label: string } | null; onChange: (g: { id: string; label: string } | null) => void }) {
  const { api, outletId, can } = useStaff();
  const { t } = useI18n();
  const [phone, setPhone] = useState('');
  const digits = phone.replace(/\D/g, '');
  const { data: matches = [] } = useQuery({
    queryKey: ['customers', outletId, 'comp-search', digits],
    enabled: digits.length >= 4 && !guest && can('customer.view'),
    queryFn: () => api<CustomerDTO[]>(`/customers?outlet_id=${outletId}&q=${digits}&limit=5`),
  });
  if (!can('customer.view')) return null;
  if (guest) {
    return (
      <div className="flex items-center gap-2 rounded-xl bg-stone-50 px-3 py-2 text-sm">
        <span className="text-ink-faint">{t('comp.for')}</span>
        <span className="flex-1 font-medium">{guest.label}</span>
        <button type="button" onClick={() => onChange(null)} aria-label="Remove guest" className="grid size-8 cursor-pointer place-items-center rounded-lg hover:bg-stone-100">
          <X className="size-4" />
        </button>
      </div>
    );
  }
  return (
    <div>
      <Input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" placeholder={t('comp.guest_search')} aria-label={t('comp.guest_search')} />
      {matches.length > 0 && (
        <ul className="mt-1 divide-y divide-line overflow-hidden rounded-xl border border-line">
          {matches.map((c) => (
            <li key={c.id}>
              <button type="button" onClick={() => onChange({ id: c.id, label: `${c.name ?? 'Guest'} (…${c.phone.slice(-4)})` })} className="flex w-full cursor-pointer items-center justify-between px-3 py-2 text-left text-sm hover:bg-stone-50">
                <span>{c.name ?? 'Guest'}</span>
                <span className="text-ink-faint tabular">…{c.phone.slice(-4)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function CompSheet({ open, onClose, title, ...form }: { open: boolean; onClose: () => void; title: string } & React.ComponentProps<typeof CompForm>) {
  return (
    <Sheet open={open} onClose={onClose} title={title}>
      {open && <CompForm {...form} />}
    </Sheet>
  );
}

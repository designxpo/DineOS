'use client';

import { Minus, Plus, ShoppingBag, Users } from 'lucide-react';
import { useMemo, useState } from 'react';
import { computeBill } from '@mezmitra/shared/billing';
import { ApiError, errorMessage } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { Sheet } from '@/components/ui/overlay';
import { VegMark } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/toast';
import { formatRupee } from './guest-app';
import type { GuestApi } from './use-guest';

export function CartSheet({ g, open, onClose, onOrdered }: { g: GuestApi; open: boolean; onClose: () => void; onOrdered: () => void }) {
  const { t, name } = useI18n();
  const toast = useToast();
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const lines = g.session?.cart.lines ?? [];
  const menu = g.menu;
  const outlet = g.context?.outlet;
  const allMods = useMemo(() => menu?.modifier_groups.flatMap((gr) => gr.modifiers) ?? [], [menu]);

  const priced = useMemo(
    () =>
      lines.map((l) => {
        const item = menu?.items.find((i) => i.id === l.item_id);
        const mods = l.modifier_ids.map((id) => allMods.find((m) => m.id === id)).filter((m) => !!m);
        const unit = (item?.price_paise ?? 0) + mods.reduce((a, m) => a + m!.price_delta_paise, 0);
        return { line: l, item, mods, unit };
      }),
    [lines, menu, allMods],
  );

  // The same arithmetic the bill will use, so the estimate matches the final invoice.
  const totals = useMemo(
    () =>
      computeBill({
        lines: priced.filter((p) => p.item).map((p) => ({ key: p.line.line_id, qty: p.line.qty, unit_price_paise: p.unit, tax_rate_bp: p.item!.tax_rate_bp })),
        service_charge_bp: outlet?.service_charge_bp ?? 0,
        service_charge_tax_rate_bp: outlet?.service_charge_tax_rate_bp ?? 500,
        prices_include_tax: outlet?.prices_include_tax ?? false,
      }),
    [priced, outlet],
  );

  const placeOrder = () => {
    setProblem(null);
    g.placeOrder.mutate(note.trim() || null, {
      onSuccess: () => {
        setNote('');
        onOrdered();
      },
      onError: (err) => {
        if (err instanceof ApiError && err.code === 'items_unavailable') {
          const items = (err.details as { items?: { message: string }[] })?.items ?? [];
          setProblem(items.map((i) => i.message).join(' · ') || err.message);
        } else toast(errorMessage(err), 'error');
      },
    });
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={t('guest.cart')}
      footer={
        lines.length > 0 ? (
          <Button size="xl" block onClick={placeOrder} loading={g.placeOrder.isPending}>
            {g.placeOrder.isPending ? t('guest.placing') : `${t('guest.order_now')} · ${formatRupee(totals.total_paise)}`}
          </Button>
        ) : undefined
      }
    >
      {lines.length === 0 ? (
        <div className="py-12 text-center">
          <ShoppingBag className="mx-auto size-10 text-ink-faint" />
          <p className="mt-3 font-medium">{t('guest.cart_empty')}</p>
          <p className="mt-1 text-sm text-ink-faint">{t('guest.cart_empty_hint')}</p>
        </div>
      ) : (
        <>
          <p className="mb-3 flex items-center gap-2 rounded-xl bg-stone-50 px-3 py-2 text-xs text-ink-soft">
            <Users className="size-4 shrink-0" /> {t('guest.cart_shared')}
          </p>
          <ul className="divide-y divide-line">
            {priced.map(({ line, item, mods, unit }) => (
              <li key={line.line_id} className="flex gap-3 py-3.5">
                <VegMark veg={item?.is_veg ?? true} className="mt-1" />
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-ink">{item ? name(item) : '…'}</p>
                  {mods.length > 0 && <p className="text-xs text-ink-faint">{mods.map((m) => name(m!)).join(', ')}</p>}
                  {line.note && <p className="text-xs text-ink-faint italic">“{line.note}”</p>}
                  {line.added_by !== g.deviceId && <p className="mt-0.5 text-[11px] font-medium text-sky-700">Added by someone at your table</p>}
                  <p className="mt-1 text-sm font-medium tabular">{formatRupee(unit * line.qty)}</p>
                </div>
                <div className="flex h-9 items-center self-center rounded-xl border border-brand-200 text-[var(--brand)]">
                  <button onClick={() => g.updateLine.mutate({ lineId: line.line_id, qty: line.qty - 1 })} aria-label="Remove one" className="grid h-full w-9 cursor-pointer place-items-center">
                    <Minus className="size-4" />
                  </button>
                  <span className="w-5 text-center text-sm font-bold tabular">{line.qty}</span>
                  <button onClick={() => g.updateLine.mutate({ lineId: line.line_id, qty: line.qty + 1 })} aria-label="Add one" className="grid h-full w-9 cursor-pointer place-items-center">
                    <Plus className="size-4" />
                  </button>
                </div>
              </li>
            ))}
          </ul>

          <label className="mt-2 block">
            <span className="text-sm font-medium text-ink">{t('guest.order_note')}</span>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={300}
              rows={2}
              placeholder={t('guest.note_placeholder')}
              className="mt-1.5 w-full rounded-xl border border-line px-3.5 py-2.5 text-[15px] focus:border-[var(--brand)] focus:outline-none"
            />
          </label>

          <dl className="mt-4 space-y-1.5 rounded-2xl bg-stone-50 p-4 text-sm">
            <Row label={t('guest.subtotal')} value={formatRupee(totals.subtotal_paise)} />
            {totals.service_charge_paise > 0 && <Row label={t('guest.service_charge')} value={formatRupee(totals.service_charge_paise)} />}
            <Row label={t('guest.taxes')} value={formatRupee(totals.tax_total_paise)} />
            <div className="border-t border-line pt-1.5">
              <Row label={t('guest.estimated_total')} value={formatRupee(totals.total_paise)} strong />
            </div>
          </dl>
          {problem && (
            <p role="alert" className="mt-3 rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-800">
              {problem}
            </p>
          )}
        </>
      )}
    </Sheet>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex justify-between">
      <dt className={strong ? 'font-semibold text-ink' : 'text-ink-soft'}>{label}</dt>
      <dd className={`tabular ${strong ? 'font-semibold text-ink' : 'text-ink'}`}>{value}</dd>
    </div>
  );
}

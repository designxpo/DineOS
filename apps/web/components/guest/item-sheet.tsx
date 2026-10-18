'use client';

import { Check, Minus, Plus } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { MenuItemDTO, ModifierGroupDTO } from '@mezmitra/shared/dto';
import { checkModifierSelection } from '@mezmitra/shared/menu';
import { errorMessage } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';
import { Sheet } from '@/components/ui/overlay';
import { VegMark } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/toast';
import { formatRupee } from './guest-app';
import type { GuestApi } from './use-guest';

export function ItemSheet({ g, item, onClose }: { g: GuestApi; item: MenuItemDTO | null; onClose: () => void }) {
  const { t, name, description } = useI18n();
  const toast = useToast();
  const [picked, setPicked] = useState<string[]>([]);
  const [qty, setQty] = useState(1);
  const [note, setNote] = useState('');
  const [showErrors, setShowErrors] = useState(false);

  useEffect(() => {
    setPicked([]);
    setQty(1);
    setNote('');
    setShowErrors(false);
  }, [item?.id]);

  const groups: ModifierGroupDTO[] = useMemo(
    () => (item && g.menu ? item.modifier_group_ids.map((id) => g.menu!.modifier_groups.find((gr) => gr.id === id)).filter((x): x is ModifierGroupDTO => !!x) : []),
    [item, g.menu],
  );
  const check = checkModifierSelection(groups, picked);
  const unit = (item?.price_paise ?? 0) + picked.reduce((a, id) => a + (groups.flatMap((gr) => gr.modifiers).find((m) => m.id === id)?.price_delta_paise ?? 0), 0);

  if (!item) return null;
  // While the restaurant bills on another system the menu is for reading: guests order with staff.
  const ordering = g.context?.outlet.ordering !== false;

  const toggle = (group: ModifierGroupDTO, id: string) => {
    setPicked((current) => {
      const inGroup = group.modifiers.map((m) => m.id);
      if (group.max_select === 1) return [...current.filter((x) => !inGroup.includes(x)), id];
      if (current.includes(id)) return current.filter((x) => x !== id);
      const count = current.filter((x) => inGroup.includes(x)).length;
      return count >= group.max_select ? current : [...current, id];
    });
  };

  const submit = () => {
    if (!check.ok) {
      setShowErrors(true);
      return;
    }
    g.addLine.mutate(
      { item_id: item.id, qty, modifier_ids: picked, note: note.trim() || null },
      {
        onSuccess: () => {
          toast(t('guest.added'));
          onClose();
        },
        onError: (err) => toast(errorMessage(err), 'error'),
      },
    );
  };

  const desc = description(item);

  return (
    <Sheet
      open
      onClose={onClose}
      footer={
        !ordering ? undefined : (
        <div className="flex items-center gap-3">
          <div className="flex h-12 items-center rounded-xl border border-line">
            <button onClick={() => setQty((q) => Math.max(1, q - 1))} aria-label="Fewer" className="grid h-full w-11 cursor-pointer place-items-center text-ink-soft">
              <Minus className="size-4" />
            </button>
            <span className="w-6 text-center font-semibold tabular">{qty}</span>
            <button onClick={() => setQty((q) => Math.min(99, q + 1))} aria-label="More" className="grid h-full w-11 cursor-pointer place-items-center text-ink-soft">
              <Plus className="size-4" />
            </button>
          </div>
          <Button size="lg" block onClick={submit} loading={g.addLine.isPending}>
            {t('guest.add_item')} · <span className="tabular">{formatRupee(unit * qty)}</span>
          </Button>
        </div>
        )
      }
    >
      {item.photo_url && <img src={item.photo_url} alt="" className="-mx-5 mb-4 aspect-[16/9] w-[calc(100%+2.5rem)] max-w-none object-cover sm:rounded-t-3xl" />}
      <div className="pt-2">
        <VegMark veg={item.is_veg} />
        <h2 className="mt-2 font-display text-2xl font-semibold text-ink">{name(item)}</h2>
        <p className="mt-1 font-medium tabular">{formatRupee(item.price_paise)}</p>
        {desc && <p className="mt-2 text-sm leading-relaxed text-ink-soft">{desc}</p>}
      </div>

      {groups.map((group) => {
        const required = group.min_select > 0;
        const count = picked.filter((id) => group.modifiers.some((m) => m.id === id)).length;
        const invalid = showErrors && !check.ok && check.group_id === group.id;
        return (
          <fieldset key={group.id} className="mt-6">
            <legend className="flex w-full items-center justify-between">
              <span className="font-semibold text-ink">{name(group)}</span>
              <span className={cn('rounded-md px-1.5 py-0.5 text-[11px] font-semibold', required ? 'bg-brand-50 text-[var(--brand)]' : 'bg-stone-100 text-ink-faint')}>
                {required ? t('guest.required') : t('guest.optional')}
              </span>
            </legend>
            <p className={cn('mt-0.5 text-xs', invalid ? 'font-medium text-rose-700' : 'text-ink-faint')}>
              {invalid ? check.message : group.max_select === 1 ? t('guest.choose_n', { n: 1 }) : t('guest.choose_up_to', { n: group.max_select })}
            </p>
            <div className="mt-2 divide-y divide-line rounded-2xl border border-line">
              {group.modifiers.map((m) => {
                const on = picked.includes(m.id);
                const full = group.max_select > 1 && !on && count >= group.max_select;
                return (
                  <button
                    key={m.id}
                    type="button"
                    role={group.max_select === 1 ? 'radio' : 'checkbox'}
                    aria-checked={on}
                    disabled={!m.in_stock || full}
                    onClick={() => toggle(group, m.id)}
                    className="flex min-h-12 w-full cursor-pointer items-center gap-3 px-4 py-2 text-left disabled:cursor-not-allowed disabled:opacity-45"
                  >
                    <span className="flex flex-1 items-center gap-2 text-[15px] text-ink">
                      {name(m)}
                      {!m.is_veg && <VegMark veg={false} className="scale-90" />}
                    </span>
                    {m.price_delta_paise !== 0 && <span className="text-sm text-ink-soft tabular">+{formatRupee(m.price_delta_paise)}</span>}
                    {!m.in_stock && <span className="text-xs text-ink-faint">{t('guest.sold_out')}</span>}
                    <span
                      className={cn(
                        'grid size-5 shrink-0 place-items-center border-2 transition',
                        group.max_select === 1 ? 'rounded-full' : 'rounded-md',
                        on ? 'border-[var(--brand)] bg-[var(--brand)] text-white' : 'border-stone-300',
                      )}
                    >
                      {on && <Check className="size-3" strokeWidth={3} />}
                    </span>
                  </button>
                );
              })}
            </div>
          </fieldset>
        );
      })}

      {ordering ? (
        <label className="mt-6 block">
          <span className="text-sm font-medium text-ink">{t('guest.order_note')}</span>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={200}
            rows={2}
            placeholder={t('guest.note_placeholder')}
            className="mt-1.5 w-full rounded-xl border border-line px-3.5 py-2.5 text-[15px] focus:border-[var(--brand)] focus:outline-none"
          />
        </label>
      ) : (
        <p className="mt-6 rounded-xl bg-stone-50 px-3.5 py-2.5 text-sm text-ink-soft">{t('guest.menu_only')}</p>
      )}
    </Sheet>
  );
}

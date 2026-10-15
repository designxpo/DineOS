'use client';

import { Check } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { MenuDTO, MenuItemDTO, ModifierGroupDTO } from '@dineos/shared/dto';
import { checkModifierSelection } from '@dineos/shared/menu';
import { formatPrice } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';
import { Sheet } from '@/components/ui/overlay';

/** Staff-side choice picker for an item's modifier groups. */
export function ModifierSheet({
  menu,
  item,
  onClose,
  onDone,
}: {
  menu: MenuDTO;
  item: MenuItemDTO | null;
  onClose: () => void;
  onDone: (modifierIds: string[]) => void;
}) {
  const [picked, setPicked] = useState<string[]>([]);
  const [tried, setTried] = useState(false);
  useEffect(() => {
    setPicked([]);
    setTried(false);
  }, [item?.id]);
  if (!item) return null;
  const groups = item.modifier_group_ids.map((id) => menu.modifier_groups.find((g) => g.id === id)).filter((g): g is ModifierGroupDTO => !!g);
  const check = checkModifierSelection(groups, picked);

  const toggle = (g: ModifierGroupDTO, id: string) =>
    setPicked((cur) => {
      const inGroup = g.modifiers.map((m) => m.id);
      if (g.max_select === 1) return [...cur.filter((x) => !inGroup.includes(x)), id];
      if (cur.includes(id)) return cur.filter((x) => x !== id);
      return cur.filter((x) => inGroup.includes(x)).length >= g.max_select ? cur : [...cur, id];
    });

  return (
    <Sheet
      open
      onClose={onClose}
      title={item.name}
      footer={
        <Button
          block
          size="lg"
          onClick={() => {
            if (!check.ok) return setTried(true);
            onDone(picked);
          }}
        >
          Add to order
        </Button>
      }
    >
      {groups.map((g) => (
        <fieldset key={g.id} className="mb-5">
          <legend className="mb-2 flex w-full justify-between text-sm font-semibold">
            {g.name}
            <span className={cn('text-xs font-medium', tried && !check.ok && check.group_id === g.id ? 'text-rose-700' : 'text-ink-faint')}>
              {tried && !check.ok && check.group_id === g.id ? check.message : g.min_select > 0 ? `Pick ${g.min_select === g.max_select ? g.min_select : `${g.min_select}-${g.max_select}`}` : `Up to ${g.max_select}`}
            </span>
          </legend>
          <div className="grid grid-cols-2 gap-2">
            {g.modifiers.map((m) => {
              const on = picked.includes(m.id);
              return (
                <button
                  key={m.id}
                  disabled={!m.in_stock}
                  onClick={() => toggle(g, m.id)}
                  aria-pressed={on}
                  className={cn(
                    'flex min-h-12 cursor-pointer items-center justify-between gap-2 rounded-xl border px-3 text-left text-sm transition disabled:opacity-40',
                    on ? 'border-[var(--brand)] bg-brand-50 font-semibold text-brand-700' : 'border-line hover:bg-stone-50',
                  )}
                >
                  <span>{m.name}</span>
                  <span className="flex items-center gap-1 text-xs text-ink-faint">
                    {m.price_delta_paise ? `+${formatPrice(m.price_delta_paise)}` : ''}
                    {on && <Check className="size-4 text-brand-700" />}
                  </span>
                </button>
              );
            })}
          </div>
        </fieldset>
      ))}
    </Sheet>
  );
}

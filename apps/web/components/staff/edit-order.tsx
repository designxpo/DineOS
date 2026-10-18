'use client';

import { useQueryClient } from '@tanstack/react-query';
import { Minus, Plus, Search, Undo2, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { MenuItemDTO, OrderDTO, OrderItemDTO } from '@mezmitra/shared/dto';
import { itemWasMade } from '@mezmitra/shared/order-state';
import { searchDishes } from '@mezmitra/shared/search';
import { errorMessage, newKey } from '@/lib/api';
import { formatPaise, formatPrice } from '@/lib/format';
import { usePopular, useStaffMenu } from '@/lib/menu-cache';
import { useStaff } from '@/lib/staff';
import { Button, IconButton } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';
import { Sheet } from '@/components/ui/overlay';
import { Input, VegMark } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/toast';
import { useWithApproval } from './approval';
import { ModifierSheet } from './modifier-sheet';

interface NewLine {
  key: string;
  item: MenuItemDTO;
  qty: number;
  modifierIds: string[];
}

const CANCEL_REASONS = ['Guest changed mind', 'Out of stock', 'Entered by mistake', 'Took too long'];

/**
 * Edit an order from the inbox or the floor (spec §7): change quantities before the kitchen has it,
 * cancel single dishes (a manager approves once the kitchen has them), add dishes while cooking.
 */
export function EditOrderSheet({ order, open, onClose }: { order: OrderDTO; open: boolean; onClose: () => void }) {
  const { api } = useStaff();
  const qc = useQueryClient();
  const toast = useToast();
  const withApproval = useWithApproval();
  const menu = useStaffMenu();
  const popular = usePopular();
  const [qty, setQty] = useState<Record<string, number>>({});
  const [cancel, setCancel] = useState<Record<string, string>>({});
  // Whether the kitchen had made a cancelled dish (its ingredients are wasted); defaults from its status.
  const [made, setMade] = useState<Record<string, boolean>>({});
  // What became of a dish that was made: thrown away, remade, or eaten by staff.
  const [fate, setFate] = useState<Record<string, 'discarded' | 'remake' | 'staff_meal'>>({});
  const [adds, setAdds] = useState<NewLine[]>([]);
  const [search, setSearch] = useState('');
  const [picking, setPicking] = useState<MenuItemDTO | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setQty({});
    setCancel({});
    setMade({});
    setAdds([]);
    setSearch('');
  }, [open]);

  const placed = order.status === 'placed';
  const madeOf = (i: OrderItemDTO) => made[i.id] ?? itemWasMade(i.status);
  const canAdd = ['placed', 'accepted', 'preparing'].includes(order.status);
  const active = order.items.filter((i) => i.status !== 'cancelled');
  const allMods = useMemo(() => menu.data?.modifier_groups.flatMap((g) => g.modifiers) ?? [], [menu.data]);
  const results = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q || !menu.data) return [];
    return searchDishes(menu.data.items.filter((i) => i.in_stock), q, popular).slice(0, 8);
  }, [search, menu.data, popular]);

  const changed = Object.keys(qty).length + Object.keys(cancel).length + adds.length > 0;
  const unit = (l: NewLine) => l.item.price_paise + l.modifierIds.reduce((a, id) => a + (allMods.find((m) => m.id === id)?.price_delta_paise ?? 0), 0);

  const add = (item: MenuItemDTO, modifierIds: string[] = []) => {
    setAdds((cur) => {
      const same = cur.find((l) => l.item.id === item.id && l.modifierIds.join() === modifierIds.join());
      if (same) return cur.map((l) => (l === same ? { ...l, qty: l.qty + 1 } : l));
      return [...cur, { key: newKey(), item, qty: 1, modifierIds }];
    });
    setSearch('');
  };

  const save = async () => {
    const missingReason = Object.entries(cancel).find(([, r]) => !r.trim());
    if (missingReason) return toast('Give a reason for each cancelled dish', 'error');
    setBusy(true);
    try {
      const body = {
        ...(Object.keys(qty).length ? { set_qty: Object.entries(qty).map(([order_item_id, q]) => ({ order_item_id, qty: q })) } : {}),
        ...(Object.keys(cancel).length
          ? {
              cancel: Object.entries(cancel).map(([order_item_id, reason]) => {
                const item = order.items.find((i) => i.id === order_item_id)!;
                return { order_item_id, reason: reason.trim(), ...(item.status === 'placed' ? {} : { made: madeOf(item), ...(madeOf(item) ? { disposition: fate[item.id] ?? 'discarded' } : {}) }) };
              }),
            }
          : {}),
        ...(adds.length ? { add: adds.map((l) => ({ item_id: l.item.id, qty: l.qty, modifier_ids: l.modifierIds })) } : {}),
      };
      const res = await withApproval((approvalToken) => api<OrderDTO>(`/orders/${order.id}/items`, { method: 'PATCH', body, approvalToken }));
      if (!res) return;
      await qc.invalidateQueries({ queryKey: ['orders'] });
      await qc.invalidateQueries({ queryKey: ['kds'] });
      toast(`Order #${order.order_no} updated`);
      onClose();
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Sheet
        open={open}
        onClose={onClose}
        title={`Edit order #${order.order_no}`}
        footer={
          <Button block size="lg" disabled={!changed} loading={busy} onClick={() => void save()}>
            Save changes
          </Button>
        }
      >
        {!placed && <p className="mb-3 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-900">The kitchen already has this order. Cancelling a dish prints a cancellation ticket and needs a manager.</p>}
        <ul className="divide-y divide-line">
          {active.map((i) => {
            const cancelled = i.id in cancel;
            const q = qty[i.id] ?? i.qty;
            return (
              <li key={i.id} className="py-3">
                <div className="flex items-center gap-2">
                  <VegMark veg={i.is_veg} />
                  <div className={cn('min-w-0 flex-1', cancelled && 'text-ink-faint line-through')}>
                    <p className="text-sm font-medium">{i.name}</p>
                    {i.modifiers.length > 0 && <p className="text-xs text-ink-faint">{i.modifiers.map((m) => m.name).join(', ')}</p>}
                  </div>
                  {placed && !cancelled ? (
                    <div className="flex h-9 items-center rounded-lg border border-line">
                      <button className="grid h-full w-8 cursor-pointer place-items-center" aria-label="Fewer" disabled={q <= 1} onClick={() => setQty({ ...qty, [i.id]: q - 1 })}>
                        <Minus className="size-3.5" />
                      </button>
                      <span className="w-6 text-center text-sm font-semibold tabular">{q}</span>
                      <button className="grid h-full w-8 cursor-pointer place-items-center" aria-label="More" onClick={() => setQty({ ...qty, [i.id]: q + 1 })}>
                        <Plus className="size-3.5" />
                      </button>
                    </div>
                  ) : (
                    <span className="text-sm font-semibold tabular">{i.qty}×</span>
                  )}
                  {cancelled ? (
                    <IconButton
                      label="Keep this dish"
                      onClick={() => {
                        const next = { ...cancel };
                        delete next[i.id];
                        setCancel(next);
                      }}
                    >
                      <Undo2 className="size-4" />
                    </IconButton>
                  ) : (
                    <IconButton label={`Cancel ${i.name}`} disabled={i.status === 'served' && !placed} onClick={() => setCancel({ ...cancel, [i.id]: '' })}>
                      <X className="size-4 text-rose-600" />
                    </IconButton>
                  )}
                </div>
                {cancelled && (
                  <div className="mt-2 flex flex-wrap gap-1.5 pl-6">
                    {CANCEL_REASONS.map((r) => (
                      <button key={r} onClick={() => setCancel({ ...cancel, [i.id]: r })} className={cn('h-8 cursor-pointer rounded-full border px-2.5 text-xs', cancel[i.id] === r ? 'border-rose-400 bg-rose-50 text-rose-800' : 'border-line')}>
                        {r}
                      </button>
                    ))}
                  </div>
                )}
                {cancelled && i.status !== 'placed' && (
                  <div className="mt-2 flex flex-wrap gap-1.5 pl-6" role="radiogroup" aria-label={`Had the kitchen made ${i.name}?`}>
                    {[false, true].map((m) => (
                      <button
                        key={String(m)}
                        type="button"
                        role="radio"
                        aria-checked={madeOf(i) === m}
                        onClick={() => setMade({ ...made, [i.id]: m })}
                        className={cn('h-8 cursor-pointer rounded-full border px-2.5 text-xs', madeOf(i) === m ? 'border-stone-500 bg-stone-100 font-medium text-ink' : 'border-line text-ink-soft')}
                      >
                        {m ? 'Already made (wasted)' : 'Not made yet'}
                      </button>
                    ))}
                  </div>
                )}
                {cancelled && i.status !== 'placed' && madeOf(i) && (
                  <div className="mt-2 flex flex-wrap gap-1.5 pl-6" role="radiogroup" aria-label={`What happened to ${i.name}?`}>
                    {([['discarded', 'Thrown away'], ['remake', 'Being remade'], ['staff_meal', 'Staff meal']] as const).map(([v, label]) => (
                      <button
                        key={v}
                        type="button"
                        role="radio"
                        aria-checked={(fate[i.id] ?? 'discarded') === v}
                        onClick={() => setFate({ ...fate, [i.id]: v })}
                        className={cn('h-8 cursor-pointer rounded-full border px-2.5 text-xs', (fate[i.id] ?? 'discarded') === v ? 'border-stone-500 bg-stone-100 font-medium text-ink' : 'border-line text-ink-soft')}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                )}
              </li>
            );
          })}
        </ul>

        {canAdd ? (
          <div className="mt-4 rounded-2xl bg-stone-50 p-3">
            <p className="mb-2 text-sm font-medium">Add dishes</p>
            <label className="relative block">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-faint" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search the menu" className="pl-9" aria-label="Search the menu" />
            </label>
            {results.length > 0 && (
              <ul className="mt-2 divide-y divide-line rounded-xl border border-line bg-surface">
                {results.map((item) => (
                  <li key={item.id}>
                    <button className="flex w-full cursor-pointer items-center gap-2 px-3 py-2.5 text-left text-sm hover:bg-stone-50" onClick={() => (item.modifier_group_ids.length ? setPicking(item) : add(item))}>
                      <VegMark veg={item.is_veg} /> <span className="flex-1">{item.name}</span>
                      <span className="text-ink-faint tabular">{formatPrice(item.price_paise)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {adds.length > 0 && (
              <ul className="mt-3 space-y-2">
                {adds.map((l) => (
                  <li key={l.key} className="flex items-center gap-2 text-sm">
                    <span className="flex-1">
                      {l.qty}× {l.item.name}
                      {l.modifierIds.length > 0 && <span className="block text-xs text-ink-faint">{l.modifierIds.map((id) => allMods.find((m) => m.id === id)?.name).join(', ')}</span>}
                    </span>
                    <span className="tabular">{formatPaise(unit(l) * l.qty)}</span>
                    <IconButton label="Remove" onClick={() => setAdds(adds.filter((x) => x.key !== l.key))}>
                      <X className="size-4" />
                    </IconButton>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <p className="mt-4 text-xs text-ink-faint">This order is already ready or served. Start a new order from the POS to add more.</p>
        )}
      </Sheet>
      {menu.data && (
        <ModifierSheet
          menu={menu.data}
          item={picking}
          onClose={() => setPicking(null)}
          onDone={(ids) => {
            if (picking) add(picking, ids);
            setPicking(null);
          }}
        />
      )}
    </>
  );
}

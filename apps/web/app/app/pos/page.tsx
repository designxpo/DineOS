'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Minus, Plus, Search, ShoppingCart, StickyNote, Trash2, X } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Fragment, Suspense, useEffect, useMemo, useState } from 'react';
import type { BillDTO, MenuItemDTO, OrderDTO, TableDTO } from '@dineos/shared/dto';
import type { DeliveryChannel, OrderType } from '@dineos/shared/enums';
import { isScheduleOpen } from '@dineos/shared/menu';
import { ApiError, errorMessage, newKey } from '@/lib/api';
import { formatPaise, formatPrice } from '@/lib/format';
import { useStaffMenu } from '@/lib/menu-cache';
import { send } from '@/lib/outbox';
import { useI18n } from '@/lib/i18n';
import { useStaff } from '@/lib/staff';
import { Button, IconButton } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';
import { Sheet } from '@/components/ui/overlay';
import { EmptyState, Input, Segmented, Select, Spinner, VegMark } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/toast';
import { ModifierSheet } from '@/components/staff/modifier-sheet';

interface Line {
  key: string;
  item: MenuItemDTO;
  qty: number;
  modifierIds: string[];
  note: string;
  seat: number | null;
}

export default function PosPage() {
  return (
    <Suspense fallback={null}>
      <Pos />
    </Suspense>
  );
}

function Pos() {
  const { api, token, outletId, can, roles } = useStaff();
  const { t } = useI18n();
  const router = useRouter();
  const params = useSearchParams();
  const qc = useQueryClient();
  const toast = useToast();
  const menu = useStaffMenu();
  const tables = useQuery({ queryKey: ['tables', outletId], queryFn: () => api<TableDTO[]>(`/tables?outlet_id=${outletId}`) });

  const [type, setType] = useState<OrderType>('dine_in');
  const [tableId, setTableId] = useState('');
  const [guests, setGuests] = useState('');
  const [customer, setCustomer] = useState({ name: '', phone: '' });
  const [channel, setChannel] = useState<DeliveryChannel>('zomato');
  const [channelRef, setChannelRef] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [note, setNote] = useState('');
  const [category, setCategory] = useState<string>('all');
  const [query, setQuery] = useState('');
  const [picking, setPicking] = useState<MenuItemDTO | null>(null);
  const [ticketOpen, setTicketOpen] = useState(false);
  const [noteFor, setNoteFor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const t = params.get('table');
    if (t) {
      setType('dine_in');
      setTableId(t);
    }
  }, [params]);

  const m = menu.data;
  const allMods = useMemo(() => m?.modifier_groups.flatMap((g) => g.modifiers) ?? [], [m]);
  const categories = useMemo(() => m?.categories.filter((c) => c.is_active) ?? [], [m]);
  const items = useMemo(() => {
    if (!m) return [];
    const q = query.trim().toLowerCase();
    const active = new Set(categories.map((c) => c.id));
    const rank = new Map(categories.map((c, i) => [c.id, i]));
    return m.items
      .filter((i) => active.has(i.category_id) && (category === 'all' || i.category_id === category) && (!q || i.name.toLowerCase().includes(q)))
      .sort((a, b) => (rank.get(a.category_id) ?? 0) - (rank.get(b.category_id) ?? 0));
  }, [m, categories, category, query]);
  const grouped = category === 'all' && !query.trim();

  const unit = (l: Line) => l.item.price_paise + l.modifierIds.reduce((a, id) => a + (allMods.find((x) => x.id === id)?.price_delta_paise ?? 0), 0);
  const subtotal = lines.reduce((a, l) => a + unit(l) * l.qty, 0);
  const count = lines.reduce((a, l) => a + l.qty, 0);

  const add = (item: MenuItemDTO, modifierIds: string[] = []) => {
    setLines((cur) => {
      const same = cur.find((l) => l.item.id === item.id && l.modifierIds.join() === modifierIds.join() && !l.note && l.seat === null);
      if (same) return cur.map((l) => (l === same ? { ...l, qty: l.qty + 1 } : l));
      return [...cur, { key: newKey(), item, qty: 1, modifierIds, note: '', seat: null }];
    });
  };
  const tap = (item: MenuItemDTO) => (item.modifier_group_ids.length ? setPicking(item) : add(item));
  const setQty = (key: string, qty: number) => setLines((cur) => (qty <= 0 ? cur.filter((l) => l.key !== key) : cur.map((l) => (l.key === key ? { ...l, qty } : l))));

  const reset = () => {
    setLines([]);
    setNote('');
    setCustomer({ name: '', phone: '' });
    setChannelRef('');
    setGuests('');
    setTicketOpen(false);
  };

  const submit = async (andBill: boolean) => {
    if (lines.length === 0) return;
    if (type === 'dine_in' && !tableId) return toast('Pick a table', 'error');
    setBusy(true);
    const body = {
      outlet_id: outletId,
      type,
      source: roles.includes('waiter') ? 'waiter' : 'pos',
      table_id: type === 'dine_in' ? tableId : undefined,
      guest_count: guests ? Number(guests) : undefined,
      note: note.trim() || null,
      customer_name: customer.name.trim() || null,
      customer_phone: customer.phone.trim() || null,
      channel: type === 'delivery' ? channel : undefined,
      channel_ref: type === 'delivery' ? channelRef.trim() || null : undefined,
      lines: lines.map((l) => ({ item_id: l.item.id, qty: l.qty, modifier_ids: l.modifierIds, note: l.note.trim() || null, seat_no: l.seat })),
    };
    try {
      const res = await send<OrderDTO>(token, '/orders', { method: 'POST', body, label: `${type === 'dine_in' ? tables.data?.find((t) => t.id === tableId)?.label : type === 'delivery' ? t(`channel.${channel}`) : 'Counter'} order` });
      if (res.queued) {
        toast('No connection: order saved on this device and will be sent automatically', 'info');
        reset();
        return;
      }
      toast(`Order #${res.data.order_no} sent to the kitchen`);
      void qc.invalidateQueries({ queryKey: ['orders'] });
      void qc.invalidateQueries({ queryKey: ['tables'] });
      reset();
      if (andBill && can('bill.manage')) {
        const bill = await api<BillDTO>('/bills', { method: 'POST', body: type === 'dine_in' ? { table_session_id: res.data.table_session_id } : { order_id: res.data.id } });
        router.push(`/app/bills/${bill.id}`);
      }
    } catch (err) {
      if (err instanceof ApiError && err.code === 'items_unavailable') void qc.invalidateQueries({ queryKey: ['menu'] });
      toast(errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  const ticket = (
    <div className="flex h-full flex-col">
      <div className="space-y-3 border-b border-line p-4">
        <Segmented
          value={type}
          onChange={setType}
          className="w-full"
          options={[
            { value: 'dine_in', label: t('pos.dine_in') },
            { value: 'takeaway', label: t('pos.takeaway') },
            { value: 'counter', label: t('pos.counter') },
            { value: 'delivery', label: t('pos.delivery') },
          ]}
        />
        {type === 'delivery' && (
          <Segmented
            value={channel}
            onChange={setChannel}
            className="w-full"
            options={[
              { value: 'zomato', label: t('channel.zomato') },
              { value: 'swiggy', label: t('channel.swiggy') },
              { value: 'own', label: t('channel.own') },
            ]}
          />
        )}
        {type === 'dine_in' ? (
          <div className="flex gap-2">
            <Select value={tableId} onChange={(e) => setTableId(e.target.value)} aria-label="Table" className="flex-1">
              <option value="">{t('pos.select_table')}</option>
              {(tables.data ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                  {t.session?.status === 'open' ? ' • occupied' : ''}
                </option>
              ))}
            </Select>
            <Input value={guests} onChange={(e) => setGuests(e.target.value.replace(/\D/g, ''))} placeholder={t('pos.guests')} inputMode="numeric" className="w-24" aria-label={t('pos.guests')} />
          </div>
        ) : type === 'delivery' && channel !== 'own' ? (
          <Input value={channelRef} onChange={(e) => setChannelRef(e.target.value)} placeholder={t('pos.platform_ref')} aria-label={t('pos.platform_ref')} />
        ) : (
          <div className="flex gap-2">
            <Input value={customer.name} onChange={(e) => setCustomer({ ...customer, name: e.target.value })} placeholder={t('pos.customer')} aria-label={t('pos.customer')} />
            <Input value={customer.phone} onChange={(e) => setCustomer({ ...customer, phone: e.target.value })} placeholder={t('pos.phone')} inputMode="tel" aria-label={t('pos.phone')} className="w-40" />
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        {lines.length === 0 ? (
          <EmptyState icon={<ShoppingCart className="size-5" />} title={t('pos.no_items')} hint={t('pos.tap')} />
        ) : (
          <ul className="divide-y divide-line">
            {lines.map((l) => {
              const mods = l.modifierIds.map((id) => allMods.find((x) => x.id === id)?.name).filter(Boolean);
              return (
                <li key={l.key} className="px-4 py-3">
                  <div className="flex items-start gap-2">
                    <VegMark veg={l.item.is_veg} className="mt-1" />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">{l.item.name}</p>
                      {mods.length > 0 && <p className="text-xs text-ink-faint">{mods.join(', ')}</p>}
                      {l.note && <p className="text-xs text-amber-800">“{l.note}”</p>}
                      <div className="mt-1.5 flex items-center gap-2">
                        <Select
                          value={l.seat ?? ''}
                          onChange={(e) => setLines((cur) => cur.map((x) => (x.key === l.key ? { ...x, seat: e.target.value ? Number(e.target.value) : null } : x)))}
                          className="h-8 w-24 rounded-lg px-2 text-xs"
                          aria-label="Seat"
                        >
                          <option value="">{t('pos.no_seat')}</option>
                          {Array.from({ length: 12 }, (_, i) => (
                            <option key={i + 1} value={i + 1}>
                              {t('pos.seat', { n: i + 1 })}
                            </option>
                          ))}
                        </Select>
                        <button onClick={() => setNoteFor(l.key)} className="inline-flex h-8 cursor-pointer items-center gap-1 rounded-lg px-2 text-xs text-ink-soft hover:bg-stone-100">
                          <StickyNote className="size-3.5" /> {t('pos.note_btn')}
                        </button>
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-semibold tabular">{formatPaise(unit(l) * l.qty)}</p>
                      <div className="mt-1 flex h-9 items-center rounded-lg border border-line">
                        <button onClick={() => setQty(l.key, l.qty - 1)} className="grid h-full w-8 cursor-pointer place-items-center" aria-label="Fewer">
                          {l.qty === 1 ? <Trash2 className="size-3.5 text-rose-600" /> : <Minus className="size-3.5" />}
                        </button>
                        <span className="w-6 text-center text-sm font-semibold tabular">{l.qty}</span>
                        <button onClick={() => setQty(l.key, l.qty + 1)} className="grid h-full w-8 cursor-pointer place-items-center" aria-label="More">
                          <Plus className="size-3.5" />
                        </button>
                      </div>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="space-y-3 border-t border-line p-4">
        <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('pos.note')} aria-label={t('pos.note')} />
        <div className="flex items-baseline justify-between">
          <span className="text-sm text-ink-soft">{t('pos.items', { n: count })}</span>
          <span className="font-display text-2xl font-semibold tabular">{formatPaise(subtotal)}</span>
        </div>
        <div className="flex gap-2">
          {lines.length > 0 && (
            <IconButton label="Clear ticket" onClick={reset} className="h-12 w-12 shrink-0 border border-line">
              <X className="size-5" />
            </IconButton>
          )}
          <Button size="lg" block disabled={lines.length === 0} loading={busy} onClick={() => void submit(false)} variant={type === 'dine_in' ? 'primary' : 'outline'}>
            {t('pos.send')}
          </Button>
          {can('bill.manage') && (
            <Button size="lg" block disabled={lines.length === 0} loading={busy} onClick={() => void submit(true)} variant={type === 'dine_in' ? 'outline' : 'primary'}>
              {t('pos.send_bill')}
            </Button>
          )}
        </div>
      </div>
    </div>
  );

  return (
    <div className="flex h-[calc(100dvh-4rem-var(--tabbar-h))]">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="space-y-3 border-b border-line bg-surface p-4">
          <label className="relative block">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-faint" />
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('pos.search')} className="pl-9" aria-label={t('pos.search')} />
          </label>
          <div className="-mx-4 flex gap-2 overflow-x-auto px-4 [scrollbar-width:none]">
            {[{ id: 'all', name: t('pos.all') }, ...categories].map((c) => (
              <button
                key={c.id}
                onClick={() => setCategory(c.id)}
                className={cn('h-9 shrink-0 cursor-pointer rounded-full px-3.5 text-sm font-medium', category === c.id ? 'bg-ink text-white' : 'bg-stone-100 text-ink-soft hover:bg-stone-200')}
              >
                {c.name}
              </button>
            ))}
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          {menu.isLoading && !m ? (
            <div className="grid place-items-center py-24">
              <Spinner />
            </div>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3 pb-24 lg:pb-4">
              {items.map((item, i) => {
                const cat = categories.find((c) => c.id === item.category_id);
                const closed = !!cat && !isScheduleOpen(cat.available_schedule, new Date());
                const off = !item.in_stock || closed;
                const inTicket = lines.filter((l) => l.item.id === item.id).reduce((a, l) => a + l.qty, 0);
                // "All" with no search reads as the menu does: a heading where each category starts.
                const heading = grouped && cat && items[i - 1]?.category_id !== item.category_id;
                return (
                  <Fragment key={item.id}>
                  {heading && <h3 className="col-span-full pt-2 text-xs font-semibold tracking-wide text-ink-faint uppercase first:pt-0">{cat.name}</h3>}
                  <button
                    disabled={off}
                    onClick={() => tap(item)}
                    className={cn(
                      'relative flex min-h-24 cursor-pointer flex-col rounded-2xl border bg-surface p-3 text-left shadow-[var(--shadow-card)] transition active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-45',
                      inTicket ? 'border-[var(--brand)] ring-1 ring-[var(--brand)]' : 'border-line hover:border-stone-300',
                    )}
                  >
                    <span className="flex items-start gap-1.5">
                      <VegMark veg={item.is_veg} className="mt-0.5" />
                      <span className="text-sm leading-snug font-medium">{item.name}</span>
                    </span>
                    <span className="mt-auto flex items-center justify-between pt-2 text-sm">
                      <span className="font-semibold tabular">{formatPrice(item.price_paise)}</span>
                      {!item.in_stock ? (
                        <span className="text-xs text-rose-700">{t('pos.sold_out')}</span>
                      ) : closed ? (
                        <span className="text-xs text-ink-soft">{t('pos.not_now')}</span>
                      ) : (
                        item.modifier_group_ids.length > 0 && <span className="text-xs text-ink-faint">{t('pos.options')}</span>
                      )}
                    </span>
                    {inTicket > 0 && <span className="absolute -top-2 -right-2 grid size-6 place-items-center rounded-full bg-[var(--brand)] text-xs font-bold text-white">{inTicket}</span>}
                  </button>
                  </Fragment>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <aside className="hidden w-[380px] shrink-0 border-l border-line bg-surface lg:block">{ticket}</aside>

      {lines.length > 0 && (
        <button
          onClick={() => setTicketOpen(true)}
          className="fixed inset-x-4 bottom-[calc(var(--tabbar-h)+1rem)] z-30 flex h-14 cursor-pointer items-center justify-between rounded-2xl bg-[var(--brand)] px-5 text-white shadow-[var(--shadow-pop)] lg:hidden"
        >
          <span className="font-semibold">{count} items</span>
          <span className="font-semibold tabular">{formatPaise(subtotal)} · {t('pos.review')} →</span>
        </button>
      )}
      <Sheet open={ticketOpen} onClose={() => setTicketOpen(false)} title="Order" className="h-[92dvh]">
        <div className="-mx-5 h-full">{ticket}</div>
      </Sheet>

      {m && (
        <ModifierSheet
          menu={m}
          item={picking}
          onClose={() => setPicking(null)}
          onDone={(ids) => {
            if (picking) add(picking, ids);
            setPicking(null);
          }}
        />
      )}
      <NoteSheet
        value={lines.find((l) => l.key === noteFor)?.note ?? ''}
        open={!!noteFor}
        onClose={() => setNoteFor(null)}
        onSave={(v) => {
          setLines((cur) => cur.map((l) => (l.key === noteFor ? { ...l, note: v } : l)));
          setNoteFor(null);
        }}
      />
    </div>
  );
}

function NoteSheet({ open, value, onClose, onSave }: { open: boolean; value: string; onClose: () => void; onSave: (v: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value, open]);
  const quick = ['Less spicy', 'Extra spicy', 'No onion', 'No garlic', 'Jain', 'Pack separately'];
  return (
    <Sheet open={open} onClose={onClose} title="Note for the kitchen" footer={<Button block onClick={() => onSave(text.trim())}>Save note</Button>}>
      <div className="mb-3 flex flex-wrap gap-2">
        {quick.map((q) => (
          <button key={q} onClick={() => setText((t) => (t ? `${t}, ${q}` : q))} className="h-9 cursor-pointer rounded-full border border-line px-3 text-sm hover:bg-stone-50">
            {q}
          </button>
        ))}
      </div>
      <Input value={text} onChange={(e) => setText(e.target.value)} maxLength={200} aria-label="Note" />
    </Sheet>
  );
}

'use client';

import { Minus, Plus, Search, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { MenuCategoryDTO, MenuItemDTO } from '@dineos/shared/dto';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/components/ui/cn';
import { VegMark } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/toast';
import { errorMessage } from '@/lib/api';
import { formatRupee } from './guest-app';
import { ItemSheet } from './item-sheet';
import type { GuestApi } from './use-guest';

export function MenuView({ g, stickyOffset }: { g: GuestApi; stickyOffset: number }) {
  const { t, name } = useI18n();
  const [query, setQuery] = useState('');
  const [vegOnly, setVegOnly] = useState(false);
  const [activeCat, setActiveCat] = useState<string | null>(null);
  const [sheetItem, setSheetItem] = useState<MenuItemDTO | null>(null);
  const tabsRef = useRef<HTMLDivElement>(null);

  const menu = g.menu;
  const sections = useMemo(() => {
    if (!menu) return [];
    const q = query.trim().toLowerCase();
    return menu.categories
      .map((c) => ({
        category: c,
        items: menu.items.filter(
          (i) =>
            i.category_id === c.id &&
            (!vegOnly || i.is_veg) &&
            (!q ||
              i.name.toLowerCase().includes(q) ||
              (i.translations.hi?.name ?? '').includes(q) ||
              (i.description ?? '').toLowerCase().includes(q) ||
              i.tags.some((tag) => tag.toLowerCase().includes(q))),
        ),
      }))
      .filter((s) => s.items.length > 0);
  }, [menu, query, vegOnly]);

  // Highlight the category tab for the section in view.
  useEffect(() => {
    if (sections.length === 0) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (visible) setActiveCat(visible.target.getAttribute('data-cat'));
      },
      { rootMargin: `-${130 + stickyOffset}px 0px -60% 0px` },
    );
    for (const s of sections) {
      const el = document.getElementById(`cat-${s.category.id}`);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [sections, stickyOffset]);

  useEffect(() => {
    if (!activeCat) return;
    tabsRef.current?.querySelector(`[data-tab="${activeCat}"]`)?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
  }, [activeCat]);

  if (g.menuError && !menu) {
    return (
      <div className="px-6 py-16 text-center">
        <p className="font-medium text-ink">{t('guest.offline')}</p>
        <button onClick={g.retryMenu} className="mt-4 h-11 cursor-pointer rounded-xl bg-[var(--brand)] px-5 text-sm font-semibold text-white">
          Retry
        </button>
      </div>
    );
  }
  if (g.menuLoading || !menu) return <MenuSkeleton />;

  return (
    <div>
      <div className="sticky z-20 space-y-2 border-b border-line bg-surface/95 px-4 pt-2 pb-2 backdrop-blur" style={{ top: stickyOffset }}>
        <div className="flex gap-2">
          <label className="relative flex-1">
            <span className="sr-only">{t('guest.search')}</span>
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-faint" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('guest.search')}
              className="h-11 w-full rounded-xl border border-line bg-stone-50 pr-9 pl-9 text-[15px] focus:border-[var(--brand)] focus:bg-surface focus:outline-none"
            />
            {query && (
              <button onClick={() => setQuery('')} aria-label="Clear search" className="absolute top-1/2 right-2 grid size-7 -translate-y-1/2 cursor-pointer place-items-center rounded-full text-ink-faint hover:bg-stone-200">
                <X className="size-4" />
              </button>
            )}
          </label>
          <button
            onClick={() => setVegOnly((v) => !v)}
            aria-pressed={vegOnly}
            className={cn(
              'flex h-11 shrink-0 cursor-pointer items-center gap-2 rounded-xl border px-3 text-sm font-medium transition',
              vegOnly ? 'border-veg bg-emerald-50 text-veg' : 'border-line text-ink-soft',
            )}
          >
            <VegMark veg />
            {t('guest.veg_only')}
          </button>
        </div>
        <div ref={tabsRef} className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-0.5 [scrollbar-width:none]">
          {sections.map(({ category }) => (
            <button
              key={category.id}
              data-tab={category.id}
              onClick={() => {
                const el = document.getElementById(`cat-${category.id}`);
                if (el) window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - (120 + stickyOffset), behavior: 'smooth' });
              }}
              className={cn(
                'h-9 shrink-0 cursor-pointer rounded-full px-3.5 text-sm font-medium whitespace-nowrap transition',
                activeCat === category.id ? 'bg-ink text-white' : 'bg-stone-100 text-ink-soft hover:bg-stone-200',
              )}
            >
              {name(category)}
            </button>
          ))}
        </div>
      </div>

      {sections.length === 0 && <p className="px-6 py-16 text-center text-ink-faint">No dishes match “{query}”.</p>}

      {sections.map(({ category, items }) => (
        <section key={category.id} id={`cat-${category.id}`} data-cat={category.id} className="px-4 pt-6">
          <div className="mb-1 flex items-baseline justify-between gap-3">
            <h2 className="font-display text-xl font-semibold text-ink">{name(category)}</h2>
            <span className="text-xs text-ink-faint">{items.length}</span>
          </div>
          {!category.available_now && <ScheduleNote category={category} />}
          <ul className="divide-y divide-line">
            {items.map((item) => (
              <ItemRow key={item.id} g={g} item={item} available={category.available_now} onOpen={() => setSheetItem(item)} />
            ))}
          </ul>
        </section>
      ))}
      <p className="px-4 pt-8 pb-4 text-center text-xs text-ink-faint">{t('guest.prices_note')}</p>

      <ItemSheet g={g} item={sheetItem} onClose={() => setSheetItem(null)} />
    </div>
  );
}

function ScheduleNote({ category }: { category: MenuCategoryDTO }) {
  const { t } = useI18n();
  const s = category.available_schedule;
  const fmt = (hhmm?: string) => {
    if (!hhmm) return '';
    const [h, m] = hhmm.split(':').map(Number);
    const d = new Date(2000, 0, 1, h, m);
    return d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
  };
  return (
    <p className="mb-2 inline-block rounded-lg bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-800">
      {t('guest.not_now')}
      {s?.from && s?.to ? ` · ${fmt(s.from)} – ${fmt(s.to)}` : ''}
    </p>
  );
}

function ItemRow({ g, item, available, onOpen }: { g: GuestApi; item: MenuItemDTO; available: boolean; onOpen: () => void }) {
  const { t, name, description } = useI18n();
  const toast = useToast();
  const lines = (g.session?.cart.lines ?? []).filter((l) => l.item_id === item.id);
  const qty = lines.reduce((a, l) => a + l.qty, 0);
  const customisable = item.modifier_group_ids.length > 0;
  const disabled = !item.in_stock || !available;
  const busy = g.addLine.isPending || g.updateLine.isPending;
  const desc = description(item);

  const add = () => {
    if (customisable) return onOpen();
    g.addLine.mutate(
      { item_id: item.id, qty: 1, modifier_ids: [] },
      { onError: (err) => toast(errorMessage(err), 'error') },
    );
  };
  const remove = () => {
    const last = lines.at(-1);
    if (last) g.updateLine.mutate({ lineId: last.line_id, qty: last.qty - 1 });
  };

  return (
    <li className={cn('flex gap-4 py-5', disabled && 'opacity-60')}>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <VegMark veg={item.is_veg} />
          {item.tags.slice(0, 2).map((tag) => (
            <span key={tag} className="rounded-md bg-amber-50 px-1.5 py-0.5 text-[11px] font-semibold text-amber-800 capitalize">
              {tag}
            </span>
          ))}
        </div>
        <h3 className="mt-1.5 text-[16px] leading-snug font-semibold text-ink">{name(item)}</h3>
        <p className="mt-0.5 text-[15px] font-medium text-ink tabular">{formatRupee(item.price_paise)}</p>
        {desc && <p className="mt-1.5 line-clamp-2 text-sm leading-relaxed text-ink-faint">{desc}</p>}
      </div>
      <div className="relative w-[118px] shrink-0">
        {item.photo_url ? (
          <button onClick={onOpen} className="block size-[118px] cursor-pointer overflow-hidden rounded-2xl bg-stone-100" aria-label={`View ${item.name}`}>
            <img src={item.photo_url} alt="" loading="lazy" decoding="async" className="size-full object-cover" />
          </button>
        ) : (
          <div className="h-[60px]" />
        )}
        <div className={cn('absolute inset-x-2', item.photo_url ? '-bottom-3' : 'bottom-0')}>
          {disabled ? (
            <div className="grid h-10 place-items-center rounded-xl border border-line bg-surface text-xs font-semibold text-ink-faint shadow-sm">
              {!item.in_stock ? t('guest.sold_out') : t('guest.not_now')}
            </div>
          ) : qty === 0 ? (
            <button
              onClick={add}
              disabled={busy}
              className="h-10 w-full cursor-pointer rounded-xl border border-brand-200 bg-surface text-sm font-bold tracking-wide text-[var(--brand)] uppercase shadow-sm transition hover:bg-brand-50 active:scale-95"
            >
              {t('guest.add')}
              {customisable && <span className="ml-0.5">+</span>}
            </button>
          ) : (
            <div className="flex h-10 items-center justify-between rounded-xl bg-[var(--brand)] text-white shadow-sm">
              <button onClick={remove} disabled={busy} aria-label={`Remove one ${item.name}`} className="grid h-full w-10 cursor-pointer place-items-center">
                <Minus className="size-4" />
              </button>
              <span className="text-sm font-bold tabular" aria-live="polite">
                {qty}
              </span>
              <button onClick={add} disabled={busy} aria-label={`Add one ${item.name}`} className="grid h-full w-10 cursor-pointer place-items-center">
                <Plus className="size-4" />
              </button>
            </div>
          )}
        </div>
        {customisable && !disabled && <p className={cn('text-center text-[11px] text-ink-faint', item.photo_url ? 'mt-4' : 'mt-11')}>{t('guest.customisable')}</p>}
      </div>
    </li>
  );
}

function MenuSkeleton() {
  return (
    <div className="space-y-6 px-4 pt-4" aria-busy>
      <div className="h-11 animate-pulse rounded-xl bg-stone-100" />
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="flex gap-4">
          <div className="flex-1 space-y-2">
            <div className="h-4 w-12 animate-pulse rounded bg-stone-100" />
            <div className="h-5 w-40 animate-pulse rounded bg-stone-200" />
            <div className="h-4 w-16 animate-pulse rounded bg-stone-100" />
          </div>
          <div className="size-[118px] animate-pulse rounded-2xl bg-stone-100" />
        </div>
      ))}
    </div>
  );
}

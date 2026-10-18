'use client';

import Link from 'next/link';
import { Search, X } from 'lucide-react';
import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/components/ui/cn';

export interface NavigationEntry {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

const GROUPS = [
  { en: 'Overview', hi: 'एक नज़र', paths: ['/app'] },
  { en: 'Service', hi: 'सर्विस', paths: ['/app/inbox', '/app/kds', '/app/floor', '/app/pos', '/app/bills'] },
  { en: 'Guests', hi: 'मेहमान', paths: ['/app/reservations', '/app/customers', '/app/loyalty'] },
  { en: 'Business', hi: 'कारोबार', paths: ['/app/menu', '/app/inventory', '/app/reports', '/app/reconcile'] },
  { en: 'Setup', hi: 'सेटअप', paths: ['/app/tables', '/app/staff', '/app/settings'] },
];

/** Receives only the destinations permitted for this person and outlet. */
export function NavigationMenu({ items, pathname, compact = false, onNavigate }: {
  items: NavigationEntry[];
  pathname: string;
  compact?: boolean;
  onNavigate?: () => void;
}) {
  const { lang } = useI18n();
  const [query, setQuery] = useState('');
  const hindi = lang === 'hi';
  const term = query.trim().toLocaleLowerCase();
  const groups = GROUPS.map((group) => ({
    ...group,
    items: items.filter((item) => group.paths.includes(item.href) &&
      (!term || `${item.label} ${item.href === '/app' ? 'dashboard today' : item.href.slice(5)} ${group.en} ${group.hi}`.toLocaleLowerCase().includes(term))),
  })).filter((group) => group.items.length);

  return (
    <div className={cn('space-y-4', !compact && 'p-3')}>
      <div className="relative">
        <Search aria-hidden="true" className="pointer-events-none absolute top-3.5 left-3 size-4 text-ink-faint" />
        <input
          type="search"
          aria-label={hindi ? 'स्क्रीन खोजें' : 'Find a screen'}
          placeholder={hindi ? 'स्क्रीन खोजें…' : 'Find a screen…'}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && query) { event.stopPropagation(); setQuery(''); }
          }}
          className="h-11 w-full rounded-xl border border-line bg-surface pr-10 pl-9 text-sm text-ink placeholder:text-ink-faint [&::-webkit-search-cancel-button]:hidden"
        />
        {query && <button type="button" onClick={() => setQuery('')} aria-label={hindi ? 'खोज साफ़ करें' : 'Clear search'} className="absolute top-0 right-0 grid size-11 cursor-pointer place-items-center rounded-xl text-ink-soft"><X aria-hidden="true" className="size-4" /></button>}
      </div>
      {query && <p role="status" className="text-xs text-ink-soft">{hindi ? 'मिली स्क्रीन' : 'Screens found'}: {groups.reduce((n, group) => n + group.items.length, 0)}</p>}
      <nav aria-label={hindi ? 'स्क्रीन' : 'Screens'} className="space-y-4">
        {groups.map((group) => (
          <section key={group.en} aria-label={hindi ? group.hi : group.en}>
            <h2 className="mb-1.5 px-3 text-xs font-semibold tracking-wide text-ink-faint">{hindi ? group.hi : group.en}</h2>
            <div className={compact ? 'grid grid-cols-3 gap-2' : 'space-y-0.5'}>
              {group.items.map((item) => {
                const active = item.href === '/app' ? pathname === '/app' : pathname === item.href || pathname.startsWith(`${item.href}/`);
                const Icon = item.icon;
                return (
                  <Link key={item.href} href={item.href} onClick={onNavigate} aria-current={active ? 'page' : undefined}
                    className={cn('relative rounded-xl font-medium transition-colors', compact ? 'flex min-h-20 flex-col items-center justify-center gap-2 px-2 py-3 text-center text-sm' : 'flex min-h-11 items-center gap-3 px-3 py-2 text-sm', active ? 'bg-brand-100 text-brand-700' : 'text-ink-soft hover:bg-stone-100 hover:text-ink', compact && !active && 'bg-stone-50')}>
                    <Icon className="size-[18px] shrink-0" />
                    <span>{item.label}</span>
                    {active && !compact && <span aria-hidden="true" className="absolute top-3 bottom-3 left-0 w-0.5 rounded-full bg-[var(--brand)]" />}
                  </Link>
                );
              })}
            </div>
          </section>
        ))}
      </nav>
      {!groups.length && <p className="rounded-xl bg-stone-50 p-3 text-sm text-ink-soft">{hindi ? 'कोई स्क्रीन नहीं मिली। दूसरा नाम खोजें या खोज साफ़ करें।' : 'No matching screens. Try another name or clear your search.'}</p>}
    </div>
  );
}

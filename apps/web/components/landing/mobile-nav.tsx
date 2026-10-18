'use client';

import { useRef } from 'react';
import { Menu } from 'lucide-react';

/** Native disclosure keeps the mobile navigation usable before hydration. */
export function MobileNav() {
  const ref = useRef<HTMLDetailsElement>(null);
  return (
    <details
      ref={ref}
      className="relative lg:hidden"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && ref.current?.open) {
          ref.current.open = false;
          ref.current.querySelector('summary')?.focus();
        }
      }}
    >
      <summary className="grid size-11 cursor-pointer list-none place-items-center rounded-xl border border-line bg-surface [&::-webkit-details-marker]:hidden" aria-label="Navigation menu">
        <Menu className="size-5" aria-hidden="true" />
      </summary>
      <nav
        aria-label="Mobile navigation"
        className="absolute right-0 top-full mt-2 w-60 rounded-2xl border border-line bg-surface p-2 text-ink shadow-lg"
        onClick={(event) => {
          const link = (event.target as HTMLElement).closest('a');
          if (!link || !ref.current) return;
          ref.current.open = false;
          // Move focus out of the now-closed disclosure for keyboard users.
          const target = link.hash && document.getElementById(link.hash.slice(1));
          if (target) {
            target.tabIndex = -1;
            target.focus({ preventScroll: true });
          }
        }}
      >
        {[
          ['#night', 'The problem'], ['#how', 'How it works'], ['#pricing', 'Pricing'], ['#switch', 'Already on software?'],
          ['#faq', 'Questions'], ['/login', 'Staff sign-in'],
        ].map(([href, label]) => (
          <a key={href} href={href} className="flex min-h-11 items-center rounded-lg px-3 text-sm font-medium hover:bg-brand-50">{label}</a>
        ))}
      </nav>
    </details>
  );
}

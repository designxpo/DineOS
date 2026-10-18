'use client';

import { useEffect, useState } from 'react';

/** Progressive enhancement: server-rendered content stays visible without JS or motion support. */
export function LandingMotion() {
  useEffect(() => {
    const root = document.querySelector<HTMLElement>('[data-marketing]');
    if (!root || !('IntersectionObserver' in window) || !('animate' in Element.prototype)) return;
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    const animations = new Map<Element, Animation>();
    const seen = new WeakSet<Element>();
    let observer: IntersectionObserver | undefined;

    const cancel = () => {
      observer?.disconnect();
      animations.forEach((animation) => animation.cancel());
      animations.clear();
    };
    const setup = () => {
      cancel();
      if (preference.matches) return;
      observer = new IntersectionObserver((entries) => {
        entries.forEach(({ target, isIntersecting }) => {
          if (preference.matches || !isIntersecting || seen.has(target)) return;
          seen.add(target);
          observer?.unobserve(target);
          // Never move a control while someone is using it or navigating to its anchor.
          const hash = window.location.hash.slice(1);
          if (target.contains(document.activeElement) || (hash && target.closest('section')?.id === hash)) return;
          const delay = Math.min(Number((target as HTMLElement).dataset.revealDelay) || 0, 240);
          const animation = target.animate(
            [{ opacity: 0.35, transform: 'translateY(18px)' }, { opacity: 1, transform: 'translateY(0)' }],
            { duration: 560, delay, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'backwards' },
          );
          animations.set(target, animation);
          animation.onfinish = () => animations.delete(target);
        });
      }, { threshold: 0.12 });
      root.querySelectorAll('[data-reveal]').forEach((el) => {
        if (!seen.has(el)) observer?.observe(el);
      });
    };
    const stopFocused = (event: FocusEvent) => {
      animations.forEach((animation, element) => {
        if (event.target instanceof Node && element.contains(event.target)) {
          animation.cancel();
          animations.delete(element);
        }
      });
    };
    setup();
    preference.addEventListener('change', setup);
    root.addEventListener('focusin', stopFocused);
    window.addEventListener('beforeprint', cancel);
    return () => {
      cancel();
      preference.removeEventListener('change', setup);
      root.removeEventListener('focusin', stopFocused);
      window.removeEventListener('beforeprint', cancel);
    };
  }, []);

  return null;
}

/** Visitors can stop ambient movement independently of their system preference. */
export function AmbientMotionToggle() {
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    const root = document.querySelector<HTMLElement>('[data-marketing]');
    if (!root) return;
    root.dataset.ambientPaused = String(paused);
    return () => { delete root.dataset.ambientPaused; };
  }, [paused]);
  return (
    <div className="mt-6 text-center motion-reduce:hidden print:hidden">
      <button
        type="button"
        aria-pressed={paused}
        onClick={() => setPaused((value) => !value)}
        className="min-h-11 cursor-pointer rounded-lg px-3 text-xs font-medium text-ink-soft underline decoration-line underline-offset-4 hover:text-ink"
      >
        {paused ? 'Resume gentle motion' : 'Pause gentle motion'}
      </button>
    </div>
  );
}

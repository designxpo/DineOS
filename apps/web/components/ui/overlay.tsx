'use client';

import { X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { IconButton } from './button';
import { cn } from './cn';

function useOverlay(open: boolean, onClose: () => void) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    // Move focus into the panel for keyboard and screen-reader users.
    requestAnimationFrame(() => panel.current?.querySelector<HTMLElement>('[data-autofocus], input, button, textarea, select')?.focus());
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
      previous?.focus?.();
    };
  }, [open, onClose]);
  return panel;
}

/** Where a released drag will come to rest: Apple's momentum projection (scroll deceleration). */
function project(velocity: number, deceleration = 0.99): number {
  return ((velocity / 1000) * deceleration) / (1 - deceleration);
}

/** Past an edge the sheet follows less and less, so it reads as "nothing more this way". */
function rubberband(overshoot: number, dimension: number, constant = 0.55): number {
  return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));
}

const isPhoneSheet = () => typeof window !== 'undefined' && window.matchMedia('(max-width: 639px)').matches;

/**
 * A still copy of a sheet that its caller removed while it was showing, sent out the way it came in
 * (down on phones, shrinking on desktop). It takes no input and is gone when the animation ends.
 */
function leaveFrom(node: HTMLElement): HTMLElement {
  const ghost = node.cloneNode(true) as HTMLElement;
  // What was typed stays visible while the copy leaves.
  const typed = node.querySelectorAll<HTMLInputElement>('input, textarea, select');
  ghost.querySelectorAll<HTMLInputElement>('input, textarea, select').forEach((el, i) => (el.value = typed[i]?.value ?? el.value));
  ghost.setAttribute('aria-hidden', 'true');
  ghost.style.pointerEvents = 'none';
  const [scrim, panel] = Array.from(ghost.children) as HTMLElement[];
  panel?.removeAttribute('role');
  scrim?.classList.replace('animate-fade-in', 'animate-fade-out');
  panel?.classList.remove('animate-sheet-in', 'sm:animate-pop-in');
  panel?.classList.add('animate-sheet-out', 'sm:animate-pop-out');
  document.body.appendChild(ghost);
  const done = () => ghost.remove();
  panel?.addEventListener('animationend', done, { once: true });
  setTimeout(done, 400);
  return ghost;
}

/**
 * Bottom sheet on phones, centred dialog on larger screens. It leaves the way it came in (down on
 * phones, shrinking on desktop) and keeps showing its last content while it goes. On phones it can
 * be dragged down by its handle or title: it follows the finger, and a release heading off-screen
 * closes it while anything else settles it back.
 */
export function Sheet({
  open,
  onClose,
  title,
  children,
  footer,
  className,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
  wide?: boolean;
}) {
  const panel = useOverlay(open, onClose);
  const scrim = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(open);
  const [leaving, setLeaving] = useState(false);
  // Callers often clear the data behind a sheet as they close it; show what was there until it is gone.
  const last = useRef({ title, children, footer });
  if (open) last.current = { title, children, footer };
  const drag = useRef<{ startY: number; offset: number; samples: { y: number; t: number }[] } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const alive = useRef(true);
  const leavingNow = useRef(false);
  leavingNow.current = leaving;

  // Declared first so that on unmount it runs first: the effect below then knows the sheet is gone.
  useLayoutEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  // Most callers remove a sheet outright when it closes; it should still leave the way it came in.
  useLayoutEffect(() => {
    const node = root.current;
    if (!node) return;
    return () => {
      if (alive.current || leavingNow.current) return;
      const ghost = leaveFrom(node);
      // Development's strict mode unmounts and remounts on purpose: drop the copy if we are back.
      requestAnimationFrame(() => alive.current && ghost.remove());
    };
  }, [shown]);

  useEffect(() => {
    if (open) {
      setShown(true);
      setLeaving(false);
    } else if (shown) {
      setLeaving(true);
      // If the animation event never arrives (tab hidden, reduced motion), still unmount.
      const t = setTimeout(() => setShown(false), 400);
      return () => clearTimeout(t);
    }
  }, [open, shown]);

  const setOffset = (y: number) => {
    const el = panel.current;
    if (!el) return;
    el.style.transform = `translateY(${y}px)`;
    el.style.setProperty('--sheet-drag', `${y}px`);
    if (scrim.current) {
      const fade = Math.max(0, 1 - y / Math.max(1, el.offsetHeight));
      scrim.current.style.opacity = String(fade);
      scrim.current.style.setProperty('--scrim-from', String(fade));
    }
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (!isPhoneSheet() || (e.target as HTMLElement).closest('button, a, input, select, textarea')) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    if (panel.current) panel.current.style.transition = 'none';
    drag.current = { startY: e.clientY, offset: 0, samples: [{ y: e.clientY, t: e.timeStamp }] };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || !panel.current) return;
    const raw = e.clientY - d.startY;
    d.offset = raw >= 0 ? raw : rubberband(raw, panel.current.offsetHeight);
    d.samples = [...d.samples.filter((s) => e.timeStamp - s.t < 100), { y: e.clientY, t: e.timeStamp }];
    setOffset(d.offset);
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    const el = panel.current;
    drag.current = null;
    if (!d || !el) return;
    const first = d.samples[0]!;
    const dt = Math.max(1, e.timeStamp - first.t);
    const velocity = ((e.clientY - first.y) / dt) * 1000; // px/s, positive is down
    const height = el.offsetHeight;
    // Decide from where the motion is going, not where it stopped.
    if (d.offset > 0 && d.offset + project(velocity) > height * 0.4) {
      onClose();
    } else {
      el.style.transition = 'transform 320ms cubic-bezier(0.32, 0.72, 0, 1)';
      if (scrim.current) scrim.current.style.transition = 'opacity 320ms ease-out';
      setOffset(0);
    }
  };

  if (!shown || typeof document === 'undefined') return null;
  const content = open ? { title, children, footer } : last.current;
  return createPortal(
    <div ref={root} className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-6">
      <div ref={scrim} className={cn('absolute inset-0 bg-stone-950/45', leaving ? 'animate-fade-out' : 'animate-fade-in')} onClick={onClose} aria-hidden />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={typeof content.title === 'string' ? content.title : undefined}
        onAnimationEnd={(e) => {
          if (leaving && e.target === e.currentTarget) setShown(false);
        }}
        className={cn(
          'relative flex max-h-[92dvh] w-full flex-col rounded-t-3xl bg-surface shadow-[var(--shadow-pop)] sm:rounded-3xl',
          leaving ? 'pointer-events-none animate-sheet-out sm:animate-pop-out' : 'animate-sheet-in sm:animate-pop-in',
          wide ? 'sm:max-w-3xl' : 'sm:max-w-lg',
          className,
        )}
      >
        <div className="touch-none" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
          <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-stone-300 sm:hidden" aria-hidden />
          {content.title !== undefined && (
            <div className="flex items-center justify-between gap-3 px-5 pt-3 pb-2 sm:pt-5">
              <h2 className="text-lg font-semibold tracking-tight text-ink">{content.title}</h2>
              <IconButton label="Close" onClick={onClose} className="-mr-2">
                <X className="size-5" />
              </IconButton>
            </div>
          )}
        </div>
        <div className="flex-1 overflow-y-auto overscroll-contain px-5 pb-5">{content.children}</div>
        {content.footer && <div className="border-t border-line px-5 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">{content.footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

/** Asks for a short reason (rejections, voids, cancellations) before a destructive action. */
export function ConfirmDialog({
  open,
  onClose,
  title,
  description,
  confirmLabel,
  tone = 'danger',
  onConfirm,
  busy,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  confirmLabel: string;
  tone?: 'danger' | 'primary';
  onConfirm: () => void;
  busy?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <div className="flex justify-end gap-2">
          <button className="h-11 cursor-pointer rounded-xl px-4 text-sm font-medium text-ink-soft transition hover:bg-stone-100 active:scale-[0.97]" onClick={onClose}>
            Back
          </button>
          <button
            className={cn(
              'h-11 cursor-pointer rounded-xl px-5 text-sm font-medium text-white transition enabled:active:scale-[0.97] disabled:opacity-50',
              tone === 'danger' ? 'bg-rose-600 hover:bg-rose-700' : 'bg-[var(--brand)] hover:brightness-110',
            )}
            onClick={onConfirm}
            disabled={busy}
          >
            {confirmLabel}
          </button>
        </div>
      }
    >
      {description && <p className="text-sm text-ink-soft">{description}</p>}
      {children}
    </Sheet>
  );
}

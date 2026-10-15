'use client';

import { X } from 'lucide-react';
import { useEffect, useRef } from 'react';
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

/** Bottom sheet on phones, centred dialog on larger screens. */
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
  if (!open || typeof document === 'undefined') return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-6">
      <div className="absolute inset-0 animate-fade-in bg-stone-950/45" onClick={onClose} aria-hidden />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
        className={cn(
          'relative flex max-h-[92dvh] w-full animate-sheet-in flex-col rounded-t-3xl bg-surface shadow-[var(--shadow-pop)] sm:animate-fade-in sm:rounded-3xl',
          wide ? 'sm:max-w-3xl' : 'sm:max-w-lg',
          className,
        )}
      >
        <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-stone-300 sm:hidden" aria-hidden />
        {title !== undefined && (
          <div className="flex items-center justify-between gap-3 px-5 pt-3 pb-2 sm:pt-5">
            <h2 className="text-lg font-semibold text-ink">{title}</h2>
            <IconButton label="Close" onClick={onClose} className="-mr-2">
              <X className="size-5" />
            </IconButton>
          </div>
        )}
        <div className="flex-1 overflow-y-auto overscroll-contain px-5 pb-5">{children}</div>
        {footer && <div className="border-t border-line px-5 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">{footer}</div>}
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
          <button className="h-11 cursor-pointer rounded-xl px-4 text-sm font-medium text-ink-soft hover:bg-stone-100" onClick={onClose}>
            Back
          </button>
          <button
            className={cn(
              'h-11 cursor-pointer rounded-xl px-5 text-sm font-medium text-white disabled:opacity-50',
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

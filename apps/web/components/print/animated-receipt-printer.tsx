'use client';

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import styles from './animated-receipt-printer.module.css';

export const RECEIPT_ANIMATION_DURATION_MS = 3800;

/** Presentation only: never submits, waits for, or reports success of a print job. */
export function AnimatedReceiptPrinter({ children, onDismiss, durationMs = RECEIPT_ANIMATION_DURATION_MS }: {
  children: ReactNode;
  onDismiss: () => void;
  durationMs?: number;
}) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const paper = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const close = useRef(onDismiss);
  const [size, setSize] = useState({ height: 500, scale: 1 });
  const duration = Math.max(500, durationMs);
  useLayoutEffect(() => { close.current = onDismiss; });
  useLayoutEffect(() => {
    const node = paper.current;
    if (!node) return;
    const measure = () => {
      const height = node.offsetHeight;
      setSize({ height, scale: Math.min(1, (window.innerWidth - 40) / 340, (window.innerHeight - 150) / (height + 134)) });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    window.addEventListener('resize', measure);
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); };
  }, [mounted]);
  useEffect(() => {
    if (!mounted) return;
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    const dismiss = () => close.current();
    const timer = window.setTimeout(dismiss, reduced.matches ? 700 : duration);
    // Native print dialogs can suspend the page. Dismiss on return instead of replaying stale motion.
    window.addEventListener('afterprint', dismiss);
    reduced.addEventListener('change', dismiss);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('afterprint', dismiss);
      reduced.removeEventListener('change', dismiss);
      if (previous?.isConnected) previous.focus();
    };
  }, [duration, mounted]);

  if (!mounted) return null;
  return createPortal(
    <dialog ref={dialog} className={styles.overlay} aria-label="Receipt printing preview" onCancel={(event) => { event.preventDefault(); close.current(); }}>
      <div className={styles.experience} style={{ '--duration': `${duration}ms` } as CSSProperties}>
        <p className={styles.caption} role="status">Preparing your receipt</p>
        <div style={{ width: 340 * size.scale, height: (size.height + 134) * size.scale }}>
          <div className={styles.scene} style={{ transform: `scale(${size.scale})` }} aria-hidden="true">
            <div className={styles.printer}>
              <div className={styles.lid} />
              <span className={styles.indicator} />
              <span className={styles.brand}>THERMAL · 80</span>
              <div className={styles.slot} />
            </div>
            <div className={styles.output}>
              <div className={styles.feed}>
                <div className={styles.paper} ref={paper}>
                  {children}
                </div>
              </div>
            </div>
          </div>
        </div>
        <button type="button" className={styles.skip} onClick={() => close.current()}>Skip animation</button>
      </div>
    </dialog>, document.body,
  );
}

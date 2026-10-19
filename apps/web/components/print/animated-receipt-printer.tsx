'use client';

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
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
  const panel = useRef<HTMLElement>(null);
  const [complete, setComplete] = useState(false);
  const close = useRef(onDismiss);
  const [size, setSize] = useState({ height: 500, scale: 1 });
  const duration = Math.max(500, durationMs);
  useLayoutEffect(() => { close.current = onDismiss; });
  useLayoutEffect(() => {
    const node = paper.current;
    if (!node) return;
    const measure = () => {
      const height = node.offsetHeight;
      setSize({ height, scale: Math.min(1, (panel.current?.clientWidth ?? window.innerWidth) / 340) });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    if (panel.current) observer.observe(panel.current);
    window.addEventListener('resize', measure);
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); };
  }, [mounted]);
  useEffect(() => {
    if (!mounted) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    const finish = () => setComplete(true);
    if (reduced.matches) finish();
    const timer = window.setTimeout(finish, duration);
    // Keep the receipt until an actual portal action, not scrolling or elapsed time.
    const onAction = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && !panel.current?.contains(target) && target.closest('button, a, input, select, textarea, [role="button"]')) close.current();
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') close.current(); };
    document.addEventListener('click', onAction, true);
    document.addEventListener('keydown', onKey);
    window.addEventListener('afterprint', finish);
    reduced.addEventListener('change', finish);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('click', onAction, true);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('afterprint', finish);
      reduced.removeEventListener('change', finish);
    };
  }, [duration, mounted]);

  if (!mounted) return null;
  return (
    <section ref={panel} className={`${styles.panel} ${complete ? styles.complete : ''}`} aria-label="Receipt preview">
      <div className={styles.experience} style={{ '--duration': `${duration}ms` } as CSSProperties}>
        <p className={styles.caption} role="status">{complete ? 'Receipt preview' : 'Preparing your receipt'}</p>
        <div style={{ width: 340 * size.scale, height: (size.height + 134) * size.scale }}>
          <div className={styles.scene} style={{ transform: `scale(${size.scale})` }}>
            <div className={styles.printer} aria-hidden="true">
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
        <div className={styles.actions}>
          {!complete && <button type="button" className={styles.skip} onClick={() => setComplete(true)}>Skip animation</button>}
          <button type="button" className={styles.skip} onClick={() => close.current()}>Close preview</button>
        </div>
      </div>
    </section>
  );
}

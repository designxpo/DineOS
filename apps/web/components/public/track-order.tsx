'use client';

import { Check, ChefHat, PackageCheck, ReceiptText } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { TrackedOrderDTO } from '@mezmitra/shared/dto';
import { ApiError, apiFetch } from '@/lib/api';
import { useBrandTheme } from '@/lib/brand-theme';
import { chime, unlockSound } from '@/lib/sound';
import { BrandMark } from '@/components/brand-mark';
import { cn } from '@/components/ui/cn';
import { Spinner } from '@/components/ui/primitives';

const STEPS = [
  { key: 'received', label: 'Order received', icon: ReceiptText },
  { key: 'making', label: 'Being made', icon: ChefHat },
  { key: 'ready', label: 'Ready to collect', icon: PackageCheck },
] as const;

function stepOf(status: TrackedOrderDTO['status']): number {
  if (status === 'ready' || status === 'served' || status === 'billed') return 2;
  if (status === 'accepted' || status === 'preparing') return 1;
  return 0;
}

/**
 * The guest's phone after ordering at the counter: their number, how far along the order is, and
 * a big "ready" with a buzz and a sound when it is, so nobody has to call out names.
 */
export function TrackOrder({ code }: { code: string }) {
  const [order, setOrder] = useState<TrackedOrderDTO | null>(null);
  const [missing, setMissing] = useState(false);
  const [sound, setSound] = useState(false);
  const wasReady = useRef<boolean | null>(null);

  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const o = await apiFetch<TrackedOrderDTO>(`/public/track/${encodeURIComponent(code)}`);
        if (stop) return;
        setOrder(o);
        const ready = stepOf(o.status) === 2;
        if (ready && wasReady.current === false) {
          chime('ready');
          navigator.vibrate?.([300, 120, 300, 120, 300]);
        }
        wasReady.current = ready;
        // Check often while waiting; stop once it is collected.
        if (!['served', 'billed', 'cancelled', 'rejected'].includes(o.status)) timer = setTimeout(load, ready ? 15_000 : 5_000);
      } catch (err) {
        if (stop) return;
        if (err instanceof ApiError && err.status === 404) setMissing(true);
        else timer = setTimeout(load, 8_000);
      }
    };
    void load();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [code]);

  useEffect(() => {
    if (order) document.title = stepOf(order.status) === 2 && order.status === 'ready' ? `Ready: order ${order.order_no}` : `Order ${order.order_no}`;
  }, [order]);

  useBrandTheme(order?.branding, order?.tenant_name);

  if (missing) return <Shell><p className="text-center text-ink-soft">This order link is not valid. Ask at the counter.</p></Shell>;
  if (!order) {
    return (
      <Shell>
        <div className="grid place-items-center py-20">
          <Spinner />
        </div>
      </Shell>
    );
  }

  const step = stepOf(order.status);
  const ready = order.status === 'ready';
  const collected = order.status === 'served' || order.status === 'billed';
  const stopped = order.status === 'cancelled' || order.status === 'rejected';

  return (
    <Shell>
      {order.branding.logo_url && <BrandMark branding={order.branding} className="mx-auto mb-3 size-16 rounded-2xl border border-line" />}
      <p className="text-center text-sm font-medium text-ink-soft">{order.outlet_name}</p>
      <div className={cn('mt-4 rounded-3xl p-6 text-center transition-colors duration-500', ready ? 'bg-emerald-600 text-white' : 'bg-surface shadow-[var(--shadow-card)]')}>
        <p className={cn('text-sm font-medium', ready ? 'text-emerald-50' : 'text-ink-faint')}>Your order number</p>
        <p className="font-display text-7xl leading-none font-semibold tracking-tight tabular">{order.order_no}</p>
        <p className={cn('mt-3 text-lg font-semibold', ready ? 'text-white' : 'text-ink')}>
          {stopped ? 'This order was cancelled. Please ask at the counter.' : collected ? 'Collected. Enjoy!' : ready ? 'Ready! Collect it at the counter.' : step === 1 ? 'Being made…' : 'Received'}
        </p>
      </div>

      {!stopped && (
        <ol className="mt-6 space-y-3" aria-label="Order progress">
          {STEPS.map((s, i) => {
            const done = i < step || collected || (ready && i === 2);
            const current = i === step && !collected && !done;
            return (
              <li key={s.key} className="flex items-center gap-3">
                <span className={cn('grid size-9 shrink-0 place-items-center rounded-full', done ? 'bg-emerald-600 text-white' : current ? 'bg-brand-50 text-brand-700 ring-2 ring-[var(--brand)]' : 'bg-stone-100 text-ink-faint')}>
                  {done ? <Check className="size-4" /> : <s.icon className="size-4" />}
                </span>
                <span className={cn('font-medium', current ? 'text-ink' : done ? 'text-ink-soft' : 'text-ink-faint')}>{s.label}</span>
                {current && i < 2 && <Spinner className="ml-auto size-4" />}
              </li>
            );
          })}
        </ol>
      )}

      {!ready && !collected && !stopped && !sound && (
        <button
          type="button"
          onClick={() => setSound(unlockSound())}
          className="mt-6 h-12 w-full cursor-pointer rounded-2xl bg-stone-900 text-sm font-semibold text-white transition active:scale-[0.98]"
        >
          Play a sound when it is ready
        </button>
      )}
      {sound && !ready && !collected && <p className="mt-6 text-center text-sm text-ink-soft">Keep this page open. Your phone will chime when the order is ready.</p>}

      <div className="mt-6 rounded-2xl bg-surface p-4 shadow-[var(--shadow-card)]">
        <p className="text-xs font-medium tracking-wide text-ink-faint uppercase">Your order</p>
        <ul className="mt-2 space-y-1 text-sm">
          {order.items.map((i, n) => (
            <li key={n} className="flex gap-2">
              <span className="w-6 font-semibold tabular">{i.qty}×</span>
              <span>{i.name}</span>
            </li>
          ))}
        </ul>
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-dvh bg-paper px-4 pt-8 pb-[max(2rem,env(safe-area-inset-bottom))]">
      <div className="mx-auto max-w-md">{children}</div>
    </main>
  );
}

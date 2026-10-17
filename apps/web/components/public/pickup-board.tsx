'use client';

import { Maximize, Volume2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { PickupBoardDTO } from '@mezmitra/shared/dto';
import { ApiError, apiFetch } from '@/lib/api';
import { useBrandTheme } from '@/lib/brand-theme';
import { chime, unlockSound } from '@/lib/sound';
import { BrandMark } from '@/components/brand-mark';
import { cn } from '@/components/ui/cn';

const clock = new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit' });

/**
 * The screen by the counter: order numbers being made and ready to collect, readable from across
 * the room. A number that turns ready flashes and chimes (once sound is switched on).
 */
export function PickupBoard({ token }: { token: string }) {
  const [board, setBoard] = useState<PickupBoardDTO | null>(null);
  const [missing, setMissing] = useState(false);
  const [sound, setSound] = useState(false);
  const [fresh, setFresh] = useState<Set<number>>(new Set());
  const [now, setNow] = useState(() => new Date());
  const known = useRef<Set<number> | null>(null);

  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const b = await apiFetch<PickupBoardDTO>(`/public/pickup/${encodeURIComponent(token)}`);
        if (stop) return;
        const readyNow = new Set(b.ready.map((r) => r.order_no));
        if (known.current) {
          const added = [...readyNow].filter((n) => !known.current!.has(n));
          if (added.length) {
            chime('ready');
            setFresh(new Set(added));
            setTimeout(() => setFresh(new Set()), 12_000);
          }
        }
        known.current = readyNow;
        setBoard(b);
        setMissing(false);
      } catch (err) {
        if (!stop && err instanceof ApiError && err.status === 404) setMissing(true);
      }
      if (!stop) timer = setTimeout(load, 4_000);
    };
    void load();
    const tick = setInterval(() => setNow(new Date()), 30_000);
    return () => {
      stop = true;
      clearTimeout(timer);
      clearInterval(tick);
    };
  }, [token]);

  useBrandTheme(board?.branding, board?.tenant_name);

  if (missing) {
    return (
      <main className="grid min-h-dvh place-items-center bg-stone-950 p-8 text-center text-stone-300">
        <p className="max-w-md text-xl">This pickup screen link is no longer valid. Open the current link from Settings → Ordering.</p>
      </main>
    );
  }

  return (
    <main className="flex min-h-dvh flex-col bg-stone-950 text-white">
      <header className="flex items-center gap-4 border-b border-white/10 px-8 py-5">
        {board?.branding.logo_url && <BrandMark branding={board.branding} className="size-14 rounded-2xl" />}
        <h1 className="flex-1 truncate text-2xl font-semibold">{board?.outlet_name ?? ''}</h1>
        {!sound && (
          <button onClick={() => setSound(unlockSound())} className="inline-flex h-11 cursor-pointer items-center gap-2 rounded-xl bg-white/10 px-4 text-sm font-semibold hover:bg-white/20">
            <Volume2 className="size-5" /> Turn on sound
          </button>
        )}
        <button onClick={() => void document.documentElement.requestFullscreen?.()} aria-label="Full screen" className="grid size-11 cursor-pointer place-items-center rounded-xl hover:bg-white/10">
          <Maximize className="size-5" />
        </button>
        <span className="text-2xl font-semibold tabular text-stone-300">{clock.format(now)}</span>
      </header>
      <div className="grid flex-1 grid-cols-1 md:grid-cols-[2fr_3fr]">
        <section className="border-white/10 p-8 md:border-r" aria-label="Being made">
          <h2 className="text-xl font-semibold tracking-wide text-stone-400 uppercase">Being made</h2>
          <ul className="mt-6 flex flex-wrap gap-4">
            {(board?.preparing ?? []).map((o) => (
              <li key={o.order_no} className="min-w-28 rounded-2xl bg-white/5 px-5 py-3 text-center">
                <span className="block text-5xl leading-none font-semibold tabular text-stone-200">{o.order_no}</span>
                {o.label && <span className="mt-1 block text-sm text-stone-400">{o.label}</span>}
              </li>
            ))}
          </ul>
        </section>
        <section className="p-8" aria-label="Ready to collect">
          <h2 className="text-xl font-semibold tracking-wide text-emerald-400 uppercase">Ready to collect</h2>
          <ul className="mt-6 flex flex-wrap gap-5">
            {(board?.ready ?? []).map((o) => (
              <li
                key={o.order_no}
                className={cn('min-w-36 rounded-3xl bg-emerald-600 px-6 py-4 text-center shadow-lg transition', fresh.has(o.order_no) && 'animate-pulse ring-4 ring-emerald-300')}
              >
                <span className="block text-7xl leading-none font-bold tabular">{o.order_no}</span>
                {o.label && <span className="mt-1 block text-sm text-emerald-100">{o.label}</span>}
              </li>
            ))}
          </ul>
          {board && board.ready.length === 0 && <p className="mt-6 text-lg text-stone-500">Ready orders appear here.</p>}
        </section>
      </div>
    </main>
  );
}

'use client';

import { CheckCircle2, Info, TriangleAlert } from 'lucide-react';
import { createContext, useCallback, useContext, useState } from 'react';
import { cn } from './cn';

type Tone = 'success' | 'error' | 'info';
interface Toast {
  id: number;
  tone: Tone;
  message: string;
  leaving?: boolean;
}

const Ctx = createContext<(message: string, tone?: Tone) => void>(() => {});

/**
 * Short notes at the bottom of the screen. They rise from the bottom edge and sink back the same
 * way; a tap sends one away early. Errors are announced at once to screen readers, the rest when
 * the reader is free.
 */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const remove = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const dismiss = useCallback(
    (id: number) => {
      setToasts((t) => t.map((x) => (x.id === id ? { ...x, leaving: true } : x)));
      // Gone when its exit ends; this is the backstop if that event never comes (hidden tab).
      setTimeout(() => remove(id), 400);
    },
    [remove],
  );
  const push = useCallback(
    (message: string, tone: Tone = 'success') => {
      const id = Date.now() + Math.random();
      setToasts((t) => [...t.slice(-3), { id, tone, message }]);
      setTimeout(() => dismiss(id), tone === 'error' ? 6000 : 3500);
    },
    [dismiss],
  );
  return (
    <Ctx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-[calc(var(--tabbar-h)+1rem)] z-[60] flex flex-col items-center gap-2 px-4 no-print">
        {toasts.map((t) => (
          <div
            key={t.id}
            role={t.tone === 'error' ? 'alert' : 'status'}
            title="Tap to dismiss"
            onClick={() => dismiss(t.id)}
            onAnimationEnd={(e) => {
              if (t.leaving && e.target === e.currentTarget) remove(t.id);
            }}
            className={cn(
              'pointer-events-auto flex max-w-md cursor-pointer items-center gap-2.5 rounded-2xl px-4 py-3 text-sm font-medium shadow-[var(--shadow-pop)] select-none',
              t.leaving ? 'pointer-events-none animate-toast-out' : 'animate-toast-in',
              t.tone === 'error' ? 'bg-rose-700 text-white' : t.tone === 'info' ? 'bg-stone-800 text-white' : 'bg-emerald-700 text-white',
            )}
          >
            {t.tone === 'error' ? <TriangleAlert className="size-4 shrink-0" aria-hidden /> : t.tone === 'info' ? <Info className="size-4 shrink-0" aria-hidden /> : <CheckCircle2 className="size-4 shrink-0" aria-hidden />}
            {t.message}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useToast() {
  return useContext(Ctx);
}

import { CloudOff } from 'lucide-react';

/** Shown when a screen is displaying data saved on this device because the server is unreachable. */
export function StaleBanner({ show, dark }: { show: boolean; dark?: boolean }) {
  if (!show) return null;
  return (
    <p role="status" className={`mx-4 mb-3 flex items-center gap-2 rounded-xl px-3 py-2 text-sm lg:mx-8 ${dark ? 'bg-amber-500/20 text-amber-200' : 'bg-amber-50 text-amber-900'}`}>
      <CloudOff className="size-4 shrink-0" /> No connection. Showing the last saved orders; changes you make will sync when it returns.
    </p>
  );
}

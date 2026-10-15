'use client';

import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CloudOff, RefreshCw, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { ago } from '@/lib/format';
import { discard, dismissRejected, flush, listQueued, listRejected, onOutboxChange, type OutboxState, type QueuedRequest, type RejectedRequest } from '@/lib/outbox';
import { useStaff } from '@/lib/staff';
import { Button, IconButton } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';
import { Sheet } from '@/components/ui/overlay';
import { useToast } from '@/components/ui/toast';

export function useOutboxState(): OutboxState {
  const [s, setS] = useState<OutboxState>({ pending: 0, rejected: 0 });
  useEffect(() => onOutboxChange(setS), []);
  return s;
}

/** Header badge for changes saved on this device: waiting to sync, or refused by the server. */
export function OutboxBadge({ className }: { className?: string }) {
  const { pending, rejected } = useOutboxState();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState(rejected);
  useEffect(() => {
    if (rejected > seen) toast(`${rejected - seen} offline change${rejected - seen === 1 ? ' was' : 's were'} refused by the server. Tap the red badge to see why.`, 'error');
    setSeen(rejected);
  }, [rejected, seen, toast]);
  if (!pending && !rejected) return null;
  return (
    <>
      <button onClick={() => setOpen(true)} className={cn('flex cursor-pointer items-center gap-1.5', className)} aria-label="Changes waiting to sync">
        {pending > 0 && (
          <span className="flex items-center gap-1 rounded-full bg-amber-100 px-2 py-1 text-xs font-medium text-amber-900">
            <CloudOff className="size-3.5" /> {pending} waiting to sync
          </span>
        )}
        {rejected > 0 && (
          <span className="flex items-center gap-1 rounded-full bg-rose-100 px-2 py-1 text-xs font-medium text-rose-800">
            <AlertTriangle className="size-3.5" /> {rejected} not saved
          </span>
        )}
      </button>
      {open && <OutboxSheet onClose={() => setOpen(false)} />}
    </>
  );
}

export function OutboxSheet({ onClose }: { onClose: () => void }) {
  const { token } = useStaff();
  const qc = useQueryClient();
  const toast = useToast();
  const [queued, setQueued] = useState<QueuedRequest[]>([]);
  const [rejected, setRejected] = useState<RejectedRequest[]>([]);
  const [busy, setBusy] = useState(false);
  const reload = useCallback(async () => {
    setQueued(await listQueued());
    setRejected(await listRejected());
  }, []);
  useEffect(() => onOutboxChange(() => void reload()), [reload]);

  const retry = async () => {
    setBusy(true);
    const r = await flush(token);
    setBusy(false);
    if (r.sent) {
      void qc.invalidateQueries();
      toast(`${r.sent} change${r.sent === 1 ? '' : 's'} sent`);
    } else if (!r.failed.length) {
      toast('Still offline. Changes stay on this device and send automatically.', 'error');
    }
  };

  return (
    <Sheet
      open
      onClose={onClose}
      title="Changes on this device"
      footer={
        queued.length > 0 && (
          <Button block onClick={() => void retry()} loading={busy}>
            <RefreshCw className="size-4" /> Send now
          </Button>
        )
      }
    >
      <div className="space-y-5">
        {queued.length > 0 && (
          <section>
            <p className="mb-2 text-sm text-ink-soft">Made while the internet was down. They send by themselves when the connection is back, in the order they were made.</p>
            <ul className="divide-y divide-line rounded-xl border border-line">
              {queued.map((q) => (
                <li key={q.key} className="flex items-center gap-3 px-3 py-2.5 text-sm">
                  <CloudOff className="size-4 shrink-0 text-amber-700" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{q.label}</p>
                    <p className="text-xs text-ink-faint">{ago(new Date(q.queuedAt).toISOString())}</p>
                  </div>
                  <IconButton
                    label={`Discard ${q.label}`}
                    onClick={() => {
                      if (window.confirm(`Discard "${q.label}"? It will not be sent.`)) void discard(q.key);
                    }}
                  >
                    <Trash2 className="size-4" />
                  </IconButton>
                </li>
              ))}
            </ul>
          </section>
        )}
        {rejected.length > 0 && (
          <section>
            <div className="mb-2 flex items-center justify-between gap-2">
              <p className="text-sm font-medium text-rose-800">Refused by the server. Please redo these if they are still needed.</p>
              <Button size="sm" variant="ghost" onClick={() => void dismissRejected()}>
                Clear all
              </Button>
            </div>
            <ul className="divide-y divide-line rounded-xl border border-rose-200 bg-rose-50/50">
              {rejected.map((r) => (
                <li key={r.key} className="flex items-center gap-3 px-3 py-2.5 text-sm">
                  <AlertTriangle className="size-4 shrink-0 text-rose-700" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{r.label}</p>
                    <p className="text-xs text-rose-800">{r.message}</p>
                  </div>
                  <Button size="sm" variant="ghost" onClick={() => void dismissRejected(r.key)}>
                    OK
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        )}
        {!queued.length && !rejected.length && <p className="py-8 text-center text-sm text-ink-faint">Everything is synced.</p>}
      </div>
    </Sheet>
  );
}

'use client';

import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, CloudOff, RefreshCw, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { OFFLINE_CHECKLIST, OFFLINE_LEVELS } from '@mezmitra/shared/offline';
import { onHub } from '@/lib/api';
import { ago } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { discard, dismissRejected, flush, listQueued, listRejected, listSent, onOutboxChange, type OutboxState, type QueuedRequest, type RejectedRequest, type SentRequest } from '@/lib/outbox';
import { useConnection } from '@/lib/realtime';
import { useStaff } from '@/lib/staff';
import { Button, IconButton } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';
import { Sheet } from '@/components/ui/overlay';
import { useToast } from '@/components/ui/toast';

export function useOutboxState(): OutboxState {
  const [s, setS] = useState<OutboxState>({ pending: 0, rejected: 0, sent: 0 });
  useEffect(() => onOutboxChange(setS), []);
  return s;
}

/** Header badge for changes saved on this device: waiting to sync, or refused by the server. */
export function OutboxBadge({ className }: { className?: string }) {
  const { pending, rejected } = useOutboxState();
  const { t } = useI18n();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState(rejected);
  useEffect(() => {
    if (rejected > seen) toast(rejected - seen === 1 ? t('outbox.refused_one') : t('outbox.refused', { n: rejected - seen }), 'error');
    setSeen(rejected);
  }, [rejected, seen, toast, t]);
  if (!pending && !rejected) return null;
  return (
    <>
      <button onClick={() => setOpen(true)} className={cn('flex cursor-pointer items-center gap-1.5', className)} aria-label={t('outbox.aria')}>
        {pending > 0 && (
          <span className="flex items-center gap-1 rounded-full bg-amber-100 px-2 py-1 text-xs font-medium text-amber-900">
            <CloudOff className="size-3.5" /> {t('outbox.waiting', { n: pending })}
          </span>
        )}
        {rejected > 0 && (
          <span className="flex items-center gap-1 rounded-full bg-rose-100 px-2 py-1 text-xs font-medium text-rose-800">
            <AlertTriangle className="size-3.5" /> {t('outbox.not_saved', { n: rejected })}
          </span>
        )}
      </button>
      {open && <OutboxSheet onClose={() => setOpen(false)} />}
    </>
  );
}

/**
 * The header's connection dot, which opens the sync sheet even when nothing is waiting: during an
 * outage staff need the counts and the recovery steps, not only when something went wrong.
 */
export function SyncStatus() {
  const { t } = useI18n();
  const connection = useConnection();
  const [open, setOpen] = useState(false);
  const hub = onHub();
  return (
    <div className="flex items-center gap-2 text-xs">
      <OutboxBadge />
      <button type="button" data-help="Check your connection and any changes waiting to sync. Open this panel to review pending or rejected changes." data-help-hi="कनेक्शन और सिंक होने वाले बदलाव देखें। लंबित या अस्वीकृत बदलाव देखने के लिए पैनल खोलें।" onClick={() => setOpen(true)} className="flex cursor-pointer items-center gap-1.5 rounded-full px-1.5 py-1 text-ink-faint hover:bg-stone-100" aria-label={t('sync.aria')} role="status">
        <span className={cn('size-2 rounded-full', hub ? 'bg-sky-500' : connection === 'online' ? 'bg-emerald-500' : connection === 'connecting' ? 'bg-amber-400' : 'bg-rose-500')} />
        {hub ? 'Hub' : connection === 'online' ? 'Live' : connection === 'connecting' ? 'Connecting' : 'Offline'}
      </button>
      {open && <OutboxSheet onClose={() => setOpen(false)} />}
    </div>
  );
}

export function OutboxSheet({ onClose }: { onClose: () => void }) {
  const { token } = useStaff();
  const { t, lang } = useI18n();
  const qc = useQueryClient();
  const toast = useToast();
  const connection = useConnection();
  const hub = onHub();
  const [queued, setQueued] = useState<QueuedRequest[]>([]);
  const [rejected, setRejected] = useState<RejectedRequest[]>([]);
  const [sent, setSent] = useState<SentRequest[]>([]);
  const [busy, setBusy] = useState(false);
  const reload = useCallback(async () => {
    setQueued(await listQueued());
    setRejected(await listRejected());
    setSent(await listSent());
  }, []);
  useEffect(() => onOutboxChange(() => void reload()), [reload]);

  const retry = async () => {
    setBusy(true);
    const r = await flush(token);
    setBusy(false);
    if (r.sent) {
      void qc.invalidateQueries();
      toast(r.sent === 1 ? t('outbox.sent_one') : t('outbox.sent', { n: r.sent }));
    } else if (!r.failed.length) {
      toast(t('outbox.still_offline'), 'error');
    }
  };

  return (
    <Sheet
      open
      onClose={onClose}
      title={t('outbox.title')}
      footer={
        queued.length > 0 && (
          <Button block onClick={() => void retry()} loading={busy}>
            <RefreshCw className="size-4" /> {t('outbox.send_now')}
          </Button>
        )
      }
    >
      <div className="space-y-5">
        {/* Live updates can be up while requests still fail; waiting changes say which is true. */}
        <div
          className={cn(
            'flex items-center gap-2 rounded-xl px-3 py-2.5 text-sm font-medium',
            hub ? 'bg-sky-50 text-sky-950' : connection === 'online' && !queued.length ? 'bg-emerald-50 text-emerald-950' : connection === 'offline' ? 'bg-rose-50 text-rose-950' : 'bg-amber-50 text-amber-950',
          )}
        >
          {connection === 'online' && !hub && !queued.length ? <CheckCircle2 className="size-4" /> : <CloudOff className="size-4" />}
          {hub
            ? t('sync.hub')
            : connection === 'online'
              ? queued.length
                ? t('sync.stuck', { n: queued.length })
                : t('sync.online')
              : connection === 'connecting'
                ? t('sync.connecting')
                : t('sync.offline')}
        </div>
        <dl className="grid grid-cols-3 gap-2 text-center">
          {(
            [
              ['sync.waiting', queued.length, queued.length ? 'text-amber-800' : ''],
              ['sync.sent', sent.length, ''],
              ['sync.refused', rejected.length, rejected.length ? 'text-rose-700' : ''],
            ] as const
          ).map(([label, n, tone]) => (
            <div key={label} className="rounded-xl border border-line px-2 py-2.5">
              <dd className={cn('text-2xl font-semibold tabular', tone)}>{n}</dd>
              <dt className="text-xs text-ink-faint">{t(label)}</dt>
            </div>
          ))}
        </dl>
        {queued.length > 0 && (
          <section>
            <p className="mb-2 text-sm text-ink-soft">{t('outbox.queued_hint')}</p>
            <ul className="divide-y divide-line rounded-xl border border-line">
              {queued.map((q) => (
                <li key={q.key} className="flex items-center gap-3 px-3 py-2.5 text-sm">
                  <CloudOff className="size-4 shrink-0 text-amber-700" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{q.label}</p>
                    <p className="text-xs text-ink-faint">{ago(new Date(q.queuedAt).toISOString())}</p>
                  </div>
                  <IconButton
                    label={t('outbox.discard', { label: q.label })}
                    onClick={() => {
                      if (window.confirm(t('outbox.discard_confirm', { label: q.label }))) void discard(q.key);
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
              <p className="text-sm font-medium text-rose-800">{t('outbox.refused_hint')}</p>
              <Button size="sm" variant="ghost" onClick={() => void dismissRejected()}>
                {t('outbox.clear_all')}
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
                    {t('outbox.ok')}
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        )}
        {!queued.length && !rejected.length && <p className="text-center text-sm text-ink-faint">{t('outbox.synced')}</p>}
        {sent.length > 0 && (
          <details className="rounded-xl border border-line">
            <summary className="cursor-pointer px-3 py-2.5 text-sm font-medium">
              {t('sync.sent_list')} ({sent.length})
            </summary>
            <ul className="divide-y divide-line border-t border-line">
              {sent.slice(0, 30).map((x) => (
                <li key={x.key} className="flex items-center gap-3 px-3 py-2 text-sm">
                  <CheckCircle2 className="size-4 shrink-0 text-emerald-600" />
                  <span className="min-w-0 flex-1 truncate">{x.label}</span>
                  <span className="text-xs text-ink-faint">{ago(new Date(x.sentAt).toISOString())}</span>
                </li>
              ))}
            </ul>
          </details>
        )}
        <details className="rounded-xl border border-line" open={connection !== 'online' || hub}>
          <summary className="cursor-pointer px-3 py-2.5 text-sm font-medium">{t('sync.checklist')}</summary>
          <ol className="list-decimal space-y-1.5 border-t border-line py-3 pr-3 pl-8 text-sm text-ink-soft">
            {OFFLINE_CHECKLIST.map((c) => (
              <li key={c.en}>{c[lang]}</li>
            ))}
          </ol>
        </details>
        <details className="rounded-xl border border-line">
          <summary className="cursor-pointer px-3 py-2.5 text-sm font-medium">{t('sync.works')}</summary>
          <div className="space-y-4 border-t border-line p-3 text-sm">
            {OFFLINE_LEVELS.map((l) => (
              <section key={l.id}>
                <h3 className="font-semibold">{l.title[lang]}</h3>
                <p className="mt-0.5 text-xs text-ink-faint">{l.summary[lang]}</p>
                <p className="mt-2 text-xs font-semibold tracking-wide text-emerald-800 uppercase">{t('sync.works_label')}</p>
                <ul className="mt-1 list-disc space-y-0.5 pl-5 text-ink-soft">
                  {l.works.map((w) => (
                    <li key={w.en}>{w[lang]}</li>
                  ))}
                </ul>
                <p className="mt-2 text-xs font-semibold tracking-wide text-ink-faint uppercase">{t('sync.waits_label')}</p>
                <ul className="mt-1 list-disc space-y-0.5 pl-5 text-ink-soft">
                  {l.waits.map((w) => (
                    <li key={w.en}>{w[lang]}</li>
                  ))}
                </ul>
              </section>
            ))}
            <a href="/offline-guide" target="_blank" rel="noreferrer" className="block font-medium text-brand-700 underline">
              {t('sync.full_list')}
            </a>
          </div>
        </details>
      </div>
    </Sheet>
  );
}

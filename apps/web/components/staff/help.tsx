'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { LifeBuoy } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import type { SupportCaseDTO } from '@mezmitra/shared/dto';
import { SUPPORT_HOURS, SUPPORT_SEVERITIES, SUPPORT_TARGET_MINUTES, supportOpen, type SupportSeverity, type SupportStatus } from '@mezmitra/shared/support';
import { errorMessage } from '@/lib/api';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { useConnection, useOutletEvents } from '@/lib/realtime';
import { screenId } from '@/lib/screen-check-in';
import { soundReady } from '@/lib/sound';
import { useStaff } from '@/lib/staff';
import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';
import { Sheet } from '@/components/ui/overlay';
import { Field, Input, Textarea } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/toast';

export const SEVERITY: Record<SupportSeverity, { label: I18nKey; hint: I18nKey; tone: string }> = {
  stopped: { label: 'help.sev.stopped', hint: 'help.sev.stopped_hint', tone: 'border-rose-300 bg-rose-50 text-rose-950' },
  degraded: { label: 'help.sev.degraded', hint: 'help.sev.degraded_hint', tone: 'border-amber-300 bg-amber-50 text-amber-950' },
  question: { label: 'help.sev.question', hint: 'help.sev.question_hint', tone: 'border-sky-300 bg-sky-50 text-sky-950' },
};

export const STATUS: Record<SupportStatus, I18nKey> = {
  open: 'help.status.open',
  in_progress: 'help.status.in_progress',
  waiting_on_outlet: 'help.status.waiting_on_outlet',
  resolved: 'help.status.resolved',
  closed: 'help.status.closed',
};

/** Cases where the next move is the outlet's: answer a question, or confirm a fix. */
export const needsOutlet = (c: SupportCaseDTO) => c.status === 'waiting_on_outlet' || c.status === 'resolved';

export function useHelpCases() {
  const { api, outletId } = useStaff();
  return useQuery({
    queryKey: ['support', outletId],
    queryFn: () => api<SupportCaseDTO[]>(`/support/cases?outlet_id=${outletId}`),
    staleTime: 60_000,
  });
}

/** What support needs to see what this screen saw. Nothing about guests, orders or bills. */
function technicalReport(page: string, live: string) {
  const nav = navigator as Navigator & { connection?: { effectiveType?: string; downlink?: number } };
  return {
    page,
    screen_id: screenId(),
    browser: navigator.userAgent,
    screen: `${window.screen.width}×${window.screen.height}`,
    window: `${window.innerWidth}×${window.innerHeight}`,
    online: navigator.onLine,
    live_updates: live,
    connection: nav.connection?.effectiveType ?? null,
    language: navigator.language,
    sound_on: soundReady(),
    at: new Date().toISOString(),
  };
}

export function targetWords(t: ReturnType<typeof useI18n>['t'], s: SupportSeverity): string {
  const m = SUPPORT_TARGET_MINUTES[s];
  return m === null ? t('help.target.day') : t('help.target.minutes', { n: m });
}

/** Raise a case from wherever the problem is: how bad, what happened, and (if they agree) a technical report. */
export function NewCaseSheet({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated?: (c: SupportCaseDTO) => void }) {
  const { t } = useI18n();
  const { api, outletId } = useStaff();
  const qc = useQueryClient();
  const toast = useToast();
  const page = usePathname();
  const live = useConnection();
  const [severity, setSeverity] = useState<SupportSeverity | null>(null);
  const [summary, setSummary] = useState('');
  const [details, setDetails] = useState('');
  const [report, setReport] = useState(true);
  const [busy, setBusy] = useState(false);
  const [tried, setTried] = useState(false);
  const staffed = supportOpen();

  const send = async () => {
    setTried(true);
    if (!severity || summary.trim().length < 3) return;
    setBusy(true);
    try {
      const c = await api<SupportCaseDTO>('/support/cases', {
        method: 'POST',
        body: { outlet_id: outletId, severity, summary: summary.trim(), details: details.trim() || null, diagnostics: report ? technicalReport(page, live) : null },
      });
      await qc.invalidateQueries({ queryKey: ['support'] });
      toast(t('help.sent', { n: c.number }));
      setSeverity(null);
      setSummary('');
      setDetails('');
      setTried(false);
      onClose();
      onCreated?.(c);
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={t('help.ask')}
      footer={
        <Button className="w-full" onClick={() => void send()} disabled={busy}>
          {t('help.send')}
        </Button>
      }
    >
      <div className="space-y-4">
        <fieldset className="space-y-2">
          <legend className="mb-2 text-sm font-medium">{t('help.how_bad')}</legend>
          {SUPPORT_SEVERITIES.map((s) => (
            <label
              key={s}
              className={cn(
                'flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition active:scale-[0.99]',
                severity === s ? SEVERITY[s].tone : 'border-line bg-surface hover:bg-stone-50',
              )}
            >
              <input type="radio" name="severity" checked={severity === s} onChange={() => setSeverity(s)} className="mt-1 size-4 accent-[var(--brand)]" />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold">{t(SEVERITY[s].label)}</span>
                <span className="block text-xs opacity-80">{t(SEVERITY[s].hint)}</span>
                <span className="mt-1 block text-xs font-medium opacity-90">{targetWords(t, s)}</span>
              </span>
            </label>
          ))}
          {tried && !severity && (
            <p className="text-sm text-rose-700" role="alert">
              {t('help.pick_one')}
            </p>
          )}
        </fieldset>
        <p className={cn('rounded-xl px-3 py-2 text-xs', staffed ? 'bg-stone-50 text-ink-soft' : 'bg-amber-50 text-amber-950')}>
          {t('help.hours', { hours: SUPPORT_HOURS.label })} {!staffed && t('help.closed_now')}
        </p>
        <Field label={t('help.summary')} error={tried && summary.trim().length < 3 ? t('help.summary_needed') : null}>
          {(id) => <Input id={id} value={summary} onChange={(e) => setSummary(e.target.value)} maxLength={140} placeholder={t('help.summary_ph')} />}
        </Field>
        <Field label={t('help.details')}>{(id) => <Textarea id={id} value={details} onChange={(e) => setDetails(e.target.value)} maxLength={4000} placeholder={t('help.details_ph')} />}</Field>
        <label className="flex cursor-pointer items-start gap-3 text-sm">
          <input type="checkbox" checked={report} onChange={(e) => setReport(e.target.checked)} className="mt-0.5 size-4 accent-[var(--brand)]" />
          <span>
            {t('help.report')}
            <span className="block text-xs text-ink-faint">{t('help.report_hint')}</span>
          </span>
        </label>
      </div>
    </Sheet>
  );
}

/**
 * The lifebuoy at the top of every screen: raise a case right where the problem is. A dot shows
 * when support is waiting on this outlet; a reply to whoever raised a case also shows here.
 */
export function HelpButton({ dark }: { dark?: boolean }) {
  const { t } = useI18n();
  const { me } = useStaff();
  const toast = useToast();
  const { data } = useHelpCases();
  const [open, setOpen] = useState(false);
  useOutletEvents((e) => {
    if (e.type !== 'support.updated') return;
    const p = e.payload as { number: number; status: SupportStatus; notify_user_id: string | null };
    if (p.notify_user_id && p.notify_user_id === me.user.id) toast(t('help.reply_toast', { n: p.number, status: t(STATUS[p.status]) }));
  });
  const waiting = (data ?? []).filter(needsOutlet).length;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={waiting ? t('help.button_waiting', { n: waiting }) : t('help.button')}
        title={t('help.button')}
        className={cn('relative grid size-10 cursor-pointer place-items-center rounded-xl', dark ? 'text-stone-300 hover:bg-stone-800' : 'text-ink-soft hover:bg-stone-100')}
      >
        <LifeBuoy className="size-5" />
        {waiting > 0 && <span className="absolute top-2 right-2 size-2.5 rounded-full bg-rose-500 ring-2 ring-[var(--surface,white)]" />}
      </button>
      <HelpSheet open={open} onClose={() => setOpen(false)} />
    </>
  );
}

/** Open cases that need the outlet, a way to raise a new one, and the way to every case. */
function HelpSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useI18n();
  const { data } = useHelpCases();
  const [asking, setAsking] = useState(false);
  const live = (data ?? []).filter((c) => c.status !== 'closed');
  return (
    <>
      <Sheet open={open && !asking} onClose={onClose} title={t('help.title')}>
        <div className="space-y-4">
          <Button className="w-full" onClick={() => setAsking(true)}>
            <LifeBuoy className="size-4" /> {t('help.ask')}
          </Button>
          {live.length > 0 && (
            <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line">
              {live.slice(0, 5).map((c) => (
                <li key={c.id}>
                  <Link href={`/app/help?case=${c.id}`} onClick={onClose} className="flex items-center gap-3 px-3 py-2.5 text-sm hover:bg-stone-50">
                    <span className="tabular text-ink-faint">#{c.number}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{c.summary}</span>
                      <span className={cn('block text-xs', needsOutlet(c) ? 'font-semibold text-rose-700' : 'text-ink-faint')}>{t(STATUS[c.status])}</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          <Link href="/app/help" onClick={onClose} className="block text-center text-sm font-medium text-brand-700">
            {t('help.see_all')}
          </Link>
        </div>
      </Sheet>
      <NewCaseSheet
        open={open && asking}
        onClose={() => {
          setAsking(false);
          onClose();
        }}
      />
    </>
  );
}

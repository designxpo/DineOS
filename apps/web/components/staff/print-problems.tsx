'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, PrinterIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { PrintProblemDTO, PrintStatusDTO } from '@mezmitra/shared/print';
import { errorMessage, onHub } from '@/lib/api';
import { ago, time } from '@/lib/format';
import { chime } from '@/lib/sound';
import { useI18n } from '@/lib/i18n';
import { useStaff } from '@/lib/staff';
import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';
import { useToast } from '@/components/ui/toast';

/**
 * Says so on every staff screen when a kitchen ticket or bill did not print, or is stuck because
 * the print computer is off, so an order is never lost on a jammed printer. Each one can be
 * printed from this device instead, sent again, or cleared once the kitchen has it.
 */
export function PrintProblems() {
  const { api, outletId, can } = useStaff();
  const { t } = useI18n();
  const qc = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  // The outlet hub has its own printing; this check is for the cloud.
  const [hub, setHub] = useState(true);
  useEffect(() => setHub(onHub()), []);
  const { data } = useQuery({
    queryKey: ['print-status', outletId],
    queryFn: () => api<PrintStatusDTO>(`/print/status?outlet_id=${outletId}`),
    enabled: !hub && can('order.view'),
    refetchInterval: 30_000,
  });
  const problems = data?.problems ?? [];
  // A ticket or bill that did not print is urgent: it sounds on every screen, even ones that
  // turned other alerts off.
  const seen = useRef<number | null>(null);
  useEffect(() => {
    if (!data) return;
    if (seen.current !== null && data.problems.length > seen.current) chime('alert');
    seen.current = data.problems.length;
  }, [data]);
  if (problems.length === 0) return null;

  const offline = data!.agents.length > 0 && data!.agents.every((a) => !a.online) ? data!.agents[0]! : null;
  const act = async (p: PrintProblemDTO, what: 'retry' | 'dismiss') => {
    setBusy(`${p.job_id}:${what}`);
    try {
      await api(`/print-jobs/${p.job_id}/${what}`, { method: 'POST' });
      await qc.invalidateQueries({ queryKey: ['print-status'] });
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy(null);
    }
  };
  const printHere = (p: PrintProblemDTO) => {
    if (p.order_id) window.open(`/print/kot/${p.order_id}`, '_blank');
    else if (p.bill_id) window.open(`/print/bill/${p.bill_id}`, '_blank');
  };

  return (
    <div className="border-b border-rose-200 bg-rose-50 text-sm text-rose-950 no-print" role="alert">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-full cursor-pointer items-center gap-3 px-4 py-2.5 text-left lg:px-6">
        <PrinterIcon className="size-4 shrink-0" />
        <span className="min-w-0 flex-1">
          <span className="font-semibold">{t('print.title', { n: problems.length })}</span>{' '}
          {offline
            ? t('print.offline', { name: offline.name, time: offline.last_seen_at ? time(offline.last_seen_at) : '—' })
            : problems[0]!.error && <span className="text-rose-800">{problems[0]!.error}</span>}
        </span>
        <span className="shrink-0 text-xs font-semibold">{open ? t('print.hide') : t('print.show')}</span>
        <ChevronDown className={cn('size-4 shrink-0 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <ul className="divide-y divide-rose-200 border-t border-rose-200">
          {problems.map((p) => (
            <li key={p.job_id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5 lg:px-6">
              <div className="min-w-48 flex-1">
                <p className="font-medium">
                  {p.label} <span className="font-normal text-rose-800 capitalize">· {p.target}</span>
                </p>
                <p className="text-xs text-rose-800">
                  {t(p.status === 'failed' ? 'print.failed' : 'print.waiting')} · {ago(p.since)}
                  {p.error ? ` · ${p.error}` : ''}
                </p>
              </div>
              <div className="flex shrink-0 flex-wrap gap-2">
                {(p.order_id || p.bill_id) && (
                  <Button size="sm" variant="outline" onClick={() => printHere(p)}>
                    {t('print.here')}
                  </Button>
                )}
                <Button size="sm" variant="outline" loading={busy === `${p.job_id}:retry`} onClick={() => void act(p, 'retry')}>
                  {t('print.retry')}
                </Button>
                <Button size="sm" variant="ghost" loading={busy === `${p.job_id}:dismiss`} onClick={() => void act(p, 'dismiss')}>
                  {t('print.dismiss')}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BellRing, Check, ReceiptIndianRupee } from 'lucide-react';
import type { ServiceRequestDTO } from '@dineos/shared/dto';
import { errorMessage } from '@/lib/api';
import { ago } from '@/lib/format';
import { useOutletEvents } from '@/lib/realtime';
import { chime } from '@/lib/sound';
import { useI18n } from '@/lib/i18n';
import { useStaff } from '@/lib/staff';
import { cn } from '@/components/ui/cn';
import { useToast } from '@/components/ui/toast';

/** Waiters (without manager or cashier duties) only handle their own tables and unassigned ones. */
export function useRequestFilter() {
  const { roles, me } = useStaff();
  const floorOnly = roles.length > 0 && roles.every((r) => r === 'waiter');
  return (assignedWaiterId: string | null | undefined) => !floorOnly || !assignedWaiterId || assignedWaiterId === me.user.id;
}

/** Chime and announce guest requests meant for this staff member (spec §9: waiter.called → assigned waiter). */
export function useServiceRequestAlerts() {
  const toast = useToast();
  const mine = useRequestFilter();
  useOutletEvents((e) => {
    if (e.type !== 'waiter.called' && e.type !== 'bill.requested') return;
    const p = e.payload as { assigned_waiter_id?: string | null; request?: ServiceRequestDTO };
    if (!mine(p.assigned_waiter_id ?? p.request?.assigned_waiter_id)) return;
    chime('call');
    const label = p.request?.table_label ?? '';
    toast(e.type === 'waiter.called' ? `Table ${label} is calling a waiter` : `Table ${label} asked for the bill`, 'info');
  });
}

/** Live strip of guests calling a waiter or asking for the bill. */
export function ServiceRequestStrip() {
  const { api, outletId, can } = useStaff();
  const { t } = useI18n();
  const mine = useRequestFilter();
  const qc = useQueryClient();
  const toast = useToast();
  const { data = [] } = useQuery({
    queryKey: ['service-requests', outletId],
    queryFn: () => api<ServiceRequestDTO[]>(`/service-requests?outlet_id=${outletId}`),
    refetchInterval: 60_000,
  });
  const visible = data.filter((r) => mine(r.assigned_waiter_id));
  if (visible.length === 0) return null;

  const act = async (r: ServiceRequestDTO, action: 'ack' | 'close') => {
    try {
      await api(`/service-requests/${r.id}/${action}`, { method: 'POST' });
      await qc.invalidateQueries({ queryKey: ['service-requests'] });
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  return (
    <div className="flex gap-2 overflow-x-auto px-4 pb-3 lg:px-8" aria-label="Guest requests">
      {visible.map((r) => (
        <div
          key={r.id}
          className={cn(
            'flex shrink-0 items-center gap-3 rounded-2xl border px-3 py-2',
            r.status === 'open' ? 'border-amber-300 bg-amber-50' : 'border-line bg-surface',
          )}
        >
          <span className={cn('grid size-9 place-items-center rounded-xl', r.kind === 'bill' ? 'bg-violet-100 text-violet-700' : 'bg-amber-100 text-amber-800')}>
            {r.kind === 'bill' ? <ReceiptIndianRupee className="size-4" /> : <BellRing className="size-4" />}
          </span>
          <div className="leading-tight">
            <p className="text-sm font-semibold">
              {r.table_label} · {r.kind === 'bill' ? t('req.bill') : t('req.calling')}
            </p>
            <p className="text-xs text-ink-faint">
              {ago(r.created_at)}
              {r.acknowledged_by ? ` · ${r.acknowledged_by} on it` : ''}
            </p>
          </div>
          {can('service_request.handle') && (
            <button
              onClick={() => void act(r, r.status === 'open' ? 'ack' : 'close')}
              className="ml-1 inline-flex h-9 cursor-pointer items-center gap-1 rounded-xl bg-surface px-3 text-xs font-semibold text-ink shadow-sm ring-1 ring-line hover:bg-stone-50"
            >
              <Check className="size-3.5" /> {r.status === 'open' ? t('req.on_my_way') : t('req.done')}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

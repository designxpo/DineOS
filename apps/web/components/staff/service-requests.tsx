'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BellRing, Check, ReceiptIndianRupee } from 'lucide-react';
import type { ServiceRequestDTO } from '@dineos/shared/dto';
import { errorMessage } from '@/lib/api';
import { ago } from '@/lib/format';
import { useStaff } from '@/lib/staff';
import { cn } from '@/components/ui/cn';
import { useToast } from '@/components/ui/toast';

/** Live strip of guests calling a waiter or asking for the bill. */
export function ServiceRequestStrip() {
  const { api, outletId, can } = useStaff();
  const qc = useQueryClient();
  const toast = useToast();
  const { data = [] } = useQuery({
    queryKey: ['service-requests', outletId],
    queryFn: () => api<ServiceRequestDTO[]>(`/service-requests?outlet_id=${outletId}`),
    refetchInterval: 60_000,
  });
  if (data.length === 0) return null;

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
      {data.map((r) => (
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
              {r.table_label} · {r.kind === 'bill' ? 'Bill requested' : 'Calling waiter'}
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
              <Check className="size-3.5" /> {r.status === 'open' ? 'On my way' : 'Done'}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

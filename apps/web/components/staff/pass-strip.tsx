'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { HandPlatter } from 'lucide-react';
import type { PassItemDTO } from '@mezmitra/shared/dto';
import { errorMessage } from '@/lib/api';
import { ago } from '@/lib/format';
import { useOutletEvents } from '@/lib/realtime';
import { useStaff } from '@/lib/staff';
import { cn } from '@/components/ui/cn';
import { useToast } from '@/components/ui/toast';
import { useRequestFilter } from './service-requests';

/**
 * Dishes waiting at the pass. Each can be taken ("I've got it"), which starts a short carry clock;
 * anyone who serves may take one over. Held by nobody for too long, or held and not delivered, it
 * turns red, and managers see it first.
 */
export function PassStrip() {
  const { api, outletId, can, me, roles } = useStaff();
  const mine = useRequestFilter();
  const qc = useQueryClient();
  const toast = useToast();
  const key = ['pass', outletId];
  const { data = [] } = useQuery({
    queryKey: key,
    queryFn: () => api<PassItemDTO[]>(`/pass?outlet_id=${outletId}`),
    refetchInterval: 15_000,
  });
  useOutletEvents((e) => {
    if (e.type === 'order.items_ready' || e.type === 'order.status_changed' || e.type === 'order.updated') void qc.invalidateQueries({ queryKey: key });
  });
  const manager = roles.some((r) => r === 'owner' || r === 'manager');
  // Waiters see their own tables and unassigned ones; managers and cashiers see all.
  const visible = data.filter((p) => mine(p.assigned_waiter_id) || p.claimed_by === me.user.id);
  if (!visible.length) return null;
  const late = visible.filter((p) => p.level === 'escalated').length;

  const claim = async (p: PassItemDTO, claimed: boolean) => {
    try {
      await api('/pass/claim', { method: 'POST', body: { outlet_id: outletId, order_item_ids: [p.order_item_id], claimed } });
      await qc.invalidateQueries({ queryKey: key });
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  return (
    <div className="px-4 pb-3 lg:px-8" aria-label="Food waiting at the pass">
      {manager && late > 0 && (
        <p role="status" className="mb-2 rounded-xl bg-rose-50 px-3 py-2 text-sm font-medium text-rose-900">
          {late} dish{late === 1 ? ' is' : 'es are'} going cold at the pass.
        </p>
      )}
      <div className="flex gap-2 overflow-x-auto">
        {visible.map((p) => {
          const holder = p.claimed_by === me.user.id ? 'You' : p.claimed_by_name;
          return (
            <div
              key={p.order_item_id}
              className={cn(
                'flex shrink-0 items-center gap-3 rounded-2xl border px-3 py-2',
                p.level === 'escalated' ? 'border-rose-300 bg-rose-50' : p.level === 'overdue' ? 'border-amber-300 bg-amber-50' : 'border-line bg-surface',
              )}
            >
              <span className="grid size-9 place-items-center rounded-xl bg-emerald-100 text-emerald-800">
                <HandPlatter className="size-4" />
              </span>
              <div className="leading-tight">
                <p className="text-sm font-semibold">
                  {p.table_label ?? `#${p.order_no}`} · {p.qty}× {p.name}
                </p>
                <p className="text-xs text-ink-faint">
                  Ready {ago(p.ready_at)}
                  {holder ? ` · ${holder} carrying it` : p.assigned_waiter_name ? ` · ${p.assigned_waiter_name}’s table` : ' · nobody has it'}
                </p>
              </div>
              {can('order.serve') &&
                (p.claimed_by === me.user.id ? (
                  <button type="button" onClick={() => void claim(p, false)} className="inline-flex h-9 cursor-pointer items-center rounded-xl px-3 text-xs font-semibold text-ink-soft ring-1 ring-line hover:bg-stone-50">
                    Let go
                  </button>
                ) : (
                  <button type="button" onClick={() => void claim(p, true)} className="inline-flex h-9 cursor-pointer items-center rounded-xl bg-surface px-3 text-xs font-semibold text-ink shadow-sm ring-1 ring-line hover:bg-stone-50">
                    {p.claimed_by ? 'Take over' : 'I’ve got it'}
                  </button>
                ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

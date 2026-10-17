'use client';

import type { ItemsReadyDTO } from '@dineos/shared/dto';
import { useI18n } from '@/lib/i18n';
import { useOutletEvents } from '@/lib/realtime';
import { chime } from '@/lib/sound';
import { useStaff } from '@/lib/staff';
import { useToast } from '@/components/ui/toast';
import { orderTitle } from './order-title';
import { useRequestFilter } from './service-requests';

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * A double ding and a note when something is waiting at the pass: one station's part of an order
 * (the bar's drinks while the kitchen still cooks) or the whole order. For staff who serve; waiters
 * with no other duties hear only their own tables and unassigned ones.
 */
export function useReadyAlerts() {
  const { can } = useStaff();
  const { t } = useI18n();
  const toast = useToast();
  const mine = useRequestFilter();
  useOutletEvents((e) => {
    if (e.type !== 'order.items_ready' || !can('order.serve')) return;
    const ready = e.payload as ItemsReadyDTO;
    if (!mine(ready.assigned_waiter_id)) return;
    chime('ready');
    const title = orderTitle({ table_label: ready.table_label, type: ready.order_type, channel: ready.channel, channel_ref: ready.channel_ref }, t);
    const where = ready.table_label || ready.channel_ref ? title : `${title} #${ready.order_no}`;
    const what = ready.complete ? t('ready.order', { where }) : t('ready.station', { where, station: ready.stations.map(capital).join(' + ') });
    toast(`${what} · ${ready.items.map((i) => `${i.qty}× ${i.name}`).join(', ')}`);
  });
}

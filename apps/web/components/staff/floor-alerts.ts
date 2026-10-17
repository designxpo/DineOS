'use client';

import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import type { TableDTO } from '@mezmitra/shared/dto';
import { GUESTS_WAITING_ALERT_MINUTES } from '@mezmitra/shared/table-state';
import { duration, minutesSince } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { chime } from '@/lib/sound';
import { useStaff } from '@/lib/staff';
import { useToast } from '@/components/ui/toast';
import { useRequestFilter } from './service-requests';

/**
 * Guests scanned the table QR (or the camera saw them) and nobody has seated them or taken an
 * order for a few minutes: chime once per table so someone goes over. Waiters with no other
 * duties hear only their own tables and unassigned ones.
 */
export function useGuestsWaitingAlerts() {
  const { api, outletId, can } = useStaff();
  const { t } = useI18n();
  const toast = useToast();
  const mine = useRequestFilter();
  const told = useRef(new Set<string>());
  const [, tick] = useState(0);
  // Same cache as the floor map, so the floor page does not fetch twice.
  const { data: tables } = useQuery({
    queryKey: ['tables', outletId],
    queryFn: () => api<TableDTO[]>(`/tables?outlet_id=${outletId}`),
    enabled: can('table.operate'),
    refetchInterval: 60_000,
  });

  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    for (const table of tables ?? []) {
      const since = table.guests_since ?? (!table.session && table.camera?.state === 'occupied' ? table.camera.occupied_since : null);
      if (!since || minutesSince(since) < GUESTS_WAITING_ALERT_MINUTES || !mine(table.assigned_waiter_id)) continue;
      const key = `${table.id}:${since}`;
      if (told.current.has(key)) continue;
      told.current.add(key);
      chime('call');
      toast(t('floor.guests_alert', { label: table.label, time: duration(minutesSince(since)) }), 'info');
    }
  });
}

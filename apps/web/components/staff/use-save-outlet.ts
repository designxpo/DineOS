'use client';

import { useQueryClient } from '@tanstack/react-query';
import type { OutletDTO } from '@dineos/shared/dto';
import { errorMessage } from '@/lib/api';
import { useStaff } from '@/lib/staff';
import { useToast } from '@/components/ui/toast';

/** Saves outlet settings and refreshes everything that shows them. */
export function useSaveOutlet() {
  const { api, outletId } = useStaff();
  const qc = useQueryClient();
  const toast = useToast();
  return async (body: Partial<OutletDTO>) => {
    try {
      await api(`/outlets/${outletId}`, { method: 'PATCH', body });
      await qc.invalidateQueries({ queryKey: ['outlet'] });
      toast('Saved');
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };
}

'use client';

import { useQuery } from '@tanstack/react-query';
import { createStore, get, set } from 'idb-keyval';
import { useEffect, useState } from 'react';
import type { MenuDTO } from '@dineos/shared/dto';
import { useStaff } from './staff';

const store = typeof indexedDB !== 'undefined' ? createStore('dineos-cache', 'menus') : null;

/**
 * The outlet menu for staff screens, also kept in IndexedDB so the POS still opens and takes
 * orders during a short internet drop (spec §2).
 */
export function useStaffMenu() {
  const { api, outletId } = useStaff();
  const [cached, setCached] = useState<MenuDTO | undefined>(undefined);
  useEffect(() => {
    if (store) void get<MenuDTO>(outletId, store).then((m) => m && setCached(m));
  }, [outletId]);
  const query = useQuery({
    queryKey: ['menu', outletId],
    queryFn: async () => {
      const menu = await api<MenuDTO>(`/menu?outlet_id=${outletId}`);
      if (store) void set(outletId, menu, store);
      return menu;
    },
    placeholderData: cached,
  });
  return { ...query, data: query.data ?? cached };
}

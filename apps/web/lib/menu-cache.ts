'use client';

import { useQuery } from '@tanstack/react-query';
import { createStore, get, set } from 'idb-keyval';
import { useEffect, useState } from 'react';
import type { MenuDTO } from '@mezmitra/shared/dto';
import { moveLegacyStore } from './legacy-names';
import { useStaff } from './staff';

const store = typeof indexedDB !== 'undefined' ? createStore('mezmitra-cache', 'menus') : null;
// Menus cached under the product's earlier name come along before the cache is used.
const moved = moveLegacyStore('dineos-cache', 'menus', store);

/**
 * The outlet menu for staff screens, also kept in IndexedDB so the POS still opens and takes
 * orders during a short internet drop (spec §2).
 */
export function useStaffMenu() {
  const { api, outletId } = useStaff();
  const [cached, setCached] = useState<MenuDTO | undefined>(undefined);
  useEffect(() => {
    if (store) void moved.then(() => get<MenuDTO>(outletId, store)).then((m) => m && setCached(m));
  }, [outletId]);
  const query = useQuery({
    queryKey: ['menu', outletId],
    queryFn: async () => {
      const menu = await api<MenuDTO>(`/menu?outlet_id=${outletId}`);
      if (store) void moved.then(() => set(outletId, menu, store));
      return menu;
    },
    placeholderData: cached,
  });
  return { ...query, data: query.data ?? cached };
}

/** What this outlet sold most lately, best first: search and the POS show these first. */
export function usePopular(): string[] {
  const { api, outletId } = useStaff();
  const { data } = useQuery({
    queryKey: ['menu-popular', outletId],
    queryFn: () => api<{ item_ids: string[] }>(`/menu/popular?outlet_id=${outletId}`).then((r) => r.item_ids),
    staleTime: 10 * 60_000,
  });
  return data ?? [];
}

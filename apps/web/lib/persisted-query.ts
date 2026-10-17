'use client';

import { useQuery, type QueryKey } from '@tanstack/react-query';
import { createStore, get, set } from 'idb-keyval';
import { useEffect, useState } from 'react';
import { moveLegacyStore } from './legacy-names';

const store = typeof indexedDB !== 'undefined' ? createStore('mezmitra-queries', 'snapshots') : null;
// Snapshots saved under the product's earlier name come along before the cache is used.
const moved = moveLegacyStore('dineos-queries', 'snapshots', store);

/**
 * A query whose last good result is kept in IndexedDB (spec §2: POS and KDS cache open orders).
 * After a reload during an internet drop the screen shows the last known data, marked `stale`,
 * instead of an empty page.
 */
export function usePersistedQuery<T>(
  key: QueryKey,
  fn: () => Promise<T>,
  opts: { enabled?: boolean; refetchInterval?: number } = {},
) {
  const storeKey = JSON.stringify(key);
  const [snapshot, setSnapshot] = useState<{ data: T; savedAt: number } | undefined>(undefined);

  useEffect(() => {
    setSnapshot(undefined);
    if (store) void moved.then(() => get<{ data: T; savedAt: number }>(storeKey, store)).then((v) => v && setSnapshot(v));
  }, [storeKey]);

  const query = useQuery({
    queryKey: key,
    enabled: opts.enabled,
    refetchInterval: opts.refetchInterval,
    queryFn: async () => {
      const data = await fn();
      if (store) void moved.then(() => set(storeKey, { data, savedAt: Date.now() }, store));
      return data;
    },
  });

  const fresh = query.data !== undefined;
  return {
    ...query,
    data: fresh ? query.data : snapshot?.data,
    /** True when showing data saved on this device because the server could not be reached. */
    stale: !fresh && !!snapshot,
    savedAt: snapshot?.savedAt ?? null,
    isLoading: query.isLoading && !snapshot,
  };
}

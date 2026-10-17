'use client';

// The product was called DineOS. Browsers that used it keep their settings under dineos.* (local
// storage) and their offline work in dineos-* IndexedDB stores. Both move to the Mezmitra names
// once, before they are read, so nobody is signed out and nothing queued offline is lost.

import { clear, createStore, entries, setMany, type UseStore } from 'idb-keyval';

/**
 * dineos.x becomes mezmitra.x. An old key wins over a new one: only code from before the rename
 * writes it (an outlet hub not yet updated, signing staff in during an outage), so it is newer.
 */
export function moveLegacyLocalStorage(): void {
  try {
    const ls = window.localStorage;
    const old: string[] = [];
    for (let i = 0; i < ls.length; i++) {
      const k = ls.key(i);
      if (k?.startsWith('dineos.')) old.push(k);
    }
    for (const k of old) {
      const v = ls.getItem(k);
      if (v !== null) ls.setItem(`mezmitra.${k.slice('dineos.'.length)}`, v);
      ls.removeItem(k);
    }
  } catch {
    // Storage blocked (private mode): nothing was saved under the old names either.
  }
}

/** Copies an IndexedDB store kept under its old name into its new one, then empties and drops the old. */
export async function moveLegacyStore(oldDb: string, storeName: string, target: UseStore | null): Promise<void> {
  if (!target || typeof indexedDB === 'undefined') return;
  try {
    if (typeof indexedDB.databases === 'function' && !(await indexedDB.databases()).some((d) => d.name === oldDb)) return;
    const old = createStore(oldDb, storeName);
    const rows = await entries(old);
    if (rows.length) await setMany(rows, target);
    // Emptied first, so a deletion that waits for this page to close can never copy twice.
    await clear(old);
    indexedDB.deleteDatabase(oldDb);
  } catch {
    // A move that fails leaves the old data where it was; the next page load tries again.
  }
}

if (typeof window !== 'undefined') moveLegacyLocalStorage();

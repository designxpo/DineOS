'use client';

import { useQueryClient } from '@tanstack/react-query';
import { usePathname } from 'next/navigation';
import { useEffect, useRef } from 'react';
import type { ScreenKind } from '@dineos/shared/dto';
import { onHub } from './api';
import { useOutletEvents } from './realtime';
import { useStaff } from './staff';

const KEY = 'dineos.screen.id';
const EVERY_MS = 30_000;

/** This browser's screen id, kept so it stays the same screen (and name) across reloads. */
function screenId(): string {
  try {
    let id = localStorage.getItem(KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(KEY, id);
    }
    return id;
  } catch {
    return crypto.randomUUID();
  }
}

function kindFor(path: string): ScreenKind {
  if (path.startsWith('/app/kds')) return 'kitchen';
  if (path.startsWith('/app/pos')) return 'till';
  if (path.startsWith('/app/floor')) return 'floor';
  if (path.startsWith('/app/inbox')) return 'orders';
  if (path.startsWith('/app/bills')) return 'bills';
  return 'other';
}

/**
 * Checks this screen in every half minute with the menu and settings version it is running, so the
 * owner can see every screen has a change. A screen that hears of a change, or finds out at check
 * in that it missed one, refreshes everything first and then reports the new version. The office
 * can reload it.
 */
export function useScreenCheckIn(): void {
  const { api, outletId } = useStaff();
  const qc = useQueryClient();
  const kind = kindFor(usePathname());
  const live = useRef({ api, kind });
  live.current = { api, kind };
  const id = useRef<string | null>(null);
  const applied = useRef<number | null>(null);

  const beat = useRef(async (outlet: string, depth = 0): Promise<void> => {
    if (onHub()) return;
    id.current ??= screenId();
    try {
      const r = await live.current.api<{ config_version: number; reload: boolean }>('/screens/heartbeat', {
        method: 'POST',
        body: { outlet_id: outlet, screen_id: id.current, kind: live.current.kind, applied_version: applied.current },
      });
      if (r.reload) return window.location.reload();
      if (applied.current !== null && applied.current >= r.config_version) return;
      // A page that just opened already has fresh data; one that was open refetches first.
      if (applied.current !== null) await qc.invalidateQueries();
      applied.current = r.config_version;
      if (depth < 1) await beat.current(outlet, depth + 1);
    } catch {
      // Offline or signed out: the next check-in tries again.
    }
  });

  useEffect(() => {
    applied.current = null;
    void beat.current(outletId);
    const timer = setInterval(() => void beat.current(outletId), EVERY_MS);
    return () => clearInterval(timer);
  }, [outletId]);

  // Moving between screens changes what this one is used for.
  useEffect(() => {
    if (applied.current !== null) void beat.current(outletId);
  }, [kind, outletId]);

  useOutletEvents((e) => {
    if (e.type === 'config.changed') {
      const version = (e.payload as { config_version: number }).config_version;
      void qc.invalidateQueries().then(() => {
        applied.current = Math.max(applied.current ?? 0, version);
        void beat.current(outletId, 1);
      });
    }
    if (e.type === 'screen.reload' && (e.payload as { screen_id: string }).screen_id === id.current) window.location.reload();
  });
}

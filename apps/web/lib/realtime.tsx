'use client';

import { useQueryClient, type QueryKey } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import type { EventType, OutletEvent } from '@dineos/shared/events';
import { API_URL, apiFetch } from './api';
import { flush } from './outbox';

export type ConnectionState = 'connecting' | 'online' | 'offline';
type Handler = (event: OutletEvent) => void;

interface RealtimeCtx {
  state: ConnectionState;
  subscribe: (fn: Handler) => () => void;
}

const Ctx = createContext<RealtimeCtx | null>(null);

/** Which cached screens each event makes stale. */
const INVALIDATES: Partial<Record<EventType, string[]>> = {
  'order.placed': ['orders', 'kds', 'tables', 'dashboard', 'session-orders'],
  'order.status_changed': ['orders', 'kds', 'tables', 'dashboard', 'session-orders'],
  'order.updated': ['orders', 'kds', 'tables', 'session-orders'],
  'table.state_changed': ['tables'],
  'tables.updated': ['tables'],
  'waiter.called': ['service-requests', 'tables'],
  'bill.requested': ['service-requests', 'tables'],
  'service_request.updated': ['service-requests', 'tables'],
  'bill.updated': ['bills', 'bill', 'tables', 'dashboard'],
  'menu.updated': ['menu'],
  'item.stock_changed': ['menu'],
};

const LATEST = 2_147_483_647;

/**
 * One staff socket per device. Events carry a per-outlet sequence; a gap (or a reconnect) triggers
 * a replay from GET /v1/events so no screen misses an order (spec §9).
 */
export function RealtimeProvider({ token, outletId, children }: { token: string; outletId: string; children: React.ReactNode }) {
  const qc = useQueryClient();
  const [state, setState] = useState<ConnectionState>('connecting');
  const handlers = useRef(new Set<Handler>());
  const lastSeq = useRef<number | null>(null);
  const catchingUp = useRef(false);

  useEffect(() => {
    lastSeq.current = null;
    const socket: Socket = io(`${API_URL}/staff`, { auth: { token }, transports: ['websocket', 'polling'], reconnectionDelayMax: 5000 });

    const deliver = (e: OutletEvent) => {
      if (lastSeq.current !== null && e.seq <= lastSeq.current) return; // duplicate
      lastSeq.current = e.seq;
      for (const prefix of INVALIDATES[e.type] ?? []) {
        void qc.invalidateQueries({ predicate: (q) => keyStarts(q.queryKey, prefix) });
      }
      for (const h of handlers.current) h(e);
    };

    const catchUp = async () => {
      if (catchingUp.current) return;
      catchingUp.current = true;
      try {
        const since = lastSeq.current ?? LATEST;
        const res = await apiFetch<{ events: OutletEvent[]; last_seq: number; truncated: boolean }>(
          `/events?outlet_id=${outletId}&since=${since}`,
          { token },
        );
        if (lastSeq.current === null || res.truncated) {
          // First connect or too far behind: refetch everything instead of replaying.
          if (lastSeq.current !== null) void qc.invalidateQueries();
          lastSeq.current = res.last_seq;
        } else {
          for (const e of res.events) deliver(e);
        }
      } catch {
        // retried on the next reconnect
      } finally {
        catchingUp.current = false;
      }
    };

    socket.on('connect', () => {
      setState('online');
      void catchUp();
      void flush(token).then((r) => {
        if (r.sent) void qc.invalidateQueries();
      });
    });
    socket.on('disconnect', () => setState('offline'));
    socket.on('connect_error', () => setState('offline'));
    socket.on('event', (e: OutletEvent) => {
      if (e.outlet_id !== outletId) return;
      if (lastSeq.current !== null && e.seq > lastSeq.current + 1) {
        void catchUp();
        return;
      }
      deliver(e);
    });

    const online = () => void flush(token);
    window.addEventListener('online', online);
    return () => {
      window.removeEventListener('online', online);
      socket.close();
    };
  }, [token, outletId, qc]);

  const subscribe = useCallback((fn: Handler) => {
    handlers.current.add(fn);
    return () => {
      handlers.current.delete(fn);
    };
  }, []);
  const value = useMemo<RealtimeCtx>(() => ({ state, subscribe }), [state, subscribe]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

function keyStarts(key: QueryKey, prefix: string): boolean {
  return Array.isArray(key) && key[0] === prefix;
}

export function useConnection(): ConnectionState {
  return useContext(Ctx)?.state ?? 'offline';
}

/** Runs `handler` for each live outlet event (after the cache has been invalidated). */
export function useOutletEvents(handler: Handler): void {
  const ctx = useContext(Ctx);
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => ctx?.subscribe((e) => ref.current(e)), [ctx]);
}

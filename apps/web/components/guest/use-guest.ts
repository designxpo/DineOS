'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import type { CartDTO, GuestContextDTO, GuestJoinResponseDTO, GuestOrderDTO, GuestSessionDTO, MenuDTO, ServiceRequestDTO } from '@dineos/shared/dto';
import type { OutletEvent } from '@dineos/shared/events';
import { API_URL, ApiError, apiFetch, newKey } from '@/lib/api';
import { readLocal, writeLocal } from '@/lib/storage';

export type GuestPhase = 'loading' | 'invalid' | 'unavailable' | 'ready' | 'ended';

function deviceId(): string {
  let id = readLocal<string | null>('dineos.device', null);
  if (!id) {
    id = crypto.randomUUID();
    writeLocal('dineos.device', id);
  }
  return id;
}

const tokenKey = (qr: string) => `dineos.guest.${qr.slice(-24)}`;

export function useGuest(qr: string) {
  const qc = useQueryClient();
  const [phase, setPhase] = useState<GuestPhase>('loading');
  const [context, setContext] = useState<GuestContextDTO | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [online, setOnline] = useState(true);
  const menuVersion = useRef<number | null>(null);

  const join = useCallback(async () => {
    const res = await apiFetch<GuestJoinResponseDTO>('/guest/join', { method: 'POST', body: { qr_token: qr, device_id: deviceId() } });
    writeLocal(tokenKey(qr), res.guest_token);
    setToken(res.guest_token);
    return res.guest_token;
  }, [qr]);

  // 1. Who and where (before creating any session), then attach to the table's session.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const ctx = await apiFetch<GuestContextDTO>(`/guest/resolve?qr=${encodeURIComponent(qr)}`);
        if (cancelled) return;
        setContext(ctx);
        const saved = readLocal<string | null>(tokenKey(qr), null);
        if (saved) setToken(saved);
        else await join();
        if (!cancelled) setPhase('ready');
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.code === 'invalid_qr') setPhase('invalid');
        else if (err instanceof ApiError && err.status === 403) setPhase('unavailable');
        else setPhase('invalid');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [qr, join]);

  // 2. The table's session: cart, orders, bill.
  const firstLoad = useRef(true);
  const session = useQuery({
    queryKey: ['guest-session', token],
    enabled: !!token && phase === 'ready',
    queryFn: async () => {
      try {
        const s = await apiFetch<GuestSessionDTO>('/guest/session', { token });
        firstLoad.current = false;
        return s;
      } catch (err) {
        // A token from an earlier visit: start a fresh visit silently on first load.
        if (err instanceof ApiError && (err.status === 410 || err.status === 401) && firstLoad.current) {
          firstLoad.current = false;
          const fresh = await join();
          return apiFetch<GuestSessionDTO>('/guest/session', { token: fresh });
        }
        if (err instanceof ApiError && err.status === 410) setPhase('ended');
        throw err;
      }
    },
    retry: (n, err) => !(err instanceof ApiError && err.status < 500) && n < 3,
  });

  // 3. The menu, from a cacheable versioned URL.
  const menuPath = context?.outlet.menu_path;
  const menu = useQuery({
    queryKey: ['guest-menu', menuPath],
    enabled: !!menuPath,
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000, // breakfast and other timed categories open and close
    queryFn: async () => {
      const v = menuVersion.current;
      const m = await apiFetch<MenuDTO>(`${menuPath}${v ? `?v=${v}` : ''}`);
      menuVersion.current = m.menu_version;
      return m;
    },
  });

  // 4. Live updates for this table's session.
  useEffect(() => {
    if (!token || phase !== 'ready') return;
    const socket = io(`${API_URL}/guest`, { auth: { token }, transports: ['websocket'], reconnectionDelayMax: 5000 });
    let wasOffline = false;
    socket.on('connect', () => {
      setOnline(true);
      if (wasOffline) void qc.invalidateQueries({ queryKey: ['guest-session'] });
      wasOffline = false;
    });
    socket.on('disconnect', () => {
      wasOffline = true;
      setOnline(false);
    });
    socket.on('connect_error', () => {
      wasOffline = true;
      setOnline(false);
    });
    socket.on('event', (e: OutletEvent) => {
      switch (e.type) {
        case 'cart.updated':
          qc.setQueryData<GuestSessionDTO>(['guest-session', token], (s) => (s ? { ...s, cart: e.payload as CartDTO } : s));
          break;
        case 'order.placed':
        case 'order.status_changed':
        case 'order.updated': {
          const order = (e.payload as { order: GuestOrderDTO }).order;
          qc.setQueryData<GuestSessionDTO>(['guest-session', token], (s) => {
            if (!s) return s;
            const exists = s.orders.some((o) => o.id === order.id);
            return { ...s, orders: exists ? s.orders.map((o) => (o.id === order.id ? order : o)) : [...s.orders, order] };
          });
          break;
        }
        case 'bill.updated':
          void qc.invalidateQueries({ queryKey: ['guest-session'] });
          break;
        case 'item.stock_changed': {
          const { item_id, in_stock } = e.payload as { item_id: string; in_stock: boolean };
          qc.setQueryData<MenuDTO>(['guest-menu', menuPath], (m) => (m ? { ...m, items: m.items.map((i) => (i.id === item_id ? { ...i, in_stock } : i)) } : m));
          break;
        }
        case 'menu.updated':
          menuVersion.current = (e.payload as { menu_version: number }).menu_version;
          void qc.invalidateQueries({ queryKey: ['guest-menu'] });
          break;
        case 'session.closed':
          setPhase('ended');
          socket.close();
          break;
      }
    });
    return () => {
      socket.close();
    };
  }, [token, phase, qc, menuPath]);

  const setCart = (cart: CartDTO) => qc.setQueryData<GuestSessionDTO>(['guest-session', token], (s) => (s ? { ...s, cart } : s));

  const handleGone = (err: unknown) => {
    if (err instanceof ApiError && err.status === 410) setPhase('ended');
  };

  const addLine = useMutation({
    mutationFn: (line: { item_id: string; qty: number; modifier_ids: string[]; note?: string | null }) =>
      apiFetch<CartDTO>('/guest/cart/lines', { method: 'POST', body: line, token }),
    onSuccess: setCart,
    onError: handleGone,
  });

  const updateLine = useMutation({
    mutationFn: ({ lineId, qty }: { lineId: string; qty: number }) =>
      apiFetch<CartDTO>(`/guest/cart/lines/${lineId}`, { method: 'PATCH', body: { qty }, token }),
    onSuccess: setCart,
    onError: handleGone,
  });

  const placeOrder = useMutation({
    mutationFn: (note: string | null) =>
      apiFetch<{ order: GuestOrderDTO; cart: CartDTO }>('/guest/orders', { method: 'POST', body: { note }, token, idempotencyKey: newKey() }),
    onSuccess: ({ order, cart }) => {
      qc.setQueryData<GuestSessionDTO>(['guest-session', token], (s) =>
        s ? { ...s, cart, orders: s.orders.some((o) => o.id === order.id) ? s.orders : [...s.orders, order], session: { ...s.session, status: 'open' } } : s,
      );
    },
    onError: (err) => {
      handleGone(err);
      if (err instanceof ApiError && err.code === 'items_unavailable') void qc.invalidateQueries({ queryKey: ['guest-menu'] });
    },
  });

  const callWaiter = useMutation({
    mutationFn: () => apiFetch<ServiceRequestDTO>('/guest/call-waiter', { method: 'POST', token }),
    onError: handleGone,
  });

  const requestBill = useMutation({
    mutationFn: () => apiFetch<ServiceRequestDTO>('/guest/request-bill', { method: 'POST', token }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['guest-session'] }),
    onError: handleGone,
  });

  const joinLoyalty = useMutation({
    mutationFn: (body: { phone: string; name: string | null; marketing_opt_in: boolean }) =>
      apiFetch<{ phone_last4: string }>('/guest/loyalty', { method: 'POST', token, body: { ...body, consent: true } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['guest-session'] }),
    onError: handleGone,
  });

  const startOver = useCallback(async () => {
    writeLocal(tokenKey(qr), null);
    firstLoad.current = true;
    setPhase('loading');
    try {
      await join();
      setPhase('ready');
    } catch {
      setPhase('invalid');
    }
  }, [qr, join]);

  return {
    phase,
    context,
    session: session.data,
    sessionError: session.error,
    menu: menu.data,
    menuLoading: menu.isLoading,
    menuError: menu.isError,
    retryMenu: () => void menu.refetch(),
    online,
    deviceId: typeof window === 'undefined' ? '' : deviceId(),
    addLine,
    updateLine,
    placeOrder,
    callWaiter,
    requestBill,
    joinLoyalty,
    startOver,
  };
}

export type GuestApi = ReturnType<typeof useGuest>;

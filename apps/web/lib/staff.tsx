'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { LoginResponseDTO, MeDTO, OutletDTO } from '@mezmitra/shared/dto';
import type { Role } from '@mezmitra/shared/enums';
import { rolesCan, type Action } from '@mezmitra/shared/permissions';
import { turnOffPush } from '@/lib/push-alerts';
import { ApiError, apiFetch, type RequestOptions } from './api';
import { readLocal, writeLocal } from './storage';

const TOKEN_KEY = 'mezmitra.staff.token';
const OUTLET_KEY = 'mezmitra.staff.outlet';

export function saveStaffLogin(res: LoginResponseDTO): void {
  writeLocal(TOKEN_KEY, res.token);
}

export function readStaffToken(): string | null {
  return readLocal<string | null>(TOKEN_KEY, null);
}

interface StaffCtx {
  token: string;
  me: MeDTO;
  outletId: string;
  outlet: OutletDTO | undefined;
  roles: Role[];
  setOutletId: (id: string) => void;
  can: (action: Action) => boolean;
  api: <T>(path: string, opts?: Omit<RequestOptions, 'token'>) => Promise<T>;
  logout: () => Promise<void>;
}

const Ctx = createContext<StaffCtx | null>(null);

export function StaffProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const qc = useQueryClient();
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [outletId, setOutletIdState] = useState<string | null>(null);

  useEffect(() => {
    const t = readStaffToken();
    if (!t) router.replace('/login');
    setToken(t);
    setOutletIdState(readLocal<string | null>(OUTLET_KEY, null));
  }, [router]);

  const signOut = useCallback(() => {
    writeLocal(TOKEN_KEY, null);
    qc.clear();
    router.replace('/login');
  }, [qc, router]);

  const me = useQuery({
    queryKey: ['me', token],
    enabled: !!token,
    queryFn: () => apiFetch<MeDTO>('/auth/me', { token }),
    retry: (n, err) => !(err instanceof ApiError && (err.status === 401 || err.status === 403)) && n < 2,
  });

  useEffect(() => {
    if (me.error instanceof ApiError && (me.error.status === 401 || me.error.status === 403)) signOut();
  }, [me.error, signOut]);

  const effectiveOutlet = me.data ? (me.data.outlets.find((o) => o.id === outletId)?.id ?? me.data.outlets[0]?.id ?? null) : null;

  const outlet = useQuery({
    queryKey: ['outlet', effectiveOutlet],
    enabled: !!token && !!effectiveOutlet,
    queryFn: () => apiFetch<OutletDTO>(`/outlets/${effectiveOutlet}`, { token }),
    staleTime: 60_000,
  });

  const value = useMemo<StaffCtx | null>(() => {
    if (!token || !me.data || !effectiveOutlet) return null;
    const roles = me.data.outlets.find((o) => o.id === effectiveOutlet)?.roles ?? [];
    return {
      token,
      me: me.data,
      outletId: effectiveOutlet,
      outlet: outlet.data,
      roles,
      setOutletId: (id) => {
        writeLocal(OUTLET_KEY, id);
        setOutletIdState(id);
      },
      can: (action) => rolesCan(roles, action),
      api: async <T,>(path: string, opts: Omit<RequestOptions, 'token'> = {}) => {
        try {
          return await apiFetch<T>(path, { ...opts, token });
        } catch (err) {
          if (err instanceof ApiError && err.status === 401) signOut();
          throw err;
        }
      },
      logout: async () => {
        // The next person on this phone must not get this account's alerts.
        await turnOffPush((path, opts) => apiFetch(path, { ...opts, token })).catch(() => {});
        await apiFetch('/auth/logout', { method: 'POST', token }).catch(() => {});
        signOut();
      },
    };
  }, [token, me.data, effectiveOutlet, outlet.data, signOut]);

  if (token === undefined || (token && me.isLoading)) return <FullScreenLoader />;
  if (me.data && me.data.outlets.length === 0) {
    return (
      <div className="grid min-h-dvh place-items-center p-6 text-center">
        <div>
          <p className="font-medium">Your account has no outlet yet.</p>
          <button className="mt-3 text-sm text-brand-700 underline" onClick={signOut}>
            Sign out
          </button>
        </div>
      </div>
    );
  }
  if (!value) return <FullScreenLoader />;
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useStaff(): StaffCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useStaff outside StaffProvider');
  return ctx;
}

export function FullScreenLoader() {
  return (
    <div className="grid min-h-dvh place-items-center" role="status" aria-label="Loading">
      <div className="size-8 animate-spin rounded-full border-2 border-line border-t-brand-600" />
    </div>
  );
}

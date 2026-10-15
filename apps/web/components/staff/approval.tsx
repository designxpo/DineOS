'use client';

import { ShieldCheck } from 'lucide-react';
import { createContext, useCallback, useContext, useRef, useState } from 'react';
import type { ApprovalAction } from '@dineos/shared/permissions';
import { ApiError, errorMessage } from '@/lib/api';
import { useStaff } from '@/lib/staff';
import { Button } from '@/components/ui/button';
import { Sheet } from '@/components/ui/overlay';
import { Field, Input } from '@/components/ui/primitives';

const LABELS: Record<ApprovalAction, string> = {
  'bill.void': 'void this bill',
  'payment.refund': 'refund this payment',
  'order.cancel_after_accept': 'cancel food the kitchen already has',
  'bill.discount_large': 'give a discount above 10%',
};

type Request = { action: ApprovalAction; resolve: (token: string | null) => void };
const Ctx = createContext<(action: ApprovalAction) => Promise<string | null>>(async () => null);

/**
 * Manager override (spec §8): when the server says `approval_required`, a manager types their
 * login and PIN on this device and the request is retried with a single-use approval token.
 */
export function ApprovalProvider({ children }: { children: React.ReactNode }) {
  const { api, outletId } = useStaff();
  const [request, setRequest] = useState<Request | null>(null);
  const [login, setLogin] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const ask = useCallback((action: ApprovalAction) => new Promise<string | null>((resolve) => setRequest({ action, resolve })), []);

  const close = (token: string | null) => {
    request?.resolve(token);
    setRequest(null);
    setPin('');
    setError(null);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!request) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ approval_token: string }>('/approvals', { method: 'POST', body: { outlet_id: outletId, action: request.action, login, pin } });
      close(res.approval_token);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Ctx.Provider value={ask}>
      {children}
      <Sheet open={!!request} onClose={() => close(null)} title="Manager approval">
        <form onSubmit={submit} className="space-y-4">
          <div className="flex items-start gap-3 rounded-2xl bg-amber-50 p-3 text-sm text-amber-900">
            <ShieldCheck className="mt-0.5 size-5 shrink-0" />
            <p>A manager needs to approve before you can {request ? LABELS[request.action] : ''}. This is recorded in the audit log.</p>
          </div>
          <Field label="Manager email or phone">{(id) => <Input id={id} value={login} onChange={(e) => setLogin(e.target.value)} autoComplete="off" required data-autofocus />}</Field>
          <Field label="Manager PIN">
            {(id) => <Input id={id} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} inputMode="numeric" type="password" maxLength={6} required autoComplete="off" />}
          </Field>
          {error && <p className="text-sm text-rose-700">{error}</p>}
          <Button type="submit" block size="lg" loading={busy}>
            Approve
          </Button>
        </form>
      </Sheet>
    </Ctx.Provider>
  );
}

/**
 * Runs `fn`; if the server needs a manager, asks for one and retries once with their approval.
 * Returns undefined if the manager prompt was dismissed.
 */
export function useWithApproval() {
  const ask = useContext(Ctx);
  const askRef = useRef(ask);
  askRef.current = ask;
  return useCallback(async <T,>(fn: (approvalToken: string | null) => Promise<T>): Promise<T | undefined> => {
    try {
      return await fn(null);
    } catch (err) {
      if (!(err instanceof ApiError && err.code === 'approval_required')) throw err;
      const action = (err.details as { action?: ApprovalAction })?.action;
      if (!action) throw err;
      const token = await askRef.current(action);
      if (!token) return undefined;
      return fn(token);
    }
  }, []);
}

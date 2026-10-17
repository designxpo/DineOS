'use client';

import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { rolesCan } from '@mezmitra/shared/permissions';
import { errorMessage } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { pushState, turnOffPush, turnOnPush, type PushState } from '@/lib/push-alerts';
import { useStaff } from '@/lib/staff';
import { Button } from '@/components/ui/button';
import { Card, Field, Input, Segmented, Switch } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/toast';
import { PageHeader } from '@/components/staff/shell';

export default function AccountPage() {
  const { me, roles, api } = useStaff();
  const { lang, setLang } = useI18n();
  const toast = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [password, setPassword] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const approver = rolesCan(roles, 'bill.void');

  const changePassword = async () => {
    if (next !== confirm) return toast('The new passwords do not match', 'error');
    setBusy('password');
    try {
      await api('/auth/password', { method: 'POST', body: { current_password: current, new_password: next } });
      toast('Password changed. Other devices have been signed out.');
      setCurrent('');
      setNext('');
      setConfirm('');
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy(null);
    }
  };

  const savePin = async () => {
    setBusy('pin');
    try {
      await api('/auth/pin', { method: 'POST', body: { password, pin } });
      toast('PIN saved');
      setPassword('');
      setPin('');
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="pb-12">
      <PageHeader title="My account" subtitle={`${me.user.name} · ${me.user.email ?? me.user.phone ?? ''}`} />
      <div className="grid max-w-4xl gap-4 px-4 lg:grid-cols-2 lg:px-8">
        <Card className="space-y-4 p-5">
          <h2 className="font-semibold">Change password</h2>
          <Field label="Current password">{(id) => <Input id={id} type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />}</Field>
          <Field label="New password" hint="At least 8 characters">{(id) => <Input id={id} type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />}</Field>
          <Field label="New password again">{(id) => <Input id={id} type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />}</Field>
          <Button onClick={() => void changePassword()} disabled={!current || next.length < 8} loading={busy === 'password'}>
            Change password
          </Button>
        </Card>
        <div className="space-y-4">
          <PhoneAlerts />
          <Card className="space-y-3 p-5">
            <h2 className="font-semibold">Language</h2>
            <Segmented value={lang} onChange={setLang} options={[{ value: 'en', label: 'English' }, { value: 'hi', label: 'हिंदी' }]} />
          </Card>
          {approver && (
            <Card className="space-y-4 p-5">
              <div>
                <h2 className="font-semibold">Approval PIN</h2>
                <p className="mt-1 text-sm text-ink-soft">You type this on a cashier&apos;s screen to approve voids, refunds, large discounts and cancellations.</p>
              </div>
              <Field label="Your password">{(id) => <Input id={id} type="password" value={password} onChange={(e) => setPassword(e.target.value)} />}</Field>
              <Field label="New PIN (4 to 6 digits)">{(id) => <Input id={id} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} inputMode="numeric" maxLength={6} type="password" />}</Field>
              <Button onClick={() => void savePin()} disabled={pin.length < 4 || !password} loading={busy === 'pin'}>
                Save PIN
              </Button>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

/** Turns push alerts on or off for this device. Hidden until the server has push keys. */
function PhoneAlerts() {
  const { api, outletId, outlet } = useStaff();
  const toast = useToast();
  const config = useQuery({ queryKey: ['push-config'], queryFn: () => api<{ public_key: string }>('/push/config'), retry: false });
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void pushState().then(setState);
  }, []);
  if (!config.data || !state || state === 'unsupported') return null;

  const toggle = async (on: boolean) => {
    setBusy(true);
    try {
      if (on) await turnOnPush(api, outletId);
      else await turnOffPush(api);
      setState(await pushState());
      toast(on ? 'Alerts are on for this phone' : 'Alerts are off for this phone');
    } catch (err) {
      toast(err instanceof Error ? err.message : errorMessage(err), 'error');
      setState(await pushState());
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="space-y-3 p-5">
      <div>
        <h2 className="font-semibold">Alerts on this phone</h2>
        <p className="mt-1 text-sm text-ink-soft">A buzz for new orders to accept, waiter calls and bill requests at {outlet?.name ?? 'this outlet'}, even when Mezmitra is closed.</p>
      </div>
      {state === 'needs_install' && <p className="text-sm text-amber-800">On iPhone, tap Share, then “Add to Home Screen”. Open Mezmitra from the Home Screen and turn alerts on there.</p>}
      {state === 'blocked' && <p className="text-sm text-amber-800">Notifications are blocked for Mezmitra. Allow them in your browser’s site settings, then come back.</p>}
      {(state === 'on' || state === 'off') && <Switch label="Alerts on this phone" checked={state === 'on'} disabled={busy} onChange={(v) => void toggle(v)} />}
    </Card>
  );
}

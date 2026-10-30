'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, RefreshCw } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { clockMinutes, ONLINE_BOOKING_DEFAULTS, WEEKDAYS, type OnlineBooking, type OpeningHours, type Weekday } from '@mezmitra/shared/booking';
import type { TalkoLinkDTO } from '@mezmitra/shared/dto';
import { errorMessage } from '@/lib/api';
import { ago } from '@/lib/format';
import { useStaff } from '@/lib/staff';
import { Button } from '@/components/ui/button';
import { Badge, Card, Field, Input, Select, Spinner, Switch } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/toast';
import { useSaveOutlet } from '@/components/staff/use-save-outlet';

// Settings → Talko AI: the link to Talko AI (WhatsApp, Instagram, Messenger and web chat), the
// opening hours and rules for tables booked in a chat, and the review link sent after a bill.

const EVENT_LABEL: Record<string, string> = {
  'mezmitra.bill.paid': 'Bill paid',
  'mezmitra.reservation.created': 'Table booked',
  'mezmitra.reservation.cancelled': 'Booking cancelled',
  'mezmitra.reservation.reminder': 'Booking reminder',
  'mezmitra.order.ready': 'Order ready',
};
const STATUS_TONE = { sent: 'green', pending: 'amber', dead: 'rose', skipped: 'neutral' } as const;
const STATUS_LABEL = { sent: 'Sent', pending: 'Waiting', dead: 'Failed', skipped: 'Not sent' } as const;
const DAY_LABEL: Record<Weekday, string> = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };

export function TalkoSettings() {
  const { me } = useStaff();
  const owner = me.tenant_roles.includes('owner');
  return (
    <div className="space-y-4">
      {owner ? <TalkoLink /> : <Card className="p-5 text-sm text-ink-soft">Only the owner can connect Talko AI.</Card>}
      <ChatBooking />
      <ReviewLink />
    </div>
  );
}

function TalkoLink() {
  const { api } = useStaff();
  const qc = useQueryClient();
  const toast = useToast();
  const [key, setKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const { data, isLoading } = useQuery({
    queryKey: ['talko-link'],
    queryFn: () => api<TalkoLinkDTO>('/integrations/talko'),
    refetchInterval: (q) => (q.state.data?.status === 'pending' ? 5_000 : 30_000),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['talko-link'] });

  async function run(fn: () => Promise<unknown>, done?: string) {
    setBusy(true);
    try {
      await fn();
      if (done) toast(done);
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy(false);
      await refresh();
    }
  }

  if (isLoading || !data) return <Spinner />;
  const connect = () =>
    run(async () => {
      const res = await api<{ key: string }>('/integrations/talko', { method: 'POST' });
      setKey(res.key);
      setCopied(false);
    });
  const disconnect = () => {
    if (!window.confirm('Disconnect Talko AI? Chats stop booking tables and no more messages go out for bills or bookings.')) return;
    void run(async () => {
      await api('/integrations/talko', { method: 'DELETE' });
      setKey(null);
    }, 'Disconnected');
  };
  const test = () =>
    run(async () => {
      const r = await api<{ ok: boolean; error?: string }>('/integrations/talko/test', { method: 'POST' });
      toast(r.ok ? 'Talko AI answered: the link works' : (r.error ?? 'Talko AI did not answer'), r.ok ? undefined : 'error');
    });

  return (
    <Card className="space-y-4 p-5">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-semibold">Talko AI</h2>
        <Badge tone={data.status === 'active' ? 'green' : data.status === 'pending' ? 'amber' : 'neutral'}>
          {data.status === 'active' ? `Connected${data.peer_account ? ` to ${data.peer_account}` : ''}` : data.status === 'pending' ? 'Waiting for Talko AI' : 'Not connected'}
        </Badge>
      </div>
      <p className="text-sm text-ink-soft">
        Guests ask about the menu and book tables on WhatsApp, Instagram, Messenger or your website chat, answered from this menu and
        these tables. Guests get WhatsApp messages when their bill is paid, their table is booked and their takeaway is ready.
      </p>

      {!data.plan_allows ? (
        <p className="rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-950">
          Your plan does not include Talko AI.{' '}
          <Link href="/app/plan" className="font-medium underline">
            See plans
          </Link>{' '}
          to upgrade.
        </p>
      ) : !data.configured ? (
        <p className="rounded-xl bg-stone-100 px-3 py-2 text-sm text-ink-soft">Talko AI is not set up on this server yet. Ask Mezvaan support to turn it on.</p>
      ) : null}

      {key && (
        <div className="space-y-2 rounded-xl border border-brand-200 bg-brand-50 p-4">
          <p className="text-sm font-medium">Paste this key in Talko AI: Integrations → Mezvaan. It is shown only now, works once and stops working after a day.</p>
          <div className="flex gap-2">
            <Input readOnly value={key} className="font-mono text-sm" aria-label="Link key" onFocus={(e) => e.currentTarget.select()} />
            <Button
              variant="outline"
              onClick={() => {
                void navigator.clipboard.writeText(key).then(() => setCopied(true));
              }}
            >
              {copied ? <Check className="size-4" /> : <Copy className="size-4" />} {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
        </div>
      )}

      {data.last_error && <p className="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-800">{data.last_error}</p>}

      <div className="flex flex-wrap gap-2">
        {data.status === 'none' && (
          <Button onClick={() => void connect()} loading={busy} disabled={!data.plan_allows || !data.configured}>
            Connect Talko AI
          </Button>
        )}
        {data.status === 'pending' && (
          <Button variant="outline" onClick={() => void connect()} loading={busy}>
            Make a new key
          </Button>
        )}
        {data.status === 'active' && (
          <Button variant="outline" onClick={() => void test()} loading={busy}>
            Test connection
          </Button>
        )}
        {data.status !== 'none' && (
          <Button variant="ghost" onClick={disconnect} disabled={busy}>
            Disconnect
          </Button>
        )}
      </div>

      {data.status === 'active' && (
        <div className="space-y-2 border-t border-line pt-4">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
            <span>{data.counts.sent_today} sent today</span>
            {data.counts.pending > 0 && <span className="text-amber-800">{data.counts.pending} waiting</span>}
            {data.counts.dead > 0 && <span className="text-rose-700">{data.counts.dead} failed this week</span>}
            {data.last_used_at && <span className="text-ink-faint">Talko AI last checked in {ago(data.last_used_at)}</span>}
            {data.counts.dead > 0 && (
              <Button size="sm" variant="outline" onClick={() => void run(() => api('/integrations/talko/retry', { method: 'POST' }), 'Sent again')} disabled={busy}>
                <RefreshCw className="size-3.5" /> Send failed ones again
              </Button>
            )}
          </div>
          {data.recent.length > 0 && (
            <ul className="divide-y divide-line text-sm">
              {data.recent.map((d) => (
                <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span>
                    {EVENT_LABEL[d.event] ?? d.event} · guest ending {d.phone_tail}
                    {d.last_error && d.status !== 'sent' && <span className="block text-xs text-ink-faint">{d.last_error}</span>}
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="text-xs text-ink-faint">{ago(d.created_at)}</span>
                    <Badge tone={STATUS_TONE[d.status]}>{STATUS_LABEL[d.status]}</Badge>
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs text-ink-faint">Which message each guest gets is set in Talko AI under Broadcast → API rules, with your approved WhatsApp templates.</p>
        </div>
      )}
    </Card>
  );
}

type DayForm = { open: boolean; periods: [string, string][] };

function hoursForm(hours: OpeningHours | null): Record<Weekday, DayForm> {
  return Object.fromEntries(
    WEEKDAYS.map((d) => {
      const periods = hours?.[d] ?? [];
      return [d, { open: periods.length > 0, periods: periods.length ? periods : [['12:00', '15:30'], ['19:00', '23:00']] }];
    }),
  ) as Record<Weekday, DayForm>;
}

function ChatBooking() {
  const { outlet, can } = useStaff();
  const save = useSaveOutlet();
  const [days, setDays] = useState<Record<Weekday, DayForm>>(() => hoursForm(null));
  const [rules, setRules] = useState<OnlineBooking>(ONLINE_BOOKING_DEFAULTS);
  useEffect(() => {
    if (!outlet) return;
    setDays(hoursForm(outlet.opening_hours));
    setRules(outlet.online_booking);
  }, [outlet]);
  if (!outlet) return <Spinner />;
  const editable = can('outlet.settings');

  const hours: OpeningHours = Object.fromEntries(
    WEEKDAYS.filter((d) => days[d].open).map((d) => [d, days[d].periods.filter(([a, b]) => a && b)]),
  ) as OpeningHours;
  const badTime = WEEKDAYS.some((d) => days[d].open && days[d].periods.some(([a, b]) => a && b && (clockMinutes(a) ?? 0) >= (clockMinutes(b === '00:00' ? '24:00' : b) ?? 0)));
  const setPeriod = (d: Weekday, i: number, j: 0 | 1, v: string) =>
    setDays((cur) => ({ ...cur, [d]: { ...cur[d], periods: cur[d].periods.map((p, k) => (k === i ? ((j === 0 ? [v, p[1]] : [p[0], v]) as [string, string]) : p)) } }));
  const num = (k: keyof Omit<OnlineBooking, 'enabled' | 'slot_minutes'>, label: string, hint: string, max: number) => (
    <Field label={label} hint={hint}>
      {(id) => <Input id={id} type="number" min={0} max={max} value={rules[k]} onChange={(e) => setRules({ ...rules, [k]: Number(e.target.value) })} disabled={!editable} />}
    </Field>
  );

  return (
    <Card className="space-y-5 p-5">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="font-semibold">Table booking in chat</h2>
          <p className="mt-0.5 text-sm text-ink-soft">Guests book through Talko AI only at times inside these hours, at tables that are free. The booking shows on Reservations straight away.</p>
        </div>
        <Switch
          label="Table booking in chat"
          checked={outlet.online_booking.enabled}
          disabled={!editable}
          onChange={(v) => void save({ online_booking: { ...outlet.online_booking, enabled: v } })}
        />
      </div>

      <div className="space-y-2">
        <p className="text-sm font-medium">Opening hours</p>
        {WEEKDAYS.map((d) => (
          <div key={d} className="flex flex-wrap items-center gap-2">
            <label className="flex w-32 items-center gap-2 text-sm">
              <input type="checkbox" checked={days[d].open} disabled={!editable} onChange={(e) => setDays({ ...days, [d]: { ...days[d], open: e.target.checked } })} />
              {DAY_LABEL[d]}
            </label>
            {days[d].open ? (
              days[d].periods.map((p, i) => (
                <span key={i} className="flex items-center gap-1">
                  <Input type="time" className="h-9 w-28" value={p[0]} disabled={!editable} onChange={(e) => setPeriod(d, i, 0, e.target.value)} aria-label={`${DAY_LABEL[d]} opens`} />
                  <span className="text-ink-faint">to</span>
                  <Input type="time" className="h-9 w-28" value={p[1] === '24:00' ? '00:00' : p[1]} disabled={!editable} onChange={(e) => setPeriod(d, i, 1, e.target.value)} aria-label={`${DAY_LABEL[d]} closes`} />
                </span>
              ))
            ) : (
              <span className="text-sm text-ink-faint">Closed</span>
            )}
          </div>
        ))}
        <p className="text-xs text-ink-faint">Two sittings a day; set a closing time of 12:00 am for midnight. Clear the second sitting&apos;s times if you have one.</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        {num('max_party', 'Largest party', 'Bigger groups are asked to call.', 50)}
        {num('lead_minutes', 'Earliest booking (minutes from now)', 'e.g. 60: no booking for the next hour.', 2880)}
        {num('days_ahead', 'Book up to (days ahead)', '1 to 90 days.', 90)}
        {num('last_seating_minutes', 'Last booking before closing (minutes)', 'e.g. 60: nothing in the last hour.', 240)}
        {num('reminder_minutes', 'WhatsApp reminder (minutes before)', '0: no reminder.', 1440)}
        <Field label="Times offered every">
          {(id) => (
            <Select id={id} value={rules.slot_minutes} disabled={!editable} onChange={(e) => setRules({ ...rules, slot_minutes: Number(e.target.value) as OnlineBooking['slot_minutes'] })}>
              <option value={15}>15 minutes</option>
              <option value={30}>30 minutes</option>
              <option value={60}>hour</option>
            </Select>
          )}
        </Field>
      </div>
      {badTime && <p className="text-sm text-rose-700">Each sitting has to open before it closes.</p>}
      {editable && (
        <Button
          disabled={badTime}
          onClick={() =>
            void save({
              // 12:00 am as a closing time means midnight.
              opening_hours: Object.fromEntries(Object.entries(hours).map(([d, ps]) => [d, ps!.map(([a, b]) => [a, b === '00:00' ? '24:00' : b])])) as OpeningHours,
              online_booking: { ...rules, enabled: outlet.online_booking.enabled },
            })
          }
        >
          Save hours and rules
        </Button>
      )}
    </Card>
  );
}

function ReviewLink() {
  const { outlet, can } = useStaff();
  const save = useSaveOutlet();
  const [url, setUrl] = useState('');
  useEffect(() => setUrl(outlet?.google_review_url ?? ''), [outlet]);
  if (!outlet) return null;
  return (
    <Card className="space-y-3 p-5">
      <h2 className="font-semibold">Google review link</h2>
      <p className="text-sm text-ink-soft">
        Sent with the thank-you after a paid bill, to guests who agreed to hear from you. Find it in your Google Business Profile: Ask for reviews → copy
        the link.
      </p>
      <div className="flex flex-wrap gap-2">
        <Input className="max-w-md" placeholder="https://g.page/r/…/review" value={url} onChange={(e) => setUrl(e.target.value)} disabled={!can('outlet.settings')} aria-label="Google review link" />
        <Button variant="outline" disabled={!can('outlet.settings')} onClick={() => void save({ google_review_url: url.trim() || null })}>
          Save
        </Button>
      </div>
    </Card>
  );
}

'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Armchair, CalendarClock, ChevronLeft, ChevronRight, Hourglass, Pencil, PhoneCall, Plus, Users } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { ReservationDTO, TableDTO, WaitlistEntryDTO } from '@mezmitra/shared/dto';
import { errorMessage } from '@/lib/api';
import { useI18n, type I18nKey, type Lang } from '@/lib/i18n';
import { minutesSince, time, todayIst } from '@/lib/format';
import { useStaff } from '@/lib/staff';
import { Button, IconButton } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';
import { Sheet } from '@/components/ui/overlay';
import { Badge, Card, EmptyState, Field, Input, Segmented, Select, Spinner, Textarea } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/toast';
import { Forbidden, PageHeader } from '@/components/staff/shell';

const STATUS_TONE: Record<ReservationDTO['status'], 'blue' | 'green' | 'neutral' | 'rose' | 'amber'> = {
  booked: 'blue',
  seated: 'green',
  completed: 'neutral',
  cancelled: 'neutral',
  no_show: 'rose',
};
const STATUS_LABEL: Record<ReservationDTO['status'], I18nKey> = {
  booked: 'res.status_booked',
  seated: 'res.status_seated',
  completed: 'res.status_completed',
  cancelled: 'res.status_cancelled',
  no_show: 'res.status_no_show',
};
const SOURCE_LABEL: Partial<Record<ReservationDTO['source'], I18nKey>> = { phone: 'res.src_phone', walk_in: 'res.src_walk_in', online: 'res.src_online' };
type T = ReturnType<typeof useI18n>['t'];

const shiftDay = (date: string, days: number) => {
  const d = new Date(`${date}T12:00:00+05:30`);
  d.setUTCDate(d.getUTCDate() + days);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(d);
};
const dayLabel = (date: string, t: T, lang: Lang) => {
  const today = todayIst();
  if (date === today) return t('res.today');
  if (date === shiftDay(today, 1)) return t('res.tomorrow');
  if (date === shiftDay(today, -1)) return t('res.yesterday');
  return new Intl.DateTimeFormat(lang === 'hi' ? 'hi-IN' : 'en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' }).format(new Date(`${date}T12:00:00+05:30`));
};
const istTime = (iso: string) => new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' }).format(new Date(iso));

export default function ReservationsPage() {
  const { api, outletId, can } = useStaff();
  const { t, lang } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const [date, setDate] = useState(todayIst);
  const [filter, setFilter] = useState<'upcoming' | 'all'>('upcoming');
  const [editing, setEditing] = useState<ReservationDTO | 'new' | null>(null);
  const [seating, setSeating] = useState<{ kind: 'reservation'; item: ReservationDTO } | { kind: 'waitlist'; item: WaitlistEntryDTO } | null>(null);
  const [queueing, setQueueing] = useState(false);
  const allowed = can('reservation.manage');

  const bookings = useQuery({
    queryKey: ['reservations', outletId, date],
    enabled: allowed,
    queryFn: () => api<ReservationDTO[]>(`/reservations?outlet_id=${outletId}&date=${date}`),
    refetchInterval: 60_000,
  });
  const waitlist = useQuery({ queryKey: ['waitlist', outletId], enabled: allowed, queryFn: () => api<WaitlistEntryDTO[]>(`/waitlist?outlet_id=${outletId}`), refetchInterval: 30_000 });

  if (!allowed) return <Forbidden />;

  const refresh = () => qc.invalidateQueries({ predicate: (q) => ['reservations', 'waitlist', 'tables'].includes(q.queryKey[0] as string) });
  const act = async (fn: () => Promise<unknown>, done: string) => {
    try {
      await fn();
      await refresh();
      toast(done);
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  const list = (bookings.data ?? []).filter((r) => filter === 'all' || ['booked', 'seated'].includes(r.status));
  const covers = (bookings.data ?? []).filter((r) => ['booked', 'seated', 'completed'].includes(r.status)).reduce((a, r) => a + r.party_size, 0);
  const isToday = date === todayIst();

  return (
    <div className="pb-12">
      <PageHeader
        title={t('nav.reservations')}
        subtitle={(() => {
          const n = (bookings.data ?? []).filter((r) => r.status !== 'cancelled').length;
          return `${n === 1 ? t('res.bookings_one') : t('res.bookings', { n })} · ${covers === 1 ? t('res.guests_one') : t('res.guests_n', { n: covers })}`;
        })()}
        actions={
          <>
            <Button variant="outline" onClick={() => setQueueing(true)}>
              <Hourglass className="size-4" /> {t('res.add_waitlist')}
            </Button>
            <Button onClick={() => setEditing('new')}>
              <Plus className="size-4" /> {t('res.new_booking')}
            </Button>
          </>
        }
      />
      <div className="grid gap-6 px-4 lg:grid-cols-[minmax(0,1fr)_340px] lg:px-8">
        <section>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <div className="flex items-center rounded-xl border border-line bg-surface">
              <IconButton label={t('res.prev_day')} onClick={() => setDate((d) => shiftDay(d, -1))}>
                <ChevronLeft className="size-4" />
              </IconButton>
              <label className="relative px-1 text-sm font-medium">
                <span>{dayLabel(date, t, lang)}</span>
                <input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} className="absolute inset-0 cursor-pointer opacity-0" aria-label={t('res.pick_date')} />
              </label>
              <IconButton label={t('res.next_day')} onClick={() => setDate((d) => shiftDay(d, 1))}>
                <ChevronRight className="size-4" />
              </IconButton>
            </div>
            {!isToday && (
              <Button variant="ghost" size="sm" onClick={() => setDate(todayIst())}>
                {t('res.today')}
              </Button>
            )}
            <Segmented
              size="sm"
              className="ml-auto"
              value={filter}
              onChange={setFilter}
              options={[
                { value: 'upcoming', label: t('res.active') },
                { value: 'all', label: t('res.all') },
              ]}
            />
          </div>
          <Card className="overflow-hidden">
            {bookings.isLoading ? (
              <div className="grid place-items-center py-16">
                <Spinner />
              </div>
            ) : !list.length ? (
              <EmptyState icon={<CalendarClock className="size-5" />} title={isToday ? t('res.none_today') : t('res.none_day')} hint={t('res.none_hint')} />
            ) : (
              <ul className="divide-y divide-line">
                {list.map((r) => {
                  const late = r.status === 'booked' && isToday && minutesSince(r.slot_start) > 10;
                  return (
                    <li key={r.id} className={cn('flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3', ['cancelled', 'no_show', 'completed'].includes(r.status) && 'opacity-60')}>
                      <div className="w-[5.5rem] shrink-0">
                        <p className="font-display text-lg font-semibold whitespace-nowrap tabular">{time(r.slot_start)}</p>
                        {late && <p className="text-xs font-medium text-rose-700">{t('res.late', { n: minutesSince(r.slot_start) })}</p>}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="flex flex-wrap items-center gap-2 font-medium">
                          {r.guest_name}
                          <span className="inline-flex items-center gap-0.5 text-sm text-ink-soft">
                            <Users className="size-3.5" /> {r.party_size}
                          </span>
                          <Badge tone={STATUS_TONE[r.status]}>{t(STATUS_LABEL[r.status])}</Badge>
                          {r.table_label && <Badge>{t('res.table', { label: r.table_label })}</Badge>}
                        </p>
                        <p className="truncate text-xs text-ink-faint">
                          {[r.guest_phone, SOURCE_LABEL[r.source] ? t(SOURCE_LABEL[r.source]!) : null, r.notes].filter(Boolean).join(' · ')}
                        </p>
                      </div>
                      {r.status === 'booked' && (
                        <div className="flex basis-full items-center gap-1.5 sm:basis-auto">
                          <Button size="sm" variant="success" onClick={() => setSeating({ kind: 'reservation', item: r })}>
                            <Armchair className="size-4" /> {t('res.seat')}
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => act(() => api(`/reservations/${r.id}`, { method: 'PATCH', body: { status: 'no_show' } }), t('res.marked_no_show'))}>
                            {t('res.no_show')}
                          </Button>
                          <IconButton label={t('res.edit_for', { name: r.guest_name })} onClick={() => setEditing(r)}>
                            <Pencil className="size-4" />
                          </IconButton>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        </section>

        <section>
          <h2 className="mb-3 flex h-11 items-center gap-2 text-sm font-semibold tracking-wide text-ink-faint uppercase">
            {t('res.waitlist')} <span className="rounded-full bg-stone-200 px-2 text-xs text-ink-soft tabular">{waitlist.data?.length ?? 0}</span>
          </h2>
          <Card className="overflow-hidden">
            {!waitlist.data?.length ? (
              <EmptyState icon={<Hourglass className="size-5" />} title={t('res.nobody_waiting')} hint={t('res.waitlist_hint')} />
            ) : (
              <ul className="divide-y divide-line">
                {waitlist.data.map((w, i) => {
                  const waited = minutesSince(w.created_at);
                  const over = w.quoted_minutes != null && waited > w.quoted_minutes;
                  return (
                    <li key={w.id} className="space-y-2 px-4 py-3">
                      <div className="flex items-start gap-3">
                        <span className="grid size-7 shrink-0 place-items-center rounded-full bg-stone-100 text-xs font-semibold text-ink-soft">{i + 1}</span>
                        <div className="min-w-0 flex-1">
                          <p className="flex items-center gap-2 font-medium">
                            {w.guest_name}
                            <span className="inline-flex items-center gap-0.5 text-sm text-ink-soft">
                              <Users className="size-3.5" /> {w.party_size}
                            </span>
                            {w.status === 'notified' && <Badge tone="amber">{t('res.called')}</Badge>}
                          </p>
                          <p className={cn('text-xs', over ? 'font-medium text-rose-700' : 'text-ink-faint')}>
                            {t('res.waiting', { n: waited })}
                            {w.quoted_minutes != null && ` · ${t('res.quoted', { n: w.quoted_minutes })}`}
                            {w.guest_phone && ` · ${w.guest_phone}`}
                          </p>
                        </div>
                      </div>
                      <div className="flex gap-1.5 pl-10">
                        <Button size="sm" variant="success" onClick={() => setSeating({ kind: 'waitlist', item: w })}>
                          <Armchair className="size-4" /> {t('res.seat')}
                        </Button>
                        {w.status === 'waiting' && (
                          <Button size="sm" variant="outline" onClick={() => act(() => api(`/waitlist/${w.id}/notify`, { method: 'POST', body: {} }), t('res.called_toast', { name: w.guest_name }))}>
                            <PhoneCall className="size-4" /> {t('res.called')}
                          </Button>
                        )}
                        <Button size="sm" variant="ghost" onClick={() => act(() => api(`/waitlist/${w.id}/leave`, { method: 'POST', body: {} }), t('res.removed'))}>
                          {t('res.left')}
                        </Button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        </section>
      </div>

      {editing && <BookingSheet booking={editing === 'new' ? null : editing} date={date} onClose={() => setEditing(null)} onSaved={refresh} />}
      {queueing && <WaitlistSheet onClose={() => setQueueing(false)} onSaved={refresh} />}
      {seating && (
        <SeatSheet
          title={t('res.seat_title', { name: seating.item.guest_name, n: seating.item.party_size })}
          partySize={seating.item.party_size}
          preferred={seating.kind === 'reservation' ? seating.item.table_id : null}
          onClose={() => setSeating(null)}
          onSeat={(tableId) =>
            act(
              () =>
                seating.kind === 'reservation'
                  ? api(`/reservations/${seating.item.id}/seat`, { method: 'POST', body: tableId ? { table_id: tableId } : {} })
                  : api(`/waitlist/${seating.item.id}/seat`, { method: 'POST', body: { table_id: tableId } }),
              t('res.seated_toast', { name: seating.item.guest_name }),
            ).then(() => setSeating(null))
          }
        />
      )}
    </div>
  );
}

function BookingSheet({ booking, date, onClose, onSaved }: { booking: ReservationDTO | null; date: string; onClose: () => void; onSaved: () => void }) {
  const { api, outletId, outlet } = useStaff();
  const { t } = useI18n();
  const toast = useToast();
  const [name, setName] = useState(booking?.guest_name ?? '');
  const [phone, setPhone] = useState(booking?.guest_phone ?? '');
  const [consent, setConsent] = useState(!!booking?.guest_phone);
  const [party, setParty] = useState(booking?.party_size ?? 2);
  const [day, setDay] = useState(booking ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(booking.slot_start)) : date);
  const [at, setAt] = useState(booking ? istTime(booking.slot_start) : '20:00');
  const [duration, setDuration] = useState(booking ? Math.round((Date.parse(booking.slot_end) - Date.parse(booking.slot_start)) / 60_000) : (outlet?.reservation_minutes ?? 90));
  const [tableId, setTableId] = useState<string>(booking?.table_id ?? '');
  const [source, setSource] = useState<ReservationDTO['source']>(booking?.source ?? 'phone');
  const [notes, setNotes] = useState(booking?.notes ?? '');
  const [busy, setBusy] = useState(false);
  const slotStart = `${day}T${at}:00+05:30`;

  const free = useQuery({
    queryKey: ['reservations', 'availability', outletId, slotStart, party, duration],
    enabled: !!day && !!at && party > 0,
    queryFn: () =>
      api<{ id: string; label: string; seats: number; zone: string | null }[]>(
        `/reservations/availability?outlet_id=${outletId}&slot_start=${encodeURIComponent(slotStart)}&party_size=${party}&duration_minutes=${duration}`,
      ),
  });
  const options = useMemo(() => {
    const list = free.data ?? [];
    // Keep the booking's own table selectable while editing.
    if (booking?.table_id && !list.some((tb) => tb.id === booking.table_id)) return [{ id: booking.table_id, label: booking.table_label ?? t('res.current'), seats: 0, zone: null }, ...list];
    return list;
  }, [free.data, booking, t]);

  const save = async () => {
    setBusy(true);
    try {
      const body = {
        guest_name: name,
        guest_phone: phone.trim() || null,
        contact_consent: consent && !!phone.trim(),
        party_size: party,
        slot_start: slotStart,
        duration_minutes: duration,
        table_id: tableId || null,
        source,
        notes: notes.trim() || null,
      };
      if (booking) await api(`/reservations/${booking.id}`, { method: 'PATCH', body });
      else await api('/reservations', { method: 'POST', body: { outlet_id: outletId, ...body } });
      onSaved();
      toast(booking ? t('res.updated') : t('res.booked_for', { name }));
      onClose();
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (!booking) return;
    setBusy(true);
    try {
      await api(`/reservations/${booking.id}`, { method: 'PATCH', body: { status: 'cancelled' } });
      onSaved();
      toast(t('res.cancelled_toast'));
      onClose();
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open
      onClose={onClose}
      title={booking ? t('res.booking_of', { name: booking.guest_name }) : t('res.new_booking')}
      footer={
        <div className="flex gap-2">
          {booking && (
            <Button variant="ghost" className="text-rose-700" onClick={cancel} disabled={busy}>
              {t('res.cancel_booking')}
            </Button>
          )}
          <Button className="ml-auto" onClick={save} loading={busy} disabled={!name.trim() || party < 1}>
            {booking ? t('res.save') : t('res.book')}
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-[1fr_96px] gap-3">
          <Field label={t('res.guest_name')}>{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} autoFocus />}</Field>
          <Field label={t('res.guests')}>{(id) => <Input id={id} type="number" min={1} max={200} value={party} onChange={(e) => setParty(Number(e.target.value))} />}</Field>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Field label={t('res.date')} className="col-span-2 sm:col-span-1">{(id) => <Input id={id} type="date" value={day} onChange={(e) => setDay(e.target.value)} />}</Field>
          <Field label={t('res.time')}>{(id) => <Input id={id} type="time" step={900} value={at} onChange={(e) => setAt(e.target.value)} />}</Field>
          <Field label={t('res.for')}>
            {(id) => (
              <Select id={id} value={duration} onChange={(e) => setDuration(Number(e.target.value))}>
                {[45, 60, 90, 120, 150, 180, 240].map((m) => (
                  <option key={m} value={m}>
                    {m < 60 ? t('res.minutes', { n: m }) : t('res.hours', { n: String(m / 60).replace('.5', '½') })}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        <Field label={t('res.table_label')} hint={free.isFetching ? t('res.checking') : options.length ? t('res.smallest_first') : t('res.no_fit')}>
          {(id) => (
            <Select id={id} value={tableId} onChange={(e) => setTableId(e.target.value)}>
              <option value="">{t('res.on_arrival')}</option>
              {options.map((tb) => (
                <option key={tb.id} value={tb.id}>
                  {tb.label}
                  {tb.seats ? ` · ${t('res.seats', { n: tb.seats })}` : ''}
                  {tb.zone ? ` · ${tb.zone}` : ''}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('res.phone_optional')}>{(id) => <Input id={id} value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" placeholder="98765 43210" />}</Field>
        {phone.trim() && (
          <label className="flex cursor-pointer items-start gap-3 rounded-xl bg-stone-50 p-3 text-sm">
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-0.5 size-4 accent-[var(--brand)]" />
            <span>
              {t('res.consent')}
              <span className="block text-xs text-ink-faint">{t('res.consent_hint')}</span>
            </span>
          </label>
        )}
        <Field label={t('res.booked_by')}>
          {(id) => (
            <Select id={id} value={source} onChange={(e) => setSource(e.target.value as ReservationDTO['source'])}>
              <option value="phone">{t('res.by_phone')}</option>
              <option value="walk_in">{t('res.by_walk_in')}</option>
              <option value="online">{t('res.by_online')}</option>
              <option value="other">{t('res.by_other')}</option>
            </Select>
          )}
        </Field>
        <Field label={t('res.notes')}>{(id) => <Textarea id={id} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={t('res.notes_hint')} maxLength={500} />}</Field>
      </div>
    </Sheet>
  );
}

function WaitlistSheet({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { api, outletId } = useStaff();
  const { t } = useI18n();
  const toast = useToast();
  const [name, setName] = useState('');
  const [party, setParty] = useState(2);
  const [quoted, setQuoted] = useState(15);
  const [phone, setPhone] = useState('');
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await api('/waitlist', {
        method: 'POST',
        body: { outlet_id: outletId, guest_name: name, party_size: party, quoted_minutes: quoted, guest_phone: phone.trim() || null, contact_consent: consent && !!phone.trim() },
      });
      onSaved();
      toast(t('res.added_waitlist', { name }));
      onClose();
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet open onClose={onClose} title={t('res.add_waitlist')} footer={<Button block onClick={save} loading={busy} disabled={!name.trim()}>{t('res.add')}</Button>}>
      <div className="space-y-4">
        <div className="grid grid-cols-[1fr_96px] gap-3">
          <Field label={t('res.name')}>{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} autoFocus />}</Field>
          <Field label={t('res.guests')}>{(id) => <Input id={id} type="number" min={1} value={party} onChange={(e) => setParty(Number(e.target.value))} />}</Field>
        </div>
        <Field label={t('res.quoted_wait')}>
          {() => (
            <Segmented
              value={String(quoted)}
              onChange={(v) => setQuoted(Number(v))}
              options={[5, 10, 15, 20, 30, 45].map((m) => ({ value: String(m), label: String(m) }))}
            />
          )}
        </Field>
        <Field label={t('res.phone_callback')}>{(id) => <Input id={id} value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" />}</Field>
        {phone.trim() && (
          <label className="flex cursor-pointer items-center gap-3 text-sm">
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="size-4 accent-[var(--brand)]" />
            {t('res.consent_note')}
          </label>
        )}
      </div>
    </Sheet>
  );
}

function SeatSheet({ title, partySize, preferred, onClose, onSeat }: { title: string; partySize: number; preferred: string | null; onClose: () => void; onSeat: (tableId: string | null) => void }) {
  const { api, outletId } = useStaff();
  const { t } = useI18n();
  const { data: tables } = useQuery({ queryKey: ['tables', outletId], queryFn: () => api<TableDTO[]>(`/tables?outlet_id=${outletId}`) });
  const [picked, setPicked] = useState<string | null>(preferred);
  const free = (tables ?? []).filter((tb) => tb.is_active && (tb.state === 'vacant' || tb.state === 'needs_cleaning' || tb.id === preferred));
  const fits = free.filter((tb) => tb.seats >= partySize).sort((a, b) => a.seats - b.seats);
  const small = free.filter((tb) => tb.seats < partySize);
  return (
    <Sheet open onClose={onClose} title={title} footer={<Button block variant="success" onClick={() => onSeat(picked)} disabled={!picked}>{t('res.seat_here')}</Button>}>
      {!free.length ? (
        <p className="py-8 text-center text-sm text-ink-faint">{t('res.no_free')}</p>
      ) : (
        <div className="space-y-4">
          {[
            { label: t('res.fits'), list: fits },
            { label: t('res.too_small'), list: small },
          ]
            .filter((g) => g.list.length)
            .map((g) => (
              <div key={g.label}>
                <p className="mb-2 text-xs font-medium tracking-wide text-ink-faint uppercase">{g.label}</p>
                <div className="grid grid-cols-[repeat(auto-fill,minmax(88px,1fr))] gap-2">
                  {g.list.map((tb) => (
                    <button
                      key={tb.id}
                      onClick={() => setPicked(tb.id)}
                      aria-pressed={picked === tb.id}
                      className={cn(
                        'flex cursor-pointer flex-col items-start rounded-xl border-2 px-3 py-2 text-left transition',
                        picked === tb.id ? 'border-[var(--brand)] bg-brand-50' : 'border-line hover:border-stone-300',
                      )}
                    >
                      <span className="font-display text-lg font-semibold">{tb.label}</span>
                      <span className="text-xs text-ink-faint">
                        {t('res.seats', { n: tb.seats })}
                        {tb.state === 'needs_cleaning' ? ` · ${t('res.to_clean')}` : ''}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
        </div>
      )}
    </Sheet>
  );
}

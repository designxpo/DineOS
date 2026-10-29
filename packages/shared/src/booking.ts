// Opening hours and online booking: shared by the API, which enforces them for bookings made in a
// chat (Talko AI), and by the owner's settings screen, which edits them. Times are the outlet's
// local wall-clock times; the outlet's timezone turns them into instants.

import { businessDate } from './dates';

export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/** Each day's open periods as "HH:MM" pairs; a period may end at "24:00". A missing day is closed. */
export type OpeningHours = Partial<Record<Weekday, [string, string][]>>;

/** Where a booking made in a chat came from. */
export const CHAT_CHANNELS = ['whatsapp', 'instagram', 'messenger', 'webchat'] as const;
export type ChatChannel = (typeof CHAT_CHANNELS)[number];

export const RESERVATION_SOURCES = ['phone', 'walk_in', 'online', 'other', ...CHAT_CHANNELS] as const;
export type ReservationSource = (typeof RESERVATION_SOURCES)[number];

export interface OnlineBooking {
  /** Guests may book in a chat. Off until the owner turns it on. */
  enabled: boolean;
  /** Bigger parties are asked to call. */
  max_party: number;
  /** The earliest booking is this many minutes from now. */
  lead_minutes: number;
  /** How far ahead guests may book. */
  days_ahead: number;
  /** The last booking starts this many minutes before closing. */
  last_seating_minutes: number;
  /** Booking times offered: every 15, 30 or 60 minutes. */
  slot_minutes: 15 | 30 | 60;
  /** A WhatsApp reminder goes this many minutes before the booking; 0: none. */
  reminder_minutes: number;
}

export const ONLINE_BOOKING_DEFAULTS: OnlineBooking = {
  enabled: false,
  max_party: 8,
  lead_minutes: 60,
  days_ahead: 30,
  last_seating_minutes: 60,
  slot_minutes: 30,
  reminder_minutes: 120,
};

const LIMITS: Record<Exclude<keyof OnlineBooking, 'enabled' | 'slot_minutes'>, [number, number]> = {
  max_party: [1, 50],
  lead_minutes: [0, 2880],
  days_ahead: [1, 90],
  last_seating_minutes: [0, 240],
  reminder_minutes: [0, 1440],
};

/** Settings as stored (possibly partial or from an older version), with defaults and limits applied. */
export function onlineBooking(raw: unknown): OnlineBooking {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const out: OnlineBooking = { ...ONLINE_BOOKING_DEFAULTS, enabled: r.enabled === true };
  for (const [key, [min, max]] of Object.entries(LIMITS) as [keyof typeof LIMITS, [number, number]][]) {
    const n = r[key];
    if (typeof n === 'number' && Number.isInteger(n)) out[key] = Math.min(max, Math.max(min, n));
  }
  if (r.slot_minutes === 15 || r.slot_minutes === 30 || r.slot_minutes === 60) out.slot_minutes = r.slot_minutes;
  return out;
}

/** "19:30" → 1170 minutes after midnight; "24:00" is allowed as an end. Null when malformed. */
export function clockMinutes(value: string): number | null {
  const m = /^([01]\d|2[0-4]):([0-5]\d)$/.exec(value);
  if (!m) return null;
  const minutes = Number(m[1]) * 60 + Number(m[2]);
  return minutes <= 1440 ? minutes : null;
}

/** Checks opening hours as entered. Returns the cleaned hours, or a message saying what is wrong. */
export function cleanOpeningHours(raw: unknown): { hours: OpeningHours } | { error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'Opening hours must list days' };
  const hours: OpeningHours = {};
  for (const [day, periods] of Object.entries(raw as Record<string, unknown>)) {
    if (!(WEEKDAYS as readonly string[]).includes(day)) return { error: `Unknown day "${day}"` };
    if (!Array.isArray(periods) || periods.length > 4) return { error: `Give ${day} up to four open periods` };
    const clean: [string, string][] = [];
    let lastEnd = -1;
    for (const p of periods) {
      if (!Array.isArray(p) || p.length !== 2 || typeof p[0] !== 'string' || typeof p[1] !== 'string') return { error: `Times on ${day} look like ["12:00", "15:30"]` };
      const open = clockMinutes(p[0]);
      const close = clockMinutes(p[1]);
      if (open === null || close === null || open >= close || open === 1440) return { error: `On ${day}, each period opens before it closes (24-hour times)` };
      if (open < lastEnd) return { error: `On ${day}, periods overlap or are out of order` };
      lastEnd = close;
      clean.push([p[0], p[1]]);
    }
    if (clean.length) hours[day as Weekday] = clean;
  }
  return { hours };
}

/** Weekday of a calendar date (YYYY-MM-DD). */
export function weekdayOf(date: string): Weekday {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  // getUTCDay: 0 = Sunday
  return WEEKDAYS[(new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7]!;
}

/** Calendar date `days` after `date`. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** How far `tz` is ahead of UTC at `at`, in milliseconds. */
function offsetMs(at: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(at));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const local = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return local - Math.floor(at / 1000) * 1000;
}

/** The instant at which the clock in `tz` shows `minutes` after midnight on `date`. */
export function zonedTime(date: string, minutes: number, tz: string): Date {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const wall = Date.UTC(y, m - 1, d, 0, minutes);
  // Twice, so a guess on the other side of a daylight-saving change settles.
  let at = wall - offsetMs(wall, tz);
  at = wall - offsetMs(at, tz);
  return new Date(at);
}

/**
 * Start times a guest may book on `date`: inside opening hours, early enough before closing, far
 * enough from now and not too far ahead. Whether a table is free is checked separately.
 */
export function bookableStarts(input: { hours: OpeningHours | null; booking: OnlineBooking; date: string; timezone: string; now: Date }): Date[] {
  const { hours, booking, date, timezone, now } = input;
  if (!booking.enabled || !hours) return [];
  const today = businessDate(now, timezone);
  if (date < today || date > addDays(today, booking.days_ahead)) return [];
  const earliest = now.getTime() + booking.lead_minutes * 60_000;
  const out: Date[] = [];
  for (const [openAt, closeAt] of hours[weekdayOf(date)] ?? []) {
    const open = clockMinutes(openAt);
    const close = clockMinutes(closeAt);
    if (open === null || close === null) continue;
    const last = close - booking.last_seating_minutes;
    // First slot on the step grid at or after opening (a 12:10 opening offers 12:30 with 30-minute steps).
    for (let t = Math.ceil(open / booking.slot_minutes) * booking.slot_minutes; t <= last; t += booking.slot_minutes) {
      const start = zonedTime(date, t, timezone);
      if (start.getTime() >= earliest) out.push(start);
    }
  }
  return out;
}

/** "7:30 pm" in the outlet's timezone. */
export function slotLabel(at: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-IN', { timeZone: timezone, hour: 'numeric', minute: '2-digit', hour12: true }).format(at);
}

/** "Sat, 2 Nov" in the outlet's timezone. */
export function dayLabel(at: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-IN', { timeZone: timezone, weekday: 'short', day: 'numeric', month: 'short' }).format(at);
}

import { describe, expect, it } from 'vitest';
import { bookableStarts, cleanOpeningHours, onlineBooking, weekdayOf, zonedTime, type OpeningHours } from './booking';

const IST = 'Asia/Kolkata';
const hours: OpeningHours = { sat: [['12:00', '15:30'], ['19:00', '23:00']] };
const on = onlineBooking({ enabled: true, lead_minutes: 60, last_seating_minutes: 60, slot_minutes: 30, days_ahead: 7 });

describe('online booking', () => {
  it('turns local wall-clock time into the right instant', () => {
    expect(zonedTime('2026-11-07', 19 * 60 + 30, IST).toISOString()).toBe('2026-11-07T14:00:00.000Z');
    expect(zonedTime('2026-11-07', 1440, IST).toISOString()).toBe('2026-11-07T18:30:00.000Z');
    // Across a daylight-saving change: 2026-03-08 in New York jumps from 2:00 to 3:00.
    expect(zonedTime('2026-03-08', 9 * 60, 'America/New_York').toISOString()).toBe('2026-03-08T13:00:00.000Z');
  });

  it('knows the weekday of a date', () => {
    expect(weekdayOf('2026-11-07')).toBe('sat');
    expect(weekdayOf('2026-11-09')).toBe('mon');
  });

  it('offers times inside opening hours, stopping before closing', () => {
    const now = new Date('2026-11-05T04:30:00Z');
    const starts = bookableStarts({ hours, booking: on, date: '2026-11-07', timezone: IST, now }).map((d) => d.toISOString());
    // 12:00 to 14:30 (last seating an hour before 15:30), then 19:00 to 22:00.
    expect(starts[0]).toBe('2026-11-07T06:30:00.000Z');
    expect(starts).toContain('2026-11-07T09:00:00.000Z');
    expect(starts).not.toContain('2026-11-07T09:30:00.000Z');
    expect(starts.at(-1)).toBe('2026-11-07T16:30:00.000Z');
    expect(starts).toHaveLength(6 + 7);
  });

  it('offers nothing on closed days, in the past, too far ahead or when switched off', () => {
    const now = new Date('2026-11-05T04:30:00Z');
    expect(bookableStarts({ hours, booking: on, date: '2026-11-06', timezone: IST, now })).toEqual([]);
    expect(bookableStarts({ hours, booking: on, date: '2026-10-31', timezone: IST, now })).toEqual([]);
    expect(bookableStarts({ hours, booking: on, date: '2026-11-21', timezone: IST, now })).toEqual([]);
    expect(bookableStarts({ hours, booking: { ...on, enabled: false }, date: '2026-11-07', timezone: IST, now })).toEqual([]);
    expect(bookableStarts({ hours: null, booking: on, date: '2026-11-07', timezone: IST, now })).toEqual([]);
  });

  it('keeps the lead time from now', () => {
    // Saturday 18:30 IST: the evening's first bookable time is 19:30.
    const now = new Date('2026-11-07T13:00:00Z');
    const starts = bookableStarts({ hours, booking: on, date: '2026-11-07', timezone: IST, now }).map((d) => d.toISOString());
    expect(starts[0]).toBe('2026-11-07T14:00:00.000Z');
  });

  it('applies defaults and limits to stored settings', () => {
    expect(onlineBooking(null)).toMatchObject({ enabled: false, max_party: 8, slot_minutes: 30 });
    expect(onlineBooking({ enabled: 'yes', max_party: 500, slot_minutes: 20, lead_minutes: -5 })).toMatchObject({ enabled: false, max_party: 50, slot_minutes: 30, lead_minutes: 0 });
  });

  it('rejects malformed opening hours', () => {
    expect(cleanOpeningHours({ mon: [['12:00', '15:00']] })).toEqual({ hours: { mon: [['12:00', '15:00']] } });
    expect(cleanOpeningHours({ funday: [] })).toHaveProperty('error');
    expect(cleanOpeningHours({ mon: [['15:00', '12:00']] })).toHaveProperty('error');
    expect(cleanOpeningHours({ mon: [['12:00', '16:00'], ['15:00', '18:00']] })).toHaveProperty('error');
    expect(cleanOpeningHours({ mon: [['7pm', '11pm']] })).toHaveProperty('error');
    expect(cleanOpeningHours({ mon: [['18:00', '24:00']] })).toEqual({ hours: { mon: [['18:00', '24:00']] } });
  });
});

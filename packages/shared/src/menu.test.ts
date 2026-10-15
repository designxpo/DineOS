import { describe, expect, it } from 'vitest';
import { checkModifierSelection, isScheduleOpen } from './menu';
import { deriveTableState } from './table-state';

describe('isScheduleOpen', () => {
  // 2026-10-15 is a Thursday. 04:00 UTC = 09:30 IST.
  const thuMorning = new Date('2026-10-15T04:00:00Z');
  it('is open with no schedule', () => {
    expect(isScheduleOpen(null, thuMorning)).toBe(true);
  });
  it('respects the time window in India time', () => {
    expect(isScheduleOpen({ from: '07:00', to: '11:00' }, thuMorning)).toBe(true);
    expect(isScheduleOpen({ from: '12:00', to: '15:00' }, thuMorning)).toBe(false);
  });
  it('respects days', () => {
    expect(isScheduleOpen({ days: [0, 6] }, thuMorning)).toBe(false);
    expect(isScheduleOpen({ days: [4] }, thuMorning)).toBe(true);
  });
  it('handles windows past midnight', () => {
    const lateNight = new Date('2026-10-15T19:30:00Z'); // 01:00 IST Friday
    expect(isScheduleOpen({ from: '22:00', to: '02:00' }, lateNight)).toBe(true);
    expect(isScheduleOpen({ from: '22:00', to: '02:00' }, thuMorning)).toBe(false);
  });
});

describe('checkModifierSelection', () => {
  const groups = [
    { id: 'size', name: 'Size', min_select: 1, max_select: 1, modifiers: [{ id: 'reg', in_stock: true }, { id: 'lg', in_stock: true }] },
    { id: 'add', name: 'Add-ons', min_select: 0, max_select: 2, modifiers: [{ id: 'cheese', in_stock: true }, { id: 'egg', in_stock: false }, { id: 'olive', in_stock: true }] },
  ];
  it('accepts a valid pick', () => {
    expect(checkModifierSelection(groups, ['reg', 'cheese'])).toEqual({ ok: true });
  });
  it('enforces required groups', () => {
    expect(checkModifierSelection(groups, ['cheese'])).toMatchObject({ ok: false, code: 'too_few', group_id: 'size' });
  });
  it('enforces maximums', () => {
    expect(checkModifierSelection(groups, ['reg', 'lg'])).toMatchObject({ ok: false, code: 'too_many' });
  });
  it('rejects out-of-stock and foreign options', () => {
    expect(checkModifierSelection(groups, ['reg', 'egg'])).toMatchObject({ code: 'modifier_out_of_stock' });
    expect(checkModifierSelection(groups, ['reg', 'bacon'])).toMatchObject({ code: 'unknown_modifier' });
  });
});

describe('deriveTableState', () => {
  const open = { status: 'open' as const, bill_requested_at: null };
  it('treats a cart-only session as vacant', () => {
    expect(deriveTableState({ needsCleaning: false, session: { status: 'pending', bill_requested_at: null }, orderStatuses: [] })).toBe('vacant');
  });
  it('walks through the dining states', () => {
    expect(deriveTableState({ needsCleaning: false, session: open, orderStatuses: [] })).toBe('occupied');
    expect(deriveTableState({ needsCleaning: false, session: open, orderStatuses: ['served', 'preparing'] })).toBe('ordered');
    expect(deriveTableState({ needsCleaning: false, session: open, orderStatuses: ['served', 'rejected'] })).toBe('served');
    expect(deriveTableState({ needsCleaning: false, session: { status: 'open', bill_requested_at: new Date() }, orderStatuses: ['served'] })).toBe('bill_requested');
  });
  it('shows cleaning after the party leaves', () => {
    expect(deriveTableState({ needsCleaning: true, session: null, orderStatuses: [] })).toBe('needs_cleaning');
  });
});

import { describe, expect, it } from 'vitest';
import { deriveTableState } from './table-state';

const now = new Date('2026-10-15T20:00:00Z');
const at = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * 60_000).toISOString();
const open = { status: 'open' as const, bill_requested_at: null };

describe('table state', () => {
  it('follows orders and bills', () => {
    expect(deriveTableState({ needsCleaning: false, session: null, orderStatuses: [] })).toBe('vacant');
    expect(deriveTableState({ needsCleaning: false, session: open, orderStatuses: [] })).toBe('occupied');
    expect(deriveTableState({ needsCleaning: false, session: open, orderStatuses: ['preparing'] })).toBe('ordered');
    expect(deriveTableState({ needsCleaning: false, session: open, orderStatuses: ['served'] })).toBe('served');
    expect(deriveTableState({ needsCleaning: false, session: { status: 'open', bill_requested_at: at(1) }, orderStatuses: ['served'] })).toBe('bill_requested');
    expect(deriveTableState({ needsCleaning: true, session: null, orderStatuses: [] })).toBe('needs_cleaning');
    // A guest browsing the QR menu does not occupy the table.
    expect(deriveTableState({ needsCleaning: false, session: { status: 'pending', bill_requested_at: null }, orderStatuses: [] })).toBe('vacant');
  });

  it('lets the camera fill gaps only, never overriding an open visit', () => {
    const cam = (state: 'vacant' | 'occupied' | 'needs_cleaning', minutesAgo = 1) => ({ state, at: at(minutesAgo) });
    expect(deriveTableState({ needsCleaning: false, session: null, orderStatuses: [], camera: cam('occupied'), now })).toBe('occupied');
    expect(deriveTableState({ needsCleaning: false, session: null, orderStatuses: [], camera: cam('needs_cleaning'), now })).toBe('needs_cleaning');
    expect(deriveTableState({ needsCleaning: false, session: null, orderStatuses: [], camera: cam('vacant'), now })).toBe('vacant');
    // An open session or order wins.
    expect(deriveTableState({ needsCleaning: false, session: open, orderStatuses: ['accepted'], camera: cam('vacant'), now })).toBe('ordered');
    expect(deriveTableState({ needsCleaning: false, session: open, orderStatuses: [], camera: cam('needs_cleaning'), now })).toBe('occupied');
    // The camera cannot clear a table staff or billing marked for cleaning.
    expect(deriveTableState({ needsCleaning: true, session: null, orderStatuses: [], camera: cam('vacant'), now })).toBe('needs_cleaning');
    // Old readings are ignored.
    expect(deriveTableState({ needsCleaning: false, session: null, orderStatuses: [], camera: cam('occupied', 20), now })).toBe('vacant');
  });
});

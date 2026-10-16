import { describe, expect, it } from 'vitest';
import { batchSyncPayload, groupSyncPayload, type HubBill, type HubOrder, type HubSession, type HubSyncPayload } from './hub';

const session = (id: string, status: 'open' | 'closed'): HubSession =>
  ({ id, table_id: `t-${id}`, status, opened_at: null, closed_at: null, guest_count: 2, waiter_id: null, bill_requested_at: null });
// A long note pads each order so a few of them fill a small batch.
const order = (id: string, sessionId: string | null): HubOrder => ({ id, table_session_id: sessionId, note: 'x'.repeat(400) }) as unknown as HubOrder;
const bill = (id: string, sessionId: string | null, orderId: string | null): HubBill => ({ id, table_session_id: sessionId, order_id: orderId }) as unknown as HubBill;

const payload: HubSyncPayload = {
  sessions: [session('s-open', 'open'), session('s-closed', 'closed')],
  orders: [order('o1', 's-open'), order('o2', 's-open'), order('o3', 's-closed'), order('o-takeaway', null)],
  bills: [bill('b1', 's-closed', null), bill('b-takeaway', null, 'o-takeaway'), bill('b-lone', 's-gone', null)],
  tables: [{ id: 't-1', needs_cleaning: true }],
};

describe('batchSyncPayload', () => {
  it('sends everything in one request when it fits', () => {
    const batches = batchSyncPayload(payload);
    expect(batches).toHaveLength(1);
    expect(groupSyncPayload(batches[0]!)).toEqual(groupSyncPayload(payload));
    expect(batches[0]!.tables).toEqual(payload.tables);
  });

  it('splits between visits, never inside one, and keeps the order the cloud applies them in', () => {
    const batches = batchSyncPayload(payload, 1_000);
    expect(batches.length).toBeGreaterThan(1);
    // Regrouping each request gives back the original groups, in the original order.
    expect(batches.flatMap((b) => groupSyncPayload(b))).toEqual(groupSyncPayload(payload));
    // The closed visit goes before the open one, and table flags travel last.
    expect(batches[0]!.sessions.map((s) => s.id)).toEqual(['s-closed']);
    expect(batches.slice(0, -1).every((b) => b.tables.length === 0)).toBe(true);
    expect(batches.at(-1)!.tables).toEqual(payload.tables);
    // Only a single group may exceed the limit on its own.
    for (const b of batches) {
      const size = new TextEncoder().encode(JSON.stringify(b)).length;
      if (size > 1_000) expect(groupSyncPayload(b)).toHaveLength(1);
    }
  });
});

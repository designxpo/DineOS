// Realtime event contract (spec §9). Events are written to the outlet_events outbox with a
// per-outlet sequence and fanned out to socket rooms after the transaction commits.

export const EVENT_TYPES = [
  'order.placed',
  'order.status_changed',
  'order.updated',
  'item.stock_changed',
  'menu.updated',
  'table.state_changed',
  'tables.updated',
  'waiter.called',
  'bill.requested',
  'service_request.updated',
  'cart.updated',
  'session.closed',
  'bill.updated',
  'print.job',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/**
 * Channels inside an outlet. `outlet` reaches staff devices, `menu` reaches every open guest
 * menu, `session:{id}` reaches the guests of one table session, `print` reaches print agents.
 * Guests are addressed by session rather than table so that the next party at the same table
 * never receives the previous party's cart or orders.
 */
export type Channel = 'outlet' | 'menu' | 'print' | `session:${string}` | `station:${string}`;

export interface OutletEvent<P = unknown> {
  outlet_id: string;
  seq: number;
  type: EventType;
  channels: Channel[];
  payload: P;
  at: string;
}

/** Socket.IO room name, following the spec's `tenant:{id}:outlet:{id}[:...]` scheme. */
export function roomName(tenantId: string, outletId: string, channel: Channel): string {
  const base = `tenant:${tenantId}:outlet:${outletId}`;
  return channel === 'outlet' ? base : `${base}:${channel}`;
}

export const SOCKET_NAMESPACES = {
  staff: '/staff',
  guest: '/guest',
  device: '/device',
} as const;

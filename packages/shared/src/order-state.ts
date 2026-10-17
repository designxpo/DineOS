import type { ItemStatus, OrderStatus } from './enums';

const RANK: Record<ItemStatus, number> = {
  placed: 0,
  accepted: 1,
  preparing: 2,
  ready: 3,
  served: 4,
  cancelled: 99,
};

const TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  placed: ['accepted', 'rejected', 'cancelled'],
  accepted: ['preparing', 'ready', 'served', 'cancelled'],
  preparing: ['ready', 'served', 'cancelled'],
  ready: ['served', 'cancelled'],
  served: ['billed', 'cancelled'],
  billed: [],
  rejected: [],
  cancelled: [],
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Cancelling after the kitchen has the order is a manager decision (spec §5). */
export function cancelNeedsManager(from: OrderStatus): boolean {
  return from !== 'placed';
}

export function isTerminal(status: OrderStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

/** Items can move forward independently (one dish ready before another). */
export function canItemTransition(from: ItemStatus, to: ItemStatus): boolean {
  if (from === 'cancelled') return false;
  if (to === 'cancelled') return from !== 'served';
  return RANK[to] > RANK[from];
}

/**
 * The order status that follows from its items: the least-advanced active item wins,
 * so an order is `ready` only when every remaining item is ready.
 * Returns `cancelled` when every item is cancelled.
 */
export function deriveOrderStatus(items: readonly { status: ItemStatus }[]): OrderStatus {
  const active = items.filter((i) => i.status !== 'cancelled');
  if (active.length === 0) return 'cancelled';
  let min = active[0]!.status;
  for (const item of active) if (RANK[item.status] < RANK[min]) min = item.status;
  return min as OrderStatus;
}

/** Item status to apply when the whole order moves to `to`. Items already further along keep theirs. */
export function itemStatusForOrder(current: ItemStatus, to: OrderStatus): ItemStatus {
  if (current === 'cancelled') return current;
  if (to === 'cancelled' || to === 'rejected') return 'cancelled';
  if (to === 'billed') return current;
  const target = to as ItemStatus;
  return RANK[target] > RANK[current] ? target : current;
}

export interface ReadyItem {
  id: string;
  status: ItemStatus;
  station: string;
  name: string;
  qty: number;
}

/**
 * What a change made ready to serve: the stations whose whole part of the order is now ready
 * (the bar's drinks while the kitchen still cooks), and whether the whole order is. Null when
 * nothing new is waiting, e.g. one of three dishes from the same station.
 * `justReady`: the items this change moved to `ready`.
 */
export function readyNews(
  items: readonly ReadyItem[],
  justReady: ReadonlySet<string>,
): { stations: string[]; complete: boolean; items: { name: string; qty: number; station: string }[] } | null {
  const active = items.filter((i) => i.status !== 'cancelled');
  const done = (i: ReadyItem) => i.status === 'ready' || i.status === 'served';
  if (!active.some((i) => i.status === 'ready' && justReady.has(i.id))) return null;
  const complete = active.every(done);
  const stations = [...new Set(active.filter((i) => justReady.has(i.id)).map((i) => i.station))].filter((s) =>
    active.filter((i) => i.station === s).every(done),
  );
  if (!complete && stations.length === 0) return null;
  const waiting = active.filter((i) => i.status === 'ready' && (complete || stations.includes(i.station)));
  return { stations, complete, items: waiting.map((i) => ({ name: i.name, qty: i.qty, station: i.station })) };
}

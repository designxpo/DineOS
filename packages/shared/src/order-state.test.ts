import { describe, expect, it } from 'vitest';
import {
  canItemTransition,
  canTransition,
  cancelNeedsManager,
  deriveOrderStatus,
  itemStatusForOrder,
  itemWasMade,
  readyNews,
  type ReadyItem,
} from './order-state';

describe('order transitions', () => {
  it('follows the forward path', () => {
    expect(canTransition('placed', 'accepted')).toBe(true);
    expect(canTransition('accepted', 'preparing')).toBe(true);
    expect(canTransition('ready', 'served')).toBe(true);
    expect(canTransition('served', 'billed')).toBe(true);
  });
  it('allows rejection only from placed', () => {
    expect(canTransition('placed', 'rejected')).toBe(true);
    expect(canTransition('accepted', 'rejected')).toBe(false);
  });
  it('never leaves a terminal state', () => {
    expect(canTransition('cancelled', 'accepted')).toBe(false);
    expect(canTransition('billed', 'served')).toBe(false);
  });
  it('needs a manager to cancel after acceptance', () => {
    expect(cancelNeedsManager('placed')).toBe(false);
    expect(cancelNeedsManager('preparing')).toBe(true);
  });
});

describe('item status', () => {
  it('moves forward only', () => {
    expect(canItemTransition('accepted', 'ready')).toBe(true);
    expect(canItemTransition('ready', 'preparing')).toBe(false);
    expect(canItemTransition('served', 'cancelled')).toBe(false);
  });
  it('derives the order status from its least-advanced active item', () => {
    expect(
      deriveOrderStatus([{ status: 'ready' }, { status: 'preparing' }, { status: 'cancelled' }]),
    ).toBe('preparing');
    expect(deriveOrderStatus([{ status: 'ready' }, { status: 'cancelled' }])).toBe('ready');
    expect(deriveOrderStatus([{ status: 'cancelled' }])).toBe('cancelled');
  });
  it('carries order moves down to items without moving any backwards', () => {
    expect(itemStatusForOrder('placed', 'accepted')).toBe('accepted');
    expect(itemStatusForOrder('ready', 'preparing')).toBe('ready');
    expect(itemStatusForOrder('ready', 'rejected')).toBe('cancelled');
  });
});

describe('ready to serve', () => {
  const item = (id: string, station: string, status: ReadyItem['status']): ReadyItem => ({ id, station, status, name: id, qty: 1 });

  it('tells the floor when one station has finished its part', () => {
    const items = [item('mojito', 'bar', 'ready'), item('soda', 'bar', 'ready'), item('biryani', 'kitchen', 'preparing')];
    expect(readyNews(items, new Set(['soda']))).toEqual({
      stations: ['bar'],
      complete: false,
      items: [
        { name: 'mojito', qty: 1, station: 'bar' },
        { name: 'soda', qty: 1, station: 'bar' },
      ],
    });
  });

  it('stays quiet while the station still has dishes to make', () => {
    const items = [item('mojito', 'bar', 'ready'), item('soda', 'bar', 'preparing'), item('biryani', 'kitchen', 'preparing')];
    expect(readyNews(items, new Set(['mojito']))).toBeNull();
  });

  it('calls the whole order ready and lists only what is still waiting', () => {
    const items = [item('mojito', 'bar', 'served'), item('biryani', 'kitchen', 'ready'), item('naan', 'tandoor', 'cancelled')];
    expect(readyNews(items, new Set(['biryani']))).toEqual({
      stations: ['kitchen'],
      complete: true,
      items: [{ name: 'biryani', qty: 1, station: 'kitchen' }],
    });
  });

  it('says nothing when nothing became ready', () => {
    expect(readyNews([item('mojito', 'bar', 'served')], new Set())).toBeNull();
    expect(readyNews([item('mojito', 'bar', 'served')], new Set(['mojito']))).toBeNull();
  });
});

describe('cancelled dishes', () => {
  it('counts a dish as made once the kitchen has started it', () => {
    expect(['placed', 'accepted'].map((s) => itemWasMade(s as 'placed'))).toEqual([false, false]);
    expect(['preparing', 'ready', 'served'].map((s) => itemWasMade(s as 'ready'))).toEqual([true, true, true]);
  });
});

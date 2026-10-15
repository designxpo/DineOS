import { describe, expect, it } from 'vitest';
import {
  canItemTransition,
  canTransition,
  cancelNeedsManager,
  deriveOrderStatus,
  itemStatusForOrder,
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

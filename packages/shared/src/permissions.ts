import type { Role } from './enums';

export const ACTIONS = [
  'order.view',
  'order.create',
  'order.accept', // accept or reject a placed order
  'order.kitchen', // mark preparing / ready
  'order.serve',
  'order.edit_items',
  'order.cancel_after_accept',
  'menu.manage',
  'menu.stock',
  'table.manage', // create / edit tables, rotate QR
  'table.operate', // seat, transfer, merge, mark clean, assign waiter
  'service_request.handle',
  'bill.manage', // create, discount, split, finalise
  'bill.discount_large', // discount above the cashier limit
  'payment.record',
  'bill.void',
  'payment.refund',
  'report.view',
  'staff.manage',
  'outlet.settings',
  'device.manage',
  'audit.view',
  'customer.view',
  'customer.manage', // create customers (with consent), attach to bills, redeem points
  'customer.adjust', // manual point adjustments, erasure
  'reservation.manage',
  'inventory.manage', // ingredients, recipes, purchases
  'inventory.record', // wastage and stock counts
  'payment.reconcile', // match UPI payments against the bank statement
] as const;
export type Action = (typeof ACTIONS)[number];

const ALL: readonly Action[] = ACTIONS;

const MATRIX: Record<Role, readonly Action[]> = {
  owner: ALL,
  manager: ALL,
  cashier: [
    'order.view',
    'order.create',
    'order.accept',
    'order.serve',
    'order.edit_items',
    'menu.stock',
    'table.operate',
    'service_request.handle',
    'bill.manage',
    'payment.record',
    'customer.view',
    'customer.manage',
    'reservation.manage',
  ],
  waiter: [
    'order.view',
    'order.create',
    'order.accept',
    'order.serve',
    'order.edit_items',
    'table.operate',
    'service_request.handle',
    'customer.view',
    'reservation.manage',
  ],
  kitchen: ['order.view', 'order.kitchen', 'menu.stock', 'inventory.record'],
};

export function roleCan(role: Role, action: Action): boolean {
  return MATRIX[role].includes(action);
}

export function rolesCan(roles: readonly Role[], action: Action): boolean {
  return roles.some((r) => roleCan(r, action));
}

/** Wrong manager PINs in a row before that PIN locks, and for how long (guessing protection). */
export const PIN_MAX_ATTEMPTS = 5;
export const PIN_LOCK_MINUTES = 15;

/** Actions that need a manager's PIN when a lower role performs them (spec §8: voids and refunds). */
export const MANAGER_APPROVAL_ACTIONS = ['bill.void', 'payment.refund', 'order.cancel_after_accept', 'bill.discount_large'] as const;
export type ApprovalAction = (typeof MANAGER_APPROVAL_ACTIONS)[number];

/** Largest bill discount a cashier may give without approval, in basis points. */
export const CASHIER_DISCOUNT_LIMIT_BP = 1000;

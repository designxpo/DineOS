// Domain vocabulary shared by the API and every web surface.

export const ROLES = ['owner', 'manager', 'cashier', 'waiter', 'kitchen'] as const;
export type Role = (typeof ROLES)[number];

export const ORDER_TYPES = ['dine_in', 'takeaway', 'counter', 'delivery'] as const;
export type OrderType = (typeof ORDER_TYPES)[number];

/** Who delivers a delivery order. Zomato and Swiggy collect and pay its GST (CGST Act s. 9(5)). */
export const DELIVERY_CHANNELS = ['zomato', 'swiggy', 'own'] as const;
export type DeliveryChannel = (typeof DELIVERY_CHANNELS)[number];
export const OPERATOR_CHANNELS: readonly DeliveryChannel[] = ['zomato', 'swiggy'];

export const ORDER_SOURCES = ['guest_qr', 'waiter', 'pos'] as const;
export type OrderSource = (typeof ORDER_SOURCES)[number];

/** Forward path of an order. `billed` is set when its bill is finalised. */
export const ORDER_FLOW = ['placed', 'accepted', 'preparing', 'ready', 'served', 'billed'] as const;
export const ORDER_STATUSES = [...ORDER_FLOW, 'rejected', 'cancelled'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const ITEM_STATUSES = ['placed', 'accepted', 'preparing', 'ready', 'served', 'cancelled'] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

/** Order statuses that still need kitchen or floor attention. */
export const ACTIVE_ORDER_STATUSES: readonly OrderStatus[] = ['placed', 'accepted', 'preparing', 'ready'];

export const TABLE_STATES = [
  'vacant',
  'occupied',
  'ordered',
  'served',
  'bill_requested',
  'needs_cleaning',
] as const;
export type TableState = (typeof TABLE_STATES)[number];

export const TABLE_STATE_SOURCES = ['order', 'camera', 'staff', 'guest'] as const;
export type TableStateSource = (typeof TABLE_STATE_SOURCES)[number];

export const SESSION_STATUSES = ['pending', 'open', 'closed'] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

export const BILL_STATUSES = ['draft', 'finalised', 'paid', 'void'] as const;
export type BillStatus = (typeof BILL_STATUSES)[number];

/** `room`: charged to a hotel guest's room, collected by the hotel at checkout. */
/** `platform`: settled by Zomato's or Swiggy's payout, for their orders only. */
export const PAYMENT_METHODS = ['cash', 'upi', 'card_slip', 'other', 'room', 'platform'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const SERVICE_REQUEST_KINDS = ['call_waiter', 'bill'] as const;
export type ServiceRequestKind = (typeof SERVICE_REQUEST_KINDS)[number];

export const PRINT_JOB_KINDS = ['kot', 'bill', 'test'] as const;
export type PrintJobKind = (typeof PRINT_JOB_KINDS)[number];

export const TENANT_STATUSES = ['active', 'suspended', 'cancelled'] as const;
export type TenantStatus = (typeof TENANT_STATUSES)[number];

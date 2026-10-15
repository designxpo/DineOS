// Response shapes of the /v1 API. JSON is snake_case, money is integer paise, rates are basis points,
// timestamps are ISO strings. The API and every web surface code against these types.

import type {
  BillStatus,
  ItemStatus,
  OrderSource,
  OrderStatus,
  OrderType,
  PaymentMethod,
  Role,
  ServiceRequestKind,
  SessionStatus,
  TableState,
} from './enums';

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}

export type Translations = { hi?: { name?: string; description?: string } };

// ---------- Auth ----------

export interface MeDTO {
  user: { id: string; name: string; email: string | null; phone: string | null };
  tenant: { id: string; name: string; slug: string; status: string; branding: BrandingDTO };
  outlets: { id: string; name: string; roles: Role[] }[];
  /** Tenant-wide roles (outlet_id null), e.g. the owner. */
  tenant_roles: Role[];
  impersonated_by: string | null;
}

export interface LoginResponseDTO {
  token: string;
  expires_at: string;
  me: MeDTO;
}

export interface BrandingDTO {
  logo_url?: string | null;
  primary_color?: string | null;
}

// ---------- Outlet ----------

export interface OutletDTO {
  id: string;
  name: string;
  legal_name: string | null;
  address: string | null;
  city: string | null;
  state_code: string | null;
  phone: string | null;
  gstin: string | null;
  fssai_no: string | null;
  invoice_prefix: string;
  timezone: string;
  auto_accept: boolean;
  approve_flagged_orders: boolean;
  service_charge_bp: number;
  service_charge_tax_rate_bp: number;
  default_tax_rate_bp: number;
  prices_include_tax: boolean;
  kitchen_stations: string[];
  upi_vpa: string | null;
  upi_payee_name: string | null;
  status: string;
}

// ---------- Menu ----------

export interface ModifierDTO {
  id: string;
  group_id: string;
  name: string;
  price_delta_paise: number;
  is_veg: boolean;
  in_stock: boolean;
  sort: number;
  translations: Translations;
}

export interface ModifierGroupDTO {
  id: string;
  outlet_id: string;
  name: string;
  min_select: number;
  max_select: number;
  sort: number;
  modifiers: ModifierDTO[];
  translations: Translations;
}

export interface AvailabilitySchedule {
  /** 0 = Sunday. Empty or missing means every day. */
  days?: number[];
  /** "HH:MM" in outlet local time. */
  from?: string;
  to?: string;
}

export interface MenuCategoryDTO {
  id: string;
  outlet_id: string;
  name: string;
  sort: number;
  available_schedule: AvailabilitySchedule | null;
  /** Computed for the outlet's current local time. */
  available_now: boolean;
  is_active: boolean;
  translations: Translations;
}

export interface MenuItemDTO {
  id: string;
  outlet_id: string;
  category_id: string;
  name: string;
  description: string | null;
  photo_url: string | null;
  price_paise: number;
  is_veg: boolean;
  hsn_sac: string | null;
  tax_rate_bp: number;
  tags: string[];
  in_stock: boolean;
  station: string;
  sort: number;
  modifier_group_ids: string[];
  translations: Translations;
}

export interface MenuDTO {
  menu_version: number;
  categories: MenuCategoryDTO[];
  items: MenuItemDTO[];
  modifier_groups: ModifierGroupDTO[];
}

// ---------- Tables ----------

export interface ServiceRequestDTO {
  id: string;
  table_id: string;
  table_label: string;
  kind: ServiceRequestKind;
  status: 'open' | 'acknowledged' | 'closed';
  created_at: string;
  acknowledged_by: string | null;
}

export interface TableSessionDTO {
  id: string;
  status: SessionStatus;
  opened_at: string | null;
  guest_count: number | null;
  bill_requested_at: string | null;
  waiter_id: string | null;
}

export interface TableDTO {
  id: string;
  outlet_id: string;
  label: string;
  seats: number;
  zone: string | null;
  sort: number;
  state: TableState;
  needs_cleaning: boolean;
  assigned_waiter_id: string | null;
  assigned_waiter_name: string | null;
  qr_token_version: number;
  session: TableSessionDTO | null;
  /** Tables merged into this table's session (labels), when merged. */
  merged_with: string[];
  open_orders: number;
  running_total_paise: number;
  open_requests: ServiceRequestDTO[];
  is_active: boolean;
}

// ---------- Orders ----------

export interface ModifierSnapshot {
  modifier_id: string;
  group_name: string;
  name: string;
  price_delta_paise: number;
}

export interface OrderItemDTO {
  id: string;
  item_id: string;
  name: string;
  qty: number;
  /** Base price plus modifier deltas, per unit. */
  unit_price_paise: number;
  modifiers: ModifierSnapshot[];
  note: string | null;
  status: ItemStatus;
  station: string;
  seat_no: number | null;
  is_veg: boolean;
  cancelled_reason: string | null;
}

export interface OrderDTO {
  id: string;
  outlet_id: string;
  order_no: number;
  type: OrderType;
  status: OrderStatus;
  source: OrderSource;
  table_id: string | null;
  table_label: string | null;
  table_session_id: string | null;
  note: string | null;
  flagged: boolean;
  flag_reason: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  placed_at: string;
  accepted_at: string | null;
  ready_at: string | null;
  served_at: string | null;
  rejected_reason: string | null;
  cancelled_reason: string | null;
  created_by_name: string | null;
  items: OrderItemDTO[];
  /** Sum of active items before tax and discounts. */
  subtotal_paise: number;
}

/** What a guest sees about an order: no staff names, no internal flags. */
export interface GuestOrderDTO {
  id: string;
  order_no: number;
  status: OrderStatus;
  placed_at: string;
  rejected_reason: string | null;
  items: {
    id: string;
    name: string;
    qty: number;
    unit_price_paise: number;
    modifiers: string[];
    note: string | null;
    status: ItemStatus;
    is_veg: boolean;
  }[];
  subtotal_paise: number;
}

// ---------- Guest ----------

export interface CartLineDTO {
  line_id: string;
  item_id: string;
  qty: number;
  modifier_ids: string[];
  note: string | null;
  added_by: string;
}

export interface CartDTO {
  session_id: string;
  version: number;
  lines: CartLineDTO[];
}

export interface GuestJoinResponseDTO {
  guest_token: string;
  device_id: string;
  session_id: string;
}

export interface GuestContextDTO {
  tenant: { name: string; slug: string; branding: BrandingDTO };
  outlet: {
    id: string;
    name: string;
    /** Cacheable public menu, e.g. /public/menu/{tenant}/{outlet}; append ?v=<menu_version>. */
    menu_path: string;
    prices_include_tax: boolean;
    service_charge_bp: number;
    service_charge_tax_rate_bp: number;
    upi_vpa: string | null;
    upi_payee_name: string | null;
  };
  table: { id: string; label: string };
}

export interface GuestSessionDTO {
  context: GuestContextDTO;
  session: { id: string; status: SessionStatus; opened_at: string | null; bill_requested_at: string | null };
  cart: CartDTO;
  orders: GuestOrderDTO[];
  device_id: string;
  /** Latest outlet event sequence at the time of the read; resume realtime from here. */
  last_seq: number;
  bill: { total_paise: number; paid_paise: number; status: BillStatus } | null;
}

// ---------- Billing ----------

export interface BillLineDTO {
  id: string;
  order_item_id: string | null;
  name: string;
  qty: number;
  unit_price_paise: number;
  gross_paise: number;
  item_discount_paise: number;
  bill_discount_paise: number;
  taxable_paise: number;
  tax_rate_bp: number;
  cgst_paise: number;
  sgst_paise: number;
  amount_paise: number;
  hsn_sac: string | null;
  seat_no: number | null;
}

export interface PaymentDTO {
  id: string;
  bill_id: string;
  kind: 'payment' | 'refund';
  method: PaymentMethod;
  amount_paise: number;
  tendered_paise: number | null;
  change_paise: number | null;
  reference: string | null;
  confirmed_by_name: string | null;
  created_at: string;
}

export interface BillDTO {
  id: string;
  outlet_id: string;
  table_session_id: string | null;
  order_id: string | null;
  table_label: string | null;
  parent_bill_id: string | null;
  split_label: string | null;
  status: BillStatus;
  lines: BillLineDTO[];
  bill_discount: { kind: 'percent'; bp: number } | { kind: 'amount'; paise: number } | null;
  discount_reason: string | null;
  service_charge_bp: number;
  service_charge_waived: boolean;
  subtotal_paise: number;
  item_discount_paise: number;
  bill_discount_paise: number;
  service_charge_paise: number;
  taxable_paise: number;
  cgst_paise: number;
  sgst_paise: number;
  tax_total_paise: number;
  round_off_paise: number;
  total_paise: number;
  paid_paise: number;
  balance_paise: number;
  /** Planned shares when split by amount; payments are matched against these. */
  amount_shares: number[] | null;
  invoice_no: string | null;
  invoice_date: string | null;
  customer_name: string | null;
  customer_gstin: string | null;
  payments: PaymentDTO[];
  finalised_at: string | null;
  paid_at: string | null;
  voided_at: string | null;
  void_reason: string | null;
  created_at: string;
}

/** Everything a printed or on-screen GST invoice needs, frozen at finalisation. */
export interface InvoiceDTO {
  bill: BillDTO;
  outlet: {
    name: string;
    legal_name: string | null;
    address: string | null;
    gstin: string | null;
    fssai_no: string | null;
    phone: string | null;
    state_code: string | null;
  };
  tax_summary: { tax_rate_bp: number; taxable_paise: number; cgst_paise: number; sgst_paise: number }[];
}

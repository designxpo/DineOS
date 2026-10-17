// Response shapes of the /v1 API. JSON is snake_case, money is integer paise, rates are basis points,
// timestamps are ISO strings. The API and every web surface code against these types.

import type {
  BillStatus,
  CompReason,
  DeliveryChannel,
  ItemStatus,
  OrderSource,
  OrderStatus,
  OrderType,
  PaymentMethod,
  RewardSource,
  Role,
  ServiceRequestKind,
  SessionStatus,
  TableState,
} from './enums';
import type { EarnRule, LoyaltyConfig, MembershipBenefits, MembershipPlanInput, MembershipTemplateKey, ProgramTemplateKey, Reward, WalletPackInput } from './loyalty';
import type { CameraState } from './table-state';

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
  loyalty_enabled: boolean;
  loyalty_earn_bp: number;
  loyalty_point_value_paise: number;
  loyalty_min_redeem_points: number;
  reservation_minutes: number;
  inventory_auto_stockout: boolean;
  /** Print-agent device that runs as the outlet hub, and its LAN address for offline mode. */
  hub_device_id: string | null;
  hub_url: string | null;
  /** Hotel restaurants: bills can be charged to a guest's room. */
  room_charge_enabled: boolean;
  /** Commission each delivery platform takes, in basis points (2500 = 25%), for expected payouts. */
  delivery_commission_bp: Partial<Record<DeliveryChannel, number>>;
  /** A table counts as clean this many minutes after its guests leave; 0: staff mark it clean. */
  auto_clean_minutes: number;
  /** Bottled water left on tables: the menu item billed per opened bottle; null: no water check. */
  table_water_item_id: string | null;
  /** The owner's phone hears about free items worth at least this much; null: never. */
  comp_alert_paise: number | null;
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
  /** What staff type to find it fast ("PT"); set by the outlet. */
  short_code: string | null;
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
  /** The table's assigned waiter; their screen alerts, others just list it. */
  assigned_waiter_id: string | null;
}

export interface TableSessionDTO {
  id: string;
  status: SessionStatus;
  opened_at: string | null;
  guest_count: number | null;
  bill_requested_at: string | null;
  waiter_id: string | null;
  /** Bottled water opened at the table, as staff counted it; null until asked. */
  water_bottles?: number | null;
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
  /** When the last served order not yet on a bill was served (walkout watch). */
  last_served_at: string | null;
  /** When the oldest printed, still unpaid bill of this visit was printed (walkout watch). */
  unpaid_bill_since: string | null;
  /** Dishes and drinks of this visit sitting ready at the pass, not yet served. */
  ready_items: number;
  /**
   * Guests scanned the table QR but nobody has seated them or taken an order yet: since when.
   * Null once the visit is open, or when no phone at the table has been active for a while.
   */
  guests_since: string | null;
  /** When the table started waiting to be cleaned. */
  needs_cleaning_since: string | null;
  open_requests: ServiceRequestDTO[];
  is_active: boolean;
  /** Next booked reservation on this table today, within the next few hours. */
  next_reservation: { id: string; guest_name: string; party_size: number; slot_start: string } | null;
  /**
   * Latest camera reading for tables with a camera zone (Phase 3), null when stale or absent.
   * `occupied_since` with no open session means guests are seated and nobody has attended.
   */
  camera: { state: CameraState; confidence: number | null; at: string; occupied_since: string | null } | null;
}

// ---------- Cameras (Phase 3) ----------

export interface CameraDTO {
  id: string;
  outlet_id: string;
  device_id: string;
  device_name: string;
  name: string;
  rtsp_secret_ref: string;
  status: 'active' | 'disabled';
  online: boolean;
  last_seen_at: string | null;
  last_error: string | null;
  fps: number | null;
  snapshot_at: string | null;
  snapshot_width: number | null;
  snapshot_height: number | null;
  snapshot_requested_at: string | null;
  zones: { table_id: string; label: string; polygon: [number, number][] }[];
}

/** What the edge worker needs: its cameras, each table zone, and the detection settings. */
export interface VisionConfigDTO {
  device_id: string;
  outlet_id: string;
  cameras: {
    id: string;
    name: string;
    rtsp_secret_ref: string;
    snapshot_requested: boolean;
    zones: { table_id: string; label: string; polygon: [number, number][] }[];
  }[];
  settings: { fps: number; hold_seconds: number; resend_seconds: number; min_confidence: number };
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
  /** How many of this line were given free. */
  comp_qty?: number;
}

/**
 * `order.items_ready`: a station finished its part of an order (the bar's drinks), or the whole
 * order is ready to serve. `items` are the ones waiting at the pass.
 */
export interface ItemsReadyDTO {
  order_id: string;
  order_no: number;
  order_type: OrderType;
  channel: DeliveryChannel | null;
  channel_ref: string | null;
  table_id: string | null;
  table_label: string | null;
  assigned_waiter_id: string | null;
  stations: string[];
  complete: boolean;
  items: { name: string; qty: number; station: string }[];
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
  /** Delivery orders: who delivers, and the platform's own order number. */
  channel: DeliveryChannel | null;
  channel_ref: string | null;
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
  /** Sum of active items before tax and discounts, leaving out dishes given free. */
  subtotal_paise: number;
  /** Code of the link that lets the guest follow a counter or takeaway order (/o/{code}). */
  track_code?: string | null;
}

/** A counter or takeaway order as the guest follows it on their phone (no staff details). */
export interface TrackedOrderDTO {
  outlet_name: string;
  order_no: number;
  type: OrderType;
  status: OrderStatus;
  placed_at: string;
  ready_at: string | null;
  items: { name: string; qty: number }[];
}

/** The pickup screen by the counter: order numbers being made and ready to collect. */
export interface PickupBoardDTO {
  outlet_name: string;
  preparing: { order_no: number; label: string | null }[];
  ready: { order_no: number; label: string | null; ready_at: string | null }[];
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
  /**
   * Set once someone at the table has shared a phone number for loyalty. Only the last digits are
   * shown: guests are anonymous, so a typed number must not reveal whose it is or their balance.
   */
  /** Name and points only once the guest proved the number with a code sent by SMS. */
  customer:
    | { phone_last4: string; verified: false }
    | {
        phone_last4: string;
        verified: true;
        name: string | null;
        points: number;
        stamps: number;
        level: string | null;
        rewards: { label: string; valid_to: string | null }[];
        membership: { name: string; ends_at: string } | null;
        wallet_paise: number;
      }
    | null;
  /** `otp`: joining loyalty takes a code sent by SMS (MSG91 is set up). `summary`: the programme in a sentence. */
  loyalty: { enabled: boolean; earn: EarnRule['kind']; earn_bp: number; stamp_goal: number | null; summary: string | null; otp: boolean };
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
  /** Free (complimentary) part of the line: how many, their value, and the records behind it. */
  comp_qty: number;
  comp_paise: number;
  comps: { id: string; qty: number; reason: CompReason }[];
}

/** One free dish (or part of a line) and the record of why, for whom and who gave it. */
export interface CompDTO {
  id: string;
  order_item_id: string;
  item_name: string;
  qty: number;
  /** Menu value given away, and the ingredient cost from the recipe (null with no recipe). */
  value_paise: number;
  cost_paise: number | null;
  reason: CompReason;
  note: string | null;
  whole_bill: boolean;
  customer: { id: string; name: string | null; phone_last4: string } | null;
  given_by: string;
  approved_by: string | null;
  created_at: string;
  removed_at: string | null;
}

export interface CompReportDTO {
  from: string;
  to: string;
  totals: { count: number; items: number; value_paise: number; cost_paise: number; net_sales_paise: number };
  by_reason: { reason: CompReason; count: number; value_paise: number; cost_paise: number }[];
  by_staff: { user_id: string; name: string; count: number; value_paise: number }[];
  by_approver: { user_id: string; name: string; count: number; value_paise: number }[];
  by_guest: { customer_id: string; name: string | null; phone_last4: string; count: number; value_paise: number }[];
  rows: (CompDTO & { order_no: number; table_label: string | null; invoice_no: string | null })[];
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
  /** Room charges: the room and guest, and when the front desk posted it to the folio. */
  room_no: string | null;
  room_guest: string | null;
  room_posted_at: string | null;
}

export interface BillDTO {
  id: string;
  outlet_id: string;
  table_session_id: string | null;
  order_id: string | null;
  table_label: string | null;
  /** Table bills: bottled water opened at the table, as counted; null until asked. */
  water_bottles?: number | null;
  /** Value of the free (complimentary) items on the bill; part of the item discounts. */
  comp_paise: number;
  /** Counter and takeaway bills: the order number the guest collects with, and the code of the
   *  link that lets them follow the order (/o/{code}). */
  pickup_no?: number | null;
  track_code?: string | null;
  parent_bill_id: string | null;
  split_label: string | null;
  status: BillStatus;
  /** A Zomato or Swiggy order: the platform collects and pays the GST (s. 9(5)), so none is charged here. */
  tax_by_operator: boolean;
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
  customer: { id: string; name: string | null; phone: string; points: number; wallet_paise: number } | null;
  /** A membership sale: the bill's one line is the plan, and paying it starts the membership. */
  membership: { id: string; name: string; status: CustomerMembershipDTO['status']; starts_at: string | null; ends_at: string | null } | null;
  /** Money off from the guest's running membership (also in loyalty_discount_paise). */
  member_discount_paise: number;
  loyalty_points_redeemed: number;
  /** All loyalty money off: points redeemed, rewards (reward_discount_paise) and membership (member_discount_paise). */
  loyalty_discount_paise: number;
  loyalty_points_earned: number;
  reward_discount_paise: number;
  /** Rewards used on this bill: money off, and free dishes (also shown on their lines). */
  rewards: { id: string; label: string }[];
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

// ---------- Customers and loyalty (Phase 2) ----------

export interface CustomerDTO {
  id: string;
  phone: string;
  name: string | null;
  email: string | null;
  birthday: string | null;
  notes: string | null;
  consent_at: string;
  consent_source: 'staff' | 'guest';
  marketing_opt_in: boolean;
  visits: number;
  total_spend_paise: number;
  points: number;
  /** Towards the stamp card, when the programme has one. */
  stamps: number;
  /** Level name, when the programme has levels. */
  level: string | null;
  last_visit_at: string | null;
  created_at: string;
}

export interface LoyaltyEntryDTO {
  id: string;
  kind: 'earn' | 'redeem' | 'reverse' | 'adjust' | 'expire' | 'bonus';
  points: number;
  stamps: number;
  note: string | null;
  bill_id: string | null;
  invoice_no: string | null;
  created_at: string;
}

export type ProgramStatus = 'draft' | 'active' | 'paused';

export interface LoyaltyProgramDTO {
  id: string;
  name: string;
  template: ProgramTemplateKey | null;
  status: ProgramStatus;
  config: LoyaltyConfig;
  activated_at: string | null;
  updated_at: string;
  /** Guests holding points or stamps now: what switching the way guests earn would leave behind. */
  holders: { points_guests: number; points: number; stamps_guests: number };
}

export interface RewardDTO {
  id: string;
  source: RewardSource;
  label: string;
  reward: Reward;
  valid_from: string;
  valid_to: string | null;
  status: 'available' | 'applied' | 'used' | 'cancelled';
  bill_id: string | null;
}

/** Where a guest stands in the programme, for staff screens. */
export interface CustomerLoyaltyDTO {
  program: {
    name: string;
    earn: EarnRule['kind'];
    point_value_paise: number | null;
    min_redeem_points: number | null;
    stamp_goal: number | null;
    stamp_reward: string | null;
  } | null;
  points: number;
  stamps: number;
  level: { name: string; next: { name: string; visits: number | null; spend_paise: number | null } | null } | null;
  /** Ready to use now, or already on a draft bill. */
  rewards: RewardDTO[];
  /** Running, and bought but not yet paid for. */
  memberships: CustomerMembershipDTO[];
  wallet: { paid_paise: number; bonus_paise: number; expires_at: string | null };
}

export interface MembershipPlanDTO extends MembershipPlanInput {
  id: string;
  template: MembershipTemplateKey | null;
  is_active: boolean;
  /** Guests with this membership running now. */
  members: number;
}

export interface CustomerMembershipDTO {
  id: string;
  plan_id: string;
  name: string;
  status: 'pending' | 'active' | 'cancelled';
  starts_at: string | null;
  ends_at: string | null;
  benefits: MembershipBenefits;
  /** The bill it was sold on. */
  bill_id: string | null;
}

export interface WalletPackDTO extends WalletPackInput {
  id: string;
  is_active: boolean;
}

export interface WalletEntryDTO {
  id: string;
  kind: 'topup' | 'spend' | 'refund' | 'cash_out' | 'expire';
  paid_paise: number;
  bonus_paise: number;
  invoice_no: string | null;
  receipt_no: string | null;
  note: string | null;
  created_at: string;
}

export interface WalletDTO {
  paid_paise: number;
  bonus_paise: number;
  expires_at: string | null;
  ledger: WalletEntryDTO[];
}

export interface WalletTopupDTO {
  id: string;
  receipt_no: string;
  paid_paise: number;
  bonus_paise: number;
  wallet: { paid_paise: number; bonus_paise: number; expires_at: string | null };
}

/** The loyalty card on a bill: the guest's standing, and which lines each free-dish reward fits. */
export interface BillLoyaltyDTO extends CustomerLoyaltyDTO {
  eligible: Record<string, string[]>;
}

export interface LoyaltyReportDTO {
  from: string;
  to: string;
  members: { total: number; new: number; visited: number; repeat: number };
  /** Share of paid bills with a member on them, in basis points. */
  member_bill_share_bp: number;
  member_avg_bill_paise: number;
  guest_avg_bill_paise: number;
  points: { earned: number; redeemed: number; outstanding: number; outstanding_paise: number | null };
  rewards: { source: RewardSource; issued: number; used: number; value_paise: number; cost_paise: number }[];
  levels: { name: string; guests: number }[];
  memberships: { plan: string; sold: number; revenue_paise: number; active: number }[];
  /** Top-ups and spends in the dates; outstanding is what guests hold now. */
  wallet: { topped_up_paise: number; bonus_given_paise: number; spent_paise: number; outstanding_paid_paise: number; outstanding_bonus_paise: number };
}

// ---------- Screens: which settings each one is running ----------

export type ScreenKind = 'kitchen' | 'till' | 'floor' | 'orders' | 'bills' | 'other';

export interface ScreenDTO {
  id: string;
  label: string;
  kind: ScreenKind;
  user_name: string | null;
  device: string | null;
  applied_version: number | null;
  up_to_date: boolean;
  online: boolean;
  last_seen_at: string;
}

export interface PrintComputerStateDTO {
  id: string;
  name: string;
  applied_version: number | null;
  up_to_date: boolean;
  online: boolean;
  last_seen_at: string | null;
}

export interface ScreensDTO {
  config_version: number;
  /** Screens seen in the last day, the most recent first. */
  screens: ScreenDTO[];
  print_computers: PrintComputerStateDTO[];
}

// ---------- Reservations and waitlist (Phase 2) ----------

export type ReservationStatus = 'booked' | 'seated' | 'completed' | 'cancelled' | 'no_show';

export interface ReservationDTO {
  id: string;
  outlet_id: string;
  table_id: string | null;
  table_label: string | null;
  customer_id: string | null;
  guest_name: string;
  guest_phone: string | null;
  party_size: number;
  slot_start: string;
  slot_end: string;
  status: ReservationStatus;
  source: 'phone' | 'walk_in' | 'online' | 'other';
  notes: string | null;
  created_by_name: string | null;
  created_at: string;
}

export interface WaitlistEntryDTO {
  id: string;
  outlet_id: string;
  guest_name: string;
  guest_phone: string | null;
  party_size: number;
  quoted_minutes: number | null;
  status: 'waiting' | 'notified' | 'seated' | 'left';
  notes: string | null;
  table_label: string | null;
  created_at: string;
  notified_at: string | null;
  seated_at: string | null;
}

// ---------- Inventory (Phase 2) ----------

export const INGREDIENT_UNITS = ['g', 'kg', 'ml', 'l', 'pcs'] as const;
export type IngredientUnit = (typeof INGREDIENT_UNITS)[number];

export interface IngredientDTO {
  id: string;
  outlet_id: string;
  name: string;
  unit: IngredientUnit;
  stock_qty: number;
  reorder_level: number;
  /** Moving-average cost of one unit. */
  cost_per_unit_paise: number;
  is_active: boolean;
  low: boolean;
  used_by: number;
}

export type StockMovementType = 'purchase' | 'sale' | 'return' | 'wastage' | 'adjust' | 'count';

export interface StockMovementDTO {
  id: string;
  ingredient_id: string;
  ingredient_name: string;
  unit: IngredientUnit;
  type: StockMovementType;
  qty: number;
  unit_cost_paise: number | null;
  stock_after: number | null;
  supplier: string | null;
  note: string | null;
  created_by_name: string | null;
  created_at: string;
}

export interface RecipeLineDTO {
  ingredient_id: string;
  qty: number;
}

export interface RecipesDTO {
  items: Record<string, RecipeLineDTO[]>;
  modifiers: Record<string, RecipeLineDTO[]>;
}

// ---------- UPI reconciliation (Phase 4, no gateway) ----------

export interface ReconSummaryDTO {
  matched: number;
  matched_paise: number;
  /** UPI credits in the bank with no payment recorded in DineOS. */
  unrecorded_upi: number;
  unrecorded_upi_paise: number;
  /** Cash deposits, card settlements and other credits: shown, not flagged. */
  other_credits: number;
  dismissed: number;
  /** UPI payments staff confirmed that the bank never received. */
  missing: number;
  missing_paise: number;
}

export interface BankStatementDTO {
  id: string;
  outlet_id: string;
  file_name: string;
  period_from: string;
  period_to: string;
  credits: number;
  duplicates: number;
  uploaded_by_name: string | null;
  created_at: string;
  summary: ReconSummaryDTO;
}

export interface ReconPaymentDTO {
  id: string;
  /** Null for a wallet top-up, which has a receipt instead of an invoice. */
  bill_id: string | null;
  receipt_no: string | null;
  invoice_no: string | null;
  table_label: string | null;
  amount_paise: number;
  reference: string | null;
  confirmed_by_name: string | null;
  created_at: string;
}

/** What can be told about a UPI payment the bank shows no credit for. */
export interface MissingHints {
  /**
   * Payments of the same amount within a day that were matched on amount and date alone. Above 0,
   * the bank got fewer of this amount than staff recorded, and any of them may be the one it lacks.
   */
  lookalikes: number;
  /** A bank credit carries the UTR staff recorded, for this amount instead: the guest paid something else. */
  utr_credit_paise: number | null;
}

export interface BankCreditDTO {
  id: string;
  txn_date: string;
  amount_paise: number;
  narration: string;
  reference: string | null;
  utr: string | null;
  is_upi: boolean;
  match_kind: 'utr' | 'amount_date' | 'manual' | null;
  payment: ReconPaymentDTO | null;
  dismissed_reason: string | null;
}

export interface StatementDetailDTO {
  statement: BankStatementDTO;
  credits: BankCreditDTO[];
  /** UPI payments in the statement's dates with no bank credit; those on its last day may still post. */
  missing: (ReconPaymentDTO & MissingHints & { late_possible: boolean })[];
}

/** How the last few days of UPI payments stand against imported bank statements. */
export interface UpiCheckDTO {
  from: string;
  to: string;
  /** Last day any imported statement covers; null before the first import. */
  last_statement_to: string | null;
  /** Found in a statement. */
  checked: { count: number; amount_paise: number };
  /** A statement covers the day, and runs past it, with no matching credit: the bank never got it. */
  not_received: { count: number; amount_paise: number; payments: (ReconPaymentDTO & MissingHints)[] };
  /** No statement covers the day yet, or only as its last day (late payments post the next morning). */
  unchecked: { count: number; amount_paise: number; oldest_day: string | null };
}

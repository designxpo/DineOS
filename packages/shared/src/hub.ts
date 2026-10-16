// Contract between the cloud and the outlet hub (hybrid offline tier).
//
// While online the hub pulls a snapshot every minute: menu, tables, staff sessions (token hashes
// only), and the open tables with their orders and unpaid bills. When the internet drops, staff
// devices switch to the hub on the LAN and keep trading. When it returns, the hub pushes every
// session, order and bill it touched; the cloud upserts them by id, so a retry is harmless.

import type { InvoiceDTO, MeDTO, MenuDTO, ModifierSnapshot, OutletDTO } from './dto';
import type { ItemStatus, OrderSource, OrderStatus, OrderType, PaymentMethod, Role } from './enums';

export interface HubTable {
  id: string;
  label: string;
  seats: number;
  zone: string | null;
  sort: number;
  is_active: boolean;
  qr_token_version: number;
  needs_cleaning: boolean;
  assigned_waiter_id: string | null;
  current_session_id: string | null;
}

export interface HubStaff {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  /** Roles at this outlet, including tenant-wide ones. */
  roles: Role[];
  tenant_roles: Role[];
  /** sha256 of each live session token, so the hub can recognise signed-in staff offline. */
  sessions: { token_hash: string; expires_at: string }[];
}

export interface HubSession {
  id: string;
  table_id: string;
  status: 'open' | 'closed';
  opened_at: string | null;
  closed_at: string | null;
  guest_count: number | null;
  waiter_id: string | null;
  bill_requested_at: string | null;
}

export interface HubOrderItem {
  id: string;
  item_id: string;
  name: string;
  /** Menu price when ordered, before modifiers. */
  price_paise: number;
  unit_price_paise: number;
  modifiers: ModifierSnapshot[];
  is_veg: boolean;
  tax_rate_bp: number;
  hsn_sac: string | null;
  qty: number;
  note: string | null;
  status: ItemStatus;
  station: string;
  seat_no: number | null;
  cancelled_reason: string | null;
  position: number;
}

export interface HubOrder {
  id: string;
  table_session_id: string | null;
  table_id: string | null;
  order_no: number;
  /** Set on orders created by the hub, e.g. "H12". */
  offline_ref: string | null;
  business_date: string;
  type: OrderType;
  status: OrderStatus;
  source: OrderSource;
  note: string | null;
  flagged: boolean;
  customer_name: string | null;
  customer_phone: string | null;
  created_by: string | null;
  placed_at: string;
  accepted_at: string | null;
  ready_at: string | null;
  served_at: string | null;
  rejected_reason: string | null;
  cancelled_reason: string | null;
  items: HubOrderItem[];
}

export interface HubBillLine {
  order_item_id: string;
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

export interface HubPayment {
  id: string;
  method: PaymentMethod;
  amount_paise: number;
  tendered_paise: number | null;
  change_paise: number | null;
  reference: string | null;
  confirmed_by: string | null;
  created_at: string;
  room_no: string | null;
  room_guest: string | null;
}

export interface HubBill {
  id: string;
  table_session_id: string | null;
  order_id: string | null;
  status: 'draft' | 'finalised' | 'paid';
  invoice_series: 'main' | 'hub';
  fy_code: string | null;
  invoice_seq: number | null;
  invoice_no: string | null;
  invoice_date: string | null;
  service_charge_bp: number;
  service_charge_waived: boolean;
  service_charge_tax_rate_bp: number;
  subtotal_paise: number;
  item_discount_paise: number;
  bill_discount_paise: number;
  loyalty_discount_paise: number;
  service_charge_paise: number;
  taxable_paise: number;
  cgst_paise: number;
  sgst_paise: number;
  tax_total_paise: number;
  round_off_paise: number;
  total_paise: number;
  paid_paise: number;
  customer_name: string | null;
  customer_gstin: string | null;
  outlet_snapshot: InvoiceDTO['outlet'] | null;
  finalised_at: string | null;
  finalised_by: string | null;
  paid_at: string | null;
  created_at: string;
  lines: HubBillLine[];
  payments: HubPayment[];
}

export interface HubSnapshot {
  generated_at: string;
  device_id: string;
  /** The cloud staff app, for the "internet is back" link. */
  web_url: string | null;
  tenant: MeDTO['tenant'];
  outlet: OutletDTO;
  menu: MenuDTO;
  tables: HubTable[];
  staff: HubStaff[];
  live: { sessions: HubSession[]; orders: HubOrder[]; bills: HubBill[] };
  /** Highest offline invoice number already in the cloud, so a reinstalled hub never reuses one. */
  hub_invoices: { fy_code: string; last_seq: number }[];
}

export interface HubSyncPayload {
  sessions: HubSession[];
  orders: HubOrder[];
  /** Finalised and paid bills only; drafts are recomputed by whoever opens them next. */
  bills: HubBill[];
  /** Tables the hub marked clean or dirty. */
  tables: { id: string; needs_cleaning: boolean }[];
}

export interface HubSyncResult {
  applied: { sessions: string[]; orders: string[]; bills: string[]; tables: string[] };
  failed: { kind: 'session' | 'order' | 'bill' | 'table'; id: string; message: string }[];
}

/** One table visit, takeaway order or lone bill: the unit the cloud applies in one transaction. */
export interface HubSyncGroup {
  session?: HubSession;
  orders: HubOrder[];
  bills: HubBill[];
}

export function groupSyncPayload(p: HubSyncPayload): HubSyncGroup[] {
  const groups: HubSyncGroup[] = [];
  const usedOrders = new Set<string>();
  const usedBills = new Set<string>();
  // Closed visits first: a table the hub cleared and reseated must be released before the new
  // visit is attached, or the old visit's orders would be folded into the new one.
  const sessions = [...p.sessions].sort((a, b) => Number(a.status === 'open') - Number(b.status === 'open'));
  for (const session of sessions) {
    const orders = p.orders.filter((o) => o.table_session_id === session.id);
    const bills = p.bills.filter((b) => b.table_session_id === session.id);
    orders.forEach((o) => usedOrders.add(o.id));
    bills.forEach((b) => usedBills.add(b.id));
    groups.push({ session, orders, bills });
  }
  for (const order of p.orders.filter((o) => !usedOrders.has(o.id))) {
    const bills = p.bills.filter((b) => !usedBills.has(b.id) && b.order_id === order.id);
    bills.forEach((b) => usedBills.add(b.id));
    groups.push({ orders: [order], bills });
  }
  for (const bill of p.bills.filter((b) => !usedBills.has(b.id))) groups.push({ orders: [], bills: [bill] });
  return groups;
}

/**
 * Splits a sync into requests of at most `maxBytes` of JSON, because hosted platforms cap request
 * bodies (Vercel at 4.5 MB). Groups stay whole and in order, so the cloud applies them exactly as
 * it would one big request; table flags travel with the last request.
 */
export function batchSyncPayload(p: HubSyncPayload, maxBytes = 3_000_000): HubSyncPayload[] {
  const encoder = new TextEncoder();
  const batches: HubSyncPayload[] = [];
  let current: HubSyncPayload = { sessions: [], orders: [], bills: [], tables: [] };
  let size = 0;
  for (const group of groupSyncPayload(p)) {
    const bytes = encoder.encode(JSON.stringify(group)).length;
    if (size > 0 && size + bytes > maxBytes) {
      batches.push(current);
      current = { sessions: [], orders: [], bills: [], tables: [] };
      size = 0;
    }
    if (group.session) current.sessions.push(group.session);
    current.orders.push(...group.orders);
    current.bills.push(...group.bills);
    size += bytes;
  }
  current.tables = p.tables;
  batches.push(current);
  return batches;
}

/** Offline series: PREFIX + H, e.g. AGCH/2627/00012. Still at most 16 characters. */
export function formatHubInvoiceNo(prefix: string, fyCode: string, seq: number): string {
  return `${prefix}H/${fyCode}/${String(seq).padStart(5, '0')}`;
}

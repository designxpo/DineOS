import { sql } from 'kysely';
import type { MeDTO, ModifierSnapshot } from '@mezmitra/shared/dto';
import type { DeliveryChannel, ItemStatus, OrderSource, OrderStatus, OrderType, PaymentMethod, Role } from '@mezmitra/shared/enums';
import type { HubBill, HubOrder, HubSession, HubSnapshot, HubStaff, HubTable } from '@mezmitra/shared/hub';
import type { Tx } from '../../context';
import { shownBrand } from '../../lib/branding';
import { compQtyByItem } from '../billing/service';
import { loadMenu } from '../menu/service';
import { loadOutlet } from '../outlets/routes';

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const ACTIVE: OrderStatus[] = ['placed', 'accepted', 'preparing', 'ready', 'served'];

export async function loadHubOrders(tx: Tx, ids: readonly string[]): Promise<HubOrder[]> {
  if (!ids.length) return [];
  const [orders, items] = await Promise.all([
    tx.db.selectFrom('orders').selectAll().where('id', 'in', ids).orderBy('placed_at').execute(),
    tx.db.selectFrom('order_items').selectAll().where('order_id', 'in', ids).orderBy('position').execute(),
  ]);
  // Dishes already given free stay free if the outlet bills them on the hub during an outage.
  const free = await compQtyByItem(tx, items.map((i) => i.id));
  return orders.map((o) => ({
    id: o.id,
    table_session_id: o.table_session_id,
    table_id: o.table_id,
    order_no: o.order_no,
    offline_ref: o.offline_ref,
    business_date: o.business_date,
    type: o.type as OrderType,
    status: o.status as OrderStatus,
    source: o.source as OrderSource,
    note: o.note,
    flagged: o.flagged,
    customer_name: o.customer_name,
    customer_phone: o.customer_phone,
    channel: o.channel as DeliveryChannel | null,
    channel_ref: o.channel_ref,
    created_by: o.created_by,
    placed_at: o.placed_at.toISOString(),
    accepted_at: iso(o.accepted_at),
    ready_at: iso(o.ready_at),
    served_at: iso(o.served_at),
    rejected_reason: o.rejected_reason,
    cancelled_reason: o.cancelled_reason,
    items: items
      .filter((i) => i.order_id === o.id)
      .map((i) => ({
        id: i.id,
        item_id: i.item_id,
        name: i.name_snapshot,
        price_paise: i.price_snapshot_paise,
        unit_price_paise: i.unit_price_paise,
        modifiers: i.modifiers_snapshot as unknown as ModifierSnapshot[],
        is_veg: i.is_veg,
        tax_rate_bp: i.tax_rate_bp,
        hsn_sac: i.hsn_sac,
        qty: i.qty,
        note: i.note,
        status: i.status as ItemStatus,
        station: i.station,
        seat_no: i.seat_no,
        cancelled_reason: i.cancelled_reason,
        position: i.position,
        comp_qty: free.get(i.id) ?? 0,
      })),
  }));
}

export async function loadHubBills(tx: Tx, ids: readonly string[]): Promise<HubBill[]> {
  if (!ids.length) return [];
  const [bills, lines, payments] = await Promise.all([
    tx.db.selectFrom('bills').selectAll().where('id', 'in', ids).execute(),
    tx.db.selectFrom('bill_lines').selectAll().where('bill_id', 'in', ids).orderBy('created_at').execute(),
    tx.db.selectFrom('payments').selectAll().where('bill_id', 'in', ids).where('kind', '=', 'payment').orderBy('created_at').execute(),
  ]);
  return bills.map((b) => ({
    id: b.id,
    table_session_id: b.table_session_id,
    order_id: b.order_id,
    status: b.status as HubBill['status'],
    invoice_series: b.invoice_series as HubBill['invoice_series'],
    fy_code: b.fy_code,
    invoice_seq: b.invoice_seq,
    invoice_no: b.invoice_no,
    invoice_date: b.invoice_date,
    service_charge_bp: b.service_charge_bp,
    service_charge_waived: b.service_charge_waived,
    service_charge_tax_rate_bp: b.service_charge_tax_rate_bp,
    subtotal_paise: b.subtotal_paise,
    item_discount_paise: b.item_discount_paise,
    bill_discount_paise: b.bill_discount_paise,
    loyalty_discount_paise: b.loyalty_discount_paise,
    service_charge_paise: b.service_charge_paise,
    taxable_paise: b.taxable_paise,
    cgst_paise: b.cgst_paise,
    sgst_paise: b.sgst_paise,
    tax_total_paise: b.tax_total_paise,
    tax_by_operator: b.tax_by_operator,
    round_off_paise: b.round_off_paise,
    total_paise: b.total_paise,
    paid_paise: b.paid_paise,
    customer_name: b.customer_name,
    customer_gstin: b.customer_gstin,
    outlet_snapshot: b.outlet_snapshot as HubBill['outlet_snapshot'],
    finalised_at: iso(b.finalised_at),
    finalised_by: b.finalised_by,
    paid_at: iso(b.paid_at),
    created_at: b.created_at.toISOString(),
    lines: lines
      .filter((l) => l.bill_id === b.id)
      .map((l) => ({
        order_item_id: l.order_item_id!,
        name: l.name,
        qty: l.qty,
        unit_price_paise: l.unit_price_paise,
        gross_paise: l.gross_paise,
        item_discount_paise: l.item_discount_paise,
        bill_discount_paise: l.bill_discount_paise,
        taxable_paise: l.taxable_paise,
        tax_rate_bp: l.tax_rate_bp,
        cgst_paise: l.cgst_paise,
        sgst_paise: l.sgst_paise,
        amount_paise: l.amount_paise,
        hsn_sac: l.hsn_sac,
        seat_no: l.seat_no,
      })),
    payments: payments
      .filter((p) => p.bill_id === b.id)
      .map((p) => ({
        id: p.id,
        method: p.method as PaymentMethod,
        amount_paise: p.amount_paise,
        tendered_paise: p.tendered_paise,
        change_paise: p.change_paise,
        reference: p.reference,
        confirmed_by: p.confirmed_by,
        created_at: p.created_at.toISOString(),
        room_no: p.room_no,
        room_guest: p.room_guest,
      })),
  }));
}

/**
 * Everything the hub needs to run the outlet without the cloud. Staff sessions travel as token
 * hashes only; passwords and PINs never leave the cloud.
 */
export async function buildSnapshot(tx: Tx, outletId: string, deviceId: string, webUrl: string | null): Promise<HubSnapshot> {
  const outlet = await loadOutlet(tx, outletId);
  const tenantRow = await tx.db.selectFrom('tenants').select(['id', 'name', 'slug', 'status']).executeTakeFirstOrThrow();
  const brand = await shownBrand(tx);
  const tenant: MeDTO['tenant'] = { ...tenantRow, branding: brand.branding, white_label: brand.white_label };
  const menu = await loadMenu(tx, outletId);

  const tables: HubTable[] = (
    await tx.db
      .selectFrom('tables')
      .select(['id', 'label', 'seats', 'zone', 'sort', 'is_active', 'qr_token_version', 'needs_cleaning', 'assigned_waiter_id', 'current_session_id'])
      .where('outlet_id', '=', outletId)
      .orderBy('sort')
      .orderBy('label')
      .execute()
  ).map((t) => ({ ...t }));

  const roleRows = await tx.db
    .selectFrom('user_outlet_roles')
    .innerJoin('users', 'users.id', 'user_outlet_roles.user_id')
    .select(['users.id', 'users.name', 'users.email', 'users.phone', 'user_outlet_roles.role', 'user_outlet_roles.outlet_id'])
    .where('users.status', '=', 'active')
    .where((eb) => eb.or([eb('user_outlet_roles.outlet_id', '=', outletId), eb('user_outlet_roles.outlet_id', 'is', null)]))
    .execute();
  const byUser = new Map<string, HubStaff>();
  for (const r of roleRows) {
    const s = byUser.get(r.id) ?? { id: r.id, name: r.name, email: r.email, phone: r.phone, roles: [], tenant_roles: [], sessions: [] };
    if (!s.roles.includes(r.role as Role)) s.roles.push(r.role as Role);
    if (r.outlet_id === null && !s.tenant_roles.includes(r.role as Role)) s.tenant_roles.push(r.role as Role);
    byUser.set(r.id, s);
  }
  if (byUser.size) {
    const sessions = await tx.db
      .selectFrom('user_sessions')
      .select(['user_id', 'token_hash', 'expires_at'])
      .where('user_id', 'in', [...byUser.keys()])
      .where('expires_at', '>', new Date())
      // Support staff impersonating a tenant never get offline access.
      .where('impersonated_by', 'is', null)
      .execute();
    for (const s of sessions) byUser.get(s.user_id)!.sessions.push({ token_hash: s.token_hash, expires_at: s.expires_at.toISOString() });
  }

  const sessionRows = await tx.db
    .selectFrom('table_sessions')
    .select(['id', 'table_id', 'status', 'opened_at', 'closed_at', 'guest_count', 'waiter_id', 'bill_requested_at'])
    .where('outlet_id', '=', outletId)
    .where('status', '=', 'open')
    .execute();
  const sessions: HubSession[] = sessionRows.map((s) => ({
    ...s,
    status: 'open',
    opened_at: iso(s.opened_at),
    closed_at: iso(s.closed_at),
    bill_requested_at: iso(s.bill_requested_at),
  }));

  // Unpaid printed bills (the guest may pay while the internet is down) and their orders.
  const billIds = (
    await tx.db
      .selectFrom('bills')
      .select('id')
      .where('outlet_id', '=', outletId)
      .where('status', '=', 'finalised')
      // A membership starts when its bill is paid, which only the cloud can do.
      .where('membership_id', 'is', null)
      .where('finalised_at', '>', sql<Date>`now() - interval '7 days'`)
      .execute()
  ).map((b) => b.id);
  const bills = await loadHubBills(tx, billIds);
  const orderIds = (
    await tx.db
      .selectFrom('orders')
      .select('id')
      .where('outlet_id', '=', outletId)
      .where((eb) =>
        eb.or([
          ...(sessions.length ? [eb('table_session_id', 'in', sessions.map((s) => s.id))] : []),
          eb.and([eb('table_session_id', 'is', null), eb('status', 'in', ACTIVE)]),
          ...(bills.some((b) => b.order_id) ? [eb('id', 'in', bills.flatMap((b) => (b.order_id ? [b.order_id] : [])))] : []),
        ]),
      )
      .execute()
  ).map((o) => o.id);

  const hubInvoices = await tx.db
    .selectFrom('bills')
    .select((eb) => ['fy_code', eb.fn.max('invoice_seq').as('last_seq')])
    .where('outlet_id', '=', outletId)
    .where('invoice_series', '=', 'hub')
    .where('fy_code', 'is not', null)
    .groupBy('fy_code')
    .execute();

  return {
    generated_at: new Date().toISOString(),
    device_id: deviceId,
    web_url: webUrl,
    tenant,
    outlet,
    menu,
    tables,
    staff: [...byUser.values()],
    live: { sessions, orders: await loadHubOrders(tx, orderIds), bills },
    hub_invoices: hubInvoices.map((h) => ({ fy_code: h.fy_code!, last_seq: Number(h.last_seq ?? 0) })),
  };
}

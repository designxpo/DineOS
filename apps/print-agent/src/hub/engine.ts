// The outlet hub's own copy of the outlet: tables, orders, bills and payments made while the
// internet is down. It uses the same shared rules as the cloud (bill maths, order state, table
// state, permissions, menu checks) and produces the same DTOs, so the staff app cannot tell the
// difference. Everything it changes is marked for sync and sent to the cloud when it is back.

import { createHash, randomUUID } from 'node:crypto';
import { computeBill } from '@dineos/shared/billing';
import { businessDate, financialYear } from '@dineos/shared/dates';
import type { BillDTO, InvoiceDTO, ItemsReadyDTO, MeDTO, MenuDTO, ModifierSnapshot, OrderDTO, OutletDTO, PaymentDTO, TableDTO } from '@dineos/shared/dto';
import { ACTIVE_ORDER_STATUSES, type ItemStatus, type OrderSource, type OrderStatus, type OrderType, type PaymentMethod, type Role } from '@dineos/shared/enums';
import type { EventType, OutletEvent } from '@dineos/shared/events';
import { formatHubInvoiceNo, type HubBill, type HubOrder, type HubOrderItem, type HubSession, type HubSnapshot, type HubSyncPayload, type HubSyncResult } from '@dineos/shared/hub';
import { checkModifierSelection, isScheduleOpen } from '@dineos/shared/menu';
import { canItemTransition, cancelNeedsManager, canTransition, deriveOrderStatus, itemStatusForOrder, readyNews } from '@dineos/shared/order-state';
import { rolesCan, type Action } from '@dineos/shared/permissions';
import type { BillDoc, KotDoc, PrintDoc, PrinterConfig } from '@dineos/shared/print';
import { deriveTableState } from '@dineos/shared/table-state';

export class HubError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

const badRequest = (code: string, message: string, details?: unknown) => new HubError(400, code, message, details);
const conflict = (code: string, message: string, details?: unknown) => new HubError(409, code, message, details);
const notFound = (what: string) => new HubError(404, 'not_found', `${what} not found`);
const forbidden = (message = 'You do not have permission to do this') => new HubError(403, 'forbidden', message);
export const offlineUnsupported = () =>
  new HubError(503, 'offline_unsupported', 'Not available while the outlet is offline. It works again as soon as the internet is back.');

/** Hub orders are numbered 9001 upwards so they never look like the day's cloud orders. */
const HUB_ORDER_BASE = 9000;

export interface HubUser {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  roles: Role[];
  tenant_roles: Role[];
}

interface Rev {
  /** Bumped on every local change; synced up to `synced`. */
  rev: number;
  synced: number;
  origin: 'cloud' | 'hub';
}
export type LocalSession = HubSession & Rev;
export type LocalOrder = HubOrder & Rev;
export type LocalBill = HubBill & Rev;
export interface LocalTable {
  needs_cleaning: boolean;
  current_session_id: string | null;
  rev: number;
  synced: number;
}

export interface HubState {
  version: 1;
  snapshot: HubSnapshot | null;
  sessions: Record<string, LocalSession>;
  orders: Record<string, LocalOrder>;
  bills: Record<string, LocalBill>;
  tables: Record<string, LocalTable>;
  /** order:<date>, kot:<date>, invoice:<fy> */
  counters: Record<string, number>;
  events: OutletEvent[];
  last_seq: number;
  idempotency: Record<string, { at: number; status: number; body: unknown }>;
  sync: { at: string | null; error: string | null; failed: HubSyncResult['failed'] };
  /** Printer addresses from the portal, kept so the hub can print after a restart while offline. */
  printers: Record<string, PrinterConfig>;
}

export function emptyState(): HubState {
  return {
    version: 1,
    snapshot: null,
    sessions: {},
    orders: {},
    bills: {},
    tables: {},
    counters: {},
    events: [],
    last_seq: 0,
    idempotency: {},
    sync: { at: null, error: null, failed: [] },
    printers: {},
  };
}

export interface EngineHooks {
  print(target: string, doc: PrintDoc): void;
  emit(event: OutletEvent): void;
  /** Called after every change, before the response is sent: persist synchronously. */
  changed(): void;
  now?: () => Date;
}

export interface OrderLineInput {
  item_id: string;
  qty: number;
  modifier_ids?: string[];
  note?: string | null;
  seat_no?: number | null;
}

const dirty = (e: { rev: number; synced: number }) => e.rev > e.synced;
const lineName = (name: string, mods: ModifierSnapshot[]) => (mods.length ? `${name} (${mods.map((m) => m.name).join(', ')})` : name);

export class HubEngine {
  /** Whether the cloud answered recently; set by the hub's link. */
  online = false;

  constructor(
    public state: HubState,
    private readonly hooks: EngineHooks,
  ) {}

  private now(): Date {
    return this.hooks.now?.() ?? new Date();
  }

  get snap(): HubSnapshot {
    if (!this.state.snapshot) throw new HubError(503, 'hub_not_ready', 'The hub has not downloaded the outlet yet. Connect it to the internet once.');
    return this.state.snapshot;
  }

  get outletId(): string {
    return this.snap.outlet.id;
  }

  private commit(): void {
    this.hooks.changed();
  }

  private bump<T extends { rev: number }>(e: T): T {
    e.rev++;
    return e;
  }

  // ------------------------------------------------------------------ snapshot and sync

  /** Takes the cloud's view. Local data is only replaced once everything made here has synced. */
  applySnapshot(s: HubSnapshot): void {
    this.state.snapshot = s;
    for (const h of s.hub_invoices) {
      const key = `invoice:${h.fy_code}`;
      this.state.counters[key] = Math.max(this.state.counters[key] ?? 0, h.last_seq);
    }
    if (!this.hasPendingSync()) {
      const base = { rev: 0, synced: 0, origin: 'cloud' as const };
      this.state.sessions = Object.fromEntries(s.live.sessions.map((x) => [x.id, { ...x, ...base }]));
      this.state.orders = Object.fromEntries(s.live.orders.map((x) => [x.id, { ...x, ...base }]));
      this.state.bills = Object.fromEntries(s.live.bills.map((x) => [x.id, { ...x, ...base }]));
      this.state.tables = Object.fromEntries(s.tables.map((t) => [t.id, { needs_cleaning: t.needs_cleaning, current_session_id: t.current_session_id, rev: 0, synced: 0 }]));
    }
    this.commit();
  }

  hasPendingSync(): boolean {
    return (
      Object.values(this.state.sessions).some(dirty) ||
      Object.values(this.state.orders).some(dirty) ||
      Object.values(this.state.bills).some((b) => b.status !== 'draft' && dirty(b)) ||
      Object.values(this.state.tables).some(dirty)
    );
  }

  /** While the cloud is reachable and nothing is waiting to sync, the cloud is the place to work. */
  assertWritable(): void {
    if (this.online && !this.hasPendingSync()) {
      throw conflict('cloud_available', 'The internet is back. Switch back to DineOS to carry on.');
    }
  }

  buildSyncPayload(): { payload: HubSyncPayload; revs: Map<string, number> } {
    const revs = new Map<string, number>();
    const strip = <T extends Rev>(e: T) => {
      revs.set((e as unknown as { id: string }).id, e.rev);
      const { rev: _r, synced: _s, origin: _o, ...rest } = e;
      return rest;
    };
    return {
      payload: {
        sessions: Object.values(this.state.sessions).filter(dirty).map(strip),
        orders: Object.values(this.state.orders).filter(dirty).map(strip),
        bills: Object.values(this.state.bills)
          .filter((b) => b.status !== 'draft' && dirty(b))
          .map(strip),
        tables: Object.entries(this.state.tables)
          .filter(([, t]) => dirty(t))
          .map(([id, t]) => {
            revs.set(id, t.rev);
            return { id, needs_cleaning: t.needs_cleaning };
          }),
      },
      revs,
    };
  }

  /** Marks what the cloud accepted, up to the revision that was sent (later edits stay pending). */
  markSynced(result: HubSyncResult, revs: Map<string, number>): void {
    const mark = (e: { rev: number; synced: number } | undefined, id: string) => {
      if (e) e.synced = Math.max(e.synced, revs.get(id) ?? e.synced);
    };
    result.applied.sessions.forEach((id) => mark(this.state.sessions[id], id));
    result.applied.orders.forEach((id) => mark(this.state.orders[id], id));
    result.applied.bills.forEach((id) => mark(this.state.bills[id], id));
    result.applied.tables.forEach((id) => mark(this.state.tables[id], id));
    this.state.sync = { at: this.now().toISOString(), error: result.failed.length ? `${result.failed.length} item(s) refused` : null, failed: result.failed };
    this.commit();
  }

  // ------------------------------------------------------------------ auth

  /** Recognises a staff session the cloud issued, by its hash. Passwords never reach the hub. */
  authenticate(token: string): HubUser | null {
    if (!this.state.snapshot || !token.startsWith('st_')) return null;
    const hash = createHash('sha256').update(token).digest('hex');
    const now = this.now().getTime();
    for (const s of this.state.snapshot.staff) {
      if (s.sessions.some((x) => x.token_hash === hash && Date.parse(x.expires_at) > now)) {
        return { id: s.id, name: s.name, email: s.email, phone: s.phone, roles: s.roles, tenant_roles: s.tenant_roles };
      }
    }
    return null;
  }

  private assertCan(user: HubUser, action: Action): void {
    if (!rolesCan(user.roles, action)) throw forbidden();
  }

  private assertOutlet(outletId: string | undefined): void {
    if (outletId && outletId !== this.outletId) throw notFound('Outlet');
  }

  me(user: HubUser): MeDTO {
    return {
      user: { id: user.id, name: user.name, email: user.email, phone: user.phone },
      tenant: this.snap.tenant,
      outlets: [{ id: this.outletId, name: this.snap.outlet.name, roles: user.roles }],
      tenant_roles: user.tenant_roles,
      impersonated_by: null,
    };
  }

  outlet(id: string): OutletDTO {
    this.assertOutlet(id);
    return this.snap.outlet;
  }

  menu(outletId: string): MenuDTO {
    this.assertOutlet(outletId);
    return this.snap.menu;
  }

  // ------------------------------------------------------------------ events

  private emit(type: EventType, payload: unknown): void {
    const event: OutletEvent = { outlet_id: this.outletId, seq: ++this.state.last_seq, type, channels: ['outlet'], payload, at: this.now().toISOString() };
    this.state.events.push(event);
    if (this.state.events.length > 1000) this.state.events.splice(0, this.state.events.length - 1000);
    this.hooks.emit(event);
  }

  events(since: number): { events: OutletEvent[]; last_seq: number; truncated: boolean } {
    const first = this.state.events[0]?.seq ?? this.state.last_seq + 1;
    if (since >= this.state.last_seq) return { events: [], last_seq: this.state.last_seq, truncated: false };
    return { events: this.state.events.filter((e) => e.seq > since), last_seq: this.state.last_seq, truncated: since < first - 1 };
  }

  // ------------------------------------------------------------------ tables

  private staffName(id: string | null): string | null {
    return id ? (this.snap.staff.find((s) => s.id === id)?.name ?? null) : null;
  }

  private tableLabel(id: string | null): string | null {
    return id ? (this.snap.tables.find((t) => t.id === id)?.label ?? null) : null;
  }

  private tableFlags(id: string): LocalTable {
    const t = this.state.tables[id];
    if (t) return t;
    const meta = this.snap.tables.find((x) => x.id === id);
    if (!meta) throw notFound('Table');
    return (this.state.tables[id] = { needs_cleaning: meta.needs_cleaning, current_session_id: meta.current_session_id, rev: 0, synced: 0 });
  }

  private liveSession(tableId: string): LocalSession | null {
    const sid = this.tableFlags(tableId).current_session_id;
    const s = sid ? this.state.sessions[sid] : undefined;
    return s && s.status === 'open' ? s : null;
  }

  private sessionOrders(sessionId: string): LocalOrder[] {
    return Object.values(this.state.orders).filter((o) => o.table_session_id === sessionId);
  }

  tables(outletId: string): TableDTO[] {
    this.assertOutlet(outletId);
    return this.snap.tables.map((t) => {
      const flags = this.tableFlags(t.id);
      const session = this.liveSession(t.id);
      const orders = session ? this.sessionOrders(session.id) : [];
      const counted = orders.filter((o) => o.status !== 'rejected' && o.status !== 'cancelled');
      const served = orders.flatMap((o) => (o.status === 'served' && o.served_at ? [o.served_at] : [])).sort();
      const unpaid = session
        ? Object.values(this.state.bills)
            .flatMap((b) => (b.table_session_id === session.id && b.status === 'finalised' && b.finalised_at ? [b.finalised_at] : []))
            .sort()
        : [];
      return {
        id: t.id,
        outlet_id: this.outletId,
        label: t.label,
        seats: t.seats,
        zone: t.zone,
        sort: t.sort,
        state: deriveTableState({
          needsCleaning: flags.needs_cleaning,
          session: session ? { status: session.status, bill_requested_at: session.bill_requested_at } : null,
          orderStatuses: orders.map((o) => o.status),
        }),
        needs_cleaning: flags.needs_cleaning,
        assigned_waiter_id: t.assigned_waiter_id,
        assigned_waiter_name: this.staffName(t.assigned_waiter_id),
        qr_token_version: t.qr_token_version,
        session: session
          ? { id: session.id, status: session.status, opened_at: session.opened_at, guest_count: session.guest_count, bill_requested_at: session.bill_requested_at, waiter_id: session.waiter_id }
          : null,
        merged_with: [],
        open_orders: orders.filter((o) => ACTIVE_ORDER_STATUSES.includes(o.status)).length,
        running_total_paise: counted.reduce((a, o) => a + this.orderSubtotal(o), 0),
        last_served_at: served.at(-1) ?? null,
        unpaid_bill_since: unpaid[0] ?? null,
        ready_items: orders
          .filter((o) => ACTIVE_ORDER_STATUSES.includes(o.status))
          .flatMap((o) => o.items)
          .reduce((n, i) => n + (i.status === 'ready' ? i.qty : 0), 0),
        open_requests: [],
        is_active: t.is_active,
        next_reservation: null,
        // Camera readings go to the cloud; offline, the hub works from orders alone.
        camera: null,
      };
    });
  }

  private tableDto(id: string): TableDTO {
    return this.tables(this.outletId).find((t) => t.id === id)!;
  }

  /** Opens (or returns) the table's visit. */
  private openSession(tableId: string, opts: { guestCount?: number | null; waiterId?: string | null } = {}): LocalSession {
    const meta = this.snap.tables.find((t) => t.id === tableId);
    if (!meta || !meta.is_active) throw badRequest('invalid_table', 'Table is not in this outlet');
    const flags = this.tableFlags(tableId);
    let s = this.liveSession(tableId);
    if (!s) {
      s = {
        id: randomUUID(),
        table_id: tableId,
        status: 'open',
        opened_at: this.now().toISOString(),
        closed_at: null,
        guest_count: opts.guestCount ?? null,
        waiter_id: opts.waiterId ?? null,
        bill_requested_at: null,
        rev: 1,
        synced: 0,
        origin: 'hub',
      };
      this.state.sessions[s.id] = s;
      flags.current_session_id = s.id;
      flags.needs_cleaning = false;
      this.bump(flags);
    } else if (opts.guestCount != null || opts.waiterId != null) {
      if (opts.guestCount != null) s.guest_count = opts.guestCount;
      if (opts.waiterId != null) s.waiter_id = opts.waiterId;
      this.bump(s);
    }
    return s;
  }

  private closeSession(s: LocalSession, cleaning: boolean): void {
    s.status = 'closed';
    s.closed_at = this.now().toISOString();
    this.bump(s);
    const flags = this.tableFlags(s.table_id);
    if (flags.current_session_id === s.id) {
      flags.current_session_id = null;
      if (cleaning) flags.needs_cleaning = true;
      this.bump(flags);
    }
    this.emit('session.closed', { session_id: s.id });
    this.emit('tables.updated', {});
  }

  seatTable(user: HubUser, tableId: string, body: { guest_count?: number; waiter_id?: string | null }): TableDTO {
    this.assertWritable();
    this.assertCan(user, 'table.operate');
    this.openSession(tableId, { guestCount: body.guest_count ?? null, waiterId: body.waiter_id ?? user.id });
    this.emit('tables.updated', {});
    this.commit();
    return this.tableDto(tableId);
  }

  cleanTable(user: HubUser, tableId: string): TableDTO {
    this.assertWritable();
    this.assertCan(user, 'table.operate');
    const flags = this.tableFlags(tableId);
    if (flags.needs_cleaning) {
      flags.needs_cleaning = false;
      this.bump(flags);
      this.emit('tables.updated', {});
      this.commit();
    }
    return this.tableDto(tableId);
  }

  /** Frees a table nobody ordered at (seated by mistake). */
  releaseTable(user: HubUser, tableId: string): TableDTO {
    this.assertWritable();
    this.assertCan(user, 'table.operate');
    const s = this.liveSession(tableId);
    if (s) {
      if (this.sessionOrders(s.id).some((o) => o.status !== 'rejected' && o.status !== 'cancelled')) {
        throw conflict('table_has_orders', 'This table has orders; settle the bill instead');
      }
      this.closeSession(s, false);
      this.commit();
    }
    return this.tableDto(tableId);
  }

  // ------------------------------------------------------------------ orders

  private orderSubtotal(o: HubOrder): number {
    return o.items.filter((i) => i.status !== 'cancelled').reduce((a, i) => a + i.unit_price_paise * i.qty, 0);
  }

  orderDto(o: HubOrder): OrderDTO {
    return {
      id: o.id,
      outlet_id: this.outletId,
      order_no: o.order_no,
      type: o.type,
      status: o.status,
      source: o.source,
      table_id: o.table_id,
      table_label: this.tableLabel(o.table_id),
      table_session_id: o.table_session_id,
      channel: o.channel ?? null,
      channel_ref: o.channel_ref ?? null,
      note: o.note,
      flagged: o.flagged,
      flag_reason: null,
      customer_name: o.customer_name,
      customer_phone: o.customer_phone,
      placed_at: o.placed_at,
      accepted_at: o.accepted_at,
      ready_at: o.ready_at,
      served_at: o.served_at,
      rejected_reason: o.rejected_reason,
      cancelled_reason: o.cancelled_reason,
      created_by_name: this.staffName(o.created_by),
      items: o.items.map((i) => ({
        id: i.id,
        item_id: i.item_id,
        name: i.name,
        qty: i.qty,
        unit_price_paise: i.unit_price_paise,
        modifiers: i.modifiers,
        note: i.note,
        status: i.status,
        station: i.station,
        seat_no: i.seat_no,
        is_veg: i.is_veg,
        cancelled_reason: i.cancelled_reason,
      })),
      subtotal_paise: this.orderSubtotal(o),
    };
  }

  private order(id: string): LocalOrder {
    const o = this.state.orders[id];
    if (!o) throw notFound('Order');
    return o;
  }

  listOrders(q: { outlet_id: string; status?: string; table_session_id?: string; since?: string; limit?: number }): OrderDTO[] {
    this.assertOutlet(q.outlet_id);
    const statuses = q.status?.split(',').filter(Boolean) ?? [];
    const since = q.since ? Date.parse(q.since) : statuses.length || q.table_session_id ? 0 : this.now().getTime() - 86_400_000;
    return Object.values(this.state.orders)
      .filter((o) => (!statuses.length || statuses.includes(o.status)) && (!q.table_session_id || o.table_session_id === q.table_session_id) && Date.parse(o.placed_at) >= since)
      .sort((a, b) => b.placed_at.localeCompare(a.placed_at))
      .slice(0, q.limit ?? 100)
      .map((o) => this.orderDto(o));
  }

  getOrder(id: string): OrderDTO {
    return this.orderDto(this.order(id));
  }

  kds(outletId: string, station?: string): OrderDTO[] {
    this.assertOutlet(outletId);
    const orders = Object.values(this.state.orders)
      .filter((o) => ['accepted', 'preparing', 'ready'].includes(o.status))
      .sort((a, b) => (a.accepted_at ?? a.placed_at).localeCompare(b.accepted_at ?? b.placed_at))
      .map((o) => this.orderDto(o));
    if (!station) return orders;
    return orders
      .map((o) => ({ ...o, items: o.items.filter((i) => i.station === station) }))
      .filter((o) => o.items.some((i) => i.status !== 'cancelled' && i.status !== 'served'));
  }

  /** Same checks as the cloud: on the menu, in stock, served now, valid choices. */
  private prepareLines(lines: readonly OrderLineInput[]): Omit<HubOrderItem, 'id' | 'status' | 'position' | 'cancelled_reason'>[] {
    if (!lines.length) throw badRequest('empty_order', 'Add at least one item');
    const menu = this.snap.menu;
    const problems: { item_id: string; reason: string; message: string }[] = [];
    const out: Omit<HubOrderItem, 'id' | 'status' | 'position' | 'cancelled_reason'>[] = [];
    for (const line of lines) {
      const item = menu.items.find((i) => i.id === line.item_id);
      const category = item && menu.categories.find((c) => c.id === item.category_id);
      if (!item || !category || !category.is_active) {
        problems.push({ item_id: line.item_id, reason: 'not_found', message: 'This item is no longer on the menu' });
        continue;
      }
      if (!item.in_stock) {
        problems.push({ item_id: item.id, reason: 'out_of_stock', message: `${item.name} just ran out` });
        continue;
      }
      if (!isScheduleOpen(category.available_schedule, this.now(), this.snap.outlet.timezone)) {
        problems.push({ item_id: item.id, reason: 'not_available_now', message: `${item.name} is not served right now` });
        continue;
      }
      const groups = menu.modifier_groups.filter((g) => item.modifier_group_ids.includes(g.id));
      const selected = line.modifier_ids ?? [];
      const check = checkModifierSelection(
        groups.map((g) => ({ id: g.id, name: g.name, min_select: g.min_select, max_select: g.max_select, modifiers: g.modifiers.map((m) => ({ id: m.id, in_stock: m.in_stock })) })),
        selected,
      );
      if (!check.ok) {
        problems.push({ item_id: item.id, reason: check.code, message: check.message });
        continue;
      }
      const mods: ModifierSnapshot[] = selected.map((id) => {
        const g = groups.find((x) => x.modifiers.some((m) => m.id === id))!;
        const m = g.modifiers.find((x) => x.id === id)!;
        return { modifier_id: m.id, group_name: g.name, name: m.name, price_delta_paise: m.price_delta_paise };
      });
      out.push({
        item_id: item.id,
        name: item.name,
        price_paise: item.price_paise,
        unit_price_paise: item.price_paise + mods.reduce((a, m) => a + m.price_delta_paise, 0),
        modifiers: mods,
        is_veg: item.is_veg,
        tax_rate_bp: item.tax_rate_bp,
        hsn_sac: item.hsn_sac,
        qty: line.qty,
        note: line.note?.trim() || null,
        station: item.station,
        seat_no: line.seat_no ?? null,
      });
    }
    if (problems.length) {
      throw conflict('items_unavailable', problems.length === 1 ? problems[0]!.message : 'Some items are no longer available', { items: problems });
    }
    return out;
  }

  private next(key: string): number {
    this.state.counters[key] = (this.state.counters[key] ?? 0) + 1;
    return this.state.counters[key]!;
  }

  private today(): string {
    return businessDate(this.now(), this.snap.outlet.timezone);
  }

  /** One kitchen ticket per station, printed straight to the outlet's printers. */
  private printKots(o: HubOrder, itemIds: readonly string[], opts: { cancelled?: boolean; reprint?: boolean } = {}): void {
    const wanted = new Set(itemIds);
    const items = o.items.filter((i) => wanted.has(i.id) && (opts.cancelled || i.status !== 'cancelled'));
    const stations = [...new Set(items.map((i) => i.station))];
    for (const station of stations) {
      const doc: KotDoc = {
        kind: 'kot',
        outlet_name: this.snap.outlet.name,
        kot_no: this.next(`kot:${this.today()}`),
        order_no: o.order_no,
        station,
        table_label: this.tableLabel(o.table_id),
        order_type: o.type,
        placed_at: o.placed_at,
        items: items.filter((i) => i.station === station).map((i) => ({ name: i.name, qty: i.qty, modifiers: i.modifiers.map((m) => m.name), note: i.note, seat_no: i.seat_no })),
        note: o.note,
        cancelled: opts.cancelled ?? false,
        reprint: opts.reprint ?? false,
      };
      this.hooks.print(station, doc);
    }
  }

  createOrder(
    user: HubUser,
    body: {
      outlet_id: string;
      type: OrderType;
      source?: 'waiter' | 'pos';
      table_id?: string;
      lines: OrderLineInput[];
      note?: string | null;
      customer_name?: string | null;
      customer_phone?: string | null;
      guest_count?: number;
    },
  ): OrderDTO {
    this.assertWritable();
    this.assertOutlet(body.outlet_id);
    this.assertCan(user, 'order.create');
    if (body.type === 'dine_in' && !body.table_id) throw badRequest('session_required', 'Pick a table for dine-in');
    if (body.type === 'delivery') throw badRequest('online_only', 'Enter delivery orders once the internet is back');
    const prepared = this.prepareLines(body.lines);
    const session = body.type === 'dine_in' ? this.openSession(body.table_id!, { guestCount: body.guest_count ?? null, waiterId: user.id }) : null;
    const now = this.now().toISOString();
    const day = this.today();
    const n = this.next(`order:${day}`);
    const order: LocalOrder = {
      id: randomUUID(),
      table_session_id: session?.id ?? null,
      table_id: session?.table_id ?? null,
      order_no: HUB_ORDER_BASE + n,
      offline_ref: `H${n}`,
      business_date: day,
      type: body.type,
      status: 'accepted',
      source: (body.source ?? 'pos') as OrderSource,
      note: body.note?.trim() || null,
      flagged: false,
      customer_name: body.customer_name?.trim() || null,
      customer_phone: body.customer_phone?.trim() || null,
      created_by: user.id,
      placed_at: now,
      accepted_at: now,
      ready_at: null,
      served_at: null,
      rejected_reason: null,
      cancelled_reason: null,
      items: prepared.map((p, position) => ({ ...p, id: randomUUID(), status: 'accepted' as ItemStatus, position, cancelled_reason: null })),
      rev: 1,
      synced: 0,
      origin: 'hub',
    };
    this.state.orders[order.id] = order;
    // A new order supersedes an earlier bill request.
    if (session?.bill_requested_at) {
      session.bill_requested_at = null;
      this.bump(session);
    }
    this.printKots(order, order.items.map((i) => i.id));
    const dto = this.orderDto(order);
    this.emit('order.placed', { order: dto });
    if (session) this.emit('tables.updated', {});
    this.commit();
    return dto;
  }

  private actionFor(to: OrderStatus): Action {
    if (to === 'preparing' || to === 'ready') return 'order.kitchen';
    if (to === 'served') return 'order.serve';
    return 'order.accept';
  }

  transitionOrder(user: HubUser, id: string, to: OrderStatus, reason?: string | null): OrderDTO {
    this.assertWritable();
    const o = this.order(id);
    const from = o.status;
    if (to === 'billed') throw badRequest('invalid_transition', 'Orders are marked billed when their bill is finalised');
    if (!canTransition(from, to)) throw conflict('invalid_transition', `Cannot move an order from ${from} to ${to}`, { from, to });
    const why = reason?.trim() || null;
    if (to === 'cancelled') {
      if (!why) throw badRequest('reason_required', 'Give a reason for cancelling');
      // Manager PINs cannot be checked offline, so only a manager can cancel what the kitchen has.
      if (cancelNeedsManager(from) ? !rolesCan(user.roles, 'order.cancel_after_accept') : !rolesCan(user.roles, 'order.accept')) {
        throw forbidden('A manager has to cancel this while the outlet is offline');
      }
    } else {
      this.assertCan(user, this.actionFor(to));
      if (to === 'rejected' && !why) throw badRequest('reason_required', 'Tell the guest why the order was rejected');
    }
    const now = this.now().toISOString();
    o.status = to;
    if (to === 'accepted') o.accepted_at = now;
    if (to === 'ready') o.ready_at = now;
    if (to === 'served') o.served_at = now;
    if (to === 'rejected') o.rejected_reason = why;
    if (to === 'cancelled') o.cancelled_reason = why;
    const justReady = new Set<string>();
    for (const item of o.items) {
      const next = itemStatusForOrder(item.status, to);
      if (next === 'ready' && next !== item.status) justReady.add(item.id);
      if (next !== item.status) {
        item.status = next;
        if (next === 'cancelled' && why) item.cancelled_reason = why;
      }
    }
    this.bump(o);
    if (to === 'accepted') this.printKots(o, o.items.filter((i) => i.status !== 'cancelled').map((i) => i.id));
    if (to === 'cancelled' && from !== 'placed') this.printKots(o, o.items.map((i) => i.id), { cancelled: true });
    const dto = this.orderDto(o);
    this.emit('order.status_changed', { order_id: o.id, status: o.status, order: dto });
    this.announceReady(dto, justReady);
    if (o.table_id) this.emit('tables.updated', {});
    this.commit();
    return dto;
  }

  /** Same as the cloud: a station's part of an order, or the whole order, waiting at the pass. */
  private announceReady(dto: OrderDTO, justReady: ReadonlySet<string>): void {
    const news = readyNews(dto.items, justReady);
    if (!news) return;
    const payload: ItemsReadyDTO = {
      order_id: dto.id,
      order_no: dto.order_no,
      order_type: dto.type,
      channel: dto.channel,
      channel_ref: dto.channel_ref,
      table_id: dto.table_id,
      table_label: dto.table_label,
      assigned_waiter_id: this.snap.tables.find((t) => t.id === dto.table_id)?.assigned_waiter_id ?? null,
      ...news,
    };
    this.emit('order.items_ready', payload);
  }

  setItemStatus(user: HubUser, itemId: string, to: ItemStatus): OrderDTO {
    const o = Object.values(this.state.orders).find((x) => x.items.some((i) => i.id === itemId));
    if (!o) throw notFound('Order item');
    return this.setItemsStatus(user, o.id, [itemId], to);
  }

  /** Several items of one order at once; items already at or past `to` stay as they are. */
  setItemsStatus(user: HubUser, orderId: string, itemIds: readonly string[], to: ItemStatus): OrderDTO {
    this.assertWritable();
    if (to === 'cancelled' || to === 'placed') throw badRequest('invalid_transition', 'Use the order item edit endpoint to cancel items');
    const o = this.order(orderId);
    if (o.status === 'placed') throw conflict('order_not_accepted', 'Accept the order first');
    this.assertCan(user, this.actionFor(to as OrderStatus));
    const wanted = new Set(itemIds);
    const chosen = o.items.filter((i) => wanted.has(i.id));
    if (chosen.length !== wanted.size) throw notFound('Order item');
    const moving = chosen.filter((i) => canItemTransition(i.status, to));
    if (moving.length === 0) {
      throw conflict('invalid_transition', chosen.length === 1 ? `Cannot move an item from ${chosen[0]!.status} to ${to}` : `Those items are already ${to} or further along`);
    }
    for (const item of moving) item.status = to;
    const derived = deriveOrderStatus(o.items);
    if (derived !== o.status && derived !== 'cancelled' && canTransition(o.status, derived)) {
      const now = this.now().toISOString();
      o.status = derived;
      if (derived === 'ready') o.ready_at = now;
      if (derived === 'served') o.served_at = now;
    }
    this.bump(o);
    const dto = this.orderDto(o);
    this.emit('order.status_changed', { order_id: o.id, status: o.status, order: dto });
    if (to === 'ready') this.announceReady(dto, new Set(moving.map((i) => i.id)));
    if (o.table_id) this.emit('tables.updated', {});
    this.commit();
    return dto;
  }

  editItems(
    user: HubUser,
    orderId: string,
    input: { add?: OrderLineInput[]; cancel?: { order_item_id: string; reason: string }[]; set_qty?: { order_item_id: string; qty: number }[] },
  ): OrderDTO {
    this.assertWritable();
    const o = this.order(orderId);
    this.assertCan(user, 'order.edit_items');
    if (!['placed', 'accepted', 'preparing', 'ready', 'served'].includes(o.status)) throw conflict('order_closed', `This order is ${o.status} and can no longer be edited`);
    const accepted = o.status !== 'placed';
    if (input.set_qty?.length) {
      if (accepted) throw conflict('order_accepted', 'Quantities are locked once the kitchen has the order; cancel and add instead');
      for (const { order_item_id, qty } of input.set_qty) {
        const item = o.items.find((i) => i.id === order_item_id);
        if (!item || item.status === 'cancelled') throw badRequest('invalid_item', 'Item is not part of this order');
        item.qty = qty;
      }
    }
    const cancelled: string[] = [];
    if (input.cancel?.length) {
      if (accepted && !rolesCan(user.roles, 'order.cancel_after_accept')) throw forbidden('A manager has to cancel dishes while the outlet is offline');
      for (const { order_item_id, reason } of input.cancel) {
        const item = o.items.find((i) => i.id === order_item_id);
        if (!item) throw badRequest('invalid_item', 'Item is not part of this order');
        if (item.status === 'cancelled') continue;
        if (!reason.trim()) throw badRequest('reason_required', 'Give a reason for cancelling');
        if (item.status !== 'placed') cancelled.push(item.id);
        item.status = 'cancelled';
        item.cancelled_reason = reason.trim();
      }
    }
    let added: string[] = [];
    if (input.add?.length) {
      if (!['placed', 'accepted', 'preparing'].includes(o.status)) throw conflict('order_progressed', 'This order is already ready; start a new order instead');
      const start = Math.max(-1, ...o.items.map((i) => i.position)) + 1;
      const fresh = this.prepareLines(input.add).map((p, idx) => ({
        ...p,
        id: randomUUID(),
        status: (accepted ? 'accepted' : 'placed') as ItemStatus,
        position: start + idx,
        cancelled_reason: null,
      }));
      o.items.push(...fresh);
      added = fresh.map((i) => i.id);
    }
    if (deriveOrderStatus(o.items) === 'cancelled') {
      o.status = 'cancelled';
      o.cancelled_reason = input.cancel?.[0]?.reason ?? 'All items cancelled';
    }
    this.bump(o);
    if (cancelled.length) this.printKots(o, cancelled, { cancelled: true });
    if (accepted && added.length) this.printKots(o, added);
    const dto = this.orderDto(o);
    this.emit(o.status === 'cancelled' ? 'order.status_changed' : 'order.updated', { order_id: o.id, status: o.status, order: dto });
    if (o.table_id) this.emit('tables.updated', {});
    this.commit();
    return dto;
  }

  reprintKot(user: HubUser, orderId: string, station?: string): { printed: number } {
    this.assertCan(user, 'order.view');
    const o = this.order(orderId);
    const ids = o.items.filter((i) => i.status !== 'cancelled' && (!station || i.station === station)).map((i) => i.id);
    this.printKots(o, ids, { reprint: true });
    this.commit();
    return { printed: new Set(o.items.filter((i) => ids.includes(i.id)).map((i) => i.station)).size };
  }

  // ------------------------------------------------------------------ bills

  private bill(id: string): LocalBill {
    const b = this.state.bills[id];
    if (!b) throw notFound('Bill');
    return b;
  }

  /** Accepted, uncancelled items in scope that no other bill already charges for. */
  private billableItems(b: Pick<HubBill, 'id' | 'table_session_id' | 'order_id'>) {
    const onOtherBills = new Set(
      Object.values(this.state.bills)
        .filter((x) => x.id !== b.id)
        .flatMap((x) => (x.status === 'draft' ? this.billableFor(x) : x.lines.map((l) => l.order_item_id))),
    );
    return this.scopeOrders(b)
      .flatMap((o) => o.items.filter((i) => i.status !== 'cancelled').map((i) => ({ ...i, order_id: o.id })))
      .filter((i) => !onOtherBills.has(i.id));
  }

  /** Items a draft would take, ignoring other drafts (drafts never overlap: one per scope). */
  private billableFor(b: Pick<HubBill, 'table_session_id' | 'order_id'>): string[] {
    const finalised = new Set(
      Object.values(this.state.bills)
        .filter((x) => x.status !== 'draft')
        .flatMap((x) => x.lines.map((l) => l.order_item_id)),
    );
    return this.scopeOrders(b)
      .flatMap((o) => o.items.filter((i) => i.status !== 'cancelled').map((i) => i.id))
      .filter((id) => !finalised.has(id));
  }

  private scopeOrders(b: Pick<HubBill, 'table_session_id' | 'order_id'>): LocalOrder[] {
    return Object.values(this.state.orders)
      .filter((o) => !['placed', 'rejected', 'cancelled'].includes(o.status))
      .filter((o) => (b.table_session_id ? o.table_session_id === b.table_session_id : o.id === b.order_id))
      .sort((a, b2) => a.placed_at.localeCompare(b2.placed_at));
  }

  private recompute(b: LocalBill): void {
    if (b.status !== 'draft') return;
    const outlet = this.snap.outlet;
    const items = this.billableItems(b);
    const totals = computeBill({
      lines: items.map((i) => ({ key: i.id, qty: i.qty, unit_price_paise: i.unit_price_paise, tax_rate_bp: i.tax_rate_bp, item_discount_paise: 0 })),
      bill_discount: null,
      service_charge_bp: b.service_charge_waived ? 0 : b.service_charge_bp,
      service_charge_tax_rate_bp: outlet.service_charge_tax_rate_bp,
      prices_include_tax: outlet.prices_include_tax,
    });
    b.lines = totals.lines.map((l, idx) => {
      const item = items[idx]!;
      return {
        order_item_id: item.id,
        name: lineName(item.name, item.modifiers),
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
        hsn_sac: item.hsn_sac,
        seat_no: item.seat_no,
      };
    });
    Object.assign(b, {
      subtotal_paise: totals.subtotal_paise,
      item_discount_paise: totals.item_discount_paise,
      bill_discount_paise: totals.bill_discount_paise,
      loyalty_discount_paise: 0,
      service_charge_paise: totals.service_charge_paise,
      service_charge_tax_rate_bp: outlet.service_charge_tax_rate_bp,
      taxable_paise: totals.taxable_paise,
      cgst_paise: totals.cgst_paise,
      sgst_paise: totals.sgst_paise,
      tax_total_paise: totals.tax_total_paise,
      round_off_paise: totals.round_off_paise,
      total_paise: totals.total_paise,
    });
  }

  billDto(b: LocalBill): BillDTO {
    this.recompute(b);
    const session = b.table_session_id ? this.state.sessions[b.table_session_id] : undefined;
    const order = b.order_id ? this.state.orders[b.order_id] : undefined;
    const payments: PaymentDTO[] = b.payments.map((p) => ({
      id: p.id,
      bill_id: b.id,
      kind: 'payment',
      method: p.method,
      amount_paise: p.amount_paise,
      tendered_paise: p.tendered_paise,
      change_paise: p.change_paise,
      reference: p.reference,
      confirmed_by_name: this.staffName(p.confirmed_by),
      created_at: p.created_at,
      room_no: p.room_no,
      room_guest: p.room_guest,
      room_posted_at: null,
    }));
    return {
      id: b.id,
      outlet_id: this.outletId,
      table_session_id: b.table_session_id,
      order_id: b.order_id,
      table_label: this.tableLabel(session?.table_id ?? order?.table_id ?? null),
      parent_bill_id: null,
      split_label: null,
      status: b.status,
      tax_by_operator: b.tax_by_operator ?? false,
      lines: b.lines.map((l) => ({ id: l.order_item_id, ...l })),
      bill_discount: null,
      discount_reason: null,
      service_charge_bp: b.service_charge_bp,
      service_charge_waived: b.service_charge_waived,
      subtotal_paise: b.subtotal_paise,
      item_discount_paise: b.item_discount_paise,
      bill_discount_paise: b.bill_discount_paise,
      service_charge_paise: b.service_charge_paise,
      taxable_paise: b.taxable_paise,
      cgst_paise: b.cgst_paise,
      sgst_paise: b.sgst_paise,
      tax_total_paise: b.tax_total_paise,
      round_off_paise: b.round_off_paise,
      total_paise: b.total_paise,
      paid_paise: b.paid_paise,
      balance_paise: Math.max(0, b.total_paise - b.paid_paise),
      amount_shares: null,
      customer: null,
      loyalty_points_redeemed: 0,
      loyalty_discount_paise: b.loyalty_discount_paise,
      loyalty_points_earned: 0,
      invoice_no: b.invoice_no,
      invoice_date: b.invoice_date,
      customer_name: b.customer_name,
      customer_gstin: b.customer_gstin,
      payments,
      finalised_at: b.finalised_at,
      paid_at: b.paid_at,
      voided_at: null,
      void_reason: null,
      created_at: b.created_at,
    };
  }

  listBills(q: { outlet_id: string; status?: string; table_session_id?: string; limit?: number }): BillDTO[] {
    this.assertOutlet(q.outlet_id);
    const statuses = q.status?.split(',').filter(Boolean) ?? [];
    return Object.values(this.state.bills)
      .filter((b) => (!statuses.length || statuses.includes(b.status)) && (!q.table_session_id || b.table_session_id === q.table_session_id))
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, q.limit ?? 100)
      .map((b) => this.billDto(b));
  }

  getBill(id: string): BillDTO {
    return this.billDto(this.bill(id));
  }

  createBill(user: HubUser, input: { table_session_id?: string | null; order_id?: string | null }): BillDTO {
    this.assertWritable();
    this.assertCan(user, 'bill.manage');
    if (input.table_session_id) {
      const s = this.state.sessions[input.table_session_id];
      if (!s) throw notFound('Table session');
      if (s.status === 'closed') throw conflict('session_closed', 'This table visit has already been settled');
    } else if (input.order_id) {
      const o = this.order(input.order_id);
      if (o.table_session_id) throw badRequest('use_table_bill', 'Dine-in orders are billed by table');
      // Their GST and payment belong to the platform; the hub bills them once back online.
      if (o.channel === 'zomato' || o.channel === 'swiggy') throw conflict('online_only', 'Bill Zomato and Swiggy orders once the internet is back. They are paid on the app.');
    } else {
      throw badRequest('scope_required', 'Give a table session or an order');
    }
    const scope = { table_session_id: input.table_session_id ?? null, order_id: input.table_session_id ? null : (input.order_id ?? null) };
    const draft = Object.values(this.state.bills).find(
      (b) => b.status === 'draft' && (scope.table_session_id ? b.table_session_id === scope.table_session_id : b.order_id === scope.order_id),
    );
    if (draft) return this.billDto(draft);
    if (!this.billableFor(scope).length) throw conflict('nothing_to_bill', 'There are no unbilled items. Accepted orders appear here.');
    const outlet = this.snap.outlet;
    const b: LocalBill = {
      id: randomUUID(),
      ...scope,
      status: 'draft',
      invoice_series: 'hub',
      fy_code: null,
      invoice_seq: null,
      invoice_no: null,
      invoice_date: null,
      service_charge_bp: outlet.service_charge_bp,
      service_charge_waived: false,
      service_charge_tax_rate_bp: outlet.service_charge_tax_rate_bp,
      subtotal_paise: 0,
      item_discount_paise: 0,
      bill_discount_paise: 0,
      loyalty_discount_paise: 0,
      service_charge_paise: 0,
      taxable_paise: 0,
      cgst_paise: 0,
      sgst_paise: 0,
      tax_total_paise: 0,
      round_off_paise: 0,
      total_paise: 0,
      paid_paise: 0,
      customer_name: null,
      customer_gstin: null,
      outlet_snapshot: null,
      finalised_at: null,
      finalised_by: null,
      paid_at: null,
      created_at: this.now().toISOString(),
      lines: [],
      payments: [],
      rev: 0,
      synced: 0,
      origin: 'hub',
    };
    this.state.bills[b.id] = b;
    const dto = this.billDto(b);
    this.emit('bill.updated', { bill_id: b.id, status: b.status, table_session_id: b.table_session_id });
    this.commit();
    return dto;
  }

  updateBill(user: HubUser, id: string, body: Record<string, unknown>): BillDTO {
    this.assertWritable();
    this.assertCan(user, 'bill.manage');
    const allowed = ['service_charge_waived', 'customer_name', 'customer_gstin'];
    if (Object.keys(body).some((k) => !allowed.includes(k))) throw offlineUnsupported();
    const b = this.bill(id);
    if (b.status !== 'draft') throw conflict('bill_finalised', 'This bill is already printed; void it to make changes');
    if (typeof body.service_charge_waived === 'boolean') b.service_charge_waived = body.service_charge_waived;
    if (body.customer_name !== undefined) b.customer_name = typeof body.customer_name === 'string' ? body.customer_name.trim() || null : null;
    if (body.customer_gstin !== undefined) b.customer_gstin = typeof body.customer_gstin === 'string' ? body.customer_gstin.trim().toUpperCase() || null : null;
    const dto = this.billDto(b);
    this.emit('bill.updated', { bill_id: b.id, status: b.status, table_session_id: b.table_session_id });
    this.commit();
    return dto;
  }

  discardDraft(user: HubUser, id: string): void {
    this.assertWritable();
    this.assertCan(user, 'bill.manage');
    const b = this.bill(id);
    if (b.status !== 'draft') throw conflict('bill_finalised', 'Only drafts can be discarded');
    delete this.state.bills[id];
    this.emit('bill.updated', { bill_id: id, status: 'discarded', table_session_id: b.table_session_id });
    this.commit();
  }

  /** Prints the GST invoice with the next number of the hub's own offline series. */
  finalise(user: HubUser, id: string): BillDTO {
    this.assertWritable();
    this.assertCan(user, 'bill.manage');
    const b = this.bill(id);
    if (b.status !== 'draft') throw conflict('bill_finalised', 'This bill is already printed');
    this.recompute(b);
    if (!b.lines.length) throw conflict('nothing_to_bill', 'This bill has no items');
    if (b.customer_gstin && !/^[0-9]{2}[A-Z0-9]{13}$/.test(b.customer_gstin)) throw badRequest('invalid_gstin', 'Customer GSTIN must be 15 characters');
    const outlet = this.snap.outlet;
    const now = this.now();
    const day = businessDate(now, outlet.timezone);
    const fy = financialYear(day);
    const seq = this.next(`invoice:${fy.code}`);
    const paidNow = b.total_paise === 0;
    Object.assign(b, {
      status: paidNow ? 'paid' : 'finalised',
      invoice_series: 'hub',
      fy_code: fy.code,
      invoice_seq: seq,
      invoice_no: formatHubInvoiceNo(outlet.invoice_prefix, fy.code, seq),
      invoice_date: day,
      outlet_snapshot: {
        name: outlet.name,
        legal_name: outlet.legal_name,
        address: [outlet.address, outlet.city].filter(Boolean).join(', ') || null,
        gstin: outlet.gstin,
        fssai_no: outlet.fssai_no,
        phone: outlet.phone,
        state_code: outlet.state_code,
      },
      finalised_at: now.toISOString(),
      finalised_by: user.id,
      ...(paidNow ? { paid_at: now.toISOString() } : {}),
    });
    this.bump(b);
    this.markBilledOrders(b);
    this.printBill(b, false);
    if (paidNow) this.settleIfDone(b);
    const dto = this.billDto(b);
    this.emit('bill.updated', { bill_id: b.id, status: b.status, table_session_id: b.table_session_id });
    this.commit();
    return dto;
  }

  private markBilledOrders(b: LocalBill): void {
    const billed = new Set(
      Object.values(this.state.bills)
        .filter((x) => x.status !== 'draft')
        .flatMap((x) => x.lines.map((l) => l.order_item_id)),
    );
    const orderIds = new Set(this.scopeOrders(b).filter((o) => o.items.some((i) => b.lines.some((l) => l.order_item_id === i.id))).map((o) => o.id));
    for (const id of orderIds) {
      const o = this.state.orders[id]!;
      if (o.items.every((i) => i.status === 'cancelled' || billed.has(i.id)) && canTransition(o.status, 'billed')) {
        o.status = 'billed';
        this.bump(o);
      }
    }
  }

  recordPayment(
    user: HubUser,
    id: string,
    input: { method: PaymentMethod; amount_paise: number; tendered_paise?: number | null; reference?: string | null; room_no?: string | null; room_guest?: string | null },
  ): BillDTO {
    this.assertWritable();
    this.assertCan(user, 'payment.record');
    const b = this.bill(id);
    if (b.status === 'draft') throw conflict('bill_not_finalised', 'Print (finalise) the bill before taking payment');
    if (b.status !== 'finalised') throw conflict('bill_closed', `This bill is ${b.status}`);
    const balance = b.total_paise - b.paid_paise;
    if (input.amount_paise > balance) throw badRequest('overpayment', 'Payment is more than the balance due', { balance_paise: balance });
    // Same rule as the cloud: Zomato and Swiggy orders are paid by the platform, and only they are.
    if (b.tax_by_operator && input.method !== 'platform') throw badRequest('paid_by_platform', 'This order was paid on the delivery app. Record it as paid by the platform.');
    if (!b.tax_by_operator && input.method === 'platform') throw badRequest('not_a_platform_order', 'Only Zomato and Swiggy orders are paid by the platform');
    let change: number | null = null;
    if (input.method === 'cash' && input.tendered_paise != null) {
      if (input.tendered_paise < input.amount_paise) throw badRequest('tendered_short', 'Cash tendered is less than the amount');
      change = input.tendered_paise - input.amount_paise;
    }
    // Same rule as the cloud: room charges only where the outlet allows them, with a room number.
    let room: string | null = null;
    if (input.method === 'room') {
      if (!this.snap.outlet.room_charge_enabled) throw badRequest('room_charge_disabled', 'This outlet does not charge bills to rooms');
      room = input.room_no?.trim().toUpperCase() ?? '';
      if (!/^[A-Z0-9][A-Z0-9 -]{0,9}$/.test(room)) throw badRequest('room_required', 'Enter the room number');
    }
    const now = this.now().toISOString();
    b.payments.push({
      id: randomUUID(),
      method: input.method,
      amount_paise: input.amount_paise,
      tendered_paise: input.method === 'cash' ? (input.tendered_paise ?? null) : null,
      change_paise: change,
      reference: input.reference?.trim() || null,
      confirmed_by: user.id,
      created_at: now,
      room_no: room,
      room_guest: room ? input.room_guest?.trim().slice(0, 80) || null : null,
    });
    b.paid_paise += input.amount_paise;
    if (b.paid_paise >= b.total_paise) {
      b.status = 'paid';
      b.paid_at = now;
    }
    this.bump(b);
    if (b.status === 'paid') this.settleIfDone(b);
    // The hub opens the drawer only if the bill printer has one (its print hook checks).
    if (input.method === 'cash') this.hooks.print('bill', { kind: 'drawer' });
    const dto = this.billDto(b);
    this.emit('bill.updated', { bill_id: b.id, status: b.status, table_session_id: b.table_session_id });
    this.commit();
    return dto;
  }

  /** Closes the visit once everything is billed and paid, like the cloud does. */
  private settleIfDone(b: LocalBill): void {
    if (!b.table_session_id) return;
    const s = this.state.sessions[b.table_session_id];
    if (!s || s.status !== 'open') return;
    const unpaid = Object.values(this.state.bills).some((x) => x.table_session_id === s.id && x.status === 'finalised');
    const leftover = this.billableFor({ table_session_id: s.id, order_id: null }).length > 0;
    const waiting = this.sessionOrders(s.id).some((o) => o.status === 'placed');
    if (unpaid || leftover || waiting) return;
    for (const d of Object.values(this.state.bills)) if (d.table_session_id === s.id && d.status === 'draft') delete this.state.bills[d.id];
    this.closeSession(s, true);
  }

  invoice(id: string): InvoiceDTO & { upi_uri: string | null } {
    const b = this.bill(id);
    const bill = this.billDto(b);
    const o = this.snap.outlet;
    const outlet = b.outlet_snapshot ?? {
      name: o.name,
      legal_name: o.legal_name,
      address: [o.address, o.city].filter(Boolean).join(', ') || null,
      gstin: o.gstin,
      fssai_no: o.fssai_no,
      phone: o.phone,
      state_code: o.state_code,
    };
    const byRate = new Map<number, { tax_rate_bp: number; taxable_paise: number; cgst_paise: number; sgst_paise: number }>();
    const add = (rate: number, taxable: number, cgst: number, sgst: number) => {
      const r = byRate.get(rate) ?? { tax_rate_bp: rate, taxable_paise: 0, cgst_paise: 0, sgst_paise: 0 };
      r.taxable_paise += taxable;
      r.cgst_paise += cgst;
      r.sgst_paise += sgst;
      byRate.set(rate, r);
    };
    for (const l of bill.lines) add(l.tax_rate_bp, l.taxable_paise, l.cgst_paise, l.sgst_paise);
    if (bill.service_charge_paise > 0) {
      add(
        b.service_charge_tax_rate_bp,
        bill.service_charge_paise,
        bill.cgst_paise - bill.lines.reduce((a, l) => a + l.cgst_paise, 0),
        bill.sgst_paise - bill.lines.reduce((a, l) => a + l.sgst_paise, 0),
      );
    }
    return {
      bill,
      outlet,
      tax_summary: [...byRate.values()].sort((a, c) => a.tax_rate_bp - c.tax_rate_bp),
      upi_uri: this.upiUri(bill.balance_paise || bill.total_paise, bill.invoice_no ?? ''),
    };
  }

  private upiUri(amount: number, note: string): string | null {
    const o = this.snap.outlet;
    if (!o.upi_vpa) return null;
    const params = new URLSearchParams({ pa: o.upi_vpa, pn: o.upi_payee_name ?? o.name, am: (amount / 100).toFixed(2), cu: 'INR', tn: note });
    return `upi://pay?${params.toString()}`;
  }

  private printBill(b: LocalBill, duplicate: boolean): void {
    const inv = this.invoice(b.id);
    const doc: BillDoc = { kind: 'bill', invoice: { bill: inv.bill, outlet: inv.outlet, tax_summary: inv.tax_summary }, upi_uri: inv.upi_uri, duplicate };
    this.hooks.print('bill', doc);
  }

  reprintBill(user: HubUser, id: string): { ok: true } {
    this.assertCan(user, 'bill.manage');
    const b = this.bill(id);
    if (b.status === 'draft') throw conflict('bill_not_finalised', 'Finalise the bill before printing');
    this.printBill(b, true);
    this.commit();
    return { ok: true };
  }
}

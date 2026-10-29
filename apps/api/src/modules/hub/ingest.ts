// Applies what the outlet hub did while the internet was down. Everything is an upsert by id, so
// the hub can resend after a timeout without duplicating anything. Each table visit (session with
// its orders and bills) is its own transaction: one bad visit is reported, the rest still land.

import { computeBill } from '@mezmitra/shared/billing';
import type { ItemStatus, OrderStatus } from '@mezmitra/shared/enums';
import { groupSyncPayload, type HubBill, type HubOrder, type HubSession, type HubSyncGroup, type HubSyncPayload, type HubSyncResult } from '@mezmitra/shared/hub';
import { canItemTransition, canTransition, itemWasMade } from '@mezmitra/shared/order-state';
import type { AppContext, Tx } from '../../context';
import { json } from '../../db';
import { audit } from '../../lib/audit';
import { nextCounter } from '../../lib/counters';
import { badRequest, conflict } from '../../lib/errors';
import { announceBill, markFullyBilledOrders, syncDraft } from '../billing/service';
import { loadBill } from '../billing/serialize';
import { queueBillPaid } from '../integrations/outbox';
import { detachRewards } from '../loyalty/bill-hooks';
import { earnOnPaid } from '../loyalty/engine';
import { syncStock } from '../inventory/stock';
import { closeSession, refreshTableStates } from '../tables/sessions';

const STATUS_RANK: Record<OrderStatus, number> = { placed: 0, accepted: 1, preparing: 2, ready: 3, served: 4, billed: 5, rejected: 9, cancelled: 9 };
const HUB_INVOICE = /^[A-Z0-9]{1,4}H\/(\d{4})\/(\d{5})$/;

async function upsertSession(tx: Tx, outletId: string, s: HubSession): Promise<void> {
  const table = await tx.db.selectFrom('tables').select(['id']).where('id', '=', s.table_id).where('outlet_id', '=', outletId).executeTakeFirst();
  if (!table) throw badRequest('invalid_table', 'Table is not in this outlet');
  const existing = await tx.db.selectFrom('table_sessions').select(['id', 'status', 'outlet_id']).where('id', '=', s.id).forUpdate().executeTakeFirst();
  if (existing && existing.outlet_id !== outletId) throw badRequest('invalid_session', 'Session belongs to another outlet');
  if (!existing) {
    await tx.db
      .insertInto('table_sessions')
      .values({
        id: s.id,
        tenant_id: tx.tenantId,
        outlet_id: outletId,
        table_id: s.table_id,
        status: s.status,
        opened_at: s.opened_at ? new Date(s.opened_at) : new Date(),
        closed_at: s.closed_at ? new Date(s.closed_at) : null,
        guest_count: s.guest_count,
        waiter_id: s.waiter_id,
        cart: json([]),
        cart_version: 0,
      })
      .execute();
  } else if (existing.status !== 'closed') {
    await tx.db
      .updateTable('table_sessions')
      .set({ status: 'open', guest_count: s.guest_count, waiter_id: s.waiter_id })
      .where('id', '=', s.id)
      .execute();
  }
}

/**
 * Points the table at an open hub session. Whatever the cloud had on that table meanwhile (a guest
 * browsing by QR, or an order from someone on mobile data) is folded into the hub's visit.
 */
async function attachSession(tx: Tx, s: HubSession): Promise<string[]> {
  const table = await tx.db.selectFrom('tables').select(['id', 'current_session_id']).where('id', '=', s.table_id).forUpdate().executeTakeFirstOrThrow();
  const other = table.current_session_id && table.current_session_id !== s.id ? table.current_session_id : null;
  if (other) {
    await tx.db.updateTable('orders').set({ table_session_id: s.id }).where('table_session_id', '=', other).execute();
    await tx.db.updateTable('bills').set({ table_session_id: s.id }).where('table_session_id', '=', other).where('status', '=', 'draft').execute();
    await closeSession(tx, other, 'order', { cleaning: false });
  }
  await tx.db.updateTable('tables').set({ current_session_id: s.id, needs_cleaning: false }).where('id', '=', s.table_id).execute();
  return [s.table_id];
}

async function upsertOrder(tx: Tx, outletId: string, o: HubOrder): Promise<void> {
  if (o.table_session_id) {
    const s = await tx.db.selectFrom('table_sessions').select(['outlet_id', 'table_id']).where('id', '=', o.table_session_id).executeTakeFirst();
    if (!s || s.outlet_id !== outletId) throw badRequest('invalid_session', `Order ${o.offline_ref ?? o.order_no} refers to an unknown table visit`);
  }
  const itemIds = [...new Set(o.items.map((i) => i.item_id))];
  if (itemIds.length) {
    const known = await tx.db.selectFrom('menu_items').select('id').where('outlet_id', '=', outletId).where('id', 'in', itemIds).execute();
    if (known.length !== itemIds.length) throw badRequest('invalid_item', `Order ${o.offline_ref ?? o.order_no} has dishes from another outlet`);
  }
  const existing = await tx.db.selectFrom('orders').select(['id', 'status', 'outlet_id']).where('id', '=', o.id).forUpdate().executeTakeFirst();
  if (existing && existing.outlet_id !== outletId) throw badRequest('invalid_order', 'Order belongs to another outlet');
  const at = (v: string | null) => (v ? new Date(v) : null);
  if (!existing) {
    await tx.db
      .insertInto('orders')
      .values({
        id: o.id,
        tenant_id: tx.tenantId,
        outlet_id: outletId,
        table_session_id: o.table_session_id,
        table_id: o.table_id,
        order_no: await nextCounter(tx, outletId, 'order', o.business_date),
        offline_ref: o.offline_ref,
        business_date: o.business_date,
        type: o.type,
        status: o.status,
        source: o.source,
        note: o.note,
        flagged: o.flagged,
        customer_name: o.customer_name,
        customer_phone: o.customer_phone,
        created_by: o.created_by,
        placed_at: new Date(o.placed_at),
        accepted_at: at(o.accepted_at),
        ready_at: at(o.ready_at),
        served_at: at(o.served_at),
        rejected_reason: o.rejected_reason,
        cancelled_reason: o.cancelled_reason,
      })
      .execute();
  } else if (existing.status !== o.status) {
    const from = existing.status as OrderStatus;
    // The cloud never moves backwards: a later change made in the cloud (e.g. billed) wins.
    if (canTransition(from, o.status) || STATUS_RANK[o.status] > STATUS_RANK[from]) {
      await tx.db
        .updateTable('orders')
        .set({
          status: o.status,
          accepted_at: at(o.accepted_at),
          ready_at: at(o.ready_at),
          served_at: at(o.served_at),
          cancelled_reason: o.cancelled_reason,
          rejected_reason: o.rejected_reason,
        })
        .where('id', '=', o.id)
        .execute();
    }
  }

  const current = await tx.db.selectFrom('order_items').select(['id', 'status', 'order_id']).where('id', 'in', o.items.length ? o.items.map((i) => i.id) : ['00000000-0000-0000-0000-000000000000']).execute();
  const byId = new Map(current.map((i) => [i.id, i]));
  for (const i of o.items) {
    const have = byId.get(i.id);
    if (have && have.order_id !== o.id) throw badRequest('invalid_item', 'Order item belongs to another order');
    if (!have) {
      await tx.db
        .insertInto('order_items')
        .values({
          id: i.id,
          tenant_id: tx.tenantId,
          order_id: o.id,
          item_id: i.item_id,
          name_snapshot: i.name,
          price_snapshot_paise: i.price_paise,
          unit_price_paise: i.unit_price_paise,
          modifiers_snapshot: json(i.modifiers),
          is_veg: i.is_veg,
          tax_rate_bp: i.tax_rate_bp,
          hsn_sac: i.hsn_sac,
          qty: i.qty,
          note: i.note,
          status: i.status,
          station: i.station,
          seat_no: i.seat_no,
          cancelled_reason: i.cancelled_reason,
          position: i.position,
        })
        .execute();
    } else if (have.status !== i.status && (canItemTransition(have.status as ItemStatus, i.status) || i.status === 'cancelled')) {
      await tx.db
        .updateTable('order_items')
        .set({ status: i.status, cancelled_reason: i.cancelled_reason, ...(i.status === 'cancelled' ? { cancelled_made: itemWasMade(have.status as ItemStatus) } : {}) })
        .where('id', '=', i.id)
        .execute();
    }
  }
  await syncStock(tx, o.id, o.created_by);
}

/** The hub uses the same shared bill maths; a bill that does not add up is refused. */
function checkTotals(b: HubBill, pricesIncludeTax: boolean): void {
  const input = {
    lines: b.lines.map((l) => ({ key: l.order_item_id, qty: l.qty, unit_price_paise: l.unit_price_paise, tax_rate_bp: l.tax_rate_bp, item_discount_paise: l.item_discount_paise })),
    bill_discount: null,
    service_charge_bp: b.service_charge_waived ? 0 : b.service_charge_bp,
    service_charge_tax_rate_bp: b.service_charge_tax_rate_bp,
  };
  const matches = [pricesIncludeTax, !pricesIncludeTax].some((incl) => {
    const t = computeBill({ ...input, prices_include_tax: incl });
    return t.total_paise === b.total_paise && t.tax_total_paise === b.tax_total_paise && t.subtotal_paise === b.subtotal_paise;
  });
  if (!matches) throw badRequest('totals_mismatch', `Bill ${b.invoice_no} does not add up`);
}

async function upsertBill(tx: Tx, outlet: { id: string; prices_include_tax: boolean }, b: HubBill): Promise<{ newlyPaid: boolean }> {
  if (b.status === 'draft') throw badRequest('draft_bill', 'Drafts are not synced');
  const existing = await tx.db.selectFrom('bills').select(['id', 'status', 'total_paise', 'outlet_id', 'invoice_no']).where('id', '=', b.id).forUpdate().executeTakeFirst();
  if (existing && existing.outlet_id !== outlet.id) throw badRequest('invalid_bill', 'Bill belongs to another outlet');

  if (!existing) {
    const m = HUB_INVOICE.exec(b.invoice_no ?? '');
    if (b.invoice_series !== 'hub' || !m || m[1] !== b.fy_code || Number(m[2]) !== b.invoice_seq || !b.invoice_date || !b.finalised_at) {
      throw badRequest('invalid_invoice', 'Offline bills need an offline-series invoice number');
    }
    if (!b.lines.length) throw badRequest('nothing_to_bill', 'This bill has no items');
    checkTotals(b, outlet.prices_include_tax);
    const items = await tx.db
      .selectFrom('order_items')
      .innerJoin('orders', 'orders.id', 'order_items.order_id')
      .select([
        'order_items.id',
        'order_items.qty',
        'order_items.unit_price_paise',
        'order_items.tax_rate_bp',
        'order_items.status',
        'orders.outlet_id',
        'orders.table_session_id',
        'orders.id as order_id',
      ])
      .where('order_items.id', 'in', b.lines.map((l) => l.order_item_id))
      .execute();
    if (items.length !== b.lines.length || items.some((i) => i.outlet_id !== outlet.id)) {
      throw badRequest('invalid_lines', `Bill ${b.invoice_no} refers to unknown dishes`);
    }
    // Every line charges exactly what was ordered.
    for (const l of b.lines) {
      const i = items.find((x) => x.id === l.order_item_id)!;
      if (i.status === 'cancelled' || i.qty !== l.qty || i.unit_price_paise !== l.unit_price_paise || i.tax_rate_bp !== l.tax_rate_bp) {
        throw badRequest('lines_mismatch', `Bill ${b.invoice_no} does not match its orders`);
      }
    }
    if (items.some((i) => (b.table_session_id ? i.table_session_id !== b.table_session_id : i.order_id !== b.order_id))) {
      throw badRequest('invalid_lines', `Bill ${b.invoice_no} mixes dishes from another table`);
    }
    // A dish can be on one live bill only (the cloud may have billed it while the hub was cut off).
    const clash = await tx.db
      .selectFrom('bill_lines')
      .innerJoin('bills', 'bills.id', 'bill_lines.bill_id')
      .select('bills.invoice_no')
      .where('bill_lines.order_item_id', 'in', b.lines.map((l) => l.order_item_id))
      .where('bills.status', 'in', ['finalised', 'paid'])
      .executeTakeFirst();
    if (clash) throw conflict('already_billed', `Dishes on ${b.invoice_no} are already on ${clash.invoice_no}`);

    await tx.db
      .insertInto('bills')
      .values({
        id: b.id,
        tenant_id: tx.tenantId,
        outlet_id: outlet.id,
        table_session_id: b.table_session_id,
        order_id: b.order_id,
        status: 'finalised',
        invoice_series: 'hub',
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
        service_charge_paise: b.service_charge_paise,
        taxable_paise: b.taxable_paise,
        cgst_paise: b.cgst_paise,
        sgst_paise: b.sgst_paise,
        tax_total_paise: b.tax_total_paise,
        round_off_paise: b.round_off_paise,
        total_paise: b.total_paise,
        customer_name: b.customer_name,
        customer_gstin: b.customer_gstin,
        outlet_snapshot: b.outlet_snapshot ? json(b.outlet_snapshot) : null,
        finalised_at: new Date(b.finalised_at),
        finalised_by: b.finalised_by,
        created_by: b.finalised_by,
        created_at: new Date(b.created_at),
      })
      .execute();
    await tx.db
      .insertInto('bill_lines')
      .values(b.lines.map((l, idx) => ({ ...l, tenant_id: tx.tenantId, bill_id: b.id, created_at: new Date(new Date(b.created_at).getTime() + idx) })))
      .execute();
  }

  const bill = await tx.db.selectFrom('bills').select(['status', 'total_paise', 'invoice_no']).where('id', '=', b.id).executeTakeFirstOrThrow();
  if (bill.status === 'void') return { newlyPaid: false };
  const have = new Set((await tx.db.selectFrom('payments').select('id').where('bill_id', '=', b.id).execute()).map((p) => p.id));
  const fresh = b.payments.filter((p) => !have.has(p.id));
  for (const p of fresh) {
    await tx.db
      .insertInto('payments')
      .values({
        id: p.id,
        tenant_id: tx.tenantId,
        outlet_id: outlet.id,
        bill_id: b.id,
        kind: 'payment',
        method: p.method,
        amount_paise: p.amount_paise,
        tendered_paise: p.tendered_paise,
        change_paise: p.change_paise,
        reference: p.reference,
        confirmed_by: p.confirmed_by,
        created_at: new Date(p.created_at),
        room_no: p.method === 'room' ? p.room_no : null,
        room_guest: p.method === 'room' ? p.room_guest : null,
      })
      .execute();
  }
  const sums = await tx.db
    .selectFrom('payments')
    .select((eb) => eb.fn.sum<number>(eb.case().when('kind', '=', 'refund').then(eb.neg(eb.ref('amount_paise'))).else(eb.ref('amount_paise')).end()).as('paid'))
    .where('bill_id', '=', b.id)
    .executeTakeFirstOrThrow();
  const paid = Number(sums.paid ?? 0);
  if (paid > bill.total_paise) throw badRequest('overpayment', `Payments on ${bill.invoice_no} are more than the bill`);
  const newlyPaid = bill.status === 'finalised' && paid >= bill.total_paise;
  await tx.db
    .updateTable('bills')
    .set({ paid_paise: paid, ...(newlyPaid ? { status: 'paid', paid_at: b.paid_at ? new Date(b.paid_at) : new Date() } : {}) })
    .where('id', '=', b.id)
    .execute();
  await markFullyBilledOrders(tx, b.id);
  return { newlyPaid };
}

async function applyGroup(tx: Tx, outlet: { id: string; prices_include_tax: boolean }, g: HubSyncGroup, userId: string | null): Promise<string[]> {
  const touchedTables = new Set<string>();
  if (g.session) await upsertSession(tx, outlet.id, g.session);
  for (const o of g.orders) await upsertOrder(tx, outlet.id, o);
  for (const b of g.bills) {
    const { newlyPaid } = await upsertBill(tx, outlet, b);
    if (newlyPaid) {
      await earnOnPaid(tx, b.id, b.payments.at(-1)?.confirmed_by ?? b.finalised_by ?? userId);
      // Paid while offline: the thank-you still goes, unless the bill is too old by now (outbox expiry).
      await queueBillPaid(tx, b.id);
    }
  }
  // Drafts the cloud had for this visit lose the dishes the hub billed; empty ones go.
  const sessionId = g.session?.id ?? g.bills.find((b) => b.table_session_id)?.table_session_id;
  if (sessionId) {
    const drafts = await tx.db.selectFrom('bills').select('id').where('table_session_id', '=', sessionId).where('status', '=', 'draft').execute();
    for (const d of drafts) await syncDraft(tx, d.id);
    const empty = await tx.db
      .selectFrom('bills')
      .select('id')
      .where('table_session_id', '=', sessionId)
      .where('status', '=', 'draft')
      .where(({ not, exists, selectFrom }) => not(exists(selectFrom('bill_lines').select('bill_lines.id').whereRef('bill_lines.bill_id', '=', 'bills.id'))))
      .execute();
    for (const d of empty) await detachRewards(tx, d.id);
    if (empty.length) await tx.db.deleteFrom('bills').where('id', 'in', empty.map((d) => d.id)).execute();
  }
  if (g.session) {
    const s = await tx.db.selectFrom('table_sessions').select(['status', 'table_id']).where('id', '=', g.session.id).executeTakeFirstOrThrow();
    if (g.session.status === 'open') {
      // A visit the cloud already closed stays closed; its orders are still recorded.
      if (s.status !== 'closed') for (const t of await attachSession(tx, g.session)) touchedTables.add(t);
    } else if (s.status !== 'closed') {
      await closeSession(tx, g.session.id, 'order');
    }
    touchedTables.add(s.table_id);
  }
  for (const o of g.orders) if (o.table_id) touchedTables.add(o.table_id);
  if (touchedTables.size) await refreshTableStates(tx, [...touchedTables], 'order');
  for (const b of g.bills) {
    const dto = await loadBill(tx, b.id);
    if (dto) await announceBill(tx, dto);
  }
  if (g.orders.length) await tx.emit({ outletId: outlet.id, type: 'order.updated', channels: ['outlet'], payload: { source: 'hub_sync', order_ids: g.orders.map((o) => o.id) } });
  return [...touchedTables];
}

export async function ingestHubSync(ctx: AppContext, auth: { tenantId: string; outletId: string; deviceId: string }, payload: HubSyncPayload): Promise<HubSyncResult> {
  const result: HubSyncResult = { applied: { sessions: [], orders: [], bills: [], tables: [] }, failed: [] };
  const outlet = await ctx.tx(auth.tenantId, (tx) => tx.db.selectFrom('outlets').select(['id', 'prices_include_tax']).where('id', '=', auth.outletId).executeTakeFirstOrThrow());

  for (const g of groupSyncPayload(payload)) {
    try {
      await ctx.tx(auth.tenantId, (tx) => applyGroup(tx, outlet, g, g.orders[0]?.created_by ?? null));
      if (g.session) result.applied.sessions.push(g.session.id);
      result.applied.orders.push(...g.orders.map((o) => o.id));
      result.applied.bills.push(...g.bills.map((b) => b.id));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed';
      const kind = g.session ? 'session' : g.orders.length ? 'order' : 'bill';
      const id = g.session?.id ?? g.orders[0]?.id ?? g.bills[0]!.id;
      result.failed.push({ kind, id, message });
    }
  }

  if (payload.tables.length) {
    await ctx.tx(auth.tenantId, async (tx) => {
      const own = await tx.db.selectFrom('tables').select('id').where('outlet_id', '=', auth.outletId).where('id', 'in', payload.tables.map((t) => t.id)).execute();
      const ids = new Set(own.map((t) => t.id));
      for (const t of payload.tables) {
        if (!ids.has(t.id)) {
          result.failed.push({ kind: 'table', id: t.id, message: 'Table is not in this outlet' });
          continue;
        }
        await tx.db.updateTable('tables').set({ needs_cleaning: t.needs_cleaning }).where('id', '=', t.id).execute();
        result.applied.tables.push(t.id);
      }
      await refreshTableStates(tx, [...ids], 'staff');
    });
  }

  await ctx.tx(auth.tenantId, (tx) =>
    audit(tx, null, {
      outletId: auth.outletId,
      action: 'hub.sync',
      entity: 'device',
      entityId: auth.deviceId,
      after: {
        sessions: result.applied.sessions.length,
        orders: result.applied.orders.length,
        bills: result.applied.bills.length,
        failed: result.failed,
      },
    }),
  );
  return result;
}

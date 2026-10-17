import { randomUUID } from 'node:crypto';
import type { BrandingDTO, CartDTO, CartLineDTO, GuestContextDTO, GuestSessionDTO } from '@dineos/shared/dto';
import type { BillStatus, SessionStatus } from '@dineos/shared/enums';
import type { Tx } from '../../context';
import { json } from '../../db';
import type { GuestAuth } from '../../lib/auth';
import { badRequest, gone, notFound, tooMany } from '../../lib/errors';
import { loadOrders, toGuestOrder } from '../orders/serialize';
import { createOrder, prepareLines, type OrderLineInput } from '../orders/service';
import { upsertCustomer } from '../customers/service';
import { lockLiveSession } from '../tables/sessions';
import { openRewards, programSummary } from '../loyalty/engine';
import { runningMemberships } from '../loyalty/membership-state';
import { activeProgram } from '../loyalty/program';

export const MAX_CART_LINES = 50;
/** Spec §6: rate-limit orders per table. */
export const ORDER_LIMITS = { perSession10Min: 8, perGuest10Min: 2, perDevicePerMinute: 3 };

/** Orders one table visit may send in ten minutes: 8, or two per guest for bigger parties. */
async function visitOrderLimit(tx: Tx, sessionId: string): Promise<number> {
  const visit = await tx.db.selectFrom('table_sessions').select('guest_count').where('id', '=', sessionId).executeTakeFirst();
  // Joined tables all point at the party's visit, so their seats add up.
  const seats = await tx.db
    .selectFrom('tables')
    .select((eb) => eb.fn.sum<number>('seats').as('seats'))
    .where('current_session_id', '=', sessionId)
    .executeTakeFirst();
  const party = Math.max(visit?.guest_count ?? 0, Number(seats?.seats ?? 0));
  return Math.max(ORDER_LIMITS.perSession10Min, ORDER_LIMITS.perGuest10Min * party);
}

export async function guestContext(tx: Tx, outletId: string, tableId: string): Promise<GuestContextDTO> {
  const row = await tx.db
    .selectFrom('tables')
    .innerJoin('outlets', 'outlets.id', 'tables.outlet_id')
    .innerJoin('tenants', 'tenants.id', 'tables.tenant_id')
    .select([
      'tables.id as table_id',
      'tables.label',
      'tables.tenant_id',
      'outlets.id as outlet_id',
      'outlets.name as outlet_name',
      'outlets.prices_include_tax',
      'outlets.service_charge_bp',
      'outlets.service_charge_tax_rate_bp',
      'outlets.upi_vpa',
      'outlets.upi_payee_name',
      'tenants.name as tenant_name',
      'tenants.slug',
      'tenants.branding',
    ])
    .where('tables.id', '=', tableId)
    .where('outlets.id', '=', outletId)
    .executeTakeFirst();
  if (!row) throw notFound('Table');
  return {
    tenant: { name: row.tenant_name, slug: row.slug, branding: (row.branding ?? {}) as BrandingDTO },
    outlet: {
      id: row.outlet_id,
      name: row.outlet_name,
      menu_path: `/public/menu/${row.tenant_id}/${row.outlet_id}`,
      prices_include_tax: row.prices_include_tax,
      service_charge_bp: row.service_charge_bp,
      service_charge_tax_rate_bp: row.service_charge_tax_rate_bp,
      upi_vpa: row.upi_vpa,
      upi_payee_name: row.upi_payee_name,
    },
    table: { id: row.table_id, label: row.label },
  };
}

interface StoredLine {
  line_id: string;
  item_id: string;
  qty: number;
  modifier_ids: string[];
  note: string | null;
  added_by: string;
}

function readCart(raw: unknown): StoredLine[] {
  return Array.isArray(raw) ? (raw as StoredLine[]) : [];
}

function cartDto(sessionId: string, version: number, lines: StoredLine[]): CartDTO {
  return { session_id: sessionId, version, lines: lines as CartLineDTO[] };
}

/** Reads the guest's session; a closed session means the visit ended and the token is dead. */
export async function readGuestSession(tx: Tx, auth: GuestAuth) {
  const s = await tx.db
    .selectFrom('table_sessions')
    .select(['id', 'status', 'opened_at', 'bill_requested_at', 'cart', 'cart_version', 'table_id', 'customer_id', 'customer_verified_at'])
    .where('id', '=', auth.sessionId)
    .executeTakeFirst();
  if (!s) throw notFound('Table session');
  if (s.status === 'closed') throw gone('session_closed', 'This table visit has ended. Scan the QR code again.');
  return s;
}

export async function guestSessionView(tx: Tx, auth: GuestAuth, otpEnabled = false): Promise<GuestSessionDTO> {
  const s = await readGuestSession(tx, auth);
  const context = await guestContext(tx, auth.outletId, s.table_id);
  const orderIds = await tx.db
    .selectFrom('orders')
    .select('id')
    .where('table_session_id', '=', s.id)
    .orderBy('placed_at')
    .execute();
  const orders = await loadOrders(tx, orderIds.map((o) => o.id));
  const bills = await tx.db
    .selectFrom('bills')
    .select(['status', 'total_paise', 'paid_paise'])
    .where('table_session_id', '=', s.id)
    .where('status', '<>', 'void')
    .execute();
  const outlet = await tx.db.selectFrom('outlets').select(['event_seq']).where('id', '=', auth.outletId).executeTakeFirstOrThrow();
  const program = await activeProgram(tx);
  const customer = s.customer_id
    ? await tx.db
        .selectFrom('customers')
        .select(['id', 'phone', 'name', 'points', 'stamps', 'level', 'wallet_paid_paise', 'wallet_bonus_paise'])
        .where('id', '=', s.customer_id)
        .where('erased_at', 'is', null)
        .executeTakeFirst()
    : undefined;
  const verified = customer && s.customer_verified_at ? customer : null;
  const rewards = verified ? await openRewards(tx, verified.id) : [];
  const membership = verified ? (await runningMemberships(tx, verified.id))[0] : undefined;
  const earn = program?.config.earn;
  const finalised = bills.filter((b) => b.status !== 'draft');
  return {
    context,
    session: {
      id: s.id,
      status: s.status as SessionStatus,
      opened_at: s.opened_at?.toISOString() ?? null,
      bill_requested_at: s.bill_requested_at?.toISOString() ?? null,
    },
    cart: cartDto(s.id, s.cart_version, readCart(s.cart)),
    orders: orders.map(toGuestOrder),
    device_id: auth.deviceId,
    last_seq: outlet.event_seq,
    // A typed number shows only its last four digits; a number proved by SMS shows its name and points.
    customer: customer
      ? s.customer_verified_at
        ? {
            phone_last4: customer.phone.slice(-4),
            verified: true,
            name: customer.name,
            points: customer.points,
            stamps: customer.stamps,
            level: customer.level,
            rewards: rewards.filter((r) => r.status === 'available').map((r) => ({ label: r.label, valid_to: r.valid_to })),
            membership: membership ? { name: membership.plan.name, ends_at: membership.ends_at!.toISOString() } : null,
            wallet_paise: customer.wallet_paid_paise + customer.wallet_bonus_paise,
          }
        : { phone_last4: customer.phone.slice(-4), verified: false }
      : null,
    loyalty: {
      enabled: !!program,
      earn: earn?.kind ?? 'none',
      earn_bp: earn?.kind === 'points' ? earn.earn_bp : 0,
      stamp_goal: earn?.kind === 'stamps' ? earn.goal : null,
      summary: program ? await programSummary(tx, program) : null,
      otp: otpEnabled,
    },
    bill: finalised.length
      ? {
          total_paise: finalised.reduce((a, b) => a + b.total_paise, 0),
          paid_paise: finalised.reduce((a, b) => a + b.paid_paise, 0),
          status: (finalised.every((b) => b.status === 'paid') ? 'paid' : 'finalised') as BillStatus,
        }
      : null,
  };
}

async function writeCart(tx: Tx, auth: GuestAuth, version: number, lines: StoredLine[]): Promise<CartDTO> {
  const next = version + 1;
  await tx.db
    .updateTable('table_sessions')
    .set({ cart: json(lines), cart_version: next })
    .where('id', '=', auth.sessionId)
    .execute();
  const dto = cartDto(auth.sessionId, next, lines);
  // Everyone at the table sees the same cart (shared-cart decision).
  await tx.emit({ outletId: auth.outletId, type: 'cart.updated', channels: [`session:${auth.sessionId}`], payload: dto });
  return dto;
}

async function lockCart(tx: Tx, auth: GuestAuth) {
  await lockLiveSession(tx, auth.sessionId);
  const s = await tx.db
    .selectFrom('table_sessions')
    .select(['cart', 'cart_version'])
    .where('id', '=', auth.sessionId)
    .executeTakeFirstOrThrow();
  return { lines: readCart(s.cart), version: s.cart_version };
}

function sameChoice(a: StoredLine, b: { item_id: string; modifier_ids: string[]; note: string | null }): boolean {
  return (
    a.item_id === b.item_id &&
    (a.note ?? null) === (b.note ?? null) &&
    [...a.modifier_ids].sort().join(',') === [...b.modifier_ids].sort().join(',')
  );
}

export async function addCartLine(tx: Tx, auth: GuestAuth, input: OrderLineInput): Promise<CartDTO> {
  const { lines, version } = await lockCart(tx, auth);
  // Validate now so the guest learns about a missing size choice or sold-out dish immediately.
  const outlet = await tx.db.selectFrom('outlets').select(['id', 'timezone']).where('id', '=', auth.outletId).executeTakeFirstOrThrow();
  await prepareLines(tx, outlet, [input]);
  const note = input.note?.trim() || null;
  const existing = lines.find((l) => sameChoice(l, { ...input, note }));
  if (existing) {
    existing.qty = Math.min(99, existing.qty + input.qty);
  } else {
    if (lines.length >= MAX_CART_LINES) throw badRequest('cart_full', 'The cart is full. Place this order first.');
    lines.push({
      line_id: randomUUID(),
      item_id: input.item_id,
      qty: input.qty,
      modifier_ids: input.modifier_ids,
      note,
      added_by: auth.deviceId,
    });
  }
  return writeCart(tx, auth, version, lines);
}

export async function updateCartLine(
  tx: Tx,
  auth: GuestAuth,
  lineId: string,
  patch: { qty?: number; note?: string | null },
): Promise<CartDTO> {
  const { lines, version } = await lockCart(tx, auth);
  const line = lines.find((l) => l.line_id === lineId);
  if (!line) throw notFound('Cart line');
  if (patch.qty !== undefined) line.qty = patch.qty;
  if (patch.note !== undefined) line.note = patch.note?.trim() || null;
  return writeCart(
    tx,
    auth,
    version,
    lines.filter((l) => l.qty > 0),
  );
}

export async function removeCartLines(tx: Tx, auth: GuestAuth, lineIds: string[] | 'all'): Promise<CartDTO> {
  const { lines, version } = await lockCart(tx, auth);
  const keep = lineIds === 'all' ? [] : lines.filter((l) => !lineIds.includes(l.line_id));
  return writeCart(tx, auth, version, keep);
}

/** Turns cart lines into an order (spec §6 "Order now"). Ordered lines leave the shared cart. */
export async function placeGuestOrder(tx: Tx, auth: GuestAuth, input: { line_ids?: string[]; note?: string | null }) {
  const { lines, version } = await lockCart(tx, auth);
  const chosen = input.line_ids ? lines.filter((l) => input.line_ids!.includes(l.line_id)) : lines;
  if (chosen.length === 0) throw badRequest('empty_cart', 'Your cart is empty');

  const now = Date.now();
  const recent = await tx.db
    .selectFrom('orders')
    .select(['device_id', 'placed_at'])
    .where('table_session_id', '=', auth.sessionId)
    .where('placed_at', '>', new Date(now - 10 * 60_000))
    .execute();
  if (recent.length >= (await visitOrderLimit(tx, auth.sessionId))) throw tooMany('Too many orders from this table. Please call a waiter.');
  const lastMinute = recent.filter((o) => o.device_id === auth.deviceId && o.placed_at.getTime() > now - 60_000);
  if (lastMinute.length >= ORDER_LIMITS.perDevicePerMinute) throw tooMany('Please wait a moment before ordering again.');

  const order = await createOrder(tx, {
    outletId: auth.outletId,
    type: 'dine_in',
    source: 'guest_qr',
    sessionId: auth.sessionId,
    deviceId: auth.deviceId,
    note: input.note ?? null,
    lines: chosen.map((l) => ({ item_id: l.item_id, qty: l.qty, modifier_ids: l.modifier_ids, note: l.note })),
  });
  const chosenIds = new Set(chosen.map((l) => l.line_id));
  const cart = await writeCart(
    tx,
    auth,
    version,
    lines.filter((l) => !chosenIds.has(l.line_id)),
  );
  return { order: toGuestOrder(order), cart };
}

/**
 * A guest shares their phone (with consent) to earn points on this visit. Links the table session,
 * and any unprinted bill, to their customer record.
 */
export async function joinLoyalty(
  tx: Tx,
  auth: GuestAuth,
  input: { phone: string; name?: string | null; marketing_opt_in?: boolean },
): Promise<{ phone_last4: string }> {
  const s = await readGuestSession(tx, auth);
  const customer = await upsertCustomer(tx, { phone: input.phone, name: input.name, consentSource: 'guest', marketingOptIn: input.marketing_opt_in });
  await tx.db.updateTable('table_sessions').set({ customer_id: customer.id, customer_verified_at: null }).where('id', '=', s.id).execute();
  await tx.db
    .updateTable('bills')
    .set({ customer_id: customer.id })
    .where('table_session_id', '=', s.id)
    .where('status', '=', 'draft')
    .where('customer_id', 'is', null)
    .execute();
  return { phone_last4: customer.phone.slice(-4) };
}

// The prepaid wallet: a guest pays in advance (often for a bonus) and spends it on bills at any of
// the tenant's outlets. A top-up is not a sale, so it gets a receipt, not a GST invoice, and bills
// paid from the wallet are taxed in full. Paid and bonus money are kept apart: a refund gives back
// only what the guest paid. Spending needs proof the guest is there: a code texted to their phone,
// their phone proved at the table this visit, or (without SMS) a manager's PIN.

import { createHmac, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { financialYear, formatInvoiceNo, businessDate } from '@mezmitra/shared/dates';
import type { WalletDTO, WalletEntryDTO, WalletPackDTO, WalletTopupDTO } from '@mezmitra/shared/dto';
import { TOPUP_METHODS, type TopupMethod } from '@mezmitra/shared/enums';
import { checkPack, splitSpend, type WalletPackInput } from '@mezmitra/shared/loyalty';
import type { Tx } from '../../context';
import { requireApproval } from '../../lib/approvals';
import { audit } from '../../lib/audit';
import { assertCan, type StaffAuth } from '../../lib/auth';
import { nextCounter } from '../../lib/counters';
import { AppError, badRequest, notFound } from '../../lib/errors';
import type { OtpSender } from '../../lib/sms';
import { assertCodeAllowed, CODE_TTL_MS, hashCode, MAX_TRIES, mobile } from '../../lib/otp-codes';
import { openCashDrawer } from '../print/jobs';

const DAY = 86_400_000;
/** A proved code lets the cashier take wallet payments for this long. */
const PROOF_TTL_MS = 15 * 60_000;

export const packBody = z.object({
  name: z.string().trim().min(1).max(60),
  pay_paise: z.number().int().min(0).max(100_000_000),
  bonus_paise: z.number().int().min(0).max(100_000_000),
  validity_days: z.number().int().min(1).max(1095),
  is_active: z.boolean(),
});

export const topupBody = z.object({
  outlet_id: z.uuid(),
  pack_id: z.uuid().nullable().optional(),
  /** Without a pack: any amount, no bonus. */
  amount_paise: z.number().int().min(10_000).max(10_000_000).nullable().optional(),
  method: z.enum(TOPUP_METHODS),
  reference: z.string().trim().max(80).nullable().optional(),
  tendered_paise: z.number().int().min(0).max(100_000_000).nullable().optional(),
});

export async function listPacks(tx: Tx): Promise<WalletPackDTO[]> {
  return tx.db.selectFrom('wallet_packs').select(['id', 'name', 'pay_paise', 'bonus_paise', 'validity_days', 'is_active']).orderBy('is_active', 'desc').orderBy('pay_paise').execute();
}

export async function savePack(tx: Tx, auth: StaffAuth, outletId: string, id: string | null, input: z.infer<typeof packBody>): Promise<WalletPackDTO[]> {
  const problem = checkPack(input as WalletPackInput);
  if (problem) throw badRequest('invalid_pack', problem);
  const values = { name: input.name, pay_paise: input.pay_paise, bonus_paise: input.bonus_paise, validity_days: input.validity_days, is_active: input.is_active };
  if (id) {
    const r = await tx.db.updateTable('wallet_packs').set(values).where('id', '=', id).returning('id').executeTakeFirst();
    if (!r) throw notFound('Pack');
  } else {
    await tx.db.insertInto('wallet_packs').values({ tenant_id: tx.tenantId, ...values }).execute();
  }
  await audit(tx, auth, { outletId, action: 'wallet.pack', entity: 'wallet_pack', entityId: id, after: input });
  return listPacks(tx);
}

async function lockWallet(tx: Tx, customerId: string) {
  const c = await tx.db
    .selectFrom('customers')
    .select(['id', 'phone', 'wallet_paid_paise', 'wallet_bonus_paise', 'wallet_expires_at', 'erased_at'])
    .where('id', '=', customerId)
    .forUpdate()
    .executeTakeFirst();
  if (!c || c.erased_at) throw notFound('Customer');
  return c;
}

async function log(
  tx: Tx,
  row: { outletId: string | null; customerId: string; kind: WalletEntryDTO['kind']; paid: number; bonus: number; billId?: string | null; paymentId?: string | null; topupId?: string | null; note?: string | null; userId: string | null },
) {
  await tx.db
    .insertInto('wallet_ledger')
    .values({
      tenant_id: tx.tenantId,
      outlet_id: row.outletId,
      customer_id: row.customerId,
      kind: row.kind,
      paid_paise: row.paid,
      bonus_paise: row.bonus,
      bill_id: row.billId ?? null,
      payment_id: row.paymentId ?? null,
      topup_id: row.topupId ?? null,
      note: row.note ?? null,
      created_by: row.userId,
    })
    .execute();
}

/** A balance past its date lapses: what was paid and the bonus both go. */
export async function expireWallet(tx: Tx, customerId: string, outletId: string | null): Promise<void> {
  const c = await lockWallet(tx, customerId);
  if (!c.wallet_expires_at || c.wallet_expires_at > new Date() || c.wallet_paid_paise + c.wallet_bonus_paise === 0) return;
  await tx.db.updateTable('customers').set({ wallet_paid_paise: 0, wallet_bonus_paise: 0 }).where('id', '=', c.id).execute();
  await log(tx, { outletId, customerId: c.id, kind: 'expire', paid: -c.wallet_paid_paise, bonus: -c.wallet_bonus_paise, note: 'Validity ended', userId: null });
}

export async function walletBalance(tx: Tx, customerId: string) {
  const c = await tx.db.selectFrom('customers').select(['wallet_paid_paise', 'wallet_bonus_paise', 'wallet_expires_at']).where('id', '=', customerId).executeTakeFirstOrThrow();
  return { paid_paise: c.wallet_paid_paise, bonus_paise: c.wallet_bonus_paise, expires_at: c.wallet_expires_at?.toISOString() ?? null };
}

export async function walletDetail(tx: Tx, customerId: string, outletId: string): Promise<WalletDTO> {
  await expireWallet(tx, customerId, outletId);
  const ledger = await tx.db
    .selectFrom('wallet_ledger')
    .leftJoin('bills', 'bills.id', 'wallet_ledger.bill_id')
    .leftJoin('wallet_topups', 'wallet_topups.id', 'wallet_ledger.topup_id')
    .select(['wallet_ledger.id', 'wallet_ledger.kind', 'wallet_ledger.paid_paise', 'wallet_ledger.bonus_paise', 'bills.invoice_no', 'wallet_topups.receipt_no', 'wallet_ledger.note', 'wallet_ledger.created_at'])
    .where('wallet_ledger.customer_id', '=', customerId)
    .orderBy('wallet_ledger.created_at', 'desc')
    .limit(100)
    .execute();
  return { ...(await walletBalance(tx, customerId)), ledger: ledger.map((l) => ({ ...l, kind: l.kind as WalletEntryDTO['kind'], created_at: l.created_at.toISOString() })) };
}

/** Takes the guest's money for a pack (or an amount) and adds it, with any bonus, to their wallet. */
export async function topUp(tx: Tx, auth: StaffAuth, customerId: string, input: z.infer<typeof topupBody>): Promise<WalletTopupDTO> {
  assertCan(auth, input.outlet_id, 'payment.record');
  assertCan(auth, input.outlet_id, 'customer.manage');
  await expireWallet(tx, customerId, input.outlet_id);
  const c = await lockWallet(tx, customerId);
  let paid: number;
  let bonus = 0;
  let validity = 365;
  if (input.pack_id) {
    const pack = await tx.db.selectFrom('wallet_packs').selectAll().where('id', '=', input.pack_id).executeTakeFirst();
    if (!pack || !pack.is_active) throw notFound('Pack');
    paid = pack.pay_paise;
    bonus = pack.bonus_paise;
    validity = pack.validity_days;
  } else if (input.amount_paise) {
    paid = input.amount_paise;
  } else {
    throw badRequest('amount_required', 'Choose a pack or enter an amount');
  }
  let change: number | null = null;
  if (input.method === 'cash' && input.tendered_paise != null) {
    if (input.tendered_paise < paid) throw badRequest('tendered_short', 'Cash tendered is less than the amount');
    change = input.tendered_paise - paid;
  }
  const outlet = await tx.db.selectFrom('outlets').select(['invoice_prefix', 'timezone']).where('id', '=', input.outlet_id).executeTakeFirstOrThrow();
  const fy = financialYear(businessDate(new Date(), outlet.timezone));
  const receiptNo = formatInvoiceNo(`${outlet.invoice_prefix}W`, fy.code, await nextCounter(tx, input.outlet_id, 'wallet', fy.code));
  const topup = await tx.db
    .insertInto('wallet_topups')
    .values({ tenant_id: tx.tenantId, outlet_id: input.outlet_id, customer_id: c.id, pack_id: input.pack_id ?? null, receipt_no: receiptNo, paid_paise: paid, bonus_paise: bonus, created_by: auth.userId })
    .returning('id')
    .executeTakeFirstOrThrow();
  await tx.db
    .insertInto('payments')
    .values({
      tenant_id: tx.tenantId,
      outlet_id: input.outlet_id,
      wallet_topup_id: topup.id,
      method: input.method,
      amount_paise: paid,
      tendered_paise: input.method === 'cash' ? (input.tendered_paise ?? null) : null,
      change_paise: change,
      reference: input.reference?.trim() || null,
      confirmed_by: auth.userId,
    })
    .execute();
  const until = new Date(Date.now() + validity * DAY);
  const expires = c.wallet_expires_at && c.wallet_expires_at > until ? c.wallet_expires_at : until;
  await tx.db
    .updateTable('customers')
    .set({ wallet_paid_paise: c.wallet_paid_paise + paid, wallet_bonus_paise: c.wallet_bonus_paise + bonus, wallet_expires_at: expires })
    .where('id', '=', c.id)
    .execute();
  await log(tx, { outletId: input.outlet_id, customerId: c.id, kind: 'topup', paid, bonus, topupId: topup.id, userId: auth.userId });
  await audit(tx, auth, { outletId: input.outlet_id, action: 'wallet.topup', entity: 'customer', entityId: c.id, after: { receipt_no: receiptNo, paid_paise: paid, bonus_paise: bonus, method: input.method } });
  if (input.method === 'cash') await openCashDrawer(tx, input.outlet_id);
  return { id: topup.id, receipt_no: receiptNo, paid_paise: paid, bonus_paise: bonus, wallet: await walletBalance(tx, c.id) };
}

/** Texts the guest a code to read out at the counter, so their wallet can be spent. */
export async function sendWalletCode(tx: Tx, auth: StaffAuth, outletId: string, customerId: string, secret: string, sender: OtpSender) {
  assertCan(auth, outletId, 'payment.record');
  const c = await lockWallet(tx, customerId);
  const phone = mobile(c.phone);
  await assertCodeAllowed(tx, outletId, phone);
  const id = randomUUID();
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  await tx.db
    .insertInto('otp_codes')
    .values({ id, tenant_id: tx.tenantId, outlet_id: outletId, customer_id: c.id, purpose: 'wallet', phone, code_hash: hashCode(secret, id, code), expires_at: new Date(Date.now() + CODE_TTL_MS) })
    .execute();
  await sender.send(phone, code);
  return { phone_last4: phone.slice(-4) };
}

const proofSig = (secret: string, customerId: string, exp: number) => createHmac('sha256', secret).update(`wallet:${customerId}:${exp}`).digest('hex');

export type WalletCodeResult = { ok: true; proof: string } | { ok: false; reason: 'expired' } | { ok: false; reason: 'locked' } | { ok: false; reason: 'wrong'; left: number };

/**
 * Checks the code the guest read out. A wrong guess is returned, not thrown, so the attempt count
 * is kept; the right one gives a short-lived proof to pay with.
 */
export async function verifyWalletCode(tx: Tx, auth: StaffAuth, outletId: string, customerId: string, code: string, secret: string): Promise<WalletCodeResult> {
  assertCan(auth, outletId, 'payment.record');
  const row = await tx.db
    .selectFrom('otp_codes')
    .select(['id', 'code_hash', 'attempts', 'expires_at'])
    .where('customer_id', '=', customerId)
    .where('purpose', '=', 'wallet')
    .where('verified_at', 'is', null)
    .orderBy('created_at', 'desc')
    .limit(1)
    .forUpdate()
    .executeTakeFirst();
  if (!row || row.expires_at.getTime() < Date.now()) return { ok: false, reason: 'expired' };
  if (row.attempts >= MAX_TRIES) return { ok: false, reason: 'locked' };
  const right = timingSafeEqual(Buffer.from(row.code_hash, 'hex'), Buffer.from(hashCode(secret, row.id, code.trim()), 'hex'));
  if (!right) {
    await tx.db.updateTable('otp_codes').set({ attempts: row.attempts + 1 }).where('id', '=', row.id).execute();
    return { ok: false, reason: 'wrong', left: MAX_TRIES - row.attempts - 1 };
  }
  await tx.db.updateTable('otp_codes').set({ verified_at: new Date() }).where('id', '=', row.id).execute();
  const exp = Date.now() + PROOF_TTL_MS;
  return { ok: true, proof: `${exp}.${proofSig(secret, customerId, exp)}` };
}

function proofHolds(secret: string, customerId: string, proof: string | null | undefined): boolean {
  const [exp, sig] = (proof ?? '').split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const want = proofSig(secret, customerId, Number(exp));
  return sig.length === want.length && timingSafeEqual(Buffer.from(sig), Buffer.from(want));
}

/**
 * Takes `amount` off the guest's wallet for a bill payment, after checking the guest is there.
 * Returns how it splits between paid and bonus money, for the ledger once the payment exists.
 */
export async function spendFromWallet(
  tx: Tx,
  auth: StaffAuth,
  bill: { id: string; outlet_id: string; customer_id: string | null; table_session_id: string | null },
  amount: number,
  proof: { walletProof?: string | null; approvalToken?: string | null },
  ctx: { secret: string; smsReady: boolean },
): Promise<{ paid: number; bonus: number }> {
  if (!bill.customer_id) throw badRequest('customer_required', 'Attach the guest to the bill to pay from their wallet');
  const proved =
    proofHolds(ctx.secret, bill.customer_id, proof.walletProof) ||
    (bill.table_session_id
      ? !!(await tx.db
          .selectFrom('table_sessions')
          .select('id')
          .where('id', '=', bill.table_session_id)
          .where('customer_id', '=', bill.customer_id)
          .where('customer_verified_at', 'is not', null)
          .executeTakeFirst())
      : false);
  if (!proved) {
    if (ctx.smsReady) throw new AppError(403, 'wallet_code_required', "Text the guest a code and enter what they read out");
    await requireApproval(tx, auth, bill.outlet_id, 'wallet.spend', proof.approvalToken);
  }
  await expireWallet(tx, bill.customer_id, bill.outlet_id);
  const c = await lockWallet(tx, bill.customer_id);
  if (amount > c.wallet_paid_paise + c.wallet_bonus_paise) {
    throw badRequest('not_enough_wallet', 'The guest does not have that much in their wallet', { balance_paise: c.wallet_paid_paise + c.wallet_bonus_paise });
  }
  const split = splitSpend(c.wallet_paid_paise, c.wallet_bonus_paise, amount);
  await tx.db
    .updateTable('customers')
    .set({ wallet_paid_paise: c.wallet_paid_paise - split.paid, wallet_bonus_paise: c.wallet_bonus_paise - split.bonus })
    .where('id', '=', c.id)
    .execute();
  return split;
}

export async function logWalletSpend(tx: Tx, bill: { id: string; outlet_id: string; customer_id: string }, paymentId: string, split: { paid: number; bonus: number }, userId: string) {
  await log(tx, { outletId: bill.outlet_id, customerId: bill.customer_id, kind: 'spend', paid: -split.paid, bonus: -split.bonus, billId: bill.id, paymentId, userId });
}

/** A wallet payment refunded goes back into the wallet, in the same paid and bonus shares it left. */
export async function refundToWallet(tx: Tx, payment: { id: string; bill_id: string; outlet_id: string; amount_paise: number }, amount: number, userId: string): Promise<void> {
  const spent = await tx.db.selectFrom('wallet_ledger').select(['customer_id', 'paid_paise', 'bonus_paise']).where('payment_id', '=', payment.id).where('kind', '=', 'spend').executeTakeFirstOrThrow();
  const bonus = Math.round((-spent.bonus_paise * amount) / payment.amount_paise);
  const paid = amount - bonus;
  const c = await lockWallet(tx, spent.customer_id);
  await tx.db
    .updateTable('customers')
    .set({ wallet_paid_paise: c.wallet_paid_paise + paid, wallet_bonus_paise: c.wallet_bonus_paise + bonus })
    .where('id', '=', c.id)
    .execute();
  await log(tx, { outletId: payment.outlet_id, customerId: c.id, kind: 'refund', paid, bonus, billId: payment.bill_id, paymentId: payment.id, userId });
}

/**
 * Gives a guest back money they paid in, up to what they paid (a manager approves). The bonus that
 * came with that money is forfeited in proportion.
 */
export async function cashOut(
  tx: Tx,
  auth: StaffAuth,
  customerId: string,
  input: { outlet_id: string; amount_paise: number; method: TopupMethod; reason: string },
  approvalToken: string | null | undefined,
): Promise<WalletDTO> {
  assertCan(auth, input.outlet_id, 'payment.record');
  const reason = input.reason.trim();
  if (!reason) throw badRequest('reason_required', 'Give a reason for the refund');
  await expireWallet(tx, customerId, input.outlet_id);
  const c = await lockWallet(tx, customerId);
  if (input.amount_paise > c.wallet_paid_paise) throw badRequest('refund_too_large', `The guest paid in ${c.wallet_paid_paise / 100} rupees that are still unspent`);
  const approvedBy = await requireApproval(tx, auth, input.outlet_id, 'payment.refund', approvalToken);
  const latest = await tx.db.selectFrom('wallet_topups').select('id').where('customer_id', '=', c.id).orderBy('created_at', 'desc').executeTakeFirst();
  if (!latest) throw badRequest('nothing_paid_in', 'This guest has not topped up');
  const forfeit = c.wallet_paid_paise ? Math.round((c.wallet_bonus_paise * input.amount_paise) / c.wallet_paid_paise) : 0;
  const payment = await tx.db
    .insertInto('payments')
    .values({
      tenant_id: tx.tenantId,
      outlet_id: input.outlet_id,
      wallet_topup_id: latest.id,
      kind: 'refund',
      method: input.method,
      amount_paise: input.amount_paise,
      confirmed_by: auth.userId,
      approved_by: approvedBy,
      reason,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await tx.db
    .updateTable('customers')
    .set({ wallet_paid_paise: c.wallet_paid_paise - input.amount_paise, wallet_bonus_paise: c.wallet_bonus_paise - forfeit })
    .where('id', '=', c.id)
    .execute();
  await log(tx, { outletId: input.outlet_id, customerId: c.id, kind: 'cash_out', paid: -input.amount_paise, bonus: -forfeit, paymentId: payment.id, topupId: latest.id, note: reason, userId: auth.userId });
  await audit(tx, auth, { outletId: input.outlet_id, action: 'wallet.cash_out', entity: 'customer', entityId: c.id, after: { amount_paise: input.amount_paise, bonus_forfeited_paise: forfeit, method: input.method }, reason, approvedBy });
  if (input.method === 'cash') await openCashDrawer(tx, input.outlet_id);
  return walletDetail(tx, c.id, input.outlet_id);
}


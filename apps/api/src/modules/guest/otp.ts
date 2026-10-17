import { randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Tx } from '../../context';
import type { GuestAuth } from '../../lib/auth';
import { assertCodeAllowed, CODE_TTL_MS, hashCode, MAX_TRIES, mobile } from '../../lib/otp-codes';
import type { OtpSender } from '../../lib/sms';
import { joinLoyalty, readGuestSession } from './service';

/** Texts a six-digit code to the number for this table visit. */
export async function sendLoyaltyCode(tx: Tx, auth: GuestAuth, secret: string, sender: OtpSender, phoneInput: string) {
  const phone = mobile(phoneInput);
  const s = await readGuestSession(tx, auth);
  const now = Date.now();
  await assertCodeAllowed(tx, auth.outletId, phone);

  const id = randomUUID();
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  await tx.db
    .insertInto('otp_codes')
    .values({ id, tenant_id: tx.tenantId, outlet_id: auth.outletId, table_session_id: s.id, phone, code_hash: hashCode(secret, id, code), expires_at: new Date(now + CODE_TTL_MS) })
    .execute();
  // Still inside the transaction: if MSG91 refuses, no code is kept and the guest just asks again.
  await sender.send(phone, code);
  return { phone_last4: phone.slice(-4), expires_in_s: CODE_TTL_MS / 1000 };
}

export type VerifyResult =
  | { ok: true; phone_last4: string; name: string | null; points: number }
  | { ok: false; reason: 'expired' }
  | { ok: false; reason: 'locked' }
  | { ok: false; reason: 'wrong'; left: number };

/**
 * Checks the code. A wrong guess is returned, not thrown, so the attempt count is committed;
 * the route turns it into an error.
 */
export async function verifyLoyaltyCode(
  tx: Tx,
  auth: GuestAuth,
  secret: string,
  input: { phone: string; code: string; name?: string | null; marketing_opt_in?: boolean },
): Promise<VerifyResult> {
  const phone = mobile(input.phone);
  const s = await readGuestSession(tx, auth);
  const row = await tx.db
    .selectFrom('otp_codes')
    .select(['id', 'code_hash', 'attempts', 'expires_at'])
    .where('table_session_id', '=', s.id)
    .where('phone', '=', phone)
    .where('verified_at', 'is', null)
    .orderBy('created_at', 'desc')
    .limit(1)
    .forUpdate()
    .executeTakeFirst();
  if (!row || row.expires_at.getTime() < Date.now()) return { ok: false, reason: 'expired' };
  if (row.attempts >= MAX_TRIES) return { ok: false, reason: 'locked' };
  const right = timingSafeEqual(Buffer.from(row.code_hash, 'hex'), Buffer.from(hashCode(secret, row.id, input.code.trim()), 'hex'));
  if (!right) {
    await tx.db.updateTable('otp_codes').set({ attempts: row.attempts + 1 }).where('id', '=', row.id).execute();
    return { ok: false, reason: 'wrong', left: MAX_TRIES - row.attempts - 1 };
  }
  await tx.db.updateTable('otp_codes').set({ verified_at: new Date() }).where('id', '=', row.id).execute();
  await joinLoyalty(tx, auth, { phone, name: input.name, marketing_opt_in: input.marketing_opt_in });
  await tx.db.updateTable('table_sessions').set({ customer_verified_at: new Date() }).where('id', '=', s.id).execute();
  const customer = await tx.db
    .selectFrom('customers')
    .innerJoin('table_sessions', 'table_sessions.customer_id', 'customers.id')
    .select(['customers.name', 'customers.points'])
    .where('table_sessions.id', '=', s.id)
    .executeTakeFirstOrThrow();
  return { ok: true, phone_last4: phone.slice(-4), name: customer.name, points: customer.points };
}

// One-time codes texted to a guest's phone (MSG91): to prove a number at the table, or to let staff
// spend a guest's wallet at the counter. Shared limits, so neither can run up the SMS bill.

import { createHmac } from 'node:crypto';
import { normalizePhone } from '@mezmitra/shared/phone';
import type { Tx } from '../context';
import { badRequest, tooMany } from './errors';

export const CODE_TTL_MS = 10 * 60_000;
export const MAX_TRIES = 5;
/** SMS costs money and can be abused: a few codes per number, and a ceiling per outlet. */
const PER_NUMBER = { codes: 3, windowMs: 15 * 60_000 };
const PER_OUTLET_PER_HOUR = 100;

export const hashCode = (secret: string, id: string, code: string) => createHmac('sha256', secret).update(`${id}:${code}`).digest('hex');

/** Indian mobiles only: +91, then 6 to 9, then nine more digits. */
export function mobile(input: string): string {
  const phone = normalizePhone(input);
  if (!/^\+91[6-9]\d{9}$/.test(phone)) throw badRequest('invalid_phone', 'Enter a 10-digit Indian mobile number');
  return phone;
}

/** SMS costs money: refuses once a number or the outlet has had its share of codes lately. */
export async function assertCodeAllowed(tx: Tx, outletId: string, phone: string): Promise<void> {
  const now = Date.now();
  const forNumber = await tx.db
    .selectFrom('otp_codes')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('phone', '=', phone)
    .where('created_at', '>', new Date(now - PER_NUMBER.windowMs))
    .executeTakeFirstOrThrow();
  if (Number(forNumber.n) >= PER_NUMBER.codes) throw tooMany('Too many codes for this number. Try again in a few minutes.');
  const forOutlet = await tx.db
    .selectFrom('otp_codes')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('outlet_id', '=', outletId)
    .where('created_at', '>', new Date(now - 3_600_000))
    .executeTakeFirstOrThrow();
  if (Number(forOutlet.n) >= PER_OUTLET_PER_HOUR) throw tooMany('Codes are paused for a while. Ask your server to add your number.');
}

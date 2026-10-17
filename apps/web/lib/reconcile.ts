import type { MissingHints } from '@dineos/shared/dto';
import { formatPaise } from './format';

/** Why a UPI payment may be missing from the bank, in a sentence; null when nothing more is known. */
export function missingNote(p: MissingHints & { amount_paise: number }): string | null {
  if (p.utr_credit_paise !== null) return `The bank got ${formatPaise(p.utr_credit_paise)} under this UTR, not ${formatPaise(p.amount_paise)}.`;
  if (p.lookalikes > 0) {
    return `${p.lookalikes} other ${formatPaise(p.amount_paise)} payment${p.lookalikes === 1 ? '' : 's'} around then matched on amount alone, so the missing one may be any of them.`;
  }
  return null;
}

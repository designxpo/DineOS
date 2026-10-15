import type { CustomerDTO } from '@dineos/shared/dto';
import { normalizePhone } from '@dineos/shared/phone';
import type { Tx } from '../../context';
import { badRequest } from '../../lib/errors';

type Row = {
  id: string;
  phone: string;
  name: string | null;
  email: string | null;
  birthday: string | null;
  notes: string | null;
  consent_at: Date;
  consent_source: string;
  marketing_opt_in: boolean;
  visits: number;
  total_spend_paise: number;
  points: number;
  last_visit_at: Date | null;
  created_at: Date;
};

export const CUSTOMER_COLUMNS = [
  'id', 'phone', 'name', 'email', 'birthday', 'notes', 'consent_at', 'consent_source', 'marketing_opt_in',
  'visits', 'total_spend_paise', 'points', 'last_visit_at', 'created_at',
] as const;

export function customerDto(r: Row): CustomerDTO {
  return {
    ...r,
    consent_source: r.consent_source as CustomerDTO['consent_source'],
    consent_at: r.consent_at.toISOString(),
    last_visit_at: r.last_visit_at?.toISOString() ?? null,
    created_at: r.created_at.toISOString(),
  };
}

export function cleanPhone(raw: string): string {
  const phone = normalizePhone(raw);
  if (!/^\+?\d{10,15}$/.test(phone)) throw badRequest('invalid_phone', 'Enter a valid phone number');
  return phone;
}

/**
 * Finds the customer with this phone or creates one. Callers must have the person's consent:
 * the record stores when and where it was given (spec §12).
 */
export async function upsertCustomer(
  tx: Tx,
  input: { phone: string; name?: string | null; email?: string | null; consentSource: 'staff' | 'guest'; marketingOptIn?: boolean },
): Promise<CustomerDTO> {
  const phone = cleanPhone(input.phone);
  const existing = await tx.db
    .selectFrom('customers')
    .select(CUSTOMER_COLUMNS)
    .where('phone', '=', phone)
    .where('erased_at', 'is', null)
    .executeTakeFirst();
  if (existing) {
    // A guest at a table is not verified as the number's owner: they may link it to this visit
    // but not rename the record or opt it into marketing.
    if (input.consentSource === 'guest') return customerDto(existing);
    const name = input.name?.trim();
    if ((name && !existing.name) || input.marketingOptIn) {
      const updated = await tx.db
        .updateTable('customers')
        .set({ ...(name && !existing.name ? { name } : {}), ...(input.marketingOptIn ? { marketing_opt_in: true } : {}) })
        .where('id', '=', existing.id)
        .returning(CUSTOMER_COLUMNS)
        .executeTakeFirstOrThrow();
      return customerDto(updated);
    }
    return customerDto(existing);
  }
  const row = await tx.db
    .insertInto('customers')
    .values({
      tenant_id: tx.tenantId,
      phone,
      name: input.name?.trim() || null,
      email: input.email?.trim().toLowerCase() || null,
      consent_at: new Date(),
      consent_source: input.consentSource,
      marketing_opt_in: input.marketingOptIn ?? false,
    })
    .returning(CUSTOMER_COLUMNS)
    .executeTakeFirstOrThrow();
  return customerDto(row);
}

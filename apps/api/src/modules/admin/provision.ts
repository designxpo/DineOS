import { sql } from 'kysely';
import { normalizePhone } from '@dineos/shared/phone';
import type { Database } from '../../db';
import { hashSecret } from '../../lib/crypto';

export interface ProvisionInput {
  name: string;
  slug: string;
  plan_code: string;
  owner: { name: string; email?: string | null; phone?: string | null; password: string };
  outlet: {
    name: string;
    invoice_prefix?: string;
    gstin?: string | null;
    fssai_no?: string | null;
    address?: string | null;
    city?: string | null;
    state_code?: string | null;
  };
}

export interface Provisioned {
  tenantId: string;
  outletId: string;
  ownerId: string;
}

/**
 * Creates a tenant with its first outlet and owner. Runs on the admin connection (the tenant does
 * not exist yet, so there is no tenant context to set) inside one transaction.
 */
export async function provisionTenant(adminDb: Database, input: ProvisionInput): Promise<Provisioned> {
  const passwordHash = await hashSecret(input.owner.password);
  return adminDb.transaction().execute(async (trx) => {
    const tenant = await trx
      .insertInto('tenants')
      .values({ name: input.name, slug: input.slug.toLowerCase(), plan_code: input.plan_code })
      .returning('id')
      .executeTakeFirstOrThrow();
    // Inserts below are checked against RLS policies only for dineos_app; set the context anyway
    // so the same code path is valid if this ever runs under the app role.
    await sql`select set_config('app.tenant_id', ${tenant.id}, true)`.execute(trx);
    const outlet = await trx
      .insertInto('outlets')
      .values({
        tenant_id: tenant.id,
        name: input.outlet.name,
        invoice_prefix: input.outlet.invoice_prefix ?? 'INV',
        gstin: input.outlet.gstin ?? null,
        fssai_no: input.outlet.fssai_no ?? null,
        address: input.outlet.address ?? null,
        city: input.outlet.city ?? null,
        state_code: input.outlet.state_code ?? null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const owner = await trx
      .insertInto('users')
      .values({
        tenant_id: tenant.id,
        name: input.owner.name,
        email: input.owner.email?.trim().toLowerCase() || null,
        phone: input.owner.phone ? normalizePhone(input.owner.phone) : null,
        password_hash: passwordHash,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await trx
      .insertInto('user_outlet_roles')
      .values({ tenant_id: tenant.id, user_id: owner.id, outlet_id: null, role: 'owner' })
      .execute();
    const today = new Date();
    const end = new Date(today);
    end.setDate(end.getDate() + (input.plan_code === 'trial' ? 30 : 31));
    await trx
      .insertInto('subscriptions')
      .values({
        tenant_id: tenant.id,
        plan_code: input.plan_code,
        period_start: today.toISOString().slice(0, 10),
        period_end: end.toISOString().slice(0, 10),
      })
      .execute();
    return { tenantId: tenant.id, outletId: outlet.id, ownerId: owner.id };
  });
}

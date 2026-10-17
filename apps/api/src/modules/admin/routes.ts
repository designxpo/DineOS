// Platform admin (spec §10): tenants, plans, usage, manual subscription invoices, support access.
// Runs on the BYPASSRLS admin connection; every tenant-affecting action is written to that
// tenant's audit_log with actor_admin_id.

import type { FastifyPluginAsync } from 'fastify';
import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import { financialYear } from '@mezmitra/shared/dates';
import type { AppContext } from '../../context';
import { json, type DB } from '../../db';
import { clearAuthCache, requireAdmin } from '../../lib/auth';
import { randomToken, sha256, verifySecret } from '../../lib/crypto';
import { AppError, badRequest, conflict, notFound } from '../../lib/errors';
import { parse } from '../../lib/validate';
import { provisionTenant } from './provision';

const ADMIN_SESSION_HOURS = 12;
const IMPERSONATION_MINUTES = 60;

const tenantId = z.object({ id: z.uuid() });
const slug = z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{1,40}[a-z0-9]$/, 'Lowercase letters, digits and dashes');

async function tenantAudit(
  trx: Transaction<DB>,
  adminId: string,
  e: { tenantId: string; action: string; entity: string; entityId?: string | null; before?: unknown; after?: unknown; reason?: string | null },
) {
  await trx
    .insertInto('audit_log')
    .values({
      tenant_id: e.tenantId,
      actor_admin_id: adminId,
      action: e.action,
      entity: e.entity,
      entity_id: e.entityId ?? null,
      before: e.before === undefined ? null : json(e.before),
      after: e.after === undefined ? null : json(e.after),
      reason: e.reason ?? null,
    })
    .execute();
}

export default function routes(ctx: AppContext): FastifyPluginAsync {
  const db = ctx.adminDb;

  return async (app) => {
    // ---------------------------------------------------------------- auth

    app.post('/admin/auth/login', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req) => {
      const body = parse(z.object({ email: z.email(), password: z.string().min(1) }), req.body);
      const admin = await db
        .selectFrom('platform_admins')
        .selectAll()
        .where(sql`lower(email)`, '=', body.email.toLowerCase())
        .where('status', '=', 'active')
        .executeTakeFirst();
      if (!admin || !(await verifySecret(body.password, admin.password_hash))) {
        throw new AppError(401, 'invalid_credentials', 'Wrong email or password');
      }
      const token = randomToken('ad');
      const expiresAt = new Date(Date.now() + ADMIN_SESSION_HOURS * 3_600_000);
      await db.insertInto('admin_sessions').values({ admin_id: admin.id, token_hash: sha256(token), expires_at: expiresAt }).execute();
      return { token, expires_at: expiresAt.toISOString(), admin: { id: admin.id, name: admin.name, email: admin.email } };
    });

    app.post('/admin/auth/logout', async (req, reply) => {
      const auth = requireAdmin(req);
      await db.deleteFrom('admin_sessions').where('id', '=', auth.sessionId).execute();
      clearAuthCache();
      return reply.status(204).send();
    });

    app.get('/admin/auth/me', async (req) => {
      const auth = requireAdmin(req);
      return db.selectFrom('platform_admins').select(['id', 'name', 'email']).where('id', '=', auth.adminId).executeTakeFirstOrThrow();
    });

    // ---------------------------------------------------------------- tenants

    app.get('/admin/tenants', async (req) => {
      requireAdmin(req);
      const q = parse(z.object({ q: z.string().max(80).optional(), status: z.enum(['active', 'suspended', 'cancelled']).optional() }), req.query);
      let query = db
        .selectFrom('tenants')
        .innerJoin('plans', 'plans.code', 'tenants.plan_code')
        .select((eb) => [
          'tenants.id',
          'tenants.name',
          'tenants.slug',
          'tenants.status',
          'tenants.plan_code',
          'plans.name as plan_name',
          'tenants.created_at',
          eb.selectFrom('outlets').select((e) => e.fn.countAll<number>().as('n')).whereRef('outlets.tenant_id', '=', 'tenants.id').as('outlets'),
          eb
            .selectFrom('orders')
            .select((e) => e.fn.countAll<number>().as('n'))
            .whereRef('orders.tenant_id', '=', 'tenants.id')
            .where('orders.placed_at', '>', sql<Date>`now() - interval '30 days'`)
            .as('orders_30d'),
          eb
            .selectFrom('platform_invoices')
            .select((e) => e.fn.countAll<number>().as('n'))
            .whereRef('platform_invoices.tenant_id', '=', 'tenants.id')
            .where('platform_invoices.status', '=', 'unpaid')
            .as('unpaid_invoices'),
        ]);
      if (q.status) query = query.where('tenants.status', '=', q.status);
      if (q.q) query = query.where((eb) => eb.or([eb('tenants.name', 'ilike', `%${q.q}%`), eb('tenants.slug', 'ilike', `%${q.q}%`)]));
      const rows = await query.orderBy('tenants.created_at', 'desc').limit(500).execute();
      return rows.map((r) => ({ ...r, outlets: Number(r.outlets ?? 0), orders_30d: Number(r.orders_30d ?? 0), unpaid_invoices: Number(r.unpaid_invoices ?? 0) }));
    });

    app.post('/admin/tenants', async (req, reply) => {
      const auth = requireAdmin(req);
      const body = parse(
        z.object({
          name: z.string().trim().min(1).max(80),
          slug,
          plan_code: z.string().min(1),
          owner: z
            .object({ name: z.string().trim().min(1), email: z.email().nullable().optional(), phone: z.string().min(10).nullable().optional(), password: z.string().min(8) })
            .refine((o) => o.email || o.phone, 'Owner needs an email or phone'),
          outlet: z.object({
            name: z.string().trim().min(1),
            invoice_prefix: z.string().regex(/^[A-Z0-9]{1,4}$/).optional(),
            gstin: z.string().regex(/^[0-9]{2}[A-Z0-9]{13}$/).nullable().optional(),
            fssai_no: z.string().regex(/^\d{14}$/).nullable().optional(),
            address: z.string().max(300).nullable().optional(),
            city: z.string().max(60).nullable().optional(),
            state_code: z.string().regex(/^\d{2}$/).nullable().optional(),
          }),
        }),
        req.body,
      );
      const plan = await db.selectFrom('plans').select('code').where('code', '=', body.plan_code).where('is_active', '=', true).executeTakeFirst();
      if (!plan) throw badRequest('invalid_plan', 'Unknown plan');
      const taken = await db.selectFrom('tenants').select('id').where('slug', '=', body.slug).executeTakeFirst();
      if (taken) throw conflict('slug_taken', 'That restaurant code is taken');
      const ids = await provisionTenant(db, body);
      await db.transaction().execute((trx) =>
        tenantAudit(trx, auth.adminId, { tenantId: ids.tenantId, action: 'tenant.create', entity: 'tenant', entityId: ids.tenantId, after: { name: body.name, plan: body.plan_code } }),
      );
      return reply.status(201).send(ids);
    });

    app.get('/admin/tenants/:id', async (req) => {
      requireAdmin(req);
      const { id } = parse(tenantId, req.params);
      const tenant = await db.selectFrom('tenants').selectAll().where('id', '=', id).executeTakeFirst();
      if (!tenant) throw notFound('Tenant');
      const [outlets, owners, subscriptions, invoices, devices] = await Promise.all([
        db.selectFrom('outlets').select(['id', 'name', 'city', 'gstin', 'status', 'created_at']).where('tenant_id', '=', id).execute(),
        db
          .selectFrom('users')
          .innerJoin('user_outlet_roles', 'user_outlet_roles.user_id', 'users.id')
          .select(['users.id', 'users.name', 'users.email', 'users.phone', 'users.status'])
          .where('users.tenant_id', '=', id)
          .where('user_outlet_roles.role', '=', 'owner')
          .execute(),
        db.selectFrom('subscriptions').selectAll().where('tenant_id', '=', id).orderBy('period_end', 'desc').limit(12).execute(),
        db.selectFrom('platform_invoices').selectAll().where('tenant_id', '=', id).orderBy('created_at', 'desc').limit(24).execute(),
        db.selectFrom('devices').select(['id', 'name', 'kind', 'status', 'last_seen_at']).where('tenant_id', '=', id).execute(),
      ]);
      return { tenant, outlets, owners, subscriptions, invoices, devices };
    });

    /** Change plan, suspend or reactivate. Suspension blocks staff logins and guest ordering. */
    app.patch('/admin/tenants/:id', async (req) => {
      const auth = requireAdmin(req);
      const { id } = parse(tenantId, req.params);
      const body = parse(
        z.object({
          name: z.string().trim().min(1).max(80).optional(),
          plan_code: z.string().optional(),
          status: z.enum(['active', 'suspended', 'cancelled']).optional(),
          // The restaurant's own look: true or false for this restaurant, null to follow its plan.
          white_label: z.boolean().nullable().optional(),
          reason: z.string().max(300).optional(),
        }),
        req.body,
      );
      return db.transaction().execute(async (trx) => {
        const before = await trx.selectFrom('tenants').select(['name', 'plan_code', 'status', 'white_label']).where('id', '=', id).forUpdate().executeTakeFirst();
        if (!before) throw notFound('Tenant');
        if (body.plan_code) {
          const plan = await trx.selectFrom('plans').select('code').where('code', '=', body.plan_code).executeTakeFirst();
          if (!plan) throw badRequest('invalid_plan', 'Unknown plan');
        }
        if (body.status && body.status !== before.status && !body.reason) throw badRequest('reason_required', 'Give a reason for the status change');
        const set = Object.fromEntries(Object.entries({ name: body.name, plan_code: body.plan_code, status: body.status, white_label: body.white_label }).filter(([, v]) => v !== undefined));
        if (Object.keys(set).length) await trx.updateTable('tenants').set(set).where('id', '=', id).execute();
        const after = await trx.selectFrom('tenants').select(['name', 'plan_code', 'status', 'white_label']).where('id', '=', id).executeTakeFirstOrThrow();
        await tenantAudit(trx, auth.adminId, { tenantId: id, action: 'tenant.update', entity: 'tenant', entityId: id, before, after, reason: body.reason ?? null });
        clearAuthCache();
        return after;
      });
    });

    /**
     * Time-limited support access as one of the tenant's users (the owner by default). Mandatory
     * reason; every action taken is attributed to the admin in the tenant's audit log.
     */
    app.post('/admin/tenants/:id/impersonate', async (req) => {
      const auth = requireAdmin(req);
      const { id } = parse(tenantId, req.params);
      const body = parse(z.object({ reason: z.string().trim().min(5).max(300), user_id: z.uuid().optional() }), req.body);
      return db.transaction().execute(async (trx) => {
        let q = trx
          .selectFrom('users')
          .innerJoin('user_outlet_roles', 'user_outlet_roles.user_id', 'users.id')
          .select(['users.id', 'users.name'])
          .where('users.tenant_id', '=', id)
          .where('users.status', '=', 'active');
        q = body.user_id ? q.where('users.id', '=', body.user_id) : q.where('user_outlet_roles.role', '=', 'owner');
        const user = await q.executeTakeFirst();
        if (!user) throw notFound('User');
        const token = randomToken('st');
        const expiresAt = new Date(Date.now() + IMPERSONATION_MINUTES * 60_000);
        await trx
          .insertInto('user_sessions')
          .values({ tenant_id: id, user_id: user.id, token_hash: sha256(token), expires_at: expiresAt, impersonated_by: auth.adminId, user_agent: 'support-impersonation' })
          .execute();
        await tenantAudit(trx, auth.adminId, {
          tenantId: id,
          action: 'support.impersonate',
          entity: 'user',
          entityId: user.id,
          after: { expires_at: expiresAt.toISOString() },
          reason: body.reason,
        });
        return { token, expires_at: expiresAt.toISOString(), user };
      });
    });

    // ---------------------------------------------------------------- plans

    app.get('/admin/plans', async (req) => {
      requireAdmin(req);
      return db.selectFrom('plans').selectAll().orderBy('price_paise').execute();
    });

    const planBody = z.object({
      name: z.string().trim().min(1).max(60),
      price_paise: z.number().int().min(0),
      billing_period: z.enum(['monthly', 'yearly']).default('monthly'),
      features: z.record(z.string(), z.unknown()).default({}),
      is_active: z.boolean().default(true),
    });

    app.post('/admin/plans', async (req, reply) => {
      const auth = requireAdmin(req);
      const body = parse(planBody.extend({ code: z.string().regex(/^[a-z][a-z0-9_]{1,30}$/) }), req.body);
      const row = await db.insertInto('plans').values({ ...body, features: json(body.features) }).returningAll().executeTakeFirstOrThrow();
      await db.insertInto('platform_audit_log').values({ admin_id: auth.adminId, action: 'plan.create', entity: 'plan', entity_id: body.code, after: json(body) }).execute();
      return reply.status(201).send(row);
    });

    app.patch('/admin/plans/:code', async (req) => {
      const auth = requireAdmin(req);
      const { code } = parse(z.object({ code: z.string() }), req.params);
      const body = parse(planBody.partial(), req.body);
      const before = await db.selectFrom('plans').selectAll().where('code', '=', code).executeTakeFirst();
      if (!before) throw notFound('Plan');
      const row = await db
        .updateTable('plans')
        .set({ ...body, features: body.features ? json(body.features) : undefined })
        .where('code', '=', code)
        .returningAll()
        .executeTakeFirstOrThrow();
      await db.insertInto('platform_audit_log').values({ admin_id: auth.adminId, action: 'plan.update', entity: 'plan', entity_id: code, before: json(before), after: json(row) }).execute();
      return row;
    });

    // ---------------------------------------------------------------- usage

    app.get('/admin/usage', async (req) => {
      requireAdmin(req);
      const q = parse(z.object({ month: z.string().regex(/^\d{4}-\d{2}$/).optional() }), req.query);
      const month = q.month ?? new Date().toISOString().slice(0, 7);
      const from = `${month}-01`;
      const rows = await sql<{
        tenant_id: string;
        name: string;
        slug: string;
        plan_code: string;
        status: string;
        outlets: number;
        tables: number;
        orders: number;
        qr_orders: number;
        gmv_paise: number;
        active_devices: number;
      }>`
        select t.id as tenant_id, t.name, t.slug, t.plan_code, t.status,
          (select count(*) from outlets o where o.tenant_id = t.id) as outlets,
          (select count(*) from tables tb where tb.tenant_id = t.id and tb.is_active) as tables,
          (select count(*) from orders o where o.tenant_id = t.id and o.business_date >= ${from}::date and o.business_date < (${from}::date + interval '1 month')) as orders,
          (select count(*) from orders o where o.tenant_id = t.id and o.source = 'guest_qr' and o.business_date >= ${from}::date and o.business_date < (${from}::date + interval '1 month')) as qr_orders,
          (select coalesce(sum(b.total_paise), 0) from bills b where b.tenant_id = t.id and b.status in ('finalised', 'paid') and b.invoice_date >= ${from}::date and b.invoice_date < (${from}::date + interval '1 month')) as gmv_paise,
          (select count(*) from devices d where d.tenant_id = t.id and d.status = 'active' and d.last_seen_at > now() - interval '1 day') as active_devices
        from tenants t
        order by orders desc, t.name`.execute(db);
      return { month, tenants: rows.rows.map((r) => ({ ...r, outlets: Number(r.outlets), tables: Number(r.tables), orders: Number(r.orders), qr_orders: Number(r.qr_orders), gmv_paise: Number(r.gmv_paise), active_devices: Number(r.active_devices) })) };
    });

    // ---------------------------------------------------------------- subscription invoices (manual, no gateway)

    app.get('/admin/invoices', async (req) => {
      requireAdmin(req);
      const q = parse(z.object({ tenant_id: z.uuid().optional(), status: z.enum(['unpaid', 'paid', 'void']).optional() }), req.query);
      let query = db
        .selectFrom('platform_invoices')
        .innerJoin('tenants', 'tenants.id', 'platform_invoices.tenant_id')
        .selectAll('platform_invoices')
        .select(['tenants.name as tenant_name', 'tenants.slug as tenant_slug']);
      if (q.tenant_id) query = query.where('platform_invoices.tenant_id', '=', q.tenant_id);
      if (q.status) query = query.where('platform_invoices.status', '=', q.status);
      return query.orderBy('platform_invoices.created_at', 'desc').limit(500).execute();
    });

    app.post('/admin/invoices', async (req, reply) => {
      const auth = requireAdmin(req);
      const body = parse(
        z.object({
          tenant_id: z.uuid(),
          amount_paise: z.number().int().min(0).optional(),
          period_start: z.iso.date(),
          period_end: z.iso.date(),
          due_date: z.iso.date().optional(),
        }),
        req.body,
      );
      if (body.period_end < body.period_start) throw badRequest('invalid_period', 'Period ends before it starts');
      const invoice = await db.transaction().execute(async (trx) => {
        const tenant = await trx
          .selectFrom('tenants')
          .innerJoin('plans', 'plans.code', 'tenants.plan_code')
          .select(['tenants.id', 'tenants.plan_code', 'plans.price_paise'])
          .where('tenants.id', '=', body.tenant_id)
          .executeTakeFirst();
        if (!tenant) throw notFound('Tenant');
        const fy = financialYear(new Date().toISOString().slice(0, 10)).code;
        const { value } = await trx
          .insertInto('platform_counters')
          .values({ name: 'invoice', period: fy, value: 1 })
          .onConflict((oc) => oc.columns(['name', 'period']).doUpdateSet({ value: sql`platform_counters.value + 1` }))
          .returning('value')
          .executeTakeFirstOrThrow();
        const subscription = await trx
          .insertInto('subscriptions')
          .values({ tenant_id: tenant.id, plan_code: tenant.plan_code, period_start: body.period_start, period_end: body.period_end })
          .returning('id')
          .executeTakeFirstOrThrow();
        const row = await trx
          .insertInto('platform_invoices')
          .values({
            tenant_id: tenant.id,
            subscription_id: subscription.id,
            number: `DOS/${fy}/${String(value).padStart(5, '0')}`,
            amount_paise: body.amount_paise ?? tenant.price_paise,
            period_start: body.period_start,
            period_end: body.period_end,
            due_date: body.due_date ?? null,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await tenantAudit(trx, auth.adminId, { tenantId: tenant.id, action: 'platform_invoice.create', entity: 'platform_invoice', entityId: row.id, after: { number: row.number, amount_paise: row.amount_paise } });
        return row;
      });
      return reply.status(201).send(invoice);
    });

    /** UPI or bank transfer to our own account, confirmed by hand (spec §1: no gateway in v1). */
    app.post('/admin/invoices/:id/mark-paid', async (req) => {
      const auth = requireAdmin(req);
      const { id } = parse(z.object({ id: z.uuid() }), req.params);
      const body = parse(z.object({ reference: z.string().trim().min(3).max(100) }), req.body);
      return db.transaction().execute(async (trx) => {
        const inv = await trx.selectFrom('platform_invoices').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
        if (!inv) throw notFound('Invoice');
        if (inv.status !== 'unpaid') throw conflict('invoice_closed', `Invoice is ${inv.status}`);
        const row = await trx
          .updateTable('platform_invoices')
          .set({ status: 'paid', paid_reference: body.reference, paid_at: new Date() })
          .where('id', '=', id)
          .returningAll()
          .executeTakeFirstOrThrow();
        await tenantAudit(trx, auth.adminId, { tenantId: inv.tenant_id, action: 'platform_invoice.paid', entity: 'platform_invoice', entityId: id, after: { reference: body.reference } });
        return row;
      });
    });

    app.post('/admin/invoices/:id/void', async (req) => {
      const auth = requireAdmin(req);
      const { id } = parse(z.object({ id: z.uuid() }), req.params);
      const body = parse(z.object({ reason: z.string().trim().min(3).max(300) }), req.body);
      return db.transaction().execute(async (trx) => {
        const inv = await trx.selectFrom('platform_invoices').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
        if (!inv) throw notFound('Invoice');
        if (inv.status === 'void') throw conflict('invoice_closed', 'Invoice is already void');
        const row = await trx.updateTable('platform_invoices').set({ status: 'void' }).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
        await tenantAudit(trx, auth.adminId, { tenantId: inv.tenant_id, action: 'platform_invoice.void', entity: 'platform_invoice', entityId: id, reason: body.reason });
        return row;
      });
    });
  };
}

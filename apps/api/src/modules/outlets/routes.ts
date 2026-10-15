import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { OutletDTO } from '@dineos/shared/dto';
import type { AppContext, Tx } from '../../context';
import { audit } from '../../lib/audit';
import { accessibleOutletIds, assertCan, assertOutletAccess, isTenantWide, requireStaff, type StaffAuth } from '../../lib/auth';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors';
import { idParams, parse } from '../../lib/validate';

const station = z.string().trim().toLowerCase().regex(/^[a-z][a-z0-9_-]{0,29}$/, 'Station names use letters, numbers, - and _');

const outletFields = {
  name: z.string().trim().min(1).max(80),
  legal_name: z.string().trim().max(120).nullable(),
  address: z.string().trim().max(300).nullable(),
  city: z.string().trim().max(60).nullable(),
  state_code: z.string().regex(/^\d{2}$/, 'Two-digit GST state code').nullable(),
  phone: z.string().trim().max(20).nullable(),
  gstin: z.string().trim().toUpperCase().regex(/^[0-9]{2}[A-Z0-9]{13}$/, 'GSTIN is 15 characters').nullable(),
  fssai_no: z.string().trim().regex(/^\d{14}$/, 'FSSAI licence number is 14 digits').nullable(),
  invoice_prefix: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{1,4}$/, 'Up to 4 letters or digits'),
  timezone: z.string().min(3).max(60),
  auto_accept: z.boolean(),
  approve_flagged_orders: z.boolean(),
  service_charge_bp: z.number().int().min(0).max(2500),
  service_charge_tax_rate_bp: z.number().int().min(0).max(2800),
  default_tax_rate_bp: z.number().int().min(0).max(2800),
  prices_include_tax: z.boolean(),
  kitchen_stations: z.array(station).min(1).max(12),
  upi_vpa: z.string().trim().regex(/^[\w.-]{2,256}@[a-zA-Z][\w]{1,63}$/, 'UPI ID looks like name@bank').nullable(),
  upi_payee_name: z.string().trim().max(60).nullable(),
};
const updateOutlet = z.object(outletFields).partial();
const createOutlet = z.object(outletFields).partial().required({ name: true });

const OUTLET_COLUMNS = [
  'id', 'name', 'legal_name', 'address', 'city', 'state_code', 'phone', 'gstin', 'fssai_no', 'invoice_prefix', 'timezone',
  'auto_accept', 'approve_flagged_orders', 'service_charge_bp', 'service_charge_tax_rate_bp', 'default_tax_rate_bp',
  'prices_include_tax', 'kitchen_stations', 'upi_vpa', 'upi_payee_name', 'status',
] as const;

async function loadOutlet(tx: Tx, id: string): Promise<OutletDTO & { legal_name: string | null }> {
  const o = await tx.db.selectFrom('outlets').select(OUTLET_COLUMNS).where('id', '=', id).executeTakeFirst();
  if (!o) throw notFound('Outlet');
  return o;
}

function requireOwner(auth: StaffAuth): void {
  if (!auth.roles.some((r) => r.outletId === null && r.role === 'owner')) throw forbidden('Only the owner can do this');
}

/** Keys that hold secrets never leave the building, even in a data export. */
const EXPORT_OMIT = new Set(['password_hash', 'pin_hash', 'token_hash']);
const EXPORT_TABLES = [
  'outlets', 'users', 'user_outlet_roles', 'menu_categories', 'menu_items', 'modifier_groups', 'modifiers', 'item_modifier_groups',
  'tables', 'table_sessions', 'orders', 'order_items', 'kots', 'bills', 'bill_lines', 'payments', 'service_requests',
  'devices', 'audit_log', 'subscriptions', 'platform_invoices',
] as const;

export default function routes(ctx: AppContext): FastifyPluginAsync {
  return async (app) => {
    app.get('/outlets', async (req) => {
      const auth = requireStaff(req);
      return ctx.tx(auth.tenantId, async (tx) => {
        const ids = await accessibleOutletIds(tx, auth);
        if (ids.length === 0) return [];
        return tx.db.selectFrom('outlets').select(OUTLET_COLUMNS).where('id', 'in', ids).orderBy('name').execute();
      });
    });

    app.get('/outlets/:id', async (req) => {
      const auth = requireStaff(req);
      const { id } = parse(idParams, req.params);
      assertOutletAccess(auth, id);
      return ctx.tx(auth.tenantId, (tx) => loadOutlet(tx, id));
    });

    app.patch('/outlets/:id', async (req) => {
      const auth = requireStaff(req);
      const { id } = parse(idParams, req.params);
      assertCan(auth, id, 'outlet.settings');
      const body = parse(updateOutlet, req.body);
      return ctx.tx(auth.tenantId, async (tx) => {
        const before = await loadOutlet(tx, id);
        if (body.kitchen_stations) {
          const stations = [...new Set(body.kitchen_stations)];
          const removed = before.kitchen_stations.filter((s) => !stations.includes(s));
          if (removed.length) {
            const inUse = await tx.db
              .selectFrom('menu_items')
              .select('station')
              .distinct()
              .where('outlet_id', '=', id)
              .where('deleted_at', 'is', null)
              .where('station', 'in', removed)
              .execute();
            if (inUse.length) {
              throw conflict('station_in_use', `Move menu items off ${inUse.map((s) => s.station).join(', ')} first`);
            }
          }
          body.kitchen_stations = stations;
        }
        if (body.timezone && !Intl.supportedValuesOf('timeZone').includes(body.timezone)) {
          throw badRequest('invalid_timezone', 'Unknown timezone');
        }
        const set = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined));
        if (Object.keys(set).length) await tx.db.updateTable('outlets').set(set).where('id', '=', id).execute();
        const after = await loadOutlet(tx, id);
        const changed = Object.keys(set).filter((k) => JSON.stringify(before[k as keyof typeof before]) !== JSON.stringify(after[k as keyof typeof after]));
        if (changed.length) {
          await audit(tx, auth, {
            outletId: id,
            action: 'outlet.update',
            entity: 'outlet',
            entityId: id,
            before: Object.fromEntries(changed.map((k) => [k, before[k as keyof typeof before]])),
            after: Object.fromEntries(changed.map((k) => [k, after[k as keyof typeof after]])),
          });
        }
        return after;
      });
    });

    app.post('/outlets', async (req, reply) => {
      const auth = requireStaff(req);
      requireOwner(auth);
      const body = parse(createOutlet, req.body);
      const outlet = await ctx.tx(auth.tenantId, async (tx) => {
        const plan = await tx.db
          .selectFrom('tenants')
          .innerJoin('plans', 'plans.code', 'tenants.plan_code')
          .select('plans.features')
          .where('tenants.id', '=', tx.tenantId)
          .executeTakeFirstOrThrow();
        const max = Number((plan.features as { max_outlets?: number }).max_outlets ?? 1);
        const count = await tx.db.selectFrom('outlets').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow();
        if (Number(count.n) >= max) throw conflict('plan_limit', `Your plan allows ${max} outlet${max === 1 ? '' : 's'}. Upgrade to add more.`);
        const row = await tx.db.insertInto('outlets').values({ ...body, tenant_id: tx.tenantId }).returning('id').executeTakeFirstOrThrow();
        await audit(tx, auth, { outletId: row.id, action: 'outlet.create', entity: 'outlet', entityId: row.id, after: { name: body.name } });
        return loadOutlet(tx, row.id);
      });
      return reply.status(201).send(outlet);
    });

    // ---------------------------------------------------------------- tenant profile

    app.get('/tenant', async (req) => {
      const auth = requireStaff(req);
      return ctx.tx(auth.tenantId, async (tx) => {
        const tenant = await tx.db
          .selectFrom('tenants')
          .innerJoin('plans', 'plans.code', 'tenants.plan_code')
          .select(['tenants.id', 'tenants.name', 'tenants.slug', 'tenants.status', 'tenants.branding', 'tenants.plan_code', 'plans.name as plan_name', 'plans.features'])
          .where('tenants.id', '=', tx.tenantId)
          .executeTakeFirstOrThrow();
        return tenant;
      });
    });

    app.patch('/tenant', async (req) => {
      const auth = requireStaff(req);
      requireOwner(auth);
      const body = parse(
        z.object({
          name: z.string().trim().min(1).max(80).optional(),
          branding: z
            .object({
              primary_color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
              logo_url: z.string().url().nullable().optional(),
            })
            .optional(),
        }),
        req.body,
      );
      return ctx.tx(auth.tenantId, async (tx) => {
        const current = await tx.db.selectFrom('tenants').select(['name', 'branding']).where('id', '=', tx.tenantId).executeTakeFirstOrThrow();
        const branding = { ...((current.branding as object) ?? {}), ...(body.branding ?? {}) };
        await tx.db
          .updateTable('tenants')
          .set({ ...(body.name ? { name: body.name } : {}), branding: JSON.stringify(branding) })
          .where('id', '=', tx.tenantId)
          .execute();
        await audit(tx, auth, { action: 'tenant.update', entity: 'tenant', entityId: tx.tenantId, before: current, after: { name: body.name ?? current.name, branding } });
        return tx.db.selectFrom('tenants').select(['id', 'name', 'slug', 'branding']).where('id', '=', tx.tenantId).executeTakeFirstOrThrow();
      });
    });

    app.post('/tenant/logo', async (req) => {
      const auth = requireStaff(req);
      requireOwner(auth);
      const file = await req.file();
      if (!file) throw badRequest('file_required', 'Attach an image');
      const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[file.mimetype];
      if (!ext) throw badRequest('invalid_file_type', 'Use a JPG, PNG or WebP image');
      const url = await ctx.storage.put(`${auth.tenantId}/branding/logo-${randomUUID().slice(0, 8)}.${ext}`, await file.toBuffer(), file.mimetype);
      return ctx.tx(auth.tenantId, async (tx) => {
        const current = await tx.db.selectFrom('tenants').select('branding').where('id', '=', tx.tenantId).executeTakeFirstOrThrow();
        await tx.db
          .updateTable('tenants')
          .set({ branding: JSON.stringify({ ...((current.branding as object) ?? {}), logo_url: url }) })
          .where('id', '=', tx.tenantId)
          .execute();
        return { logo_url: url };
      });
    });

    app.get('/subscription', async (req) => {
      const auth = requireStaff(req);
      requireOwner(auth);
      return ctx.tx(auth.tenantId, async (tx) => {
        const subscription = await tx.db.selectFrom('subscriptions').selectAll().orderBy('period_end', 'desc').executeTakeFirst();
        const invoices = await tx.db.selectFrom('platform_invoices').selectAll().orderBy('created_at', 'desc').limit(24).execute();
        const plan = await tx.db
          .selectFrom('tenants')
          .innerJoin('plans', 'plans.code', 'tenants.plan_code')
          .select(['plans.code', 'plans.name', 'plans.price_paise', 'plans.features'])
          .where('tenants.id', '=', tx.tenantId)
          .executeTakeFirstOrThrow();
        return { plan, subscription: subscription ?? null, invoices };
      });
    });

    app.get('/audit', async (req) => {
      const auth = requireStaff(req);
      const q = parse(
        z.object({ outlet_id: z.uuid(), entity: z.string().max(40).optional(), entity_id: z.uuid().optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }),
        req.query,
      );
      assertCan(auth, q.outlet_id, 'audit.view');
      return ctx.tx(auth.tenantId, async (tx) => {
        let query = tx.db
          .selectFrom('audit_log')
          .leftJoin('users as actor', 'actor.id', 'audit_log.actor_user_id')
          .leftJoin('users as approver', 'approver.id', 'audit_log.approved_by')
          .select([
            'audit_log.id',
            'audit_log.action',
            'audit_log.entity',
            'audit_log.entity_id',
            'audit_log.before',
            'audit_log.after',
            'audit_log.reason',
            'audit_log.created_at',
            'audit_log.actor_admin_id',
            'actor.name as actor_name',
            'approver.name as approved_by_name',
          ])
          .where((eb) => eb.or([eb('audit_log.outlet_id', '=', q.outlet_id), eb('audit_log.outlet_id', 'is', null)]));
        if (q.entity) query = query.where('audit_log.entity', '=', q.entity);
        if (q.entity_id) query = query.where('audit_log.entity_id', '=', q.entity_id);
        return query.orderBy('audit_log.created_at', 'desc').limit(q.limit).execute();
      });
    });

    /** Data rights (spec §12): everything the tenant owns, minus credentials, as one JSON file. */
    app.get('/tenant/export', async (req, reply) => {
      const auth = requireStaff(req);
      requireOwner(auth);
      if (!isTenantWide(auth)) throw forbidden();
      const data = await ctx.tx(auth.tenantId, async (tx) => {
        const out: Record<string, unknown[]> = {};
        for (const table of EXPORT_TABLES) {
          const rows = (await tx.db.selectFrom(table).selectAll().execute()) as Record<string, unknown>[];
          out[table] = rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !EXPORT_OMIT.has(k))));
        }
        out.tenant = [await tx.db.selectFrom('tenants').selectAll().where('id', '=', tx.tenantId).executeTakeFirstOrThrow()];
        await audit(tx, auth, { action: 'tenant.export', entity: 'tenant', entityId: tx.tenantId });
        return out;
      });
      reply.header('content-disposition', `attachment; filename="dineos-export-${new Date().toISOString().slice(0, 10)}.json"`);
      return { exported_at: new Date().toISOString(), format_version: 1, data };
    });
  };
}

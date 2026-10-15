import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { AppContext, Tx } from '../../context';
import { audit } from '../../lib/audit';
import { assertCan, assertOutletAccess, requireAction, requireStaff, type StaffAuth } from '../../lib/auth';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { idParams, outletQuery, parse } from '../../lib/validate';
import {
  announceTables,
  loadServiceRequests,
  loadTables,
  markClean,
  mergeTables,
  releaseTable,
  seatTable,
  transferTable,
  unmergeTable,
} from './floor';
import { guestUrl, qrPng, qrSheetPdf, qrSvg } from './qr';

const tableFields = {
  label: z.string().trim().min(1).max(20),
  seats: z.number().int().min(1).max(50).optional(),
  zone: z.string().trim().max(40).nullable().optional(),
  sort: z.number().int().optional(),
};
const createTable = z.object({ outlet_id: z.uuid(), ...tableFields });
const updateTable = z.object(tableFields).partial();
const bulkCreate = z.object({
  outlet_id: z.uuid(),
  prefix: z.string().trim().max(10).default('T'),
  from: z.number().int().min(1).max(999),
  to: z.number().int().min(1).max(999),
  seats: z.number().int().min(1).max(50).default(4),
  zone: z.string().trim().max(40).nullable().optional(),
});

export default function routes(ctx: AppContext): FastifyPluginAsync {
  /** Loads a table and checks the caller may perform `action` at its outlet. */
  async function withTable<T>(
    auth: StaffAuth,
    tableId: string,
    action: 'table.manage' | 'table.operate',
    fn: (tx: Tx, table: { id: string; outlet_id: string }) => Promise<T>,
  ): Promise<T> {
    return ctx.tx(auth.tenantId, async (tx) => {
      const table = await tx.db.selectFrom('tables').select(['id', 'outlet_id']).where('id', '=', tableId).executeTakeFirst();
      if (!table) throw notFound('Table');
      assertCan(auth, table.outlet_id, action);
      return fn(tx, table);
    });
  }

  async function qrContext(tx: Tx, outletId: string) {
    const outlet = await tx.db
      .selectFrom('outlets')
      .innerJoin('tenants', 'tenants.id', 'outlets.tenant_id')
      .select(['outlets.id', 'outlets.name', 'tenants.slug', 'tenants.branding'])
      .where('outlets.id', '=', outletId)
      .executeTakeFirst();
    if (!outlet) throw notFound('Outlet');
    return outlet;
  }

  return async (app) => {
    // ---------------------------------------------------------------- floor map

    app.get('/tables', async (req) => {
      const auth = requireStaff(req);
      const q = parse(outletQuery.extend({ include_inactive: z.enum(['0', '1']).optional() }), req.query);
      assertOutletAccess(auth, q.outlet_id);
      return ctx.tx(auth.tenantId, async (tx) => {
        if (q.include_inactive === '1') {
          const ids = await tx.db.selectFrom('tables').select('id').where('outlet_id', '=', q.outlet_id).execute();
          return loadTables(tx, q.outlet_id, ids.map((r) => r.id));
        }
        return loadTables(tx, q.outlet_id);
      });
    });

    app.get('/tables/:id', async (req) => {
      const auth = requireStaff(req);
      const { id } = parse(idParams, req.params);
      return ctx.tx(auth.tenantId, async (tx) => {
        const table = await tx.db.selectFrom('tables').select('outlet_id').where('id', '=', id).executeTakeFirst();
        if (!table) throw notFound('Table');
        assertOutletAccess(auth, table.outlet_id);
        return (await loadTables(tx, table.outlet_id, [id]))[0];
      });
    });

    // ---------------------------------------------------------------- setup

    app.post('/tables', async (req, reply) => {
      const body = parse(createTable, req.body);
      const auth = requireAction(req, body.outlet_id, 'table.manage');
      const table = await ctx.tx(auth.tenantId, async (tx) => {
        const row = await tx.db
          .insertInto('tables')
          .values({
            tenant_id: tx.tenantId,
            outlet_id: body.outlet_id,
            label: body.label,
            seats: body.seats ?? 4,
            zone: body.zone ?? null,
            sort: body.sort ?? 0,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        await announceTables(tx, body.outlet_id, [row.id]);
        return (await loadTables(tx, body.outlet_id, [row.id]))[0];
      });
      return reply.status(201).send(table);
    });

    /** Quick setup: T1..T20 in one go. Existing labels are skipped. */
    app.post('/tables/bulk', async (req, reply) => {
      const body = parse(bulkCreate, req.body);
      if (body.to < body.from) throw badRequest('invalid_range', '"to" must be at least "from"');
      if (body.to - body.from >= 200) throw badRequest('too_many', 'At most 200 tables at once');
      const auth = requireAction(req, body.outlet_id, 'table.manage');
      const created = await ctx.tx(auth.tenantId, async (tx) => {
        const existing = await tx.db
          .selectFrom('tables')
          .select('label')
          .where('outlet_id', '=', body.outlet_id)
          .where('is_active', '=', true)
          .execute();
        const taken = new Set(existing.map((e) => e.label.toLowerCase()));
        const values = [];
        for (let n = body.from; n <= body.to; n++) {
          const label = `${body.prefix}${n}`;
          if (taken.has(label.toLowerCase())) continue;
          values.push({ tenant_id: tx.tenantId, outlet_id: body.outlet_id, label, seats: body.seats, zone: body.zone ?? null, sort: n });
        }
        if (values.length === 0) return [];
        const rows = await tx.db.insertInto('tables').values(values).returning('id').execute();
        await announceTables(tx, body.outlet_id, rows.map((r) => r.id));
        return loadTables(tx, body.outlet_id, rows.map((r) => r.id));
      });
      return reply.status(201).send(created);
    });

    app.patch('/tables/:id', async (req) => {
      const auth = requireStaff(req);
      const { id } = parse(idParams, req.params);
      const body = parse(updateTable, req.body);
      return withTable(auth, id, 'table.manage', async (tx, table) => {
        const set = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined));
        if (Object.keys(set).length) await tx.db.updateTable('tables').set(set).where('id', '=', id).execute();
        await announceTables(tx, table.outlet_id, [id]);
        return (await loadTables(tx, table.outlet_id, [id]))[0];
      });
    });

    /** Retires a table. Its printed QR stops working. Refused while guests are seated. */
    app.delete('/tables/:id', async (req, reply) => {
      const auth = requireStaff(req);
      const { id } = parse(idParams, req.params);
      await withTable(auth, id, 'table.manage', async (tx, table) => {
        const row = await tx.db.selectFrom('tables').select(['current_session_id']).where('id', '=', id).executeTakeFirstOrThrow();
        if (row.current_session_id) {
          const s = await tx.db.selectFrom('table_sessions').select('status').where('id', '=', row.current_session_id).executeTakeFirstOrThrow();
          if (s.status === 'open') throw conflict('table_in_use', 'Guests are seated at this table');
        }
        await tx.db.updateTable('tables').set({ is_active: false, current_session_id: null }).where('id', '=', id).execute();
        await announceTables(tx, table.outlet_id, [id]);
      });
      return reply.status(204).send();
    });

    // ---------------------------------------------------------------- QR codes

    /** Invalidates every printed copy of this table's QR (spec §6). */
    app.post('/tables/:id/rotate-qr', async (req) => {
      const auth = requireStaff(req);
      const { id } = parse(idParams, req.params);
      return withTable(auth, id, 'table.manage', async (tx, table) => {
        const row = await tx.db
          .updateTable('tables')
          .set((eb) => ({ qr_token_version: eb('qr_token_version', '+', 1) }))
          .where('id', '=', id)
          .returning(['qr_token_version'])
          .executeTakeFirstOrThrow();
        await audit(tx, auth, {
          outletId: table.outlet_id,
          action: 'table.rotate_qr',
          entity: 'table',
          entityId: id,
          after: { qr_token_version: row.qr_token_version },
        });
        return (await loadTables(tx, table.outlet_id, [id]))[0];
      });
    });

    app.get('/tables/:id/qr', async (req, reply) => {
      const auth = requireStaff(req);
      const { id } = parse(idParams, req.params);
      const q = parse(z.object({ format: z.enum(['json', 'svg', 'png']).default('json') }), req.query);
      const { url } = await withTable(auth, id, 'table.manage', async (tx, table) => {
        const t = await tx.db.selectFrom('tables').select(['id', 'label', 'zone', 'qr_token_version']).where('id', '=', id).executeTakeFirstOrThrow();
        const outlet = await qrContext(tx, table.outlet_id);
        return { url: guestUrl(ctx.config, { tenantId: tx.tenantId, outletId: outlet.id, slug: outlet.slug }, t) };
      });
      if (q.format === 'svg') return reply.header('content-type', 'image/svg+xml').send(await qrSvg(url));
      if (q.format === 'png') return reply.header('content-type', 'image/png').send(await qrPng(url));
      return { url, svg: await qrSvg(url) };
    });

    app.get('/tables/qr-sheet.pdf', async (req, reply) => {
      const auth = requireStaff(req);
      const q = parse(outletQuery.extend({ table_ids: z.string().optional() }), req.query);
      assertCan(auth, q.outlet_id, 'table.manage');
      const pdf = await ctx.tx(auth.tenantId, async (tx) => {
        const outlet = await qrContext(tx, q.outlet_id);
        let tq = tx.db
          .selectFrom('tables')
          .select(['id', 'label', 'zone', 'qr_token_version'])
          .where('outlet_id', '=', q.outlet_id)
          .where('is_active', '=', true);
        if (q.table_ids) tq = tq.where('id', 'in', q.table_ids.split(',').filter(Boolean));
        const tables = await tq.orderBy('zone').orderBy('sort').orderBy('label').execute();
        const ids = { tenantId: tx.tenantId, outletId: outlet.id, slug: outlet.slug };
        const accent = (outlet.branding as { primary_color?: string } | null)?.primary_color;
        return qrSheetPdf(
          outlet.name,
          tables.map((table) => ({ table, url: guestUrl(ctx.config, ids, table) })),
          accent && /^#[0-9a-f]{6}$/i.test(accent) ? accent : undefined,
        );
      });
      reply.header('content-type', 'application/pdf');
      reply.header('content-disposition', 'inline; filename="table-qr-codes.pdf"');
      return reply.send(pdf);
    });

    // ---------------------------------------------------------------- floor operations

    app.post('/tables/:id/seat', async (req) => {
      const auth = requireStaff(req);
      const { id } = parse(idParams, req.params);
      const body = parse(
        z.object({ guest_count: z.number().int().min(1).max(100).optional(), waiter_id: z.uuid().nullable().optional() }),
        req.body,
      );
      return withTable(auth, id, 'table.operate', async (tx, table) => {
        await seatTable(tx, id, { guestCount: body.guest_count ?? null, waiterId: body.waiter_id ?? auth.userId });
        return (await loadTables(tx, table.outlet_id, [id]))[0];
      });
    });

    app.post('/tables/:id/transfer', async (req) => {
      const auth = requireStaff(req);
      const { id } = parse(idParams, req.params);
      const body = parse(z.object({ to_table_id: z.uuid() }), req.body);
      return withTable(auth, id, 'table.operate', async (tx, table) => {
        await transferTable(tx, id, body.to_table_id);
        return loadTables(tx, table.outlet_id, [id, body.to_table_id]);
      });
    });

    app.post('/tables/merge', async (req) => {
      const auth = requireStaff(req);
      const body = parse(z.object({ table_ids: z.array(z.uuid()).min(2).max(10) }), req.body);
      return withTable(auth, body.table_ids[0]!, 'table.operate', async (tx, table) => {
        await mergeTables(tx, body.table_ids);
        return loadTables(tx, table.outlet_id, body.table_ids);
      });
    });

    app.post('/tables/:id/unmerge', async (req) => {
      const auth = requireStaff(req);
      const { id } = parse(idParams, req.params);
      return withTable(auth, id, 'table.operate', async (tx, table) => {
        await unmergeTable(tx, id);
        return (await loadTables(tx, table.outlet_id, [id]))[0];
      });
    });

    app.post('/tables/:id/release', async (req) => {
      const auth = requireStaff(req);
      const { id } = parse(idParams, req.params);
      return withTable(auth, id, 'table.operate', async (tx, table) => {
        await releaseTable(tx, id);
        return (await loadTables(tx, table.outlet_id, [id]))[0];
      });
    });

    app.post('/tables/:id/clean', async (req) => {
      const auth = requireStaff(req);
      const { id } = parse(idParams, req.params);
      return withTable(auth, id, 'table.operate', async (tx, table) => {
        await markClean(tx, id);
        return (await loadTables(tx, table.outlet_id, [id]))[0];
      });
    });

    app.patch('/tables/:id/waiter', async (req) => {
      const auth = requireStaff(req);
      const { id } = parse(idParams, req.params);
      const body = parse(z.object({ waiter_id: z.uuid().nullable() }), req.body);
      return withTable(auth, id, 'table.operate', async (tx, table) => {
        if (body.waiter_id) {
          const role = await tx.db
            .selectFrom('user_outlet_roles')
            .innerJoin('users', 'users.id', 'user_outlet_roles.user_id')
            .select('user_outlet_roles.id')
            .where('user_outlet_roles.user_id', '=', body.waiter_id)
            .where('users.status', '=', 'active')
            .where((eb) => eb.or([eb('user_outlet_roles.outlet_id', 'is', null), eb('user_outlet_roles.outlet_id', '=', table.outlet_id)]))
            .executeTakeFirst();
          if (!role) throw badRequest('invalid_waiter', 'That staff member does not work at this outlet');
        }
        await tx.db.updateTable('tables').set({ assigned_waiter_id: body.waiter_id }).where('id', '=', id).execute();
        await announceTables(tx, table.outlet_id, [id]);
        return (await loadTables(tx, table.outlet_id, [id]))[0];
      });
    });

    // ---------------------------------------------------------------- waiter calls and bill requests

    app.get('/service-requests', async (req) => {
      const auth = requireStaff(req);
      const { outlet_id } = parse(outletQuery, req.query);
      assertOutletAccess(auth, outlet_id);
      return ctx.tx(auth.tenantId, (tx) => loadServiceRequests(tx, outlet_id));
    });

    for (const [path, status] of [
      ['ack', 'acknowledged'],
      ['close', 'closed'],
    ] as const) {
      app.post(`/service-requests/:id/${path}`, async (req) => {
        const auth = requireStaff(req);
        const { id } = parse(idParams, req.params);
        return ctx.tx(auth.tenantId, async (tx) => {
          const row = await tx.db.selectFrom('service_requests').select(['outlet_id', 'status']).where('id', '=', id).executeTakeFirst();
          if (!row) throw notFound('Request');
          assertCan(auth, row.outlet_id, 'service_request.handle');
          await tx.db
            .updateTable('service_requests')
            .set({ status, ...(status === 'acknowledged' ? { acknowledged_by: auth.userId, acknowledged_at: new Date() } : {}) })
            .where('id', '=', id)
            .execute();
          const all = await tx.db
            .selectFrom('service_requests')
            .innerJoin('tables', 'tables.id', 'service_requests.table_id')
            .leftJoin('users', 'users.id', 'service_requests.acknowledged_by')
            .select([
              'service_requests.id',
              'service_requests.table_id',
              'tables.label as table_label',
              'service_requests.kind',
              'service_requests.status',
              'service_requests.created_at',
              'users.name as acknowledged_by',
            ])
            .where('service_requests.id', '=', id)
            .executeTakeFirstOrThrow();
          const dto = { ...all, created_at: all.created_at.toISOString() };
          await tx.emit({ outletId: row.outlet_id, type: 'service_request.updated', channels: ['outlet'], payload: { request: dto } });
          return dto;
        });
      });
    }
  };
}

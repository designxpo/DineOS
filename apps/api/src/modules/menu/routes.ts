import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext, Tx } from '../../context';
import { json } from '../../db';
import { assertCan, assertOutletAccess, requireAction, requireStaff } from '../../lib/auth';
import { badRequest, notFound } from '../../lib/errors';
import { idParams, outletQuery, parse } from '../../lib/validate';
import { IMPORT_TEMPLATE_CSV, importMenu, readSpreadsheet } from './import';
import { bumpMenu, loadMenu } from './service';

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM');
const translations = z
  .object({
    hi: z.object({ name: z.string().max(200).optional(), description: z.string().max(1000).optional() }).optional(),
  })
  .optional();
const schedule = z
  .object({ days: z.array(z.number().int().min(0).max(6)).max(7).optional(), from: hhmm.optional(), to: hhmm.optional() })
  .nullable()
  .optional();

const categoryFields = {
  name: z.string().trim().min(1).max(80),
  sort: z.number().int().optional(),
  available_schedule: schedule,
  is_active: z.boolean().optional(),
  translations,
};
const createCategory = z.object({ outlet_id: z.uuid(), ...categoryFields });
const updateCategory = z.object(categoryFields).partial();

const itemFields = {
  category_id: z.uuid(),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).nullable().optional(),
  price_paise: z.number().int().min(0).max(10_000_000),
  is_veg: z.boolean(),
  hsn_sac: z.string().trim().max(10).nullable().optional(),
  tax_rate_bp: z.number().int().min(0).max(2800).optional(),
  tags: z.array(z.string().trim().min(1).max(30)).max(10).optional(),
  in_stock: z.boolean().optional(),
  station: z.string().trim().min(1).max(30).optional(),
  sort: z.number().int().optional(),
  modifier_group_ids: z.array(z.uuid()).max(10).optional(),
  translations,
};
const createItem = z.object({ outlet_id: z.uuid(), ...itemFields });
const updateItem = z.object(itemFields).partial();

const modifierInput = z.object({
  id: z.uuid().optional(),
  name: z.string().trim().min(1).max(80),
  price_delta_paise: z.number().int().min(-1_000_000).max(1_000_000),
  is_veg: z.boolean().optional(),
  in_stock: z.boolean().optional(),
  sort: z.number().int().optional(),
  translations,
});
const groupFields = {
  name: z.string().trim().min(1).max(80),
  min_select: z.number().int().min(0).max(20),
  max_select: z.number().int().min(1).max(20),
  sort: z.number().int().optional(),
  translations,
  modifiers: z.array(modifierInput).min(1).max(30),
};
const createGroup = z
  .object({ outlet_id: z.uuid(), ...groupFields })
  .refine((g) => g.max_select >= g.min_select, 'max_select must be at least min_select');
const updateGroup = z.object(groupFields).partial();

const stockBody = z.object({ in_stock: z.boolean() });
const reorderBody = z.object({ outlet_id: z.uuid(), ids: z.array(z.uuid()).min(1).max(500) });

async function outletRow(tx: Tx, outletId: string) {
  const o = await tx.db
    .selectFrom('outlets')
    .select(['id', 'kitchen_stations', 'default_tax_rate_bp'])
    .where('id', '=', outletId)
    .executeTakeFirst();
  if (!o) throw notFound('Outlet');
  return o;
}

async function assertCategory(tx: Tx, outletId: string, categoryId: string) {
  const c = await tx.db
    .selectFrom('menu_categories')
    .select('id')
    .where('id', '=', categoryId)
    .where('outlet_id', '=', outletId)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  if (!c) throw badRequest('invalid_category', 'Category does not exist in this outlet');
}

function assertStation(stations: string[], station: string | undefined) {
  if (station !== undefined && !stations.includes(station)) {
    throw badRequest('invalid_station', `Station must be one of: ${stations.join(', ')}`);
  }
}

async function setItemGroups(tx: Tx, outletId: string, itemId: string, groupIds: string[]) {
  const unique = [...new Set(groupIds)];
  if (unique.length) {
    const found = await tx.db
      .selectFrom('modifier_groups')
      .select('id')
      .where('id', 'in', unique)
      .where('outlet_id', '=', outletId)
      .where('deleted_at', 'is', null)
      .execute();
    if (found.length !== unique.length) throw badRequest('invalid_modifier_group', 'Unknown modifier group');
  }
  await tx.db.deleteFrom('item_modifier_groups').where('item_id', '=', itemId).execute();
  if (unique.length) {
    await tx.db
      .insertInto('item_modifier_groups')
      .values(unique.map((group_id, sort) => ({ tenant_id: tx.tenantId, item_id: itemId, group_id, sort })))
      .execute();
  }
}

async function upsertModifiers(tx: Tx, groupId: string, mods: z.infer<typeof modifierInput>[]) {
  const existing = await tx.db
    .selectFrom('modifiers')
    .select('id')
    .where('group_id', '=', groupId)
    .where('deleted_at', 'is', null)
    .execute();
  const keep = new Set(mods.map((m) => m.id).filter(Boolean));
  const removed = existing.filter((e) => !keep.has(e.id)).map((e) => e.id);
  if (removed.length) {
    await tx.db.updateTable('modifiers').set({ deleted_at: new Date() }).where('id', 'in', removed).execute();
  }
  for (const [index, m] of mods.entries()) {
    const values = {
      name: m.name,
      price_delta_paise: m.price_delta_paise,
      is_veg: m.is_veg ?? true,
      in_stock: m.in_stock ?? true,
      sort: m.sort ?? index,
      translations: json(m.translations ?? {}),
    };
    if (m.id && existing.some((e) => e.id === m.id)) {
      await tx.db.updateTable('modifiers').set(values).where('id', '=', m.id).execute();
    } else {
      await tx.db.insertInto('modifiers').values({ ...values, tenant_id: tx.tenantId, group_id: groupId }).execute();
    }
  }
}

async function findOne<T extends { id: string }>(list: T[], id: string): Promise<T> {
  const hit = list.find((x) => x.id === id);
  if (!hit) throw notFound('Menu entry');
  return hit;
}

export default function routes(ctx: AppContext): FastifyPluginAsync {
  /** Runs `fn` for the entity's outlet after checking the caller may perform `action` there. */
  async function onEntity<T>(
    req: FastifyRequest,
    table: 'menu_categories' | 'menu_items' | 'modifier_groups',
    id: string,
    action: 'menu.manage' | 'menu.stock',
    fn: (tx: Tx, outletId: string) => Promise<T>,
  ): Promise<T> {
    const auth = requireStaff(req);
    return ctx.tx(auth.tenantId, async (tx) => {
      const row = await tx.db
        .selectFrom(table)
        .select('outlet_id')
        .where('id', '=', id)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (!row) throw notFound('Menu entry');
      assertCan(auth, row.outlet_id, action);
      return fn(tx, row.outlet_id);
    });
  }

  return async (app) => {
    app.get('/menu', async (req) => {
      const auth = requireStaff(req);
      const { outlet_id } = parse(outletQuery, req.query);
      assertOutletAccess(auth, outlet_id);
      return ctx.tx(auth.tenantId, (tx) => loadMenu(tx, outlet_id));
    });

    // ---------------------------------------------------------------- categories

    app.post('/menu/categories', async (req, reply) => {
      const body = parse(createCategory, req.body);
      const auth = requireAction(req, body.outlet_id, 'menu.manage');
      const result = await ctx.tx(auth.tenantId, async (tx) => {
        const row = await tx.db
          .insertInto('menu_categories')
          .values({
            tenant_id: tx.tenantId,
            outlet_id: body.outlet_id,
            name: body.name,
            sort: body.sort ?? 0,
            available_schedule: body.available_schedule ? json(body.available_schedule) : null,
            is_active: body.is_active ?? true,
            translations: json(body.translations ?? {}),
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        await bumpMenu(tx, body.outlet_id);
        return findOne((await loadMenu(tx, body.outlet_id)).categories, row.id);
      });
      return reply.status(201).send(result);
    });

    app.patch('/menu/categories/:id', async (req) => {
      const { id } = parse(idParams, req.params);
      const body = parse(updateCategory, req.body);
      return onEntity(req, 'menu_categories', id, 'menu.manage', async (tx, outletId) => {
        await tx.db
          .updateTable('menu_categories')
          .set({
            ...(body.name !== undefined ? { name: body.name } : {}),
            ...(body.sort !== undefined ? { sort: body.sort } : {}),
            ...(body.is_active !== undefined ? { is_active: body.is_active } : {}),
            ...(body.available_schedule !== undefined
              ? { available_schedule: body.available_schedule ? json(body.available_schedule) : null }
              : {}),
            ...(body.translations !== undefined ? { translations: json(body.translations) } : {}),
          })
          .where('id', '=', id)
          .execute();
        await bumpMenu(tx, outletId);
        return findOne((await loadMenu(tx, outletId)).categories, id);
      });
    });

    app.delete('/menu/categories/:id', async (req, reply) => {
      const { id } = parse(idParams, req.params);
      await onEntity(req, 'menu_categories', id, 'menu.manage', async (tx, outletId) => {
        const now = new Date();
        await tx.db.updateTable('menu_categories').set({ deleted_at: now }).where('id', '=', id).execute();
        await tx.db
          .updateTable('menu_items')
          .set({ deleted_at: now })
          .where('category_id', '=', id)
          .where('deleted_at', 'is', null)
          .execute();
        await bumpMenu(tx, outletId);
      });
      return reply.status(204).send();
    });

    app.post('/menu/categories/reorder', async (req) => {
      const body = parse(reorderBody, req.body);
      const auth = requireAction(req, body.outlet_id, 'menu.manage');
      return ctx.tx(auth.tenantId, async (tx) => {
        for (const [sort, id] of body.ids.entries()) {
          await tx.db.updateTable('menu_categories').set({ sort }).where('id', '=', id).where('outlet_id', '=', body.outlet_id).execute();
        }
        await bumpMenu(tx, body.outlet_id);
        return loadMenu(tx, body.outlet_id);
      });
    });

    // ---------------------------------------------------------------- items

    app.post('/menu/items', async (req, reply) => {
      const body = parse(createItem, req.body);
      const auth = requireAction(req, body.outlet_id, 'menu.manage');
      const result = await ctx.tx(auth.tenantId, async (tx) => {
        const outlet = await outletRow(tx, body.outlet_id);
        await assertCategory(tx, body.outlet_id, body.category_id);
        assertStation(outlet.kitchen_stations, body.station);
        const row = await tx.db
          .insertInto('menu_items')
          .values({
            tenant_id: tx.tenantId,
            outlet_id: body.outlet_id,
            category_id: body.category_id,
            name: body.name,
            description: body.description ?? null,
            price_paise: body.price_paise,
            is_veg: body.is_veg,
            hsn_sac: body.hsn_sac ?? null,
            tax_rate_bp: body.tax_rate_bp ?? outlet.default_tax_rate_bp,
            tags: body.tags ?? [],
            in_stock: body.in_stock ?? true,
            station: body.station ?? outlet.kitchen_stations[0] ?? 'kitchen',
            sort: body.sort ?? 0,
            translations: json(body.translations ?? {}),
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        if (body.modifier_group_ids) await setItemGroups(tx, body.outlet_id, row.id, body.modifier_group_ids);
        await bumpMenu(tx, body.outlet_id);
        return findOne((await loadMenu(tx, body.outlet_id)).items, row.id);
      });
      return reply.status(201).send(result);
    });

    app.patch('/menu/items/:id', async (req) => {
      const { id } = parse(idParams, req.params);
      const body = parse(updateItem, req.body);
      return onEntity(req, 'menu_items', id, 'menu.manage', async (tx, outletId) => {
        const outlet = await outletRow(tx, outletId);
        if (body.category_id) await assertCategory(tx, outletId, body.category_id);
        assertStation(outlet.kitchen_stations, body.station);
        const { modifier_group_ids, translations: tr, description, hsn_sac, ...rest } = body;
        const set = {
          ...Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)),
          ...(description !== undefined ? { description } : {}),
          ...(hsn_sac !== undefined ? { hsn_sac } : {}),
          ...(tr !== undefined ? { translations: json(tr) } : {}),
        };
        if (Object.keys(set).length) await tx.db.updateTable('menu_items').set(set).where('id', '=', id).execute();
        if (modifier_group_ids) await setItemGroups(tx, outletId, id, modifier_group_ids);
        await bumpMenu(tx, outletId);
        return findOne((await loadMenu(tx, outletId)).items, id);
      });
    });

    app.delete('/menu/items/:id', async (req, reply) => {
      const { id } = parse(idParams, req.params);
      // Soft delete: old orders and bills keep pointing at the item.
      await onEntity(req, 'menu_items', id, 'menu.manage', async (tx, outletId) => {
        await tx.db.updateTable('menu_items').set({ deleted_at: new Date() }).where('id', '=', id).execute();
        await bumpMenu(tx, outletId);
      });
      return reply.status(204).send();
    });

    app.post('/menu/items/reorder', async (req) => {
      const body = parse(reorderBody, req.body);
      const auth = requireAction(req, body.outlet_id, 'menu.manage');
      return ctx.tx(auth.tenantId, async (tx) => {
        for (const [sort, id] of body.ids.entries()) {
          await tx.db.updateTable('menu_items').set({ sort }).where('id', '=', id).where('outlet_id', '=', body.outlet_id).execute();
        }
        await bumpMenu(tx, body.outlet_id);
        return loadMenu(tx, body.outlet_id);
      });
    });

    /** Stock toggle: every open guest menu greys the item out within the same second (spec §6). */
    app.patch('/menu/items/:id/stock', async (req) => {
      const { id } = parse(idParams, req.params);
      const { in_stock } = parse(stockBody, req.body);
      return onEntity(req, 'menu_items', id, 'menu.stock', async (tx, outletId) => {
        await tx.db.updateTable('menu_items').set({ in_stock }).where('id', '=', id).execute();
        await bumpMenu(tx, outletId);
        await tx.emit({ outletId, type: 'item.stock_changed', channels: ['outlet', 'menu'], payload: { item_id: id, in_stock } });
        return { id, in_stock };
      });
    });

    app.post('/menu/items/:id/photo', async (req) => {
      const { id } = parse(idParams, req.params);
      const file = await req.file();
      if (!file) throw badRequest('file_required', 'Attach an image');
      const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[file.mimetype];
      if (!ext) throw badRequest('invalid_file_type', 'Use a JPG, PNG or WebP image');
      const body = await file.toBuffer();
      return onEntity(req, 'menu_items', id, 'menu.manage', async (tx, outletId) => {
        const url = await ctx.storage.put(`${tx.tenantId}/menu/${id}-${randomUUID().slice(0, 8)}.${ext}`, body, file.mimetype);
        await tx.db.updateTable('menu_items').set({ photo_url: url }).where('id', '=', id).execute();
        await bumpMenu(tx, outletId);
        return { id, photo_url: url };
      });
    });

    app.delete('/menu/items/:id/photo', async (req, reply) => {
      const { id } = parse(idParams, req.params);
      await onEntity(req, 'menu_items', id, 'menu.manage', async (tx, outletId) => {
        await tx.db.updateTable('menu_items').set({ photo_url: null }).where('id', '=', id).execute();
        await bumpMenu(tx, outletId);
      });
      return reply.status(204).send();
    });

    // ---------------------------------------------------------------- modifier groups

    app.post('/menu/modifier-groups', async (req, reply) => {
      const body = parse(createGroup, req.body);
      const auth = requireAction(req, body.outlet_id, 'menu.manage');
      const result = await ctx.tx(auth.tenantId, async (tx) => {
        const row = await tx.db
          .insertInto('modifier_groups')
          .values({
            tenant_id: tx.tenantId,
            outlet_id: body.outlet_id,
            name: body.name,
            min_select: body.min_select,
            max_select: body.max_select,
            sort: body.sort ?? 0,
            translations: json(body.translations ?? {}),
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        await upsertModifiers(tx, row.id, body.modifiers);
        await bumpMenu(tx, body.outlet_id);
        return findOne((await loadMenu(tx, body.outlet_id)).modifier_groups, row.id);
      });
      return reply.status(201).send(result);
    });

    app.patch('/menu/modifier-groups/:id', async (req) => {
      const { id } = parse(idParams, req.params);
      const body = parse(updateGroup, req.body);
      return onEntity(req, 'modifier_groups', id, 'menu.manage', async (tx, outletId) => {
        const current = await tx.db
          .selectFrom('modifier_groups')
          .select(['min_select', 'max_select'])
          .where('id', '=', id)
          .executeTakeFirstOrThrow();
        if ((body.max_select ?? current.max_select) < (body.min_select ?? current.min_select)) {
          throw badRequest('invalid_range', 'max_select must be at least min_select');
        }
        const { modifiers, translations: tr, ...rest } = body;
        const set = {
          ...Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)),
          ...(tr !== undefined ? { translations: json(tr) } : {}),
        };
        if (Object.keys(set).length) await tx.db.updateTable('modifier_groups').set(set).where('id', '=', id).execute();
        if (modifiers) await upsertModifiers(tx, id, modifiers);
        await bumpMenu(tx, outletId);
        return findOne((await loadMenu(tx, outletId)).modifier_groups, id);
      });
    });

    app.delete('/menu/modifier-groups/:id', async (req, reply) => {
      const { id } = parse(idParams, req.params);
      await onEntity(req, 'modifier_groups', id, 'menu.manage', async (tx, outletId) => {
        await tx.db.updateTable('modifier_groups').set({ deleted_at: new Date() }).where('id', '=', id).execute();
        await tx.db.deleteFrom('item_modifier_groups').where('group_id', '=', id).execute();
        await bumpMenu(tx, outletId);
      });
      return reply.status(204).send();
    });

    app.patch('/menu/modifiers/:id/stock', async (req) => {
      const { id } = parse(idParams, req.params);
      const { in_stock } = parse(stockBody, req.body);
      const auth = requireStaff(req);
      return ctx.tx(auth.tenantId, async (tx) => {
        const row = await tx.db
          .selectFrom('modifiers')
          .innerJoin('modifier_groups', 'modifier_groups.id', 'modifiers.group_id')
          .select('modifier_groups.outlet_id')
          .where('modifiers.id', '=', id)
          .where('modifiers.deleted_at', 'is', null)
          .executeTakeFirst();
        if (!row) throw notFound('Modifier');
        assertCan(auth, row.outlet_id, 'menu.stock');
        await tx.db.updateTable('modifiers').set({ in_stock }).where('id', '=', id).execute();
        await bumpMenu(tx, row.outlet_id);
        return { id, in_stock };
      });
    });

    // ---------------------------------------------------------------- spreadsheet import

    app.get('/menu/import/template.csv', async (_req, reply) => {
      reply.header('content-type', 'text/csv; charset=utf-8');
      reply.header('content-disposition', 'attachment; filename="menu-template.csv"');
      return IMPORT_TEMPLATE_CSV;
    });

    /** CSV or XLSX upload. All-or-nothing: any bad row returns the errors and imports nothing. */
    app.post('/menu/import', async (req) => {
      const q = parse(outletQuery.extend({ dry_run: z.enum(['0', '1', 'true', 'false']).optional() }), req.query);
      const auth = requireAction(req, q.outlet_id, 'menu.manage');
      const file = await req.file();
      if (!file) throw badRequest('file_required', 'Attach a CSV or Excel file');
      const rows = await readSpreadsheet(file.filename, await file.toBuffer());
      const dryRun = q.dry_run === '1' || q.dry_run === 'true';
      return ctx.tx(auth.tenantId, async (tx) => {
        const outlet = await outletRow(tx, q.outlet_id);
        const result = await importMenu(tx, outlet, rows, { dryRun });
        if (!dryRun && result.errors.length === 0) await bumpMenu(tx, q.outlet_id);
        return result;
      });
    });
  };
}

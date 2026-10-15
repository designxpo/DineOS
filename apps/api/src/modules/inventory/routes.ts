import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { INGREDIENT_UNITS, type RecipeLineDTO, type RecipesDTO, type StockMovementDTO } from '@dineos/shared/dto';
import type { AppContext, Tx } from '../../context';
import { audit } from '../../lib/audit';
import { assertCan, requireStaff } from '../../lib/auth';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { assertOutletExists } from '../../lib/outlet';
import { idParams, parse } from '../../lib/validate';
import { applyMovement, ingredientDto, round3 } from './stock';

const outletParam = z.object({ outlet_id: z.uuid() });
const qty = z.number().min(0).max(10_000_000);
const recipeLines = z
  .array(z.object({ ingredient_id: z.uuid(), qty: z.number().positive().max(1_000_000) }))
  .max(60)
  .refine((lines) => new Set(lines.map((l) => l.ingredient_id)).size === lines.length, 'Each ingredient once per recipe');

async function usage(tx: Tx, ingredientIds: string[]): Promise<Map<string, number>> {
  if (!ingredientIds.length) return new Map();
  const [items, mods] = await Promise.all([
    tx.db.selectFrom('recipes').select(['ingredient_id', (eb) => eb.fn.countAll<number>().as('n')]).where('ingredient_id', 'in', ingredientIds).groupBy('ingredient_id').execute(),
    tx.db.selectFrom('modifier_recipes').select(['ingredient_id', (eb) => eb.fn.countAll<number>().as('n')]).where('ingredient_id', 'in', ingredientIds).groupBy('ingredient_id').execute(),
  ]);
  const out = new Map<string, number>();
  for (const r of [...items, ...mods]) out.set(r.ingredient_id, (out.get(r.ingredient_id) ?? 0) + Number(r.n));
  return out;
}

/** Ingredients must belong to the same outlet as the dish they go into. */
async function assertIngredients(tx: Tx, outletId: string, ids: string[]) {
  if (!ids.length) return;
  const found = await tx.db.selectFrom('ingredients').select('id').where('outlet_id', '=', outletId).where('id', 'in', ids).execute();
  if (found.length !== new Set(ids).size) throw badRequest('invalid_ingredient', 'An ingredient is not in this outlet');
}

export default function routes(ctx: AppContext): FastifyPluginAsync {
  return async (app) => {
    app.get('/inventory/ingredients', async (req) => {
      const auth = requireStaff(req);
      const q = parse(outletParam.extend({ include_inactive: z.coerce.boolean().default(false) }), req.query);
      assertCan(auth, q.outlet_id, 'inventory.record');
      return ctx.tx(auth.tenantId, async (tx) => {
        let query = tx.db.selectFrom('ingredients').selectAll().where('outlet_id', '=', q.outlet_id);
        if (!q.include_inactive) query = query.where('is_active', '=', true);
        const rows = await query.orderBy('name').execute();
        const used = await usage(tx, rows.map((r) => r.id));
        return rows.map((r) => ingredientDto(r, used.get(r.id) ?? 0));
      });
    });

    app.post('/inventory/ingredients', async (req, reply) => {
      const auth = requireStaff(req);
      const body = parse(
        outletParam.extend({
          name: z.string().trim().min(1).max(80),
          unit: z.enum(INGREDIENT_UNITS),
          reorder_level: qty.default(0),
          cost_per_unit_paise: z.number().min(0).max(10_000_000).default(0),
          opening_qty: qty.optional(),
        }),
        req.body,
      );
      assertCan(auth, body.outlet_id, 'inventory.manage');
      const result = await ctx.tx(auth.tenantId, async (tx) => {
        await assertOutletExists(tx, body.outlet_id);
        const clash = await tx.db
          .selectFrom('ingredients')
          .select('id')
          .where('outlet_id', '=', body.outlet_id)
          .where('is_active', '=', true)
          .where((eb) => eb(eb.fn('lower', ['name']), '=', body.name.toLowerCase()))
          .executeTakeFirst();
        if (clash) throw conflict('duplicate_ingredient', `${body.name} already exists`);
        const row = await tx.db
          .insertInto('ingredients')
          .values({
            tenant_id: tx.tenantId,
            outlet_id: body.outlet_id,
            name: body.name,
            unit: body.unit,
            reorder_level: round3(body.reorder_level),
            cost_per_unit_paise: body.cost_per_unit_paise,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        if (body.opening_qty) {
          const { after } = await applyMovement(tx, { ingredientId: row.id, type: 'count', qty: body.opening_qty, note: 'Opening stock', userId: auth.userId });
          return ingredientDto(after);
        }
        return ingredientDto(row);
      });
      return reply.status(201).send(result);
    });

    app.patch('/inventory/ingredients/:id', async (req) => {
      const auth = requireStaff(req);
      const { id } = parse(idParams, req.params);
      const body = parse(
        z.object({
          name: z.string().trim().min(1).max(80).optional(),
          unit: z.enum(INGREDIENT_UNITS).optional(),
          reorder_level: qty.optional(),
          cost_per_unit_paise: z.number().min(0).max(10_000_000).optional(),
          is_active: z.boolean().optional(),
        }),
        req.body,
      );
      return ctx.tx(auth.tenantId, async (tx) => {
        const current = await tx.db.selectFrom('ingredients').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
        if (!current) throw notFound('Ingredient');
        assertCan(auth, current.outlet_id, 'inventory.manage');
        const used = (await usage(tx, [id])).get(id) ?? 0;
        // Recipes and stock are written in this unit; changing it would silently rescale them.
        if (body.unit && body.unit !== current.unit && (used || current.stock_qty !== 0)) {
          throw conflict('unit_locked', 'Unit can only change while the ingredient has no stock and no recipes');
        }
        if (body.is_active === false && used) throw conflict('in_use', `Used in ${used} recipe${used === 1 ? '' : 's'}; remove it from them first`);
        const row = await tx.db
          .updateTable('ingredients')
          .set({
            ...(body.name ? { name: body.name } : {}),
            ...(body.unit ? { unit: body.unit } : {}),
            ...(body.reorder_level !== undefined ? { reorder_level: round3(body.reorder_level) } : {}),
            ...(body.cost_per_unit_paise !== undefined ? { cost_per_unit_paise: body.cost_per_unit_paise } : {}),
            ...(body.is_active !== undefined ? { is_active: body.is_active } : {}),
          })
          .where('id', '=', id)
          .returningAll()
          .executeTakeFirstOrThrow();
        return ingredientDto(row, used);
      });
    });

    /**
     * Records stock in or out. Purchases and corrections need a manager role; the kitchen can log
     * wastage and shelf counts. Several lines at once fit a supplier invoice or a count sheet.
     */
    app.post('/inventory/movements', async (req, reply) => {
      const auth = requireStaff(req);
      const body = parse(
        outletParam.extend({
          type: z.enum(['purchase', 'wastage', 'adjust', 'count']),
          supplier: z.string().trim().max(120).nullable().optional(),
          note: z.string().trim().max(300).nullable().optional(),
          lines: z
            .array(z.object({ ingredient_id: z.uuid(), qty: z.number().min(-10_000_000).max(10_000_000), unit_cost_paise: z.number().min(0).max(10_000_000).nullable().optional() }))
            .min(1)
            .max(200),
        }),
        req.body,
      );
      assertCan(auth, body.outlet_id, body.type === 'purchase' || body.type === 'adjust' ? 'inventory.manage' : 'inventory.record');
      for (const l of body.lines) {
        if (body.type !== 'adjust' && l.qty < 0) throw badRequest('invalid_qty', 'Quantities must be positive');
        if (body.type !== 'count' && l.qty === 0) throw badRequest('invalid_qty', 'Quantity cannot be zero');
      }
      if (body.type === 'adjust' && !body.note?.trim()) throw badRequest('reason_required', 'Say why the stock is being corrected');
      const result = await ctx.tx(auth.tenantId, async (tx) => {
        const ids = body.lines.map((l) => l.ingredient_id);
        if (new Set(ids).size !== ids.length) throw badRequest('duplicate_line', 'Each ingredient once per entry');
        await assertIngredients(tx, body.outlet_id, ids);
        const out = [];
        for (const l of [...body.lines].sort((a, b) => a.ingredient_id.localeCompare(b.ingredient_id))) {
          const qty = body.type === 'wastage' ? -l.qty : l.qty;
          const { before, after } = await applyMovement(tx, {
            ingredientId: l.ingredient_id,
            type: body.type,
            qty,
            unitCostPaise: l.unit_cost_paise ?? null,
            supplier: body.supplier,
            note: body.note,
            userId: auth.userId,
          });
          out.push(ingredientDto(after));
          if (body.type === 'adjust' || (body.type === 'count' && Math.abs(after.stock_qty - before.stock_qty) > 0)) {
            await audit(tx, auth, {
              outletId: body.outlet_id,
              action: `inventory.${body.type}`,
              entity: 'ingredient',
              entityId: l.ingredient_id,
              before: { stock_qty: before.stock_qty },
              after: { stock_qty: after.stock_qty },
              reason: body.note ?? null,
            });
          }
        }
        return out;
      });
      return reply.status(201).send(result);
    });

    app.get('/inventory/movements', async (req) => {
      const auth = requireStaff(req);
      const q = parse(
        outletParam.extend({ ingredient_id: z.uuid().optional(), type: z.enum(['purchase', 'sale', 'return', 'wastage', 'adjust', 'count']).optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }),
        req.query,
      );
      assertCan(auth, q.outlet_id, 'inventory.record');
      return ctx.tx(auth.tenantId, async (tx) => {
        let query = tx.db
          .selectFrom('stock_movements as m')
          .innerJoin('ingredients as i', 'i.id', 'm.ingredient_id')
          .leftJoin('users as u', 'u.id', 'm.created_by')
          .select(['m.id', 'm.ingredient_id', 'i.name as ingredient_name', 'i.unit', 'm.type', 'm.qty', 'm.unit_cost_paise', 'm.stock_after', 'm.supplier', 'm.note', 'u.name as created_by_name', 'm.created_at'])
          .where('m.outlet_id', '=', q.outlet_id);
        if (q.ingredient_id) query = query.where('m.ingredient_id', '=', q.ingredient_id);
        if (q.type) query = query.where('m.type', '=', q.type);
        const rows = await query.orderBy('m.created_at', 'desc').limit(q.limit).execute();
        return rows.map(
          (r): StockMovementDTO => ({
            ...r,
            unit: r.unit as StockMovementDTO['unit'],
            type: r.type as StockMovementDTO['type'],
            created_at: r.created_at.toISOString(),
          }),
        );
      });
    });

    // ---------------------------------------------------------------- recipes

    app.get('/inventory/recipes', async (req) => {
      const auth = requireStaff(req);
      const q = parse(outletParam, req.query);
      assertCan(auth, q.outlet_id, 'inventory.record');
      return ctx.tx(auth.tenantId, async (tx): Promise<RecipesDTO> => {
        const [items, mods] = await Promise.all([
          tx.db
            .selectFrom('recipes')
            .innerJoin('ingredients', 'ingredients.id', 'recipes.ingredient_id')
            .select(['recipes.item_id', 'recipes.ingredient_id', 'recipes.qty'])
            .where('ingredients.outlet_id', '=', q.outlet_id)
            .execute(),
          tx.db
            .selectFrom('modifier_recipes')
            .innerJoin('ingredients', 'ingredients.id', 'modifier_recipes.ingredient_id')
            .select(['modifier_recipes.modifier_id', 'modifier_recipes.ingredient_id', 'modifier_recipes.qty'])
            .where('ingredients.outlet_id', '=', q.outlet_id)
            .execute(),
        ]);
        const group = <K extends string>(rows: ({ ingredient_id: string; qty: number } & Record<K, string>)[], key: K) => {
          const out: Record<string, RecipeLineDTO[]> = {};
          for (const r of rows) (out[r[key]] ??= []).push({ ingredient_id: r.ingredient_id, qty: Number(r.qty) });
          return out;
        };
        return { items: group(items, 'item_id'), modifiers: group(mods, 'modifier_id') };
      });
    });

    app.put('/inventory/recipes/items/:id', async (req) => {
      const auth = requireStaff(req);
      const { id } = parse(idParams, req.params);
      const body = parse(z.object({ lines: recipeLines }), req.body);
      return ctx.tx(auth.tenantId, async (tx) => {
        const item = await tx.db.selectFrom('menu_items').select(['outlet_id']).where('id', '=', id).where('deleted_at', 'is', null).executeTakeFirst();
        if (!item) throw notFound('Menu item');
        assertCan(auth, item.outlet_id, 'inventory.manage');
        await assertIngredients(tx, item.outlet_id, body.lines.map((l) => l.ingredient_id));
        await tx.db.deleteFrom('recipes').where('item_id', '=', id).execute();
        if (body.lines.length) {
          await tx.db
            .insertInto('recipes')
            .values(body.lines.map((l) => ({ tenant_id: tx.tenantId, item_id: id, ingredient_id: l.ingredient_id, qty: round3(l.qty) })))
            .execute();
        }
        return body.lines;
      });
    });

    app.put('/inventory/recipes/modifiers/:id', async (req) => {
      const auth = requireStaff(req);
      const { id } = parse(idParams, req.params);
      const body = parse(z.object({ lines: recipeLines }), req.body);
      return ctx.tx(auth.tenantId, async (tx) => {
        const mod = await tx.db
          .selectFrom('modifiers')
          .innerJoin('modifier_groups', 'modifier_groups.id', 'modifiers.group_id')
          .select('modifier_groups.outlet_id')
          .where('modifiers.id', '=', id)
          .where('modifiers.deleted_at', 'is', null)
          .executeTakeFirst();
        if (!mod) throw notFound('Modifier');
        assertCan(auth, mod.outlet_id, 'inventory.manage');
        await assertIngredients(tx, mod.outlet_id, body.lines.map((l) => l.ingredient_id));
        await tx.db.deleteFrom('modifier_recipes').where('modifier_id', '=', id).execute();
        if (body.lines.length) {
          await tx.db
            .insertInto('modifier_recipes')
            .values(body.lines.map((l) => ({ tenant_id: tx.tenantId, modifier_id: id, ingredient_id: l.ingredient_id, qty: round3(l.qty) })))
            .execute();
        }
        return body.lines;
      });
    });
  };
}

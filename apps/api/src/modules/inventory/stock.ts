import { sql } from 'kysely';
import type { IngredientDTO, IngredientUnit, ModifierSnapshot, StockMovementType } from '@dineos/shared/dto';
import type { Tx } from '../../context';
import { json } from '../../db';
import { notFound } from '../../lib/errors';
import { bumpMenu } from '../menu/service';

/** Stock is kept to three decimals (grams of a kilo, millilitres of a litre). */
export const round3 = (n: number) => Math.round(n * 1000) / 1000;

type IngredientRow = {
  id: string;
  outlet_id: string;
  name: string;
  unit: string;
  stock_qty: number;
  reorder_level: number;
  cost_per_unit_paise: number;
  is_active: boolean;
};

export function ingredientDto(r: IngredientRow, usedBy = 0): IngredientDTO {
  return {
    id: r.id,
    outlet_id: r.outlet_id,
    name: r.name,
    unit: r.unit as IngredientUnit,
    stock_qty: Number(r.stock_qty),
    reorder_level: Number(r.reorder_level),
    cost_per_unit_paise: Number(r.cost_per_unit_paise),
    is_active: r.is_active,
    low: Number(r.stock_qty) <= Number(r.reorder_level),
    used_by: usedBy,
  };
}

const INGREDIENT_COLUMNS = ['id', 'outlet_id', 'name', 'unit', 'stock_qty', 'reorder_level', 'cost_per_unit_paise', 'is_active'] as const;

interface MovementInput {
  ingredientId: string;
  type: StockMovementType;
  /** Signed change; for `count` the counted quantity on the shelf. */
  qty: number;
  unitCostPaise?: number | null;
  supplier?: string | null;
  note?: string | null;
  orderItemId?: string | null;
  userId?: string | null;
}

/**
 * Applies one stock change and logs it. Purchases update the moving-average unit cost; a count
 * sets the shelf quantity and logs the difference. Returns the ingredient before and after.
 */
export async function applyMovement(tx: Tx, input: MovementInput): Promise<{ before: IngredientRow; after: IngredientRow }> {
  const before = await tx.db.selectFrom('ingredients').select(INGREDIENT_COLUMNS).where('id', '=', input.ingredientId).forUpdate().executeTakeFirst();
  if (!before) throw notFound('Ingredient');
  const delta = round3(input.type === 'count' ? input.qty - before.stock_qty : input.qty);
  let cost = before.cost_per_unit_paise;
  if (input.type === 'purchase' && input.unitCostPaise != null && delta > 0) {
    const onHand = Math.max(before.stock_qty, 0);
    cost = (onHand * cost + delta * input.unitCostPaise) / (onHand + delta);
  }
  const after = await tx.db
    .updateTable('ingredients')
    .set({ stock_qty: sql`stock_qty + ${delta}`, cost_per_unit_paise: Math.round(cost * 10_000) / 10_000 })
    .where('id', '=', input.ingredientId)
    .returning(INGREDIENT_COLUMNS)
    .executeTakeFirstOrThrow();
  await tx.db
    .insertInto('stock_movements')
    .values({
      tenant_id: tx.tenantId,
      outlet_id: before.outlet_id,
      ingredient_id: input.ingredientId,
      type: input.type,
      qty: delta,
      unit_cost_paise: input.unitCostPaise ?? before.cost_per_unit_paise,
      stock_after: after.stock_qty,
      order_item_id: input.orderItemId ?? null,
      supplier: input.supplier?.trim() || null,
      note: input.note?.trim() || null,
      created_by: input.userId ?? null,
    })
    .execute();
  await afterStockChange(tx, before, after);
  return { before, after };
}

/**
 * Warns the floor when an ingredient drops to its reorder level and, when the outlet opts in,
 * marks every dish and add-on that needs an empty ingredient as sold out.
 */
async function afterStockChange(tx: Tx, before: IngredientRow, after: IngredientRow): Promise<void> {
  if (after.stock_qty >= before.stock_qty) return;
  if (after.stock_qty <= after.reorder_level && before.stock_qty > before.reorder_level) {
    await tx.emit({
      outletId: after.outlet_id,
      type: 'inventory.low',
      channels: ['outlet'],
      payload: { ingredient_id: after.id, name: after.name, stock_qty: after.stock_qty, unit: after.unit, reorder_level: after.reorder_level },
    });
  }
  if (after.stock_qty > 0 || before.stock_qty <= 0) return;
  const outlet = await tx.db.selectFrom('outlets').select('inventory_auto_stockout').where('id', '=', after.outlet_id).executeTakeFirstOrThrow();
  if (!outlet.inventory_auto_stockout) return;
  const items = await tx.db
    .updateTable('menu_items')
    .set({ in_stock: false })
    .where('in_stock', '=', true)
    .where('id', 'in', tx.db.selectFrom('recipes').select('item_id').where('ingredient_id', '=', after.id))
    .returning('id')
    .execute();
  const modifiers = await tx.db
    .updateTable('modifiers')
    .set({ in_stock: false })
    .where('in_stock', '=', true)
    .where('id', 'in', tx.db.selectFrom('modifier_recipes').select('modifier_id').where('ingredient_id', '=', after.id))
    .returning('id')
    .execute();
  if (!items.length && !modifiers.length) return;
  await bumpMenu(tx, after.outlet_id);
  for (const item of items) {
    await tx.emit({ outletId: after.outlet_id, type: 'item.stock_changed', channels: ['outlet', 'menu'], payload: { item_id: item.id, in_stock: false } });
  }
}

/** What one dish took from stock: ingredient id to quantity, for the whole line (qty included). */
type StockUsed = Record<string, number>;

/** What each dish uses by today's recipes, its add-ons included. */
async function recipeUse(tx: Tx, items: { id: string; item_id: string; qty: number; modifiers_snapshot: unknown }[]): Promise<Map<string, StockUsed>> {
  const out = new Map<string, StockUsed>();
  if (!items.length) return out;
  const itemIds = [...new Set(items.map((i) => i.item_id))];
  const modifierIds = [...new Set(items.flatMap((i) => (i.modifiers_snapshot as ModifierSnapshot[]).map((m) => m.modifier_id)))];
  const [recipes, modifierRecipes] = await Promise.all([
    tx.db.selectFrom('recipes').select(['item_id', 'ingredient_id', 'qty']).where('item_id', 'in', itemIds).execute(),
    modifierIds.length
      ? tx.db.selectFrom('modifier_recipes').select(['modifier_id', 'ingredient_id', 'qty']).where('modifier_id', 'in', modifierIds).execute()
      : Promise.resolve([]),
  ]);
  for (const item of items) {
    const used: StockUsed = {};
    const add = (ingredientId: string, qty: number) => (used[ingredientId] = round3((used[ingredientId] ?? 0) + qty * item.qty));
    for (const r of recipes) if (r.item_id === item.item_id) add(r.ingredient_id, r.qty);
    for (const m of item.modifiers_snapshot as ModifierSnapshot[]) {
      for (const r of modifierRecipes) if (r.modifier_id === m.modifier_id) add(r.ingredient_id, r.qty);
    }
    out.set(item.id, used);
  }
  return out;
}

/**
 * Brings an order's stock in line with its items. Every item the kitchen has accepted consumes its
 * recipe once, and keeps what it took. When an accepted item is cancelled, exactly that goes back
 * on the shelf if the kitchen had not made it yet; if it had, the ingredients are gone, so they are
 * logged as wastage instead. Safe to call after any order change; the `stock_applied` flag makes it
 * idempotent.
 */
export async function syncStock(tx: Tx, orderId: string, userId: string | null): Promise<void> {
  const items = await tx.db
    .selectFrom('order_items')
    .select(['id', 'item_id', 'qty', 'status', 'modifiers_snapshot', 'stock_used', 'cancelled_made'])
    .where('order_id', '=', orderId)
    .where((eb) =>
      eb.or([
        eb.and([eb('stock_applied', '=', false), eb('status', 'not in', ['placed', 'cancelled'])]),
        eb.and([eb('stock_applied', '=', true), eb('status', '=', 'cancelled')]),
      ]),
    )
    .execute();
  if (!items.length) return;
  const taking = items.filter((i) => i.status !== 'cancelled');
  const undoing = items.filter((i) => i.status === 'cancelled');

  // Dishes accepted before what they took was kept fall back to today's recipe.
  const byRecipe = await recipeUse(tx, [...taking, ...undoing.filter((i) => !i.stock_used)]);
  const sale = new Map<string, number>();
  const back = new Map<string, number>();
  const wasted = new Map<string, number>();
  const add = (totals: Map<string, number>, used: StockUsed) => {
    for (const [ingredientId, qty] of Object.entries(used)) totals.set(ingredientId, (totals.get(ingredientId) ?? 0) + qty);
  };
  for (const item of taking) {
    const used = byRecipe.get(item.id)!;
    await tx.db.updateTable('order_items').set({ stock_applied: true, stock_used: json(used) }).where('id', '=', item.id).execute();
    add(sale, used);
  }
  for (const item of undoing) {
    await tx.db.updateTable('order_items').set({ stock_applied: false }).where('id', '=', item.id).execute();
    add(item.cancelled_made ? wasted : back, (item.stock_used as StockUsed | null) ?? byRecipe.get(item.id)!);
  }

  const order = await tx.db.selectFrom('orders').select('order_no').where('id', '=', orderId).executeTakeFirstOrThrow();
  const note = `Order #${order.order_no}`;
  const single = items.length === 1 ? (items[0]?.id ?? null) : null;
  // Fixed lock order across concurrent orders avoids deadlocks on shared ingredients.
  for (const ingredientId of [...new Set([...sale.keys(), ...back.keys(), ...wasted.keys()])].sort()) {
    const taken = round3(sale.get(ingredientId) ?? 0);
    const returned = round3(back.get(ingredientId) ?? 0);
    const lost = round3(wasted.get(ingredientId) ?? 0);
    if (taken) await applyMovement(tx, { ingredientId, type: 'sale', qty: -taken, note, orderItemId: single, userId });
    if (returned) await applyMovement(tx, { ingredientId, type: 'return', qty: returned, note, orderItemId: single, userId });
    if (lost) await saleToWastage(tx, ingredientId, lost, `${note}, cancelled after it was made`, single, userId);
  }
}

/**
 * A dish made and then cancelled: its ingredients left the shelf as a sale and stay gone, but they
 * were wasted, not sold. Logs the sale back and the same amount as wastage, leaving stock as it is,
 * so usage reports count it as waste rather than as food sold.
 */
async function saleToWastage(tx: Tx, ingredientId: string, qty: number, note: string, orderItemId: string | null, userId: string | null): Promise<void> {
  const ing = await tx.db.selectFrom('ingredients').select(['outlet_id', 'stock_qty', 'cost_per_unit_paise']).where('id', '=', ingredientId).forUpdate().executeTakeFirst();
  if (!ing) return;
  const row = (type: 'return' | 'wastage', signed: number) => ({
    tenant_id: tx.tenantId,
    outlet_id: ing.outlet_id,
    ingredient_id: ingredientId,
    type,
    qty: signed,
    unit_cost_paise: ing.cost_per_unit_paise,
    stock_after: ing.stock_qty,
    order_item_id: orderItemId,
    note,
    created_by: userId,
  });
  await tx.db.insertInto('stock_movements').values([row('return', qty), row('wastage', -qty)]).execute();
}

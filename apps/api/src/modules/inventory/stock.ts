import { sql } from 'kysely';
import type { IngredientDTO, IngredientUnit, ModifierSnapshot, StockMovementType } from '@dineos/shared/dto';
import type { Tx } from '../../context';
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

/**
 * Brings an order's stock in line with its items: every item the kitchen has accepted consumes
 * its recipe once, and an accepted item that is later cancelled gives it back. Safe to call after
 * any order change; the `stock_applied` flag makes it idempotent.
 */
export async function syncStock(tx: Tx, orderId: string, userId: string | null): Promise<void> {
  const items = await tx.db
    .selectFrom('order_items')
    .select(['id', 'item_id', 'qty', 'status', 'stock_applied', 'modifiers_snapshot'])
    .where('order_id', '=', orderId)
    .where((eb) =>
      eb.or([
        eb.and([eb('stock_applied', '=', false), eb('status', 'not in', ['placed', 'cancelled'])]),
        eb.and([eb('stock_applied', '=', true), eb('status', '=', 'cancelled')]),
      ]),
    )
    .execute();
  if (!items.length) return;
  await tx.db
    .updateTable('order_items')
    .set((eb) => ({ stock_applied: eb.not('stock_applied') }))
    .where('id', 'in', items.map((i) => i.id))
    .execute();

  const itemIds = [...new Set(items.map((i) => i.item_id))];
  const modifierIds = [...new Set(items.flatMap((i) => (i.modifiers_snapshot as unknown as ModifierSnapshot[]).map((m) => m.modifier_id)))];
  const [recipes, modifierRecipes] = await Promise.all([
    tx.db.selectFrom('recipes').select(['item_id', 'ingredient_id', 'qty']).where('item_id', 'in', itemIds).execute(),
    modifierIds.length
      ? tx.db.selectFrom('modifier_recipes').select(['modifier_id', 'ingredient_id', 'qty']).where('modifier_id', 'in', modifierIds).execute()
      : Promise.resolve([]),
  ]);
  if (!recipes.length && !modifierRecipes.length) return;

  const sale = new Map<string, number>();
  const back = new Map<string, number>();
  for (const item of items) {
    const target = item.status === 'cancelled' ? back : sale;
    const add = (ingredientId: string, qty: number) => target.set(ingredientId, (target.get(ingredientId) ?? 0) + qty * item.qty);
    for (const r of recipes) if (r.item_id === item.item_id) add(r.ingredient_id, r.qty);
    for (const m of item.modifiers_snapshot as unknown as ModifierSnapshot[]) {
      for (const r of modifierRecipes) if (r.modifier_id === m.modifier_id) add(r.ingredient_id, r.qty);
    }
  }

  const order = await tx.db.selectFrom('orders').select('order_no').where('id', '=', orderId).executeTakeFirstOrThrow();
  const note = `Order #${order.order_no}`;
  const single = items.length === 1 ? (items[0]?.id ?? null) : null;
  // Fixed lock order across concurrent orders avoids deadlocks on shared ingredients.
  for (const [type, totals] of [['sale', sale], ['return', back]] as const) {
    for (const ingredientId of [...totals.keys()].sort()) {
      const qty = round3(totals.get(ingredientId)!);
      if (!qty) continue;
      await applyMovement(tx, { ingredientId, type, qty: type === 'sale' ? -qty : qty, note, orderItemId: single, userId });
    }
  }
}

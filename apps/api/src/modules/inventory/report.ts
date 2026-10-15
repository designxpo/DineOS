import { sql } from 'kysely';
import type { Tx } from '../../context';
import type { Range } from '../reports/service';

const n = (v: unknown) => Number(v ?? 0);
const paise = (v: number) => Math.round(v);

/**
 * Stock usage and food cost for a date range: what came in, what the menu used up, what was
 * wasted, and what each dish costs to make at today's ingredient prices.
 */
export async function inventoryReport(tx: Tx, r: Range) {
  const local = sql<string>`(stock_movements.created_at at time zone ${r.timezone})::date`;
  const moves = await tx.db
    .selectFrom('stock_movements')
    .select([
      'ingredient_id',
      'type',
      (eb) => eb.fn.sum<number>('qty').as('qty'),
      (eb) => eb.fn.sum<number>(sql`qty * coalesce(unit_cost_paise, 0)`).as('value'),
    ])
    .where('outlet_id', '=', r.outletId)
    .where(local, '>=', r.from)
    .where(local, '<=', r.to)
    .groupBy(['ingredient_id', 'type'])
    .execute();

  const ingredients = await tx.db
    .selectFrom('ingredients')
    .select(['id', 'name', 'unit', 'stock_qty', 'reorder_level', 'cost_per_unit_paise', 'is_active'])
    .where('outlet_id', '=', r.outletId)
    .orderBy('name')
    .execute();

  const rows = ingredients
    .map((i) => {
      const of = (...types: string[]) => moves.filter((m) => m.ingredient_id === i.id && types.includes(m.type));
      const sum = (types: string[], f: 'qty' | 'value') => of(...types).reduce((a, m) => a + n(m[f]), 0);
      // Sales are stored negative and returns positive; usage is the net taken off the shelf.
      const used = -sum(['sale', 'return'], 'qty');
      return {
        ingredient_id: i.id,
        name: i.name,
        unit: i.unit,
        purchased_qty: sum(['purchase'], 'qty'),
        purchased_paise: paise(sum(['purchase'], 'value')),
        used_qty: Math.round(used * 1000) / 1000,
        used_paise: paise(-sum(['sale', 'return'], 'value')),
        wasted_qty: -sum(['wastage'], 'qty'),
        wasted_paise: paise(-sum(['wastage'], 'value')),
        adjusted_qty: sum(['adjust', 'count'], 'qty'),
        stock_qty: i.stock_qty,
        stock_value_paise: paise(Math.max(i.stock_qty, 0) * i.cost_per_unit_paise),
        low: i.stock_qty <= i.reorder_level,
        is_active: i.is_active,
      };
    })
    .filter((x) => x.is_active || x.purchased_qty || x.used_qty || x.wasted_qty);

  const sales = await tx.db
    .selectFrom('bills')
    .select((eb) => eb.fn.sum<number>(sql`subtotal_paise - item_discount_paise - bill_discount_paise - loyalty_discount_paise`).as('net'))
    .where('outlet_id', '=', r.outletId)
    .where('status', 'in', ['finalised', 'paid'])
    .where('invoice_date', '>=', r.from)
    .where('invoice_date', '<=', r.to)
    .executeTakeFirstOrThrow();

  const dishes = await tx.db
    .selectFrom('menu_items')
    .innerJoin('recipes', 'recipes.item_id', 'menu_items.id')
    .innerJoin('ingredients', 'ingredients.id', 'recipes.ingredient_id')
    .select([
      'menu_items.id',
      'menu_items.name',
      'menu_items.price_paise',
      (eb) => eb.fn.sum<number>(sql`recipes.qty * ingredients.cost_per_unit_paise`).as('cost'),
    ])
    .where('menu_items.outlet_id', '=', r.outletId)
    .where('menu_items.deleted_at', 'is', null)
    .groupBy(['menu_items.id', 'menu_items.name', 'menu_items.price_paise'])
    .orderBy('menu_items.name')
    .execute();

  const total = (k: 'purchased_paise' | 'used_paise' | 'wasted_paise' | 'stock_value_paise') => rows.reduce((a, x) => a + x[k], 0);
  const netSales = n(sales.net);
  const costOfSales = total('used_paise');
  return {
    from: r.from,
    to: r.to,
    totals: {
      purchased_paise: total('purchased_paise'),
      cost_of_sales_paise: costOfSales,
      wastage_paise: total('wasted_paise'),
      stock_value_paise: total('stock_value_paise'),
      net_sales_paise: netSales,
      // Food cost as a share of sales, in basis points. Only dishes with recipes are costed.
      food_cost_bp: netSales ? Math.round((costOfSales / netSales) * 10_000) : null,
      low_count: rows.filter((x) => x.low && x.is_active).length,
    },
    ingredients: rows.map(({ is_active: _a, ...x }) => x),
    dishes: dishes.map((d) => {
      const cost = paise(n(d.cost));
      return { item_id: d.id, name: d.name, price_paise: d.price_paise, cost_paise: cost, cost_bp: d.price_paise ? Math.round((cost / d.price_paise) * 10_000) : null };
    }),
  };
}

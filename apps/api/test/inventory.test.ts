import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { IngredientDTO, OrderDTO, RecipesDTO, StockMovementDTO } from '@dineos/shared/dto';
import { createOrder } from '../src/modules/orders/service';
import { addStaff, api, createMenu, createTable, createTenant, setOutlet, startApp, type TestApp, type TestMenu, type TestTenant } from './helpers';

let t: TestApp;
let tenant: TestTenant;
let menu: TestMenu;
let owner: ReturnType<typeof api>;
let kitchen: ReturnType<typeof api>;
let waiter: ReturnType<typeof api>;
let manager: { login: string };
const ing: Record<'paneer' | 'milk' | 'coffee', string> = { paneer: '', milk: '', coffee: '' };
let tableNo = 0;

beforeAll(async () => {
  t = await startApp();
  tenant = await createTenant(t);
  menu = await createMenu(t, tenant);
  owner = api(t, tenant.ownerToken);
  kitchen = api(t, (await addStaff(t, tenant, 'kitchen')).token);
  waiter = api(t, (await addStaff(t, tenant, 'waiter')).token);
  manager = await addStaff(t, tenant, 'manager', { pin: '1122' });
  // Stock follows guest orders through manual acceptance here.
  await setOutlet(t, tenant.outletId, { auto_accept: false });
});
afterAll(() => t.close());

const outlet = () => tenant.outletId;

async function stock(): Promise<Record<string, IngredientDTO>> {
  const list: IngredientDTO[] = (await kitchen({ method: 'GET', url: `/v1/inventory/ingredients?outlet_id=${outlet()}` })).json();
  return Object.fromEntries(list.map((i) => [i.name, i]));
}

async function order(lines: { item_id: string; qty: number; modifier_ids?: string[] }[]): Promise<OrderDTO> {
  const tableId = await createTable(t, tenant, `I${++tableNo}`);
  const res = await waiter({ method: 'POST', url: '/v1/orders', payload: { outlet_id: outlet(), type: 'dine_in', table_id: tableId, lines } });
  expect(res.statusCode).toBe(201);
  return res.json();
}

describe('inventory', () => {
  it('sets up ingredients with opening stock and recipes for dishes and add-ons', async () => {
    const create = (payload: object, as = owner) => as({ method: 'POST', url: '/v1/inventory/ingredients', payload: { outlet_id: outlet(), ...payload } });
    expect((await create({ name: 'Paneer', unit: 'kg' }, kitchen)).statusCode).toBe(403);
    const paneer = await create({ name: 'Paneer', unit: 'kg', opening_qty: 2, reorder_level: 0.5, cost_per_unit_paise: 30000 });
    expect(paneer.statusCode).toBe(201);
    expect(paneer.json().stock_qty).toBe(2);
    ing.paneer = paneer.json().id;
    ing.milk = (await create({ name: 'Milk', unit: 'l', opening_qty: 5, reorder_level: 4.5, cost_per_unit_paise: 6000 })).json().id;
    ing.coffee = (await create({ name: 'Coffee beans', unit: 'g', opening_qty: 100, cost_per_unit_paise: 200 })).json().id;
    expect((await create({ name: 'paneer', unit: 'kg' })).json().error.code).toBe('duplicate_ingredient');

    const put = (url: string, lines: object[], as = owner) => as({ method: 'PUT', url, payload: { lines } });
    expect((await put(`/v1/inventory/recipes/items/${menu.paneerTikka}`, [{ ingredient_id: ing.paneer, qty: 0.2 }], kitchen)).statusCode).toBe(403);
    expect((await put(`/v1/inventory/recipes/items/${menu.paneerTikka}`, [{ ingredient_id: ing.paneer, qty: 0.2 }])).statusCode).toBe(200);
    await put(`/v1/inventory/recipes/items/${menu.coldCoffee}`, [{ ingredient_id: ing.milk, qty: 0.25 }, { ingredient_id: ing.coffee, qty: 10 }]);
    await put(`/v1/inventory/recipes/modifiers/${menu.extraShot}`, [{ ingredient_id: ing.coffee, qty: 10 }]);
    expect((await put(`/v1/inventory/recipes/items/${menu.chickenTikka}`, [{ ingredient_id: ing.milk, qty: 1 }, { ingredient_id: ing.milk, qty: 2 }])).statusCode).toBe(400);

    const recipes: RecipesDTO = (await kitchen({ method: 'GET', url: `/v1/inventory/recipes?outlet_id=${outlet()}` })).json();
    expect(recipes.items[menu.coldCoffee]).toHaveLength(2);
    expect(recipes.modifiers[menu.extraShot]).toEqual([{ ingredient_id: ing.coffee, qty: 10 }]);

    const s = await stock();
    expect(s.Paneer!.used_by).toBe(1);
    expect(s['Coffee beans']!.used_by).toBe(2);
    const locked = await owner({ method: 'PATCH', url: `/v1/inventory/ingredients/${ing.paneer}`, payload: { unit: 'g' } });
    expect(locked.json().error.code).toBe('unit_locked');
  });

  it('consumes stock when the kitchen accepts an order, including add-ons, and warns at the reorder level', async () => {
    await order([{ item_id: menu.paneerTikka, qty: 2 }]);
    let s = await stock();
    expect(s.Paneer!.stock_qty).toBe(1.6);

    const before = t.events.length;
    await order([{ item_id: menu.coldCoffee, qty: 2, modifier_ids: [menu.large, menu.extraShot] }]);
    s = await stock();
    expect(s.Milk!.stock_qty).toBe(4.5);
    expect(s.Milk!.low).toBe(true);
    expect(s['Coffee beans']!.stock_qty).toBe(60); // 2 × (10 + 10)
    const low = t.events.slice(before).filter((e) => e.event.type === 'inventory.low');
    expect(low.map((e) => (e.event.payload as { name: string }).name)).toEqual(['Milk']);

    const moves: StockMovementDTO[] = (await kitchen({ method: 'GET', url: `/v1/inventory/movements?outlet_id=${outlet()}&ingredient_id=${ing.coffee}` })).json();
    expect(moves[0]).toMatchObject({ type: 'sale', qty: -40, stock_after: 60 });
    expect(moves[0]!.note).toMatch(/^Order #\d+$/);
  });

  it('waits for approval of guest orders, and gives stock back for items cancelled after acceptance', async () => {
    const staffOrder = await order([{ item_id: menu.paneerTikka, qty: 1 }]);
    expect((await stock()).Paneer!.stock_qty).toBe(1.4);
    const guestOrder = await t.ctx.tx(tenant.tenantId, (tx) =>
      createOrder(tx, { outletId: outlet(), type: 'dine_in', source: 'guest_qr', sessionId: staffOrder.table_session_id, lines: [{ item_id: menu.paneerTikka, qty: 2, modifier_ids: [] }] }),
    );
    expect(guestOrder.status).toBe('placed');
    expect((await stock()).Paneer!.stock_qty).toBe(1.4);
    await owner({ method: 'PATCH', url: `/v1/orders/${guestOrder.id}/status`, payload: { status: 'accepted' } });
    expect((await stock()).Paneer!.stock_qty).toBe(1);
    // Accepting twice cannot happen, and re-running the sync is a no-op.
    const { syncStock } = await import('../src/modules/inventory/stock');
    await t.ctx.tx(tenant.tenantId, (tx) => syncStock(tx, guestOrder.id, null));
    expect((await stock()).Paneer!.stock_qty).toBe(1);

    const approval = (await waiter({ method: 'POST', url: '/v1/approvals', payload: { outlet_id: outlet(), action: 'order.cancel_after_accept', login: manager.login, pin: '1122' } })).json().approval_token;
    const res = await owner({
      method: 'PATCH',
      url: `/v1/orders/${guestOrder.id}/items`,
      payload: { cancel: [{ order_item_id: guestOrder.items[0]!.id, reason: 'Guest changed mind' }] },
      headers: { 'x-approval-token': approval },
    });
    expect(res.statusCode).toBe(200);
    expect((await stock()).Paneer!.stock_qty).toBe(1.4);
    const moves: StockMovementDTO[] = (await kitchen({ method: 'GET', url: `/v1/inventory/movements?outlet_id=${outlet()}&ingredient_id=${ing.paneer}&type=return` })).json();
    expect(moves).toHaveLength(1);
    expect(moves[0]!.qty).toBe(0.4);
  });

  it('records purchases at a moving-average cost, counts and corrections with an audit trail', async () => {
    const move = (payload: object, as = owner) => as({ method: 'POST', url: '/v1/inventory/movements', payload: { outlet_id: outlet(), ...payload } });
    expect((await move({ type: 'purchase', lines: [{ ingredient_id: ing.paneer, qty: 1 }] }, kitchen)).statusCode).toBe(403);
    // 1.4 kg at ₹300 + 0.6 kg at ₹400 → 2 kg at ₹330
    const bought = await move({ type: 'purchase', supplier: 'Amul depot', lines: [{ ingredient_id: ing.paneer, qty: 0.6, unit_cost_paise: 40000 }] });
    expect(bought.statusCode).toBe(201);
    expect(bought.json()[0]).toMatchObject({ stock_qty: 2, cost_per_unit_paise: 33000 });

    expect((await move({ type: 'adjust', lines: [{ ingredient_id: ing.milk, qty: -0.5 }] })).json().error.code).toBe('reason_required');
    const counted = await move({ type: 'count', note: 'Night count', lines: [{ ingredient_id: ing.coffee, qty: 55 }] }, kitchen);
    expect(counted.statusCode).toBe(201);
    expect(counted.json()[0].stock_qty).toBe(55);
    const audit = await t.ctx.adminDb.selectFrom('audit_log').select(['action', 'before', 'after']).where('tenant_id', '=', tenant.tenantId).where('action', '=', 'inventory.count').execute();
    expect(audit).toHaveLength(1);
    expect(audit[0]!.after).toEqual({ stock_qty: 55 });
    expect((await move({ type: 'wastage', lines: [{ ingredient_id: ing.coffee, qty: -5 }] }, kitchen)).json().error.code).toBe('invalid_qty');
  });

  it('marks dishes sold out when an ingredient runs out, if the outlet opts in', async () => {
    await setOutlet(t, outlet(), { inventory_auto_stockout: true });
    const before = t.events.length;
    const wasted = await kitchen({ method: 'POST', url: '/v1/inventory/movements', payload: { outlet_id: outlet(), type: 'wastage', note: 'Spoiled', lines: [{ ingredient_id: ing.paneer, qty: 2 }] } });
    expect(wasted.json()[0].stock_qty).toBe(0);
    const item = await t.ctx.adminDb.selectFrom('menu_items').select('in_stock').where('id', '=', menu.paneerTikka).executeTakeFirstOrThrow();
    expect(item.in_stock).toBe(false);
    const types = t.events.slice(before).map((e) => e.event.type);
    expect(types).toContain('item.stock_changed');
    expect(types).toContain('menu.updated');
    // Other dishes are untouched.
    const coffee = await t.ctx.adminDb.selectFrom('menu_items').select('in_stock').where('id', '=', menu.coldCoffee).executeTakeFirstOrThrow();
    expect(coffee.in_stock).toBe(true);
  });

  it('reports usage, wastage, stock value and dish costs', async () => {
    const report = (await owner({ method: 'GET', url: `/v1/reports/inventory?outlet_id=${outlet()}` })).json();
    const paneer = report.ingredients.find((i: { name: string }) => i.name === 'Paneer');
    expect(paneer.used_qty).toBe(0.6); // 0.4 + 0.2 + 0.4 sold, 0.4 given back
    expect(paneer.wasted_qty).toBe(2);
    expect(paneer.purchased_qty).toBe(0.6);
    expect(paneer.purchased_paise).toBe(24000);
    const tikka = report.dishes.find((d: { name: string }) => d.name === 'Paneer Tikka');
    expect(tikka.cost_paise).toBe(6600); // 0.2 kg × ₹330
    expect(tikka.cost_bp).toBe(2640); // ₹66 on a ₹250 dish
    expect(paneer.wasted_paise).toBe(66000); // 2 kg × ₹330
    const csv = await owner({ method: 'GET', url: `/v1/reports/inventory?outlet_id=${outlet()}&format=csv` });
    expect(csv.body.split('\n')[0]).toContain('used_qty');
  });
});

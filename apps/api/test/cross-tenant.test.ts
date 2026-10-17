// Spec §14: "A user from tenant A cannot read any row of tenant B through any endpoint."
// Probes every registered route (new routes are covered automatically) with tenant A's owner
// token and tenant B's ids, then checks that no response leaked B's data, nothing crashed, and
// every one of B's rows is unchanged.

import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BillDTO, OrderDTO } from '@mezmitra/shared/dto';
import { addStaff, api, createTenant, startApp, type TestApp, type TestTenant } from './helpers';

let t: TestApp;
let a: TestTenant;
let b: TestTenant;
const B: Record<string, string> = {};
const MARKERS = ['Bravo Secret Outlet', 'Bravo Secret Dish', 'BX9', 'Bravo Secret Category', 'Bravo Secret Guest', 'Bravo Secret Spice', '9000012345'];

const SKIP = [
  /^\/healthz$/,
  /^\/files\//,
  /^\/v1\/public\//, // public by design: a published menu
  /^\/v1\/auth\/(login|logout)$/,
  /^\/v1\/admin\/auth\//,
  /^\/v1\/guest\/(resolve|join)$/,
];

async function snapshot(tenantId: string): Promise<string> {
  const tables = await sql<{ table_name: string }>`
    select c.table_name from information_schema.columns c
    join information_schema.tables tb on tb.table_name = c.table_name and tb.table_schema = c.table_schema
    where c.table_schema = 'public' and c.column_name = 'tenant_id' and tb.table_type = 'BASE TABLE' order by 1`.execute(t.ctx.adminDb);
  const out: Record<string, unknown> = {};
  for (const { table_name } of tables.rows) {
    const rows = await sql`select * from ${sql.table(table_name)} where tenant_id = ${tenantId} order by 1, 2`.execute(t.ctx.adminDb);
    out[table_name] = rows.rows;
  }
  out.tenant = (await sql`select * from tenants where id = ${tenantId}`.execute(t.ctx.adminDb)).rows;
  return JSON.stringify(out);
}

beforeAll(async () => {
  t = await startApp();
  a = await createTenant(t);
  b = await createTenant(t);
  const ob = api(t, b.ownerToken);
  B.outlet = b.outletId;
  B.user = b.ownerId;
  await ob({ method: 'PATCH', url: `/v1/outlets/${b.outletId}`, payload: { name: 'Bravo Secret Outlet' } });
  B.category = (await ob({ method: 'POST', url: '/v1/menu/categories', payload: { outlet_id: b.outletId, name: 'Bravo Secret Category' } })).json().id;
  const group = (
    await ob({ method: 'POST', url: '/v1/menu/modifier-groups', payload: { outlet_id: b.outletId, name: 'Size', min_select: 0, max_select: 1, modifiers: [{ name: 'Large', price_delta_paise: 100 }] } })
  ).json();
  B.group = group.id;
  B.modifier = group.modifiers[0].id;
  B.item = (await ob({ method: 'POST', url: '/v1/menu/items', payload: { outlet_id: b.outletId, category_id: B.category, name: 'Bravo Secret Dish', price_paise: 50000, is_veg: true } })).json().id;
  B.table = (await ob({ method: 'POST', url: '/v1/tables', payload: { outlet_id: b.outletId, label: 'BX9' } })).json().id;
  B.table2 = (await ob({ method: 'POST', url: '/v1/tables', payload: { outlet_id: b.outletId, label: 'BX10' } })).json().id;
  const order: OrderDTO = (await ob({ method: 'POST', url: '/v1/orders', payload: { outlet_id: b.outletId, type: 'dine_in', table_id: B.table, lines: [{ item_id: B.item, qty: 2 }] } })).json();
  B.order = order.id;
  B.orderItem = order.items[0]!.id;
  B.session = order.table_session_id!;
  // A second, settled table visit so payments exist.
  const paidOrder: OrderDTO = (await ob({ method: 'POST', url: '/v1/orders', payload: { outlet_id: b.outletId, type: 'takeaway', lines: [{ item_id: B.item, qty: 1 }] } })).json();
  const bill: BillDTO = (await ob({ method: 'POST', url: '/v1/bills', payload: { order_id: paidOrder.id } })).json();
  await ob({ method: 'POST', url: `/v1/bills/${bill.id}/finalise` });
  const paid: BillDTO = (await ob({ method: 'POST', url: `/v1/bills/${bill.id}/payments`, payload: { method: 'cash', amount_paise: bill.total_paise } })).json();
  B.bill = bill.id;
  B.payment = paid.payments[0]!.id;
  const device = (await ob({ method: 'POST', url: '/v1/devices', payload: { outlet_id: b.outletId, name: 'Bravo printer' } })).json();
  B.device = device.device.id;
  B.printJob = (await ob({ method: 'POST', url: '/v1/print/test', payload: { outlet_id: b.outletId, target: 'kitchen' } })).json().id;
  const { createServiceRequest } = await import('../src/modules/tables/floor');
  B.request = (await t.ctx.tx(b.tenantId, (tx) => createServiceRequest(tx, { outletId: b.outletId, tableId: B.table!, sessionId: B.session! }, 'call_waiter'))).id;
  B.staff = (await addStaff(t, b, 'waiter')).userId;
  B.customer = (await ob({ method: 'POST', url: '/v1/customers', payload: { outlet_id: b.outletId, phone: '9000012345', name: 'Bravo Secret Guest', consent: true } })).json().id;
  B.reservation = (
    await ob({
      method: 'POST',
      url: '/v1/reservations',
      payload: { outlet_id: b.outletId, guest_name: 'Bravo Secret Guest', party_size: 2, table_id: B.table2, slot_start: new Date(Date.now() + 86_400_000).toISOString() },
    })
  ).json().id;
  B.waitlist = (await ob({ method: 'POST', url: '/v1/waitlist', payload: { outlet_id: b.outletId, guest_name: 'Bravo Secret Guest', party_size: 2 } })).json().id;
  B.ingredient = (await ob({ method: 'POST', url: '/v1/inventory/ingredients', payload: { outlet_id: b.outletId, name: 'Bravo Secret Spice', unit: 'g', opening_qty: 100 } })).json().id;
  await ob({ method: 'PUT', url: `/v1/inventory/recipes/items/${B.item}`, payload: { lines: [{ ingredient_id: B.ingredient, qty: 1 }] } });
  for (const key of ['customer', 'reservation', 'waitlist', 'ingredient']) if (!B[key]) throw new Error(`could not seed ${key}`);
  for (const id of Object.values(B)) MARKERS.push(id);
});
afterAll(() => t.close());

function fill(url: string): string {
  const byPrefix: [RegExp, string][] = [
    [/\/menu\/categories\/:id/, B.category!],
    [/\/menu\/items\/:id/, B.item!],
    [/\/menu\/modifier-groups\/:id/, B.group!],
    [/\/menu\/modifiers\/:id/, B.modifier!],
    [/\/tables\/:id/, B.table!],
    [/\/service-requests\/:id/, B.request!],
    [/\/orders\/:id/, B.order!],
    [/\/order-items\/:id/, B.orderItem!],
    [/\/bills\/:id/, B.bill!],
    [/\/payments\/:id/, B.payment!],
    [/\/devices\/:id/, B.device!],
    [/\/print-jobs\/:id/, B.printJob!],
    [/\/outlets\/:id/, B.outlet!],
    [/\/staff\/:id/, B.staff!],
    [/\/customers\/:id/, B.customer!],
    [/\/reservations\/:id/, B.reservation!],
    [/\/waitlist\/:id/, B.waitlist!],
    [/\/inventory\/ingredients\/:id/, B.ingredient!],
    [/\/inventory\/recipes\/items\/:id/, B.item!],
    [/\/inventory\/recipes\/modifiers\/:id/, B.modifier!],
    [/\/admin\/tenants\/:id/, b.tenantId],
    [/\/admin\/invoices\/:id/, B.bill!],
  ];
  let out = url;
  for (const [re, id] of byPrefix) if (re.test(out)) out = out.replace(':id', id);
  return out
    .replace(':id', B.order!)
    .replace(':lineId', B.orderItem!)
    .replace(':code', 'standard')
    .replace(':tenantId', b.tenantId)
    .replace(':outletId', b.outletId)
    .replace('*', 'x');
}

const query = () =>
  new URLSearchParams({
    outlet_id: B.outlet!,
    table_session_id: B.session!,
    tenant_id: b.tenantId,
    since: '0',
    station: 'kitchen',
    qr: 'x'.repeat(20),
    ingredient_id: B.ingredient!,
    slot_start: new Date(Date.now() + 86_400_000).toISOString(),
    party_size: '2',
  }).toString();

const body = () => ({
  outlet_id: B.outlet,
  table_session_id: B.session,
  order_id: B.order,
  table_id: B.table,
  to_table_id: B.table2,
  table_ids: [B.table, B.table2],
  category_id: B.category,
  item_id: B.item,
  tenant_id: b.tenantId,
  lines: [{ item_id: B.item, ingredient_id: B.ingredient, qty: 1 }],
  customer_id: B.customer,
  ingredient_id: B.ingredient,
  redeem_points: 0,
  phone: '9000012345',
  consent: true,
  guest_name: 'Probe',
  party_size: 2,
  slot_start: new Date(Date.now() + 86_400_000).toISOString(),
  points: 10,
  note: 'cross-tenant probe',
  unit: 'g',
  add: [{ item_id: B.item, qty: 1 }],
  cancel: [{ order_item_id: B.orderItem, reason: 'probe' }],
  set_qty: [{ order_item_id: B.orderItem, qty: 3 }],
  status: 'served',
  reason: 'cross-tenant probe',
  in_stock: false,
  name: 'Probe',
  label: 'PRB',
  type: 'dine_in',
  price_paise: 100,
  is_veg: true,
  min_select: 0,
  max_select: 1,
  modifiers: [{ name: 'Probe', price_delta_paise: 0 }],
  modifier_group_ids: [B.group],
  method: 'cash',
  amount_paise: 100,
  mode: 'amount',
  count: 2,
  target: 'kitchen',
  waiter_id: B.staff,
  ids: [B.category],
  roles: [{ outlet_id: B.outlet, role: 'waiter' }],
  email: 'probe@probe.test',
  password: 'probe-password',
  kind: 'print_agent',
  prefix: 'PZ',
  from: 1,
  to: 2,
  guest_count: 2,
  qr_token: 'x'.repeat(20),
  user_id: B.staff,
  period_start: '2026-10-01',
  period_end: '2026-10-31',
});

describe('cross-tenant isolation through the API', () => {
  it('never returns, changes or deletes tenant B data for tenant A', async () => {
    const before = await snapshot(b.tenantId);
    const owner = api(t, a.ownerToken);
    const leaks: string[] = [];
    const crashes: string[] = [];
    const probed = t.routes.filter((r) => !SKIP.some((re) => re.test(r.url)));
    expect(probed.length).toBeGreaterThan(60);

    for (const route of probed) {
      const url = `${fill(route.url)}?${query()}`;
      const res = await owner({
        method: route.method as 'GET',
        url,
        ...(route.method === 'GET' || route.method === 'DELETE' ? {} : { payload: body() }),
      });
      if (res.statusCode >= 500) crashes.push(`${route.method} ${route.url} -> ${res.statusCode} ${res.body.slice(0, 200)}`);
      if (res.statusCode < 300) {
        const hit = MARKERS.find((m) => res.body.includes(m));
        if (hit) leaks.push(`${route.method} ${route.url} -> ${res.statusCode} leaked ${hit}`);
      }
    }

    expect(crashes).toEqual([]);
    expect(leaks).toEqual([]);
    expect(await snapshot(b.tenantId)).toBe(before);
  });

  it('refuses rows in tenant A that point at tenant B at the database level', async () => {
    await expect(
      t.ctx.tx(a.tenantId, (tx) => tx.db.insertInto('tables').values({ tenant_id: a.tenantId, outlet_id: B.outlet!, label: 'Sneaky' }).execute()),
    ).rejects.toMatchObject({ code: '23503' });
    await expect(
      t.ctx.tx(a.tenantId, (tx) =>
        tx.db.insertInto('menu_categories').values({ tenant_id: a.tenantId, outlet_id: a.outletId, name: 'Mine' }).returning('id').executeTakeFirstOrThrow().then((c) =>
          tx.db.insertInto('menu_items').values({ tenant_id: a.tenantId, outlet_id: a.outletId, category_id: B.category!, name: 'x', price_paise: 1 }).execute().then(() => c),
        ),
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it("keeps a guest of tenant B inside their own session", async () => {
    const qr = new URL((await api(t, b.ownerToken)({ method: 'GET', url: `/v1/tables/${B.table2}/qr` })).json().url).pathname.split('/').pop()!;
    const { guest_token } = (await t.app.inject({ method: 'POST', url: '/v1/guest/join', payload: { qr_token: qr } })).json();
    const guest = api(t, guest_token);
    const session = (await guest({ method: 'GET', url: '/v1/guest/session' })).json();
    expect(session.orders).toHaveLength(0); // the other table's order is not visible
    expect((await guest({ method: 'GET', url: `/v1/orders/${B.order}` })).statusCode).toBe(401);
    expect((await guest({ method: 'GET', url: `/v1/menu?outlet_id=${a.outletId}` })).statusCode).toBe(401);
  });
});

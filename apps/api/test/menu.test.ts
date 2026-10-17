import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MenuDTO } from '@dineos/shared/dto';
import { addStaff, api, createMenu, createTenant, startApp, type TestApp, type TestTenant } from './helpers';
import { multipart } from './multipart';

let t: TestApp;
let tenant: TestTenant;
let owner: ReturnType<typeof api>;

beforeAll(async () => {
  t = await startApp();
  tenant = await createTenant(t);
  owner = api(t, tenant.ownerToken);
});
afterAll(() => t.close());

async function getMenu(): Promise<MenuDTO> {
  const res = await owner({ method: 'GET', url: `/v1/menu?outlet_id=${tenant.outletId}` });
  expect(res.statusCode).toBe(200);
  return res.json();
}

describe('menu management', () => {
  let categoryId: string;
  let groupId: string;
  let itemId: string;

  it('creates a category, a modifier group and an item that uses it', async () => {
    const cat = await owner({
      method: 'POST',
      url: '/v1/menu/categories',
      payload: { outlet_id: tenant.outletId, name: 'Breakfast', available_schedule: { from: '07:00', to: '11:00' } },
    });
    expect(cat.statusCode).toBe(201);
    categoryId = cat.json().id;

    const group = await owner({
      method: 'POST',
      url: '/v1/menu/modifier-groups',
      payload: {
        outlet_id: tenant.outletId,
        name: 'Eggs',
        min_select: 1,
        max_select: 1,
        modifiers: [
          { name: 'Fried', price_delta_paise: 0 },
          { name: 'Scrambled', price_delta_paise: 2000 },
        ],
      },
    });
    expect(group.statusCode).toBe(201);
    groupId = group.json().id;
    expect(group.json().modifiers).toHaveLength(2);

    const item = await owner({
      method: 'POST',
      url: '/v1/menu/items',
      payload: {
        outlet_id: tenant.outletId,
        category_id: categoryId,
        name: 'English Breakfast',
        price_paise: 45000,
        is_veg: false,
        tags: ['bestseller'],
        modifier_group_ids: [groupId],
        translations: { hi: { name: 'अंग्रेज़ी नाश्ता' } },
      },
    });
    expect(item.statusCode).toBe(201);
    itemId = item.json().id;
    expect(item.json()).toMatchObject({ tax_rate_bp: 500, station: 'kitchen', modifier_group_ids: [groupId], in_stock: true });

    const menu = await getMenu();
    expect(menu.categories.map((c) => c.name)).toContain('Breakfast');
    expect(menu.items.find((i) => i.id === itemId)?.translations.hi?.name).toBe('अंग्रेज़ी नाश्ता');
  });

  it('bumps the menu version on every change', async () => {
    const before = (await getMenu()).menu_version;
    await owner({ method: 'PATCH', url: `/v1/menu/items/${itemId}`, payload: { price_paise: 47500 } });
    const after = await getMenu();
    expect(after.menu_version).toBe(before + 1);
    expect(after.items.find((i) => i.id === itemId)?.price_paise).toBe(47500);
  });

  it('edits modifiers in place, keeping ids, and soft-deletes removed ones', async () => {
    const menu = await getMenu();
    const group = menu.modifier_groups.find((g) => g.id === groupId)!;
    const fried = group.modifiers.find((m) => m.name === 'Fried')!;
    const res = await owner({
      method: 'PATCH',
      url: `/v1/menu/modifier-groups/${groupId}`,
      payload: { modifiers: [{ id: fried.id, name: 'Fried (sunny side)', price_delta_paise: 0 }, { name: 'Poached', price_delta_paise: 1500 }] },
    });
    expect(res.statusCode).toBe(200);
    const mods = res.json().modifiers as { id: string; name: string }[];
    expect(mods.map((m) => m.name)).toEqual(['Fried (sunny side)', 'Poached']);
    expect(mods[0]!.id).toBe(fried.id);
  });

  it('rejects an unknown station and a category from another outlet', async () => {
    const res = await owner({
      method: 'POST',
      url: '/v1/menu/items',
      payload: { outlet_id: tenant.outletId, category_id: categoryId, name: 'X', price_paise: 100, is_veg: true, station: 'moon' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_station');
  });

  it('lets kitchen staff toggle stock but not edit the menu', async () => {
    const cook = api(t, (await addStaff(t, tenant, 'kitchen')).token);
    const edit = await cook({ method: 'PATCH', url: `/v1/menu/items/${itemId}`, payload: { price_paise: 1 } });
    expect(edit.statusCode).toBe(403);
    const before = t.events.length;
    const stock = await cook({ method: 'PATCH', url: `/v1/menu/items/${itemId}/stock`, payload: { in_stock: false } });
    expect(stock.statusCode).toBe(200);
    const event = t.events.slice(before).find((e) => e.event.type === 'item.stock_changed');
    expect(event?.event.channels).toEqual(['outlet', 'menu']);
    expect(event?.event.payload).toEqual({ item_id: itemId, in_stock: false });
  });

  it('gives dishes short codes to type at the till, one per dish', async () => {
    const make = (name: string, short_code: string | null) =>
      owner({ method: 'POST', url: '/v1/menu/items', payload: { outlet_id: tenant.outletId, category_id: categoryId, name, price_paise: 9900, is_veg: true, short_code } });
    const tea = await make('Masala Tea', 'mt');
    expect(tea.json().short_code).toBe('MT');
    expect((await make('Mint Tonic', 'MT')).json().error.code).toBe('code_taken');
    expect((await make('Mango Tango', 'm t')).statusCode).toBe(400);
    // A deleted dish frees its code.
    await owner({ method: 'DELETE', url: `/v1/menu/items/${tea.json().id}` });
    expect((await make('Mint Tonic', 'MT')).statusCode).toBe(201);
  });

  it('lists what sold most lately, best first', async () => {
    const popular = async () => (await owner({ method: 'GET', url: `/v1/menu/popular?outlet_id=${tenant.outletId}` })).json().item_ids as string[];
    expect(await popular()).toEqual([]);
    const m = await createMenu(t, tenant);
    const order = (lines: object[]) => owner({ method: 'POST', url: '/v1/orders', payload: { outlet_id: tenant.outletId, type: 'counter', lines } });
    expect((await order([{ item_id: m.chickenTikka, qty: 1 }, { item_id: m.paneerTikka, qty: 2 }])).statusCode).toBe(201);
    await order([{ item_id: m.paneerTikka, qty: 1 }]);
    expect(await popular()).toEqual([m.paneerTikka, m.chickenTikka]);
  });

  it('soft-deletes an item so it leaves the menu', async () => {
    const res = await owner({ method: 'DELETE', url: `/v1/menu/items/${itemId}` });
    expect(res.statusCode).toBe(204);
    expect((await getMenu()).items.some((i) => i.id === itemId)).toBe(false);
    const row = await t.ctx.adminDb.selectFrom('menu_items').select('deleted_at').where('id', '=', itemId).executeTakeFirstOrThrow();
    expect(row.deleted_at).not.toBeNull();
  });

  it('stores an uploaded photo and serves it', async () => {
    const item = await owner({
      method: 'POST',
      url: '/v1/menu/items',
      payload: { outlet_id: tenant.outletId, category_id: categoryId, name: 'Poha', price_paise: 12000, is_veg: true },
    });
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
    const res = await owner({ method: 'POST', url: `/v1/menu/items/${item.json().id}/photo`, ...multipart('poha.png', 'image/png', png) });
    expect(res.statusCode).toBe(200);
    const url = new URL(res.json().photo_url);
    const file = await t.app.inject({ method: 'GET', url: url.pathname });
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toBe('image/png');

    // Removing it takes the photo off the menu guests see.
    expect((await owner({ method: 'DELETE', url: `/v1/menu/items/${item.json().id}/photo` })).statusCode).toBe(204);
    const menu = (await t.app.inject({ method: 'GET', url: `/v1/public/menu/${tenant.tenantId}/${tenant.outletId}` })).json();
    expect(menu.items.find((i: { id: string }) => i.id === item.json().id).photo_url).toBeNull();
  });
});

describe('spreadsheet import', () => {
  const csv = [
    'Category,Name,Price,Veg,Description,Tax Rate,HSN_SAC,Station,Tags,In Stock,Name_Hi',
    'Soups,"Tomato Shorba, Classic",180,yes,"Slow cooked, with ""spices""",5,996331,kitchen,bestseller|spicy,yes,टमाटर शोरबा',
    'Soups,Chicken Soup,220,no,,5,,kitchen,,yes,',
    'Drinks,Fresh Lime Soda,90.50,veg,,,,kitchen,,no,',
  ].join('\r\n');

  it('previews without writing on a dry run', async () => {
    const res = await owner({ method: 'POST', url: `/v1/menu/import?outlet_id=${tenant.outletId}&dry_run=1`, ...multipart('menu.csv', 'text/csv', csv) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ dry_run: true, categories_created: 2, items_created: 3, errors: [] });
    const menu = await owner({ method: 'GET', url: `/v1/menu?outlet_id=${tenant.outletId}` });
    expect(menu.json().categories.some((c: { name: string }) => c.name === 'Soups')).toBe(false);
  });

  it('imports quoted fields and rupee decimals, then updates on re-import', async () => {
    const first = await owner({ method: 'POST', url: `/v1/menu/import?outlet_id=${tenant.outletId}`, ...multipart('menu.csv', 'text/csv', csv) });
    expect(first.json()).toMatchObject({ categories_created: 2, items_created: 3, items_updated: 0, errors: [] });
    const menu: MenuDTO = (await owner({ method: 'GET', url: `/v1/menu?outlet_id=${tenant.outletId}` })).json();
    const shorba = menu.items.find((i) => i.name === 'Tomato Shorba, Classic')!;
    expect(shorba.description).toBe('Slow cooked, with "spices"');
    expect(shorba.tags).toEqual(['bestseller', 'spicy']);
    expect(shorba.translations.hi?.name).toBe('टमाटर शोरबा');
    const soda = menu.items.find((i) => i.name === 'Fresh Lime Soda')!;
    expect(soda.price_paise).toBe(9050);
    expect(soda.in_stock).toBe(false);

    const second = await owner({
      method: 'POST',
      url: `/v1/menu/import?outlet_id=${tenant.outletId}`,
      ...multipart('menu.csv', 'text/csv', csv.replace('Chicken Soup,220', 'Chicken Soup,240')),
    });
    expect(second.json()).toMatchObject({ categories_created: 0, items_created: 0, items_updated: 3 });
  });

  it('imports an Excel workbook', async () => {
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet('Menu');
    sheet.addRow(['Category', 'Name', 'Price', 'Veg', 'Tax Rate']);
    sheet.addRow(['South Indian', 'Rava Idli', 140, 'yes', 5]);
    sheet.addRow(['South Indian', 'Chicken Chettinad', 480, 'no', 5]);
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());
    const res = await owner({
      method: 'POST',
      url: `/v1/menu/import?outlet_id=${tenant.outletId}`,
      ...multipart('menu.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer),
    });
    expect(res.json()).toMatchObject({ categories_created: 1, items_created: 2, errors: [] });
    const menu: MenuDTO = (await owner({ method: 'GET', url: `/v1/menu?outlet_id=${tenant.outletId}` })).json();
    expect(menu.items.find((i) => i.name === 'Chicken Chettinad')).toMatchObject({ price_paise: 48000, is_veg: false });
  });

  it('imports nothing when any row is invalid', async () => {
    const bad = 'category,name,price\nSnacks,Samosa,40\nSnacks,Kachori,forty\n,Vada,30';
    const res = await owner({ method: 'POST', url: `/v1/menu/import?outlet_id=${tenant.outletId}`, ...multipart('bad.csv', 'text/csv', bad) });
    expect(res.json().errors).toEqual([
      { row: 3, message: 'price "forty" is not a rupee amount' },
      { row: 4, message: 'category is required' },
    ]);
    const menu = await owner({ method: 'GET', url: `/v1/menu?outlet_id=${tenant.outletId}` });
    expect(menu.json().items.some((i: { name: string }) => i.name === 'Samosa')).toBe(false);
  });
});

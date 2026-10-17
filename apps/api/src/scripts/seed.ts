// Demo data for local development and pilots: a hotel's all-day-dining restaurant.
//   npm run db:seed            (skips if the demo tenant exists)
//   npm run db:seed -- --reset (purges the demo tenant first)
import pino from 'pino';
import { loadConfig } from '../config';
import { createContext } from '../context';
import { json } from '../db';
import { authenticate, type StaffAuth } from '../lib/auth';
import { hashSecret } from '../lib/crypto';
import { provisionTenant } from '../modules/admin/provision';
import { createBill, finaliseBill, recordPayment, updateBill } from '../modules/billing/service';
import { applyMovement } from '../modules/inventory/stock';
import { createOrder, transitionOrder } from '../modules/orders/service';
import { getOrCreateSession, openSession } from '../modules/tables/sessions';
import { createStaffSession } from '../modules/auth/service';
import { purgeTenant } from '../lib/purge';
import { attachDemoPhotos } from './demo-photos';

const SLUG = 'aurum-courtyard';
const PASSWORD = 'demo1234';
const ADMIN_EMAIL = 'admin@mezmitra.local';
const ADMIN_PASSWORD = 'admin-demo-1234';

type Mod = [name: string, delta: number, hi?: string];
type Group = { name: string; min: number; max: number; mods: Mod[] };
type Item = {
  name: string;
  hi?: string;
  price: number;
  veg?: boolean;
  desc?: string;
  tags?: string[];
  station?: string;
  tax?: number;
  groups?: string[];
};

const GROUPS: Record<string, Group> = {
  spice: { name: 'Spice level', min: 1, max: 1, mods: [['Mild', 0, 'हल्का'], ['Medium', 0, 'मध्यम'], ['Hot', 0, 'तीखा']] },
  eggs: { name: 'Eggs', min: 1, max: 1, mods: [['Fried', 0], ['Scrambled', 0], ['Poached', 0], ['Omelette', 4000]] },
  coffeeSize: { name: 'Size', min: 1, max: 1, mods: [['Regular', 0], ['Large', 6000]] },
  coffeeAdd: { name: 'Add-ons', min: 0, max: 3, mods: [['Extra shot', 5000], ['Oat milk', 6000], ['Hazelnut syrup', 4000]] },
  bread: { name: 'Bread', min: 0, max: 2, mods: [['Butter naan', 9000, 'बटर नान'], ['Garlic naan', 11000, 'गार्लिक नान'], ['Tandoori roti', 5000, 'तंदूरी रोटी']] },
  dessertAdd: { name: 'Add-ons', min: 0, max: 1, mods: [['Vanilla ice cream', 9000]] },
};

const MENU: { category: string; hi: string; schedule?: { from: string; to: string }; items: Item[] }[] = [
  {
    category: 'Breakfast',
    hi: 'नाश्ता',
    schedule: { from: '07:00', to: '11:30' },
    items: [
      { name: 'Masala Dosa', hi: 'मसाला डोसा', price: 26000, desc: 'Crisp rice crepe, potato masala, sambar and chutneys', tags: ['bestseller'] },
      { name: 'Poha', hi: 'पोहा', price: 18000, desc: 'Flattened rice with peanuts, curry leaves and lemon' },
      { name: 'Aloo Paratha', hi: 'आलू पराठा', price: 22000, desc: 'Two stuffed parathas, curd, pickle and white butter' },
      { name: 'Eggs to Order', hi: 'अंडे', price: 28000, veg: false, desc: 'Two eggs your way, toast, grilled tomato', groups: ['eggs'] },
    ],
  },
  {
    category: 'Starters',
    hi: 'स्टार्टर्स',
    items: [
      { name: 'Paneer Tikka', hi: 'पनीर टिक्का', price: 42000, station: 'tandoor', desc: 'Cottage cheese, peppers, smoked in the tandoor', tags: ['bestseller'], groups: ['spice'] },
      { name: 'Hara Bhara Kebab', hi: 'हरा भरा कबाब', price: 34000, desc: 'Spinach, peas and green chilli patties' },
      { name: 'Chicken Malai Tikka', hi: 'चिकन मलाई टिक्का', price: 52000, veg: false, station: 'tandoor', desc: 'Cream, cheese and cardamom marinade', tags: ["chef's special"] },
      { name: 'Amritsari Fish', hi: 'अमृतसरी मछली', price: 56000, veg: false, desc: 'Gram-flour battered river sole, carom, lemon', groups: ['spice'] },
    ],
  },
  {
    category: 'Mains',
    hi: 'मुख्य व्यंजन',
    items: [
      { name: 'Dal Makhani', hi: 'दाल मखनी', price: 38000, desc: 'Black lentils slow cooked overnight with butter', tags: ['bestseller'], groups: ['bread'] },
      { name: 'Paneer Butter Masala', hi: 'पनीर बटर मसाला', price: 44000, desc: 'Tomato, butter and fenugreek gravy', groups: ['bread'] },
      { name: 'Butter Chicken', hi: 'बटर चिकन', price: 54000, veg: false, desc: 'Tandoori chicken in velvety makhani gravy', tags: ['bestseller'], groups: ['bread'] },
      { name: 'Laal Maas', hi: 'लाल मांस', price: 62000, veg: false, desc: 'Rajasthani mutton curry with mathania chillies', tags: ['spicy'], groups: ['spice', 'bread'] },
      { name: 'Veg Dum Biryani', hi: 'वेज दम बिरयानी', price: 42000, desc: 'Basmati, seasonal vegetables, saffron, raita' },
      { name: 'Hyderabadi Chicken Biryani', hi: 'हैदराबादी चिकन बिरयानी', price: 52000, veg: false, desc: 'Dum cooked, served with salan and raita', tags: ['bestseller'] },
    ],
  },
  {
    category: 'Continental',
    hi: 'कॉन्टिनेंटल',
    items: [
      { name: 'Grilled Chicken, Herb Jus', price: 64000, veg: false, desc: 'Mash, sautéed greens' },
      { name: 'Penne Arrabbiata', price: 46000, desc: 'San Marzano tomato, chilli, basil' },
      { name: 'Club Sandwich', price: 42000, veg: false, desc: 'Chicken, egg, bacon, fries', tags: ['all day'] },
    ],
  },
  {
    category: 'Desserts',
    hi: 'मिठाई',
    items: [
      { name: 'Gulab Jamun', hi: 'गुलाब जामुन', price: 18000, desc: 'Warm, with rabri', groups: ['dessertAdd'] },
      { name: 'Sizzling Brownie', price: 32000, desc: 'With vanilla ice cream and hot chocolate', tags: ['bestseller'] },
      { name: 'Kulfi Falooda', hi: 'कुल्फी फालूदा', price: 24000 },
    ],
  },
  {
    category: 'Beverages',
    hi: 'पेय',
    items: [
      { name: 'Masala Chai', hi: 'मसाला चाय', price: 12000, station: 'bar' },
      { name: 'Filter Coffee', hi: 'फ़िल्टर कॉफ़ी', price: 14000, station: 'bar' },
      { name: 'Cappuccino', price: 22000, station: 'bar', groups: ['coffeeSize', 'coffeeAdd'] },
      { name: 'Cold Coffee', price: 24000, station: 'bar', groups: ['coffeeSize', 'coffeeAdd'], tags: ['bestseller'] },
      { name: 'Fresh Lime Soda', hi: 'फ्रेश लाइम सोडा', price: 14000, station: 'bar' },
      { name: 'Virgin Mojito', price: 26000, station: 'bar' },
      { name: 'Mineral Water (1L)', price: 8000, station: 'bar' },
    ],
  },
];

const TABLES: { zone: string; prefix: string; count: number; seats: number }[] = [
  { zone: 'Courtyard', prefix: 'C', count: 12, seats: 4 },
  { zone: 'Poolside', prefix: 'P', count: 8, seats: 4 },
  { zone: 'Private dining', prefix: 'PD', count: 2, seats: 10 },
];

// Ingredients (unit, opening stock, reorder level, price per unit in paise) and per-portion recipes.
const INGREDIENTS: Record<string, [unit: 'g' | 'kg' | 'ml' | 'l' | 'pcs', stock: number, reorder: number, cost: number]> = {
  Paneer: ['kg', 6, 2, 32000],
  Chicken: ['kg', 8, 3, 26000],
  'Basmati rice': ['kg', 15, 5, 11000],
  'Black urad dal': ['kg', 4, 1.5, 14000],
  Butter: ['kg', 3, 1, 52000],
  Cream: ['l', 2.4, 2, 24000],
  Milk: ['l', 12, 6, 6000],
  'Coffee beans': ['g', 900, 500, 140],
  Tomatoes: ['kg', 10, 3, 4000],
  Limes: ['pcs', 40, 20, 400],
};
const RECIPES: Record<string, Record<string, number>> = {
  'Paneer Tikka': { Paneer: 0.2, Butter: 0.01 },
  'Paneer Butter Masala': { Paneer: 0.18, Butter: 0.03, Tomatoes: 0.15, Cream: 0.04 },
  'Butter Chicken': { Chicken: 0.25, Butter: 0.03, Tomatoes: 0.15, Cream: 0.05 },
  'Chicken Malai Tikka': { Chicken: 0.25, Cream: 0.05 },
  'Dal Makhani': { 'Black urad dal': 0.08, Butter: 0.03, Cream: 0.03, Tomatoes: 0.05 },
  'Veg Dum Biryani': { 'Basmati rice': 0.15 },
  'Hyderabadi Chicken Biryani': { 'Basmati rice': 0.15, Chicken: 0.2 },
  'Masala Chai': { Milk: 0.12 },
  'Filter Coffee': { Milk: 0.1, 'Coffee beans': 12 },
  Cappuccino: { Milk: 0.15, 'Coffee beans': 18 },
  'Cold Coffee': { Milk: 0.25, 'Coffee beans': 18 },
  'Fresh Lime Soda': { Limes: 1 },
  'Virgin Mojito': { Limes: 1 },
};
const CUSTOMERS: { name: string; phone: string; marketing: boolean; points?: number }[] = [
  { name: 'Ananya Rao', phone: '+919876543210', marketing: true },
  { name: 'Vikram Mehta', phone: '+919812345678', marketing: false, points: 180 },
  { name: 'Fatima Sheikh', phone: '+919900112233', marketing: true, points: 60 },
];

const STAFF: { name: string; email: string; phone: string; role: 'manager' | 'cashier' | 'waiter' | 'kitchen'; pin?: string }[] = [
  { name: 'Arjun Mehta', email: 'arjun@courtyard.demo', phone: '9800000001', role: 'manager', pin: '1234' },
  { name: 'Priya Nair', email: 'priya@courtyard.demo', phone: '9800000002', role: 'cashier' },
  { name: 'Ravi Kumar', email: 'ravi@courtyard.demo', phone: '9800000003', role: 'waiter' },
  { name: 'Sunita Das', email: 'sunita@courtyard.demo', phone: '9800000004', role: 'waiter' },
  { name: 'Chef Imran', email: 'imran@courtyard.demo', phone: '9800000005', role: 'kitchen' },
];

async function main() {
  const config = loadConfig();
  const log = pino({ level: 'warn' });
  const ctx = createContext(config, log);
  const db = ctx.adminDb;

  const existing = await db.selectFrom('tenants').select('id').where('slug', '=', SLUG).executeTakeFirst();
  if (existing && !process.argv.includes('--reset')) {
    console.log(`Demo tenant "${SLUG}" exists. Run with --reset to recreate it.`);
    await ctx.close();
    return;
  }
  if (existing) await purgeTenant(db, existing.id);

  const ids = await provisionTenant(db, {
    name: 'Aurum Grand Hotel',
    slug: SLUG,
    plan_code: 'standard',
    owner: { name: 'Meera Rao', email: 'owner@courtyard.demo', phone: '9800000000', password: PASSWORD },
    outlet: {
      name: 'The Courtyard',
      invoice_prefix: 'AGC',
      gstin: '29AABCA1234D1Z5',
      fssai_no: '11226999000123',
      address: '14 MG Road',
      city: 'Bengaluru',
      state_code: '29',
    },
  });
  const t = ids.tenantId;
  const outletId = ids.outletId;
  await db
    .updateTable('outlets')
    .set({
      legal_name: 'Aurum Hospitality Pvt Ltd',
      phone: '+91 80 4000 1234',
      kitchen_stations: ['kitchen', 'tandoor', 'bar'],
      upi_vpa: 'aurumcourtyard@okaxis',
      upi_payee_name: 'Aurum Hospitality',
      auto_accept: false,
      approve_flagged_orders: true,
      room_charge_enabled: true,
      loyalty_enabled: true,
      loyalty_earn_bp: 500,
      loyalty_point_value_paise: 100,
      loyalty_min_redeem_points: 100,
    })
    .where('id', '=', outletId)
    .execute();

  // Staff
  const staffIds: Record<string, string> = {};
  for (const s of STAFF) {
    const u = await db
      .insertInto('users')
      .values({
        tenant_id: t,
        name: s.name,
        email: s.email,
        phone: `+91${s.phone}`,
        password_hash: await hashSecret(PASSWORD),
        pin_hash: s.pin ? await hashSecret(s.pin) : null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await db.insertInto('user_outlet_roles').values({ tenant_id: t, user_id: u.id, outlet_id: outletId, role: s.role }).execute();
    staffIds[s.email] = u.id;
  }

  // Menu
  const groupIds: Record<string, string> = {};
  for (const [key, g] of Object.entries(GROUPS)) {
    const row = await db
      .insertInto('modifier_groups')
      .values({ tenant_id: t, outlet_id: outletId, name: g.name, min_select: g.min, max_select: g.max })
      .returning('id')
      .executeTakeFirstOrThrow();
    groupIds[key] = row.id;
    await db
      .insertInto('modifiers')
      .values(g.mods.map(([name, delta, hi], sort) => ({ tenant_id: t, group_id: row.id, name, price_delta_paise: delta, sort, translations: json(hi ? { hi: { name: hi } } : {}) })))
      .execute();
  }
  const itemIds: Record<string, string> = {};
  for (const [catSort, cat] of MENU.entries()) {
    const c = await db
      .insertInto('menu_categories')
      .values({ tenant_id: t, outlet_id: outletId, name: cat.category, sort: catSort, available_schedule: cat.schedule ? json(cat.schedule) : null, translations: json({ hi: { name: cat.hi } }) })
      .returning('id')
      .executeTakeFirstOrThrow();
    for (const [sort, it] of cat.items.entries()) {
      const row = await db
        .insertInto('menu_items')
        .values({
          tenant_id: t,
          outlet_id: outletId,
          category_id: c.id,
          name: it.name,
          description: it.desc ?? null,
          price_paise: it.price,
          is_veg: it.veg ?? true,
          hsn_sac: '996331',
          tax_rate_bp: it.tax ?? 500,
          tags: it.tags ?? [],
          station: it.station ?? 'kitchen',
          sort,
          translations: json(it.hi ? { hi: { name: it.hi } } : {}),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      itemIds[it.name] = row.id;
      for (const [gSort, g] of (it.groups ?? []).entries()) {
        await db.insertInto('item_modifier_groups').values({ tenant_id: t, item_id: row.id, group_id: groupIds[g]!, sort: gSort }).execute();
      }
    }
  }

  // Tables
  const tableIds: Record<string, string> = {};
  for (const z of TABLES) {
    for (let n = 1; n <= z.count; n++) {
      const label = `${z.prefix}${n}`;
      const row = await db
        .insertInto('tables')
        .values({ tenant_id: t, outlet_id: outletId, label, seats: z.seats, zone: z.zone, sort: n })
        .returning('id')
        .executeTakeFirstOrThrow();
      tableIds[label] = row.id;
    }
  }

  // Two weeks of trading history (before recipes exist, so today's stock stays intact), oldest
  // first so invoice numbers rise with the dates. Reports and the dashboard then have a shape.
  await seedHistory({ ctx, t, outletId, itemIds, tableIds, staff: [staffIds['ravi@courtyard.demo']!, staffIds['sunita@courtyard.demo']!], cashier: staffIds['priya@courtyard.demo']! });

  // Stock and recipes, so the demo orders below use up ingredients.
  const ingredientIds: Record<string, string> = {};
  await ctx.tx(t, async (tx) => {
    for (const [name, [unit, stock, reorder, cost]] of Object.entries(INGREDIENTS)) {
      const row = await tx.db
        .insertInto('ingredients')
        .values({ tenant_id: t, outlet_id: outletId, name, unit, reorder_level: reorder, cost_per_unit_paise: cost })
        .returning('id')
        .executeTakeFirstOrThrow();
      ingredientIds[name] = row.id;
      await applyMovement(tx, { ingredientId: row.id, type: 'purchase', qty: stock, unitCostPaise: cost, supplier: 'Opening stock', userId: ids.ownerId });
    }
    for (const [dish, lines] of Object.entries(RECIPES)) {
      await tx.db
        .insertInto('recipes')
        .values(Object.entries(lines).map(([ing, qty]) => ({ tenant_id: t, item_id: itemIds[dish]!, ingredient_id: ingredientIds[ing]!, qty })))
        .execute();
    }
    const large = await tx.db.selectFrom('modifiers').select('id').where('group_id', '=', groupIds.coffeeSize!).where('name', '=', 'Large').executeTakeFirstOrThrow();
    await tx.db.insertInto('modifier_recipes').values({ tenant_id: t, modifier_id: large.id, ingredient_id: ingredientIds.Milk!, qty: 0.1 }).execute();
  });

  // Guests who agreed to share their number.
  const customerIds: Record<string, string> = {};
  for (const [i, c] of CUSTOMERS.entries()) {
    const row = await db
      .insertInto('customers')
      .values({
        tenant_id: t,
        phone: c.phone,
        name: c.name,
        consent_at: new Date(Date.now() - (30 - i * 7) * 86_400_000),
        consent_source: 'staff',
        marketing_opt_in: c.marketing,
        points: c.points ?? 0,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    customerIds[c.name] = row.id;
    if (c.points) {
      await db
        .insertInto('loyalty_ledger')
        .values({ tenant_id: t, customer_id: row.id, outlet_id: outletId, kind: 'adjust', points: c.points, note: 'Carried over from the old register', created_by: ids.ownerId })
        .execute();
    }
  }

  // A few settled and live tables so the floor map and dashboard have something to show.
  const session = await ctx.tx(t, (tx) => createStaffSession(tx, ids.ownerId, { userAgent: 'seed' }));
  const owner = (await authenticate(ctx, session.token)) as StaffAuth;
  const modsOf = async (itemName: string, picks: string[]) => {
    if (!picks.length) return [];
    const rows = await db
      .selectFrom('modifiers')
      .innerJoin('item_modifier_groups', 'item_modifier_groups.group_id', 'modifiers.group_id')
      .select(['modifiers.id', 'modifiers.name'])
      .where('item_modifier_groups.item_id', '=', itemIds[itemName]!)
      .execute();
    return picks.map((p) => rows.find((r) => r.name === p)!.id);
  };
  const scenarios: { table: string; lines: [string, number, string[]][]; settle?: 'cash' | 'upi'; serve?: boolean; customer?: string }[] = [
    { table: 'C2', lines: [['Paneer Tikka', 1, ['Medium']], ['Dal Makhani', 1, ['Butter naan']], ['Masala Chai', 2, []]], settle: 'upi', customer: 'Ananya Rao' },
    { table: 'C5', lines: [['Butter Chicken', 1, ['Garlic naan']], ['Fresh Lime Soda', 2, []]], settle: 'cash' },
    { table: 'P3', lines: [['Hyderabadi Chicken Biryani', 2, []], ['Gulab Jamun', 2, []]], settle: 'upi' },
    { table: 'C7', lines: [['Hara Bhara Kebab', 1, []], ['Cold Coffee', 2, ['Large']]], serve: true },
    { table: 'P1', lines: [['Veg Dum Biryani', 1, []], ['Virgin Mojito', 1, []]] },
  ];
  for (const s of scenarios) {
    await ctx.tx(t, async (tx) => {
      const sess = await getOrCreateSession(tx, tableIds[s.table]!);
      if (s.customer) await tx.db.updateTable('table_sessions').set({ customer_id: customerIds[s.customer]! }).where('id', '=', sess.id).execute();
      const lines = [];
      for (const [name, qty, picks] of s.lines) lines.push({ item_id: itemIds[name]!, qty, modifier_ids: await modsOf(name, picks) });
      const order = await createOrder(tx, { outletId, type: 'dine_in', source: 'waiter', sessionId: sess.id, lines, createdBy: owner.userId });
      if (s.serve || s.settle) await transitionOrder(tx, owner, order.id, 'served');
      if (s.settle) {
        const bill = await createBill(tx, owner, { table_session_id: sess.id });
        const fin = await finaliseBill(tx, owner, bill.id);
        await recordPayment(tx, owner, bill.id, { method: s.settle, amount_paise: fin.total_paise, reference: s.settle === 'upi' ? 'UTR demo' : null });
      }
    });
  }
  // A guest order waiting in the inbox for approval.
  await ctx.tx(t, async (tx) => {
    const sess = await getOrCreateSession(tx, tableIds.C9!);
    await createOrder(tx, {
      outletId,
      type: 'dine_in',
      source: 'guest_qr',
      sessionId: sess.id,
      deviceId: '00000000-0000-4000-8000-000000000001',
      note: 'Anniversary dinner',
      lines: [
        { item_id: itemIds['Chicken Malai Tikka']!, qty: 1, modifier_ids: [] },
        { item_id: itemIds['Cappuccino']!, qty: 2, modifier_ids: await modsOf('Cappuccino', ['Regular', 'Hazelnut syrup']) },
      ],
    });
  });
  // Tonight's bookings and a party waiting for a table.
  const slot = (hoursAhead: number) => {
    const d = new Date(Date.now() + hoursAhead * 3600_000);
    d.setUTCMinutes(Math.ceil(d.getUTCMinutes() / 15) * 15, 0, 0);
    return d;
  };
  const bookings: { name: string; party: number; at: Date; table?: string; customer?: string; notes?: string }[] = [
    { name: 'Vikram Mehta', party: 4, at: slot(1), table: 'C4', customer: 'Vikram Mehta', notes: 'Anniversary, quiet corner' },
    { name: 'Sharma family', party: 8, at: slot(2), table: 'PD1', notes: 'High chair for a toddler' },
    { name: 'Fatima Sheikh', party: 2, at: slot(3), customer: 'Fatima Sheikh' },
    { name: 'Corporate lunch: Infra Ltd', party: 10, at: slot(26), table: 'PD2' },
  ];
  for (const b of bookings) {
    await db
      .insertInto('reservations')
      .values({
        tenant_id: t,
        outlet_id: outletId,
        table_id: b.table ? tableIds[b.table]! : null,
        customer_id: b.customer ? customerIds[b.customer]! : null,
        guest_name: b.name,
        guest_phone: b.customer ? CUSTOMERS.find((c) => c.name === b.customer)!.phone : null,
        party_size: b.party,
        slot_start: b.at,
        slot_end: new Date(b.at.getTime() + 90 * 60_000),
        source: 'phone',
        notes: b.notes ?? null,
        created_by: ids.ownerId,
      })
      .execute();
  }
  await db
    .insertInto('waitlist_entries')
    .values({ tenant_id: t, outlet_id: outletId, guest_name: 'Kapoor', party_size: 5, quoted_minutes: 20, created_at: new Date(Date.now() - 12 * 60_000), created_by: ids.ownerId })
    .execute();

  await ctx.tx(t, (tx) => tx.db.deleteFrom('user_sessions').where('id', '=', owner.sessionId).execute());

  // Platform admin
  const admin = await db.selectFrom('platform_admins').select('id').where('email', '=', ADMIN_EMAIL).executeTakeFirst();
  if (!admin) await db.insertInto('platform_admins').values({ name: 'Platform Admin', email: ADMIN_EMAIL, password_hash: await hashSecret(ADMIN_PASSWORD) }).execute();

  console.log(`
Seeded "${SLUG}" (Aurum Grand Hotel, The Courtyard): ${Object.keys(itemIds).length} dishes, ${Object.keys(tableIds).length} tables.

  Restaurant code: ${SLUG}
  Owner:    owner@courtyard.demo / ${PASSWORD}
  Manager:  arjun@courtyard.demo / ${PASSWORD}   (approval PIN 1234)
  Cashier:  priya@courtyard.demo / ${PASSWORD}
  Waiter:   ravi@courtyard.demo  / ${PASSWORD}
  Kitchen:  imran@courtyard.demo / ${PASSWORD}
  Platform admin: ${ADMIN_EMAIL} / ${ADMIN_PASSWORD}

Print a table QR from Tables in the portal, or open the guest menu for C1 via the portal's "Open guest view".
`);
  await ctx.close();
}

/** Deterministic pseudo-random numbers so every reseed looks the same. */
function rng(seed: number) {
  let x = seed;
  return () => {
    x = (x * 1_103_515_245 + 12_345) % 2_147_483_648;
    return x / 2_147_483_648;
  };
}

async function seedHistory(o: {
  ctx: ReturnType<typeof createContext>;
  t: string;
  outletId: string;
  itemIds: Record<string, string>;
  tableIds: Record<string, string>;
  staff: string[];
  cashier: string;
}) {
  const { ctx, t, outletId } = o;
  const rand = rng(20261015);
  const pick = <T,>(list: readonly T[]): T => list[Math.floor(rand() * list.length)]!;
  const auths: StaffAuth[] = [];
  for (const userId of [...o.staff, o.cashier]) {
    const session = await ctx.tx(t, (tx) => createStaffSession(tx, userId, { userAgent: 'seed' }));
    auths.push((await authenticate(ctx, session.token)) as StaffAuth);
  }
  const cashier = auths[auths.length - 1]!;
  // Breakfast items are only orderable in the morning, so history uses the all-day menu.
  const dishes = MENU.filter((c) => c.category !== 'Breakfast').flatMap((c) => c.items.filter((i) => !i.groups?.some((g) => ['spice', 'coffeeSize', 'eggs'].includes(g))).map((i) => i.name));
  const drinks = MENU.find((c) => c.category === 'Beverages')!.items.filter((i) => !i.groups).map((i) => i.name);
  const tables = Object.keys(o.tableIds).filter((l) => !l.startsWith('PD'));
  const hours = [12, 12, 13, 13, 13, 14, 15, 19, 20, 20, 20, 21, 21, 21, 22];
  const reasons = ['Regular guest', 'Hotel guest', 'Late food'];
  const guestNames = ['Mr. Kapoor', 'Ms. Iyer', 'Dr. Menon', 'Mr. & Mrs. Shah', 'Ms. Fernandes', 'Mr. Gupta'];

  for (let daysAgo = 14; daysAgo >= 1; daysAgo--) {
    const weekend = [0, 6].includes(new Date(Date.now() - daysAgo * 86_400_000).getDay());
    const visits = (weekend ? 11 : 7) + Math.floor(rand() * 4);
    const slots = Array.from({ length: visits }, () => ({ hour: pick(hours), minute: Math.floor(rand() * 60) })).sort((a, b) => a.hour * 60 + a.minute - (b.hour * 60 + b.minute));
    for (const slot of slots) {
      const day = new Date(Date.now() - daysAgo * 86_400_000);
      const ist = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(day);
      const start = new Date(`${ist}T${String(slot.hour).padStart(2, '0')}:${String(slot.minute).padStart(2, '0')}:00+05:30`);
      const at = (minutes: number) => new Date(start.getTime() + minutes * 60_000);
      const guests = 1 + Math.floor(rand() * 5);
      const viaQr = rand() < 0.35;
      const waiter = pick(auths.slice(0, -1));
      const lines = [
        ...Array.from({ length: 1 + Math.floor(rand() * 3) }, () => ({ item_id: o.itemIds[pick(dishes)]!, qty: 1 + Math.floor(rand() * 2), modifier_ids: [] })),
        { item_id: o.itemIds[pick(drinks)]!, qty: Math.max(1, guests - 1), modifier_ids: [] },
      ];
      const dwell = 35 + Math.floor(rand() * 60);
      await ctx.tx(t, async (tx) => {
        const sess = await getOrCreateSession(tx, o.tableIds[pick(tables)]!);
        await openSession(tx, sess.id, { guestCount: guests, waiterId: waiter.userId });
        const order = viaQr
          ? await createOrder(tx, { outletId, type: 'dine_in', source: 'guest_qr', sessionId: sess.id, lines, deviceId: crypto.randomUUID() })
          : await createOrder(tx, { outletId, type: 'dine_in', source: 'waiter', sessionId: sess.id, lines, createdBy: waiter.userId });
        if (viaQr) await transitionOrder(tx, waiter, order.id, 'accepted');
        await transitionOrder(tx, waiter, order.id, 'served');
        const bill = await createBill(tx, cashier, { table_session_id: sess.id });
        if (rand() < 0.12) await updateBill(tx, cashier, bill.id, { bill_discount: { kind: 'percent', bp: 1000 }, discount_reason: pick(reasons) });
        const fin = await finaliseBill(tx, cashier, bill.id);
        const roll = rand();
        const method = roll < 0.5 ? 'upi' : roll < 0.7 ? 'cash' : roll < 0.85 ? 'card_slip' : 'room';
        await recordPayment(tx, cashier, bill.id, {
          method,
          amount_paise: fin.total_paise,
          reference: null,
          // Hotel guests often put dinner on the room.
          ...(method === 'room' ? { room_no: String((1 + Math.floor(rand() * 4)) * 100 + 1 + Math.floor(rand() * 18)), room_guest: pick(guestNames) } : {}),
        });

        const accepted = at(viaQr ? 1 + rand() * 2 : 0);
        await tx.db
          .updateTable('orders')
          .set({ placed_at: at(0), created_at: at(0), accepted_at: accepted, ready_at: at(18 + rand() * 10), served_at: at(22 + rand() * 10), business_date: ist })
          .where('id', '=', order.id)
          .execute();
        await tx.db.updateTable('order_items').set({ created_at: at(0) }).where('order_id', '=', order.id).execute();
        await tx.db.updateTable('table_sessions').set({ opened_at: at(-3), created_at: at(-3), closed_at: at(dwell) }).where('id', '=', sess.id).execute();
        await tx.db.updateTable('bills').set({ invoice_date: ist, created_at: at(dwell - 8), finalised_at: at(dwell - 6), paid_at: at(dwell - 2) }).where('id', '=', bill.id).execute();
        await tx.db.updateTable('payments').set({ created_at: at(dwell - 2) }).where('bill_id', '=', bill.id).execute();
        await tx.db.updateTable('kots').set({ created_at: at(0) }).where('order_id', '=', order.id).execute();
        // The tables are free again for today's demo scenarios.
        await tx.db.updateTable('tables').set({ needs_cleaning: false }).where('outlet_id', '=', outletId).execute();
      });
    }
  }
  await ctx.tx(t, async (tx) => {
    // The front desk has posted room charges up to the day before yesterday.
    await tx.db
      .updateTable('payments')
      .set({ room_posted_at: new Date(), room_posted_by: cashier.userId })
      .where('method', '=', 'room')
      .where('created_at', '<', new Date(Date.now() - 2 * 86_400_000))
      .execute();
    await tx.db.deleteFrom('user_sessions').where('id', 'in', auths.map((a) => a.sessionId)).execute();
    await tx.db.updateTable('tables').set({ state: 'vacant', needs_cleaning: false }).where('outlet_id', '=', outletId).execute();
  });
  // Every dish with a photo, as guests see the menu.
  await attachDemoPhotos(ctx, t);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

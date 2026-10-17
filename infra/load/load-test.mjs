// Load test for one outlet at the spec's scale target (§12): 60 tables, 300 guest phones,
// 10 staff devices. Measures what matters: time from a guest tapping "Order now" to the order
// appearing on staff screens (budget: 2 s), plus menu and order request latency.
//
//   ADMIN_EMAIL=admin@mezmitra.local ADMIN_PASSWORD=admin-demo-1234 \
//   API_URL=http://localhost:4000 DURATION_S=60 node infra/load/load-test.mjs
//
// It provisions its own throwaway tenant through the admin API, so it never touches real data.
// Run the API with GUEST_JOIN_RATE_LIMIT and RATE_LIMIT_MAX raised: every simulated phone shares
// this machine's IP.

import { io } from 'socket.io-client';

const API = process.env.API_URL ?? 'http://localhost:4000';
const TABLES = Number(process.env.TABLES ?? 60);
const GUESTS_PER_TABLE = Number(process.env.GUESTS_PER_TABLE ?? 5);
const STAFF_DEVICES = Number(process.env.STAFF_DEVICES ?? 10);
const DURATION_S = Number(process.env.DURATION_S ?? 60);
const ORDER_EVERY_S = Number(process.env.ORDER_EVERY_S ?? 20); // per table
const BUDGET_MS = 2000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);

async function call(path, { method = 'GET', body, token } = {}) {
  const started = performance.now();
  const res = await fetch(`${API}/v1${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const ms = performance.now() - started;
  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!res.ok) throw Object.assign(new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 200)}`), { status: res.status, ms });
  return { data, ms };
}

function stats(values) {
  if (values.length === 0) return { n: 0 };
  const s = [...values].sort((a, b) => a - b);
  const p = (q) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  return { n: s.length, p50: Math.round(p(0.5)), p95: Math.round(p(0.95)), p99: Math.round(p(0.99)), max: Math.round(s.at(-1)) };
}

async function setup() {
  const admin = (await call('/admin/auth/login', { method: 'POST', body: { email: process.env.ADMIN_EMAIL ?? 'admin@mezmitra.local', password: process.env.ADMIN_PASSWORD ?? 'admin-demo-1234' } })).data.token;
  const slug = `load-${Date.now().toString(36)}`;
  await call('/admin/tenants', {
    method: 'POST',
    token: admin,
    body: { name: `Load test ${slug}`, slug, plan_code: 'premium', owner: { name: 'Load', email: `owner@${slug}.test`, password: 'load-test-pass' }, outlet: { name: 'Load outlet' } },
  });
  const owner = (await call('/auth/login', { method: 'POST', body: { tenant_slug: slug, login: `owner@${slug}.test`, password: 'load-test-pass' } })).data;
  const token = owner.token;
  const outletId = owner.me.outlets[0].id;
  await call(`/outlets/${outletId}`, { method: 'PATCH', token, body: { auto_accept: true, approve_flagged_orders: false } });
  const cat = (await call('/menu/categories', { method: 'POST', token, body: { outlet_id: outletId, name: 'Everything' } })).data;
  const items = [];
  for (let i = 0; i < 40; i++) {
    items.push((await call('/menu/items', { method: 'POST', token, body: { outlet_id: outletId, category_id: cat.id, name: `Dish ${i + 1}`, price_paise: 10000 + i * 500, is_veg: i % 3 !== 0 } })).data.id);
  }
  const tables = (await call('/tables/bulk', { method: 'POST', token, body: { outlet_id: outletId, prefix: 'L', from: 1, to: TABLES } })).data;
  const qrs = [];
  for (const t of tables) qrs.push(new URL((await call(`/tables/${t.id}/qr`, { token })).data.url).pathname.split('/').pop());
  return { admin, slug, token, outletId, items, qrs };
}

async function main() {
  console.log(`Setting up a throwaway tenant: ${TABLES} tables, ${TABLES * GUESTS_PER_TABLE} guests, ${STAFF_DEVICES} staff devices...`);
  const env = await setup();

  // Staff screens (inbox / KDS / floor) all listening.
  // The staff event often lands before the guest's HTTP response returns, so match in both orders.
  const pending = new Map(); // order id -> time "Order now" was sent
  const arrived = new Map(); // order id -> time the staff screen got it
  const deliveries = [];
  const staffSockets = [];
  for (let i = 0; i < STAFF_DEVICES; i++) {
    const s = io(`${API}/staff`, { auth: { token: env.token }, transports: ['websocket'], forceNew: true });
    await new Promise((r) => s.once('ready', r));
    if (i === 0) {
      s.on('event', (e) => {
        if (e.type !== 'order.placed') return;
        const key = e.payload.order.id;
        const now = performance.now();
        const sent = pending.get(key);
        if (sent !== undefined) {
          deliveries.push(now - sent);
          pending.delete(key);
        } else arrived.set(key, now);
      });
    }
    staffSockets.push(s);
  }

  // Guests join their tables and open the menu.
  const joinMs = [];
  const menuMs = [];
  const guests = [];
  for (const [t, qr] of env.qrs.entries()) {
    for (let g = 0; g < GUESTS_PER_TABLE; g++) {
      const j = await call('/guest/join', { method: 'POST', body: { qr_token: qr } });
      joinMs.push(j.ms);
      const session = await call('/guest/session', { token: j.data.guest_token });
      const m = await call(`${session.data.context.outlet.menu_path}`);
      menuMs.push(m.ms);
      const socket = io(`${API}/guest`, { auth: { token: j.data.guest_token }, transports: ['websocket'], forceNew: true });
      guests.push({ table: t, token: j.data.guest_token, socket });
    }
  }
  await sleep(500);
  console.log(`${guests.length} guests connected. Ordering for ${DURATION_S}s...`);

  // Each table orders every ~ORDER_EVERY_S seconds from a random phone at that table.
  const orderMs = [];
  const errors = [];
  const deadline = Date.now() + DURATION_S * 1000;
  const tableLoops = env.qrs.map(async (_, t) => {
    await sleep(rand(0, ORDER_EVERY_S * 1000));
    while (Date.now() < deadline) {
      const phones = guests.filter((x) => x.table === t);
      const phone = phones[Math.floor(Math.random() * phones.length)];
      const item = env.items[Math.floor(Math.random() * env.items.length)];
      try {
        await call('/guest/cart/lines', { method: 'POST', token: phone.token, body: { item_id: item, qty: 1 + Math.floor(Math.random() * 2), modifier_ids: [] } });
        const sent = performance.now();
        const res = await call('/guest/orders', { method: 'POST', token: phone.token, body: {} });
        orderMs.push(res.ms);
        const id = res.data.order.id;
        if (arrived.has(id)) {
          deliveries.push(arrived.get(id) - sent);
          arrived.delete(id);
        } else pending.set(id, sent);
      } catch (err) {
        errors.push(err.message);
      }
      await sleep(rand(ORDER_EVERY_S * 500, ORDER_EVERY_S * 1500));
    }
  });
  await Promise.all(tableLoops);
  await sleep(3000);

  for (const s of [...staffSockets, ...guests.map((g) => g.socket)]) s.close();

  const lost = pending.size;
  const d = stats(deliveries);
  console.log('\nResults');
  console.table({
    'guest join (ms)': stats(joinMs),
    'menu load (ms)': stats(menuMs),
    'place order (ms)': stats(orderMs),
    'order → staff screen (ms)': d,
  });
  console.log(`orders: ${orderMs.length}, delivered to staff: ${deliveries.length}, not delivered: ${lost}, errors: ${errors.length}`);
  if (errors.length) console.log('first errors:', [...new Set(errors)].slice(0, 5));
  const pass = d.n > 0 && d.p99 <= BUDGET_MS && lost === 0 && errors.length === 0;
  console.log(pass ? `PASS: p99 order-to-staff ${d.p99} ms within the ${BUDGET_MS} ms budget` : 'FAIL: see numbers above');
  console.log(`Throwaway tenant "${env.slug}" can be suspended and purged from the admin console.`);
  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

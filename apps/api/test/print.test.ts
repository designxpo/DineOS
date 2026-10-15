// End to end: register a print agent, run the real agent against the test server with a fake
// printer, and check kitchen tickets print, get acknowledged and survive an offline agent.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrintAgent, type Transport } from '../../print-agent/src/agent';
import { addStaff, api, createMenu, createTable, createTenant, startApp, type TestApp, type TestMenu, type TestTenant } from './helpers';

let t: TestApp;
let tenant: TestTenant;
let menu: TestMenu;
let owner: ReturnType<typeof api>;

beforeAll(async () => {
  t = await startApp();
  tenant = await createTenant(t);
  menu = await createMenu(t, tenant);
  owner = api(t, tenant.ownerToken);
});
afterAll(() => t.close());

async function registerAgent() {
  const res = await owner({
    method: 'POST',
    url: '/v1/devices',
    payload: {
      outlet_id: tenant.outletId,
      name: 'Kitchen PC',
      config: { printers: { kitchen: { address: '10.0.0.5:9100', width: 48 }, bar: { address: '10.0.0.6:9100', width: 32 }, bill: { address: '10.0.0.7:9100' } } },
    },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { device: { id: string }; token: string };
}

function fakePrinter() {
  const printed: { address: string; bytes: Buffer }[] = [];
  const transport: Transport = async (address, bytes) => {
    printed.push({ address, bytes });
  };
  return { printed, transport };
}

async function until(check: () => boolean | Promise<boolean>, ms = 4000) {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('print agent', () => {
  it('only managers can register devices, and the token is shown once', async () => {
    const waiter = api(t, (await addStaff(t, tenant, 'waiter')).token);
    expect((await waiter({ method: 'POST', url: '/v1/devices', payload: { outlet_id: tenant.outletId, name: 'x' } })).statusCode).toBe(403);
    const { token } = await registerAgent();
    expect(token).toMatch(/^dv_/);
    const list = (await owner({ method: 'GET', url: `/v1/devices?outlet_id=${tenant.outletId}` })).json();
    expect(JSON.stringify(list)).not.toContain(token);
  });

  it('prints kitchen tickets per station as orders are accepted, and acks them', async () => {
    const { token } = await registerAgent();
    const { printed, transport } = fakePrinter();
    const agent = new PrintAgent({ apiUrl: t.url, token, transport, log: () => {}, pollMs: 60_000 });
    await agent.start();
    await until(() => true);

    const tableId = await createTable(t, tenant, 'K1');
    const order = await owner({
      method: 'POST',
      url: '/v1/orders',
      payload: {
        outlet_id: tenant.outletId,
        type: 'dine_in',
        table_id: tableId,
        lines: [
          { item_id: menu.paneerTikka, qty: 2 },
          { item_id: menu.coldCoffee, qty: 1, modifier_ids: [menu.large] },
        ],
      },
    });
    expect(order.statusCode).toBe(201);
    await until(() => printed.length >= 2);
    await agent.idle();
    expect(printed.map((p) => p.address).sort()).toEqual(['10.0.0.5:9100', '10.0.0.6:9100']);
    expect(printed.find((p) => p.address === '10.0.0.6:9100')!.bytes.toString('latin1')).toContain('Cold Coffee');

    await until(async () => {
      const kots = await t.ctx.adminDb.selectFrom('kots').select('printed_at').where('order_id', '=', order.json().id).execute();
      return kots.length === 2 && kots.every((k) => k.printed_at !== null);
    });
    await agent.stop();
  });

  it('catches up on jobs queued while the agent was offline', async () => {
    const { token } = await registerAgent();
    const tableId = await createTable(t, tenant, 'K2');
    await owner({ method: 'POST', url: '/v1/orders', payload: { outlet_id: tenant.outletId, type: 'dine_in', table_id: tableId, lines: [{ item_id: menu.paneerTikka, qty: 1 }] } });

    const { printed, transport } = fakePrinter();
    const agent = new PrintAgent({ apiUrl: t.url, token, transport, log: () => {}, pollMs: 60_000 });
    await agent.start();
    await until(() => printed.some((p) => p.bytes.toString('latin1').includes('Table K2')));
    await agent.idle();
    await agent.stop();
  });

  it('reports a printer failure and retries on the next poll', async () => {
    const { token } = await registerAgent();
    let fail = true;
    const printed: string[] = [];
    const agent = new PrintAgent({
      apiUrl: t.url,
      token,
      log: () => {},
      pollMs: 60_000,
      transport: async (address) => {
        if (fail) throw new Error('paper out');
        printed.push(address);
      },
    });
    await agent.start();
    const job = (await owner({ method: 'POST', url: '/v1/print/test', payload: { outlet_id: tenant.outletId, target: 'bill' } })).json();
    await until(async () => {
      const row = await t.ctx.adminDb.selectFrom('print_jobs').select(['status', 'last_error']).where('id', '=', job.id).executeTakeFirstOrThrow();
      return row.last_error === 'paper out' && row.status === 'queued';
    });
    fail = false;
    await agent.poll();
    await agent.idle();
    await until(async () => (await t.ctx.adminDb.selectFrom('print_jobs').select('status').where('id', '=', job.id).executeTakeFirstOrThrow()).status === 'printed');
    expect(printed).toContain('10.0.0.7:9100');
    await agent.stop();
  });

  it('stops working when the device is revoked', async () => {
    const { device, token } = await registerAgent();
    await owner({ method: 'PATCH', url: `/v1/devices/${device.id}`, payload: { status: 'revoked' } });
    const { clearAuthCache } = await import('../src/lib/auth');
    clearAuthCache();
    const res = await t.app.inject({ method: 'GET', url: '/v1/device/me', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(401);
  });
});

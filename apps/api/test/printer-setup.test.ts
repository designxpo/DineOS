// Connecting printers from Settings: the agent lists what it can reach, picks up changes without a
// restart, prints only where a printer is set, opens the cash drawer on cash, and staff hear about
// tickets that did not print.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FoundPrinter, PrintStatusDTO } from '@dineos/shared/print';
import { PrintAgent, type Transport } from '../../print-agent/src/agent';
import { addStaff, api, createMenu, createTable, createTenant, startApp, type TestApp, type TestMenu, type TestTenant } from './helpers';

let t: TestApp;
let tenant: TestTenant;
let menu: TestMenu;
let owner: ReturnType<typeof api>;
const agents: PrintAgent[] = [];

beforeAll(async () => {
  t = await startApp();
  tenant = await createTenant(t);
  menu = await createMenu(t, tenant);
  owner = api(t, tenant.ownerToken);
  await t.ctx.adminDb.updateTable('outlets').set({ kitchen_stations: ['kitchen', 'bar'] }).where('id', '=', tenant.outletId).execute();
});
afterAll(async () => {
  for (const a of agents) await a.stop();
  await t.close();
});

async function until(check: () => boolean | Promise<boolean>, ms = 5000) {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Only one print computer at a time in this outlet, so each test knows where jobs go. */
async function freshComputer(printers: Record<string, unknown> = {}) {
  for (const a of agents.splice(0)) await a.stop();
  await t.ctx.adminDb.updateTable('devices').set({ status: 'revoked' }).where('outlet_id', '=', tenant.outletId).execute();
  const res = await owner({ method: 'POST', url: '/v1/devices', payload: { outlet_id: tenant.outletId, name: 'Billing PC', config: { printers } } });
  expect(res.statusCode).toBe(201);
  return res.json() as { device: { id: string }; token: string };
}

function runAgent(token: string, opts: { discover?: () => Promise<FoundPrinter[]> } = {}) {
  const printed: { address: string; bytes: Buffer }[] = [];
  const transport: Transport = async (address, bytes) => {
    printed.push({ address, bytes });
  };
  const agent = new PrintAgent({ apiUrl: t.url, token, transport, log: () => {}, pollMs: 60_000, ...opts });
  agents.push(agent);
  return { agent, printed };
}

const devices = async () => (await owner({ method: 'GET', url: `/v1/devices?outlet_id=${tenant.outletId}` })).json() as { id: string; info: { printers?: FoundPrinter[]; version?: string } }[];
const jobsFor = (refIds: string[]) => t.ctx.adminDb.selectFrom('print_jobs').select(['id', 'target', 'kind', 'status']).where('ref_id', 'in', refIds).execute();

describe('printer setup', () => {
  it('lists the printers the computer can reach, and looks again when asked', async () => {
    const { device, token } = await freshComputer();
    let searches = 0;
    const found: FoundPrinter[] = [
      { address: 'printer:EPSON TM-T82', label: 'EPSON TM-T82', kind: 'system' },
      { address: '10.0.0.9:9100', label: 'Network printer 10.0.0.9', kind: 'network' },
    ];
    const { agent } = runAgent(token, {
      discover: async () => {
        searches++;
        return found;
      },
    });
    await agent.start();
    await until(async () => ((await devices()).find((d) => d.id === device.id)?.info.printers?.length ?? 0) === 2);
    expect((await devices()).find((d) => d.id === device.id)!.info).toMatchObject({ version: 'dev', printers: found });

    expect((await owner({ method: 'POST', url: `/v1/devices/${device.id}/scan` })).statusCode).toBe(202);
    await until(() => searches === 2);
    const waiter = api(t, (await addStaff(t, tenant, 'waiter')).token);
    expect((await waiter({ method: 'POST', url: `/v1/devices/${device.id}/scan` })).statusCode).toBe(403);
  });

  it('takes printer changes straight away, and checks the addresses', async () => {
    const { device, token } = await freshComputer();
    const { agent } = runAgent(token);
    await agent.start();
    const set = (printers: Record<string, unknown>) => owner({ method: 'PATCH', url: `/v1/devices/${device.id}`, payload: { config: { printers } } });

    expect((await set({ kitchen: { address: 'printer:EPSON TM-T82', width: 48 }, bill: { address: '/dev/usb/lp0', width: 32, drawer: true } })).statusCode).toBe(200);
    await until(() => agent.printerConfig.kitchen?.address === 'printer:EPSON TM-T82');
    expect(agent.printerConfig.bill).toEqual({ address: '/dev/usb/lp0', width: 32, drawer: true });
    expect((await set({ kitchen: { address: '192.168.1.50', width: 48 } })).statusCode).toBe(200);

    for (const bad of ['not a printer!', 'printer:', 'printer:Bad\nname', '/etc/passwd']) {
      expect((await set({ kitchen: { address: bad, width: 48 } })).statusCode, bad).toBe(400);
    }
  });

  it('prints kitchen tickets only for stations that have a printer', async () => {
    const { token } = await freshComputer({ kitchen: { address: '10.0.0.5:9100', width: 48 } });
    const { agent, printed } = runAgent(token);
    await agent.start();
    const tableId = await createTable(t, tenant, 'S1');
    const order = (
      await owner({
        method: 'POST',
        url: '/v1/orders',
        payload: { outlet_id: tenant.outletId, type: 'dine_in', table_id: tableId, lines: [{ item_id: menu.paneerTikka, qty: 1 }, { item_id: menu.coldCoffee, qty: 1, modifier_ids: [menu.regular] }] },
      })
    ).json();
    const kots = await t.ctx.adminDb.selectFrom('kots').select(['id', 'station']).where('order_id', '=', order.id).execute();
    expect(kots.map((k) => k.station).sort()).toEqual(['bar', 'kitchen']);
    // The bar has no printer: its ticket is on the kitchen screen, not a print job that fails.
    expect((await jobsFor(kots.map((k) => k.id))).map((j) => j.target)).toEqual(['kitchen']);
    await until(() => printed.length === 1);
    const reprint = (await owner({ method: 'POST', url: `/v1/orders/${order.id}/reprint-kot`, payload: { station: 'bar' } })).json();
    expect(reprint.queued).toBe(0);
  });

  it('opens the cash drawer on cash payments when the bill printer has one', async () => {
    const { token } = await freshComputer({ bill: { address: '10.0.0.7:9100', width: 48, drawer: true } });
    const { agent, printed } = runAgent(token);
    await agent.start();
    const pay = async (method: string) => {
      const order = (await owner({ method: 'POST', url: '/v1/orders', payload: { outlet_id: tenant.outletId, type: 'takeaway', lines: [{ item_id: menu.paneerTikka, qty: 1 }] } })).json();
      const draft = (await owner({ method: 'POST', url: '/v1/bills', payload: { order_id: order.id } })).json();
      const bill = (await owner({ method: 'POST', url: `/v1/bills/${draft.id}/finalise` })).json();
      const res = await owner({ method: 'POST', url: `/v1/bills/${bill.id}/payments`, payload: { method, amount_paise: bill.total_paise, ...(method === 'upi' ? { reference: '123456789012' } : {}) } });
      expect(res.statusCode).toBe(201);
    };
    const drawerJobs = () => t.ctx.adminDb.selectFrom('print_jobs').select('id').where('outlet_id', '=', tenant.outletId).where('kind', '=', 'drawer').execute();
    const before = (await drawerJobs()).length;
    await pay('cash');
    expect((await drawerJobs()).length).toBe(before + 1);
    await until(() => printed.some((p) => p.bytes.includes(Buffer.from([0x1b, 0x70, 0, 25, 250]))));
    await pay('upi');
    expect((await drawerJobs()).length).toBe(before + 1);
  });

  it('tells staff about tickets that did not print, until someone deals with them', async () => {
    // A computer that is switched off: jobs wait for it.
    await freshComputer({ kitchen: { address: '10.0.0.5:9100', width: 48 } });
    const tableId = await createTable(t, tenant, 'S2');
    const order = (await owner({ method: 'POST', url: '/v1/orders', payload: { outlet_id: tenant.outletId, type: 'dine_in', table_id: tableId, lines: [{ item_id: menu.paneerTikka, qty: 1 }] } })).json();
    const cook = api(t, (await addStaff(t, tenant, 'kitchen')).token);
    const status = async () => (await cook({ method: 'GET', url: `/v1/print/status?outlet_id=${tenant.outletId}` })).json() as PrintStatusDTO;

    expect((await status()).problems).toHaveLength(0); // just queued: give the printer a moment
    const kot = await t.ctx.adminDb.selectFrom('kots').select(['id', 'kot_no']).where('order_id', '=', order.id).executeTakeFirstOrThrow();
    const [job] = await jobsFor([kot.id]);
    await t.ctx.adminDb.updateTable('print_jobs').set({ created_at: new Date(Date.now() - 2 * 60_000) }).where('id', '=', job!.id).execute();
    const waiting = await status();
    expect(waiting.agents).toEqual([expect.objectContaining({ name: 'Billing PC', online: false })]);
    expect(waiting.problems).toEqual([expect.objectContaining({ job_id: job!.id, status: 'waiting', label: `KOT ${kot.kot_no} · Table S2`, order_id: order.id, target: 'kitchen' })]);

    await t.ctx.adminDb.updateTable('print_jobs').set({ status: 'failed', last_error: 'paper out' }).where('id', '=', job!.id).execute();
    expect((await status()).problems[0]).toMatchObject({ status: 'failed', error: 'paper out' });

    // Sending it again replaces the warning with the new job; clearing it ends the warning.
    const again = (await cook({ method: 'POST', url: `/v1/print-jobs/${job!.id}/retry` })).json();
    expect((await status()).problems).toHaveLength(0);
    await t.ctx.adminDb.updateTable('print_jobs').set({ status: 'failed', created_at: new Date(Date.now() - 2 * 60_000) }).where('id', '=', again.id).execute();
    expect((await status()).problems.map((p) => p.job_id)).toEqual([again.id]);
    expect((await cook({ method: 'POST', url: `/v1/print-jobs/${again.id}/dismiss` })).statusCode).toBe(204);
    expect((await status()).problems).toHaveLength(0);
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CameraDTO, TableDTO, VisionConfigDTO } from '@mezmitra/shared/dto';
import { runMaintenance } from '../src/lib/maintenance';
import { addStaff, api, createMenu, createTable, createTenant, startApp, type TestApp, type TestMenu, type TestTenant } from './helpers';

let t: TestApp;
let tenant: TestTenant;
let menu: TestMenu;
let owner: ReturnType<typeof api>;
let waiter: ReturnType<typeof api>;
let box: ReturnType<typeof api>;
let camera: CameraDTO;
const tables: Record<string, string> = {};

const ago = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString();
const square = (x: number): [number, number][] => [
  [x, 0.2],
  [x + 0.2, 0.2],
  [x + 0.2, 0.6],
  [x, 0.6],
];
// Smallest valid JPEG header plus filler: enough for the upload checks.
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]);

async function read(tableId: string, state: 'vacant' | 'occupied' | 'needs_cleaning', secondsAgo = 0, confidence = 0.9) {
  const res = await box({ method: 'POST', url: '/v1/vision/table-state', payload: { table_id: tableId, state, confidence, observed_at: ago(secondsAgo) } });
  expect(res.statusCode).toBe(200);
  return res.json().results[0].result as string;
}
const floor = async (): Promise<Record<string, TableDTO>> =>
  Object.fromEntries(((await owner({ method: 'GET', url: `/v1/tables?outlet_id=${tenant.outletId}` })).json() as TableDTO[]).map((x) => [x.label, x]));

beforeAll(async () => {
  t = await startApp();
  tenant = await createTenant(t);
  menu = await createMenu(t, tenant);
  owner = api(t, tenant.ownerToken);
  waiter = api(t, (await addStaff(t, tenant, 'waiter')).token);
  for (const label of ['V1', 'V2', 'V3']) tables[label] = await createTable(t, tenant, label);

  const device = (await owner({ method: 'POST', url: '/v1/devices', payload: { outlet_id: tenant.outletId, kind: 'vision', name: 'Camera box' } })).json();
  box = api(t, device.token);
  const printer = (await owner({ method: 'POST', url: '/v1/devices', payload: { outlet_id: tenant.outletId, name: 'Printer PC' } })).json();
  expect((await owner({ method: 'POST', url: '/v1/cameras', payload: { outlet_id: tenant.outletId, device_id: printer.device.id, name: 'X', rtsp_secret_ref: 'x' } })).statusCode).toBe(400);
  expect((await api(t, printer.token)({ method: 'GET', url: '/v1/vision/config' })).statusCode).toBe(401);

  const res = await owner({ method: 'POST', url: '/v1/cameras', payload: { outlet_id: tenant.outletId, device_id: device.device.id, name: 'Courtyard east', rtsp_secret_ref: 'Courtyard_East' } });
  expect(res.statusCode).toBe(201);
  camera = res.json();
  expect(camera.rtsp_secret_ref).toBe('courtyard_east');
});
afterAll(() => t.close());

describe('camera setup', () => {
  it('draws table zones on a camera and hands them to the edge worker', async () => {
    const put = (label: string, body: object, as = owner) => as({ method: 'PUT', url: `/v1/tables/${tables[label]}/camera-zone`, payload: body });
    expect((await put('V1', { camera_id: camera.id, polygon: square(0.1) }, waiter)).statusCode).toBe(403);
    expect((await put('V1', { camera_id: camera.id, polygon: [[0.1, 0.1], [0.2, 0.2]] })).statusCode).toBe(400);
    expect((await put('V1', { camera_id: camera.id, polygon: [[0.1, 0.1], [1.4, 0.2], [0.3, 0.3]] })).statusCode).toBe(400);
    expect((await put('V1', { camera_id: camera.id, polygon: null })).statusCode).toBe(400);
    for (const [label, x] of [['V1', 0.05], ['V2', 0.4], ['V3', 0.7]] as const) expect((await put(label, { camera_id: camera.id, polygon: square(x) })).statusCode).toBe(200);

    const config: VisionConfigDTO = (await box({ method: 'GET', url: '/v1/vision/config' })).json();
    expect(config.cameras).toHaveLength(1);
    expect(config.cameras[0]).toMatchObject({ id: camera.id, rtsp_secret_ref: 'courtyard_east', snapshot_requested: true });
    expect(config.cameras[0]!.zones.map((z) => z.label)).toEqual(['V1', 'V2', 'V3']);
    expect(config.cameras[0]!.zones[0]!.polygon).toEqual(square(0.05));
    expect(config.settings.hold_seconds).toBeGreaterThanOrEqual(20);
    // The stream address and password never reach the cloud.
    expect(JSON.stringify(config)).not.toMatch(/rtsp:\/\//);
  });

  it('keeps zone stills private and short-lived', async () => {
    expect((await box({ method: 'PUT', url: `/v1/vision/cameras/${camera.id}/snapshot?width=1280&height=720`, payload: Buffer.from('not an image'), headers: { 'content-type': 'image/jpeg' } })).statusCode).toBe(400);
    const up = await box({ method: 'PUT', url: `/v1/vision/cameras/${camera.id}/snapshot?width=1280&height=720`, payload: JPEG, headers: { 'content-type': 'image/jpeg' } });
    expect(up.statusCode).toBe(204);
    const cams: CameraDTO[] = (await owner({ method: 'GET', url: `/v1/cameras?outlet_id=${tenant.outletId}` })).json();
    expect(cams[0]).toMatchObject({ snapshot_width: 1280, snapshot_height: 720, snapshot_requested_at: null, online: false });
    const img = await owner({ method: 'GET', url: `/v1/cameras/${camera.id}/snapshot` });
    expect(img.headers['content-type']).toBe('image/jpeg');
    expect(img.headers['cache-control']).toContain('no-store');
    expect(img.rawPayload.equals(JPEG)).toBe(true);
    expect((await waiter({ method: 'GET', url: `/v1/cameras/${camera.id}/snapshot` })).statusCode).toBe(403);

    await t.ctx.adminDb.updateTable('cameras').set({ snapshot_at: new Date(Date.now() - 2 * 86_400_000) }).where('id', '=', camera.id).execute();
    await runMaintenance(t.ctx.adminDb);
    expect((await owner({ method: 'GET', url: `/v1/cameras/${camera.id}/snapshot` })).statusCode).toBe(404);

    await box({ method: 'POST', url: '/v1/vision/heartbeat', payload: { cameras: [{ camera_id: camera.id, ok: false, fps: 0, error: 'RTSP timeout' }] } });
    const after: CameraDTO[] = (await owner({ method: 'GET', url: `/v1/cameras?outlet_id=${tenant.outletId}` })).json();
    expect(after[0]).toMatchObject({ online: true, last_error: 'RTSP timeout' });
  });
});

describe('camera readings and the fusion rule', () => {
  it('fills gaps: a table nobody opened shows occupied, and how long guests have waited', async () => {
    expect(await read(tables.V1!, 'occupied', 90)).toBe('applied');
    const f = await floor();
    expect(f.V1!.state).toBe('occupied');
    expect(f.V1!.session).toBeNull();
    expect(f.V1!.camera).toMatchObject({ state: 'occupied', confidence: 0.9 });
    expect(Date.now() - Date.parse(f.V1!.camera!.occupied_since!)).toBeGreaterThanOrEqual(89_000);

    // A resend keeps the original "since".
    await read(tables.V1!, 'occupied', 30);
    expect((await floor()).V1!.camera!.occupied_since).toBe(f.V1!.camera!.occupied_since);

    // Seating the table ends the wait; the visit now owns the state.
    await waiter({ method: 'POST', url: `/v1/tables/${tables.V1}/seat`, payload: { guest_count: 2 } });
    const seated = (await floor()).V1!;
    expect(seated.camera!.occupied_since).toBeNull();
    expect(seated.state).toBe('occupied');
  });

  it('never overrides an open visit or order', async () => {
    await waiter({ method: 'POST', url: '/v1/orders', payload: { outlet_id: tenant.outletId, type: 'dine_in', table_id: tables.V2, lines: [{ item_id: menu.paneerTikka, qty: 1 }] } });
    expect(await read(tables.V2!, 'vacant')).toBe('applied');
    expect(await read(tables.V2!, 'needs_cleaning', -1)).toBe('applied');
    expect((await floor()).V2!.state).toBe('ordered');
  });

  it('flags a messy table that staff can clear, and ignores late or impossible readings', async () => {
    expect(await read(tables.V3!, 'needs_cleaning', 20)).toBe('applied');
    expect((await floor()).V3!.state).toBe('needs_cleaning');
    expect(await read(tables.V3!, 'vacant', 60)).toBe('stale');
    expect((await floor()).V3!.state).toBe('needs_cleaning');
    const future = await box({ method: 'POST', url: '/v1/vision/table-state', payload: { table_id: tables.V3, state: 'vacant', confidence: 0.9, observed_at: new Date(Date.now() + 10 * 60_000).toISOString() } });
    expect(future.statusCode).toBe(400);

    await waiter({ method: 'POST', url: `/v1/tables/${tables.V3}/clean` });
    const cleaned = (await floor()).V3!;
    expect(cleaned.state).toBe('vacant');
    expect(cleaned.camera).toBeNull();
  });

  it('lets a camera-only state lapse when the camera goes quiet', async () => {
    expect(await read(tables.V3!, 'occupied')).toBe('applied');
    expect((await floor()).V3!.state).toBe('occupied');
    await t.ctx.adminDb.updateTable('tables').set({ camera_at: new Date(Date.now() - 20 * 60_000) }).where('id', '=', tables.V3!).execute();
    const quiet = (await floor()).V3!;
    expect(quiet.state).toBe('vacant');
    expect(quiet.camera).toBeNull();
  });

  it('switching a camera off stops it counting at once', async () => {
    await read(tables.V3!, 'occupied');
    await owner({ method: 'PATCH', url: `/v1/cameras/${camera.id}`, payload: { status: 'disabled' } });
    expect((await floor()).V3!.state).toBe('vacant');
    expect(((await box({ method: 'GET', url: '/v1/vision/config' })).json() as VisionConfigDTO).cameras).toEqual([]);
    await owner({ method: 'PATCH', url: `/v1/cameras/${camera.id}`, payload: { status: 'active' } });
  });
});

describe('camera audit', () => {
  it('scores the camera against open visits and measures the wait before guests are attended', async () => {
    const table = await createTable(t, tenant, 'V9');
    await owner({ method: 'PUT', url: `/v1/tables/${table}/camera-zone`, payload: { camera_id: camera.id, polygon: square(0.5) } });
    await read(table, 'occupied', 600); // guests sit down, nobody comes
    const seat = await waiter({ method: 'POST', url: `/v1/tables/${table}/seat`, payload: {} });
    const sessionId = (seat.json() as TableDTO).session!.id;
    await t.ctx.adminDb.updateTable('table_sessions').set({ opened_at: new Date(Date.now() - 300_000) }).where('id', '=', sessionId).execute();
    await read(table, 'occupied', 180); // during the visit
    await waiter({ method: 'POST', url: `/v1/tables/${table}/release` });
    await t.ctx.adminDb.updateTable('table_sessions').set({ closed_at: new Date(Date.now() - 60_000) }).where('id', '=', sessionId).execute();
    await read(table, 'vacant', 30); // they left

    const audit = (await owner({ method: 'GET', url: `/v1/reports/vision?outlet_id=${tenant.outletId}` })).json();
    const row = audit.tables.find((x: { label: string }) => x.label === 'V9');
    expect(row).toMatchObject({ readings: 3, agree: 2, false_alarms: 1, misses: 0 });
    expect(audit.target_pct).toBe(95);
    expect(audit.readings).toBeGreaterThan(3);
    expect(audit.dwell.visits_seen).toBeGreaterThanOrEqual(1);
    expect(audit.dwell.avg_wait_to_attend_seconds).toBeGreaterThan(0);
    expect((await waiter({ method: 'GET', url: `/v1/reports/vision?outlet_id=${tenant.outletId}` })).statusCode).toBe(403);
  });
});

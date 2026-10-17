// Settings that visibly reach every screen: screens report the version they run, a change makes
// them "behind" until they confirm it, and a screen or print computer can be reloaded remotely.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ScreensDTO } from '@dineos/shared/dto';
import { addStaff, api, createMenu, createTenant, startApp, type TestApp, type TestMenu, type TestTenant } from './helpers';

let t: TestApp;
let tenant: TestTenant;
let menu: TestMenu;
let owner: ReturnType<typeof api>;
let kitchen: ReturnType<typeof api>;
const kds = randomUUID();
const till = randomUUID();

beforeAll(async () => {
  t = await startApp();
  tenant = await createTenant(t);
  menu = await createMenu(t, tenant);
  owner = api(t, tenant.ownerToken);
  kitchen = api(t, (await addStaff(t, tenant, 'kitchen')).token);
});
afterAll(() => t.close());

const outlet = () => tenant.outletId;
const beat = (as: ReturnType<typeof api>, screen: string, applied: number | null, kind = 'kitchen') =>
  as({ method: 'POST', url: '/v1/screens/heartbeat', payload: { outlet_id: outlet(), screen_id: screen, kind, applied_version: applied } }).then((r) => {
    expect(r.statusCode).toBe(200);
    return r.json() as { config_version: number; reload: boolean };
  });
const state = async (): Promise<ScreensDTO> => (await owner({ method: 'GET', url: `/v1/screens?outlet_id=${outlet()}` })).json();

describe('screens', () => {
  it('shows which screens run the latest settings, and which are behind after a change', async () => {
    const first = await beat(kitchen, kds, null);
    await beat(kitchen, kds, first.config_version);
    await beat(owner, till, first.config_version, 'till');
    let s = await state();
    expect(s.screens.map((x) => [x.kind, x.up_to_date, x.online])).toEqual([
      ['till', true, true],
      ['kitchen', true, true],
    ]);
    expect(s.screens.find((x) => x.id === kds)?.user_name).toBeTruthy();

    // Marking a dish sold out is a change every screen must apply.
    expect((await kitchen({ method: 'PATCH', url: `/v1/menu/items/${menu.paneerTikka}/stock`, payload: { in_stock: false } })).statusCode).toBe(200);
    s = await state();
    expect(s.config_version).toBe(first.config_version + 1);
    expect(s.screens.every((x) => !x.up_to_date)).toBe(true);
    const event = t.events.find((e) => e.event.type === 'config.changed' && (e.event.payload as { config_version: number }).config_version === s.config_version);
    expect(event).toBeTruthy();

    const told = await beat(kitchen, kds, first.config_version);
    expect(told.config_version).toBe(s.config_version);
    await beat(kitchen, kds, told.config_version);
    s = await state();
    expect(s.screens.find((x) => x.id === kds)).toMatchObject({ up_to_date: true });
    expect(s.screens.find((x) => x.id === till)).toMatchObject({ up_to_date: false });
  });

  it('lets the owner name a screen and reload one that is behind; staff cannot', async () => {
    expect((await kitchen({ method: 'GET', url: `/v1/screens?outlet_id=${outlet()}` })).statusCode).toBe(403);
    expect((await owner({ method: 'PATCH', url: `/v1/screens/${till}`, payload: { outlet_id: outlet(), label: 'Front till' } })).statusCode).toBe(200);
    expect((await owner({ method: 'POST', url: `/v1/screens/${till}/reload`, payload: { outlet_id: outlet() } })).statusCode).toBe(204);
    expect(t.events.some((e) => e.event.type === 'screen.reload' && (e.event.payload as { screen_id: string }).screen_id === till)).toBe(true);
    // A screen that missed the live message reloads when it next checks in, once.
    expect((await beat(owner, till, 1, 'till')).reload).toBe(true);
    expect((await beat(owner, till, 1, 'till')).reload).toBe(false);
    expect((await state()).screens.find((x) => x.id === till)?.label).toBe('Front till');
  });

  it('counts a print computer as up to date once it fetches its settings', async () => {
    const res = await owner({ method: 'POST', url: '/v1/devices', payload: { outlet_id: outlet(), name: 'Counter PC' } });
    const { device, token } = res.json() as { device: { id: string }; token: string };
    const agent = api(t, token);
    expect((await state()).print_computers.find((d) => d.id === device.id)).toMatchObject({ applied_version: null, up_to_date: false });
    expect((await agent({ method: 'GET', url: '/v1/device/me' })).statusCode).toBe(200);
    expect((await state()).print_computers.find((d) => d.id === device.id)).toMatchObject({ up_to_date: true, online: true });

    // New printer routing: behind until it fetches again.
    await owner({ method: 'PATCH', url: `/v1/devices/${device.id}`, payload: { config: { printers: {} } } });
    expect((await state()).print_computers.find((d) => d.id === device.id)?.up_to_date).toBe(false);
    expect((await owner({ method: 'POST', url: `/v1/screens/print-computers/${device.id}/reload`, payload: { outlet_id: outlet() } })).statusCode).toBe(204);
    await agent({ method: 'GET', url: '/v1/device/me' });
    expect((await state()).print_computers.find((d) => d.id === device.id)?.up_to_date).toBe(true);
  });
});

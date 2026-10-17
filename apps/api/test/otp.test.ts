// Loyalty with a one-time code by SMS: a guest proves a number is theirs before the menu shows the
// name and points on it. Without MSG91 keys the typed-number flow stays (last four digits only).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GuestSessionDTO } from '@mezmitra/shared/dto';
import { addStaff, api, createTable, createTenant, setOutlet, startApp, type TestApp, type TestTenant } from './helpers';

let t: TestApp;
let tenant: TestTenant;
let owner: ReturnType<typeof api>;
let tables = 0;
const sent: { phone: string; code: string }[] = [];
const lastCode = () => sent.at(-1)!.code;

beforeAll(async () => {
  t = await startApp();
  tenant = await createTenant(t);
  owner = api(t, tenant.ownerToken);
  await setOutlet(t, tenant.outletId, { loyalty_enabled: true });
  t.ctx.otp = { send: async (phone, code) => void sent.push({ phone, code }) };
  const cashier = api(t, (await addStaff(t, tenant, 'cashier')).token);
  const member = await cashier({ method: 'POST', url: '/v1/customers', payload: { outlet_id: tenant.outletId, phone: '9876500070', name: 'Asha', consent: true } });
  await owner({ method: 'POST', url: `/v1/customers/${member.json().id}/points`, payload: { outlet_id: tenant.outletId, points: 300, note: 'Welcome' } });
});
afterAll(() => t.close());

async function guestAtTable() {
  const tableId = await createTable(t, tenant, `OTP${++tables}`);
  const qr = new URL((await owner({ method: 'GET', url: `/v1/tables/${tableId}/qr` })).json().url).pathname.split('/').pop()!;
  const joined = await t.app.inject({ method: 'POST', url: '/v1/guest/join', payload: { qr_token: qr } });
  return api(t, joined.json().guest_token);
}

const verify = (guest: ReturnType<typeof api>, code: string, phone = '98765 00070') =>
  guest({ method: 'POST', url: '/v1/guest/loyalty/verify', payload: { phone, code, consent: true } });

describe('loyalty one-time codes', () => {
  it('texts a code, and only the right code shows the guest their name and points', async () => {
    const guest = await guestAtTable();
    const res = await guest({ method: 'POST', url: '/v1/guest/loyalty/otp', payload: { phone: '98765 00070' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ phone_last4: '0070' });
    expect(sent.at(-1)).toMatchObject({ phone: '+919876500070' });
    expect(lastCode()).toMatch(/^\d{6}$/);

    const wrong = await verify(guest, lastCode() === '000000' ? '111111' : '000000');
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error.code).toBe('wrong_code');

    const ok = await verify(guest, lastCode());
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ phone_last4: '0070', name: 'Asha', points: 300 });
    const session: GuestSessionDTO = (await guest({ method: 'GET', url: '/v1/guest/session' })).json();
    expect(session.customer).toEqual({ phone_last4: '0070', verified: true, name: 'Asha', points: 300, stamps: 0, level: null, rewards: [], membership: null, wallet_paise: 0 });
    expect(session.loyalty.otp).toBe(true);

    // While codes are on, typing a number without one is not accepted.
    const typed = await guest({ method: 'POST', url: '/v1/guest/loyalty', payload: { phone: '9876500070', consent: true } });
    expect(typed.statusCode).toBe(409);
    expect(typed.json().error.code).toBe('verify_phone');
  });

  it('stops guessing after five wrong codes, and codes expire', async () => {
    const guest = await guestAtTable();
    await guest({ method: 'POST', url: '/v1/guest/loyalty/otp', payload: { phone: '9876500071' } });
    const right = lastCode();
    const wrong = right === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) expect((await verify(guest, wrong, '9876500071')).statusCode).toBe(400);
    expect((await verify(guest, right, '9876500071')).statusCode).toBe(429);

    await guest({ method: 'POST', url: '/v1/guest/loyalty/otp', payload: { phone: '9876500071' } });
    await t.ctx.adminDb.updateTable('otp_codes').set({ expires_at: new Date(Date.now() - 1000) }).where('phone', '=', '+919876500071').execute();
    const expired = await verify(guest, lastCode(), '9876500071');
    expect(expired.statusCode).toBe(400);
    expect(expired.json().error.code).toBe('code_expired');
  });

  it('sends at most three codes to a number in fifteen minutes, and only to Indian mobiles', async () => {
    const guest = await guestAtTable();
    const ask = (phone: string) => guest({ method: 'POST', url: '/v1/guest/loyalty/otp', payload: { phone } });
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push((await ask('9876500072')).statusCode);
    expect(codes).toEqual([200, 200, 200, 429]);
    expect((await ask('0801234567')).json().error.code).toBe('invalid_phone');
  });

  it('keeps the typed-number flow when SMS is not set up', async () => {
    const otp = t.ctx.otp;
    t.ctx.otp = null;
    try {
      const guest = await guestAtTable();
      const res = await guest({ method: 'POST', url: '/v1/guest/loyalty/otp', payload: { phone: '9876500073' } });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('otp_unavailable');
      const typed = await guest({ method: 'POST', url: '/v1/guest/loyalty', payload: { phone: '9876500070', consent: true } });
      expect(typed.json()).toEqual({ phone_last4: '0070' });
      const session: GuestSessionDTO = (await guest({ method: 'GET', url: '/v1/guest/session' })).json();
      expect(session.customer).toEqual({ phone_last4: '0070', verified: false });
      expect(session.loyalty.otp).toBe(false);
    } finally {
      t.ctx.otp = otp;
    }
  });
});

import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Call = { url: string; auth: string | undefined; key: string | undefined };

let online = false;
let calls: Call[] = [];
let respond: (call: Call) => Response = () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  online = false;
  calls = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    const call = { url, auth: headers.authorization, key: headers['idempotency-key'] };
    if (!online) throw new TypeError('Failed to fetch');
    calls.push(call);
    return respond(call);
  });
});
afterEach(async () => {
  const { dismissRejected, listQueued, discard } = await import('./outbox');
  for (const q of await listQueued()) await discard(q.key);
  await dismissRejected();
  vi.unstubAllGlobals();
});

describe('offline outbox', () => {
  it('queues while offline and replays in order with the same idempotency key and original session', async () => {
    const { flush, listQueued, onOutboxChange, send } = await import('./outbox');
    const states: { pending: number; rejected: number; sent: number }[] = [];
    const off = onOutboxChange((s) => states.push(s));

    expect(await send('st_waiter', '/orders', { method: 'POST', body: { a: 1 }, label: 'Order for T1' })).toEqual({ queued: true });
    expect(await send('st_waiter', '/order-items/x/status', { method: 'PATCH', body: { status: 'ready' }, label: 'Dish ready' })).toEqual({ queued: true });
    const queued = await listQueued();
    expect(queued.map((q) => q.label)).toEqual(['Order for T1', 'Dish ready']);

    // Still offline: nothing is lost.
    expect(await flush('st_cashier')).toEqual({ sent: 0, failed: [] });
    expect(await listQueued()).toHaveLength(2);

    online = true;
    // A different person is signed in by the time the tablet reconnects.
    expect(await flush('st_cashier')).toEqual({ sent: 2, failed: [] });
    expect(calls.map((c) => [c.url.replace(/^.*\/v1/, ''), c.auth, c.key])).toEqual([
      ['/orders', 'Bearer st_waiter', queued[0]!.key],
      ['/order-items/x/status', 'Bearer st_waiter', queued[1]!.key],
    ]);
    expect(await listQueued()).toEqual([]);
    expect(states.at(-1)).toEqual({ pending: 0, rejected: 0, sent: 2 });
    off();
  });

  it('keeps changes the server refused so staff can see why', async () => {
    const { flush, listQueued, listRejected, send, dismissRejected } = await import('./outbox');
    await send('st_a', '/orders/1/items', { method: 'PATCH', body: {}, label: 'Add 2 × Chai' });
    await send('st_a', '/orders', { method: 'POST', body: {}, label: 'Order for T4' });
    online = true;
    respond = (call) =>
      call.url.endsWith('/orders/1/items')
        ? new Response(JSON.stringify({ error: { code: 'order_closed', message: 'This order is cancelled and can no longer be edited' } }), { status: 409, headers: { 'content-type': 'application/json' } })
        : new Response(JSON.stringify({ ok: true }), { status: 201, headers: { 'content-type': 'application/json' } });
    const r = await flush('st_a');
    expect(r.sent).toBe(1);
    expect(r.failed).toEqual([{ label: 'Add 2 × Chai', message: 'This order is cancelled and can no longer be edited' }]);
    expect(await listQueued()).toEqual([]);
    const rejected = await listRejected();
    expect(rejected.map((x) => [x.label, x.message])).toEqual([['Add 2 × Chai', 'This order is cancelled and can no longer be edited']]);
    await dismissRejected(rejected[0]!.key);
    expect(await listRejected()).toEqual([]);
  });

  it('never queues an action that carried a manager approval', async () => {
    const { listQueued, send } = await import('./outbox');
    await expect(send('st_a', '/bills/1/void', { method: 'POST', body: {}, label: 'Void bill', approvalToken: 'ap_x' })).rejects.toThrow('No connection');
    expect(await listQueued()).toEqual([]);
  });

  it('remembers for a day what was sent after reconnecting, so counts can be checked', async () => {
    const { flush, listSent, send } = await import('./outbox');
    await send('st_a', '/orders', { method: 'POST', body: {}, label: 'Order for T7' });
    online = true;
    respond = () => new Response(JSON.stringify({ ok: true }), { status: 201, headers: { 'content-type': 'application/json' } });
    await flush('st_a');
    expect((await listSent())[0]).toMatchObject({ label: 'Order for T7', sentAt: expect.any(Number) });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 25 * 3_600_000);
    expect((await listSent()).map((x) => x.label)).not.toContain('Order for T7');
    vi.useRealTimers();
  });

  it('lets staff discard a queued change', async () => {
    const { discard, listQueued, send } = await import('./outbox');
    await send('st_a', '/orders', { method: 'POST', body: {}, label: 'Wrong table' });
    const [q] = await listQueued();
    await discard(q!.key);
    expect(await listQueued()).toEqual([]);
  });
});

// The hub's LAN server. Staff devices switch to it when the internet is down; it answers the
// subset of /v1 the POS, waiter, kitchen and bill screens need, pushes live events over
// Socket.IO like the cloud, and proxies everything else to the staff web app running beside it.

import { createServer, request as httpRequest, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { connect, type Socket as NetSocket } from 'node:net';
import { Server as IoServer } from 'socket.io';
import { z, ZodError } from 'zod';
import { ITEM_STATUSES, ORDER_STATUSES, ORDER_TYPES, PAYMENT_METHODS } from '@dineos/shared/enums';
import type { OutletEvent } from '@dineos/shared/events';
import { HubError, offlineUnsupported, type HubEngine, type HubUser } from './engine';

type Handler = (c: { user: HubUser; params: Record<string, string>; query: URLSearchParams; body: unknown }) => unknown;
interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
  status?: number;
}

const uuid = z.uuid();
const line = z.object({
  item_id: uuid,
  qty: z.number().int().min(1).max(99),
  modifier_ids: z.array(uuid).max(20).default([]),
  note: z.string().max(200).nullable().optional(),
  seat_no: z.number().int().min(1).max(50).nullable().optional(),
});

export interface HubServerOptions {
  engine: HubEngine;
  /** Staff web app (Next.js) to proxy page requests to, e.g. http://127.0.0.1:3000 */
  webUpstream: string | null;
  status: () => Record<string, unknown>;
  /** Writes the state to disk now. */
  persist: () => void;
  log: (msg: string) => void;
}

export class HubServer {
  readonly http: HttpServer;
  readonly io: IoServer;
  private readonly routes: Route[] = [];

  constructor(private readonly opts: HubServerOptions) {
    this.http = createServer((req, res) => void this.handle(req, res));
    this.io = new IoServer(this.http, { cors: { origin: true }, serveClient: false, destroyUpgrade: false });
    const staff = this.io.of('/staff');
    staff.use((socket, next) => {
      const token = socket.handshake.auth?.token;
      const user = typeof token === 'string' ? opts.engine.authenticate(token) : null;
      if (!user) return next(new Error('unauthorized'));
      socket.data.user = user;
      next();
    });
    staff.on('connection', (socket) => {
      void socket.join('outlet');
      socket.emit('ready', { outlets: opts.engine.state.snapshot ? [opts.engine.outletId] : [] });
    });
    this.define();
    // WebSockets other than Socket.IO (e.g. the web app's dev reload channel) go to the web app.
    this.http.on('upgrade', (req: IncomingMessage, socket: NetSocket, head: Buffer) => {
      if (req.url?.startsWith('/socket.io/')) return;
      this.proxyUpgrade(req, socket, head);
    });
  }

  private proxyUpgrade(req: IncomingMessage, socket: NetSocket, head: Buffer): void {
    if (!this.opts.webUpstream) return void socket.destroy();
    const target = new URL(this.opts.webUpstream);
    const upstream = connect(Number(target.port || 80), target.hostname, () => {
      const headers = Object.entries({ ...req.headers, host: target.host })
        .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
        .join('\r\n');
      upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${headers}\r\n\r\n`);
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  }

  broadcast(event: OutletEvent): void {
    this.io.of('/staff').to('outlet').emit('event', event);
  }

  listen(port: number, host = '0.0.0.0'): Promise<number> {
    return new Promise((resolve) => {
      this.http.listen(port, host, () => {
        const address = this.http.address();
        resolve(typeof address === 'object' && address ? address.port : port);
      });
    });
  }

  async close(): Promise<void> {
    this.io.close();
    await new Promise<void>((r) => this.http.close(() => r()));
  }

  private on(method: string, path: string, handler: Handler, status = 200): void {
    const keys: string[] = [];
    const pattern = new RegExp(`^${path.replace(/:(\w+)/g, (_m, k: string) => (keys.push(k), '([^/]+)'))}$`);
    this.routes.push({ method, pattern, keys, handler, status });
  }

  private define(): void {
    const e = this.opts.engine;
    const q = (query: URLSearchParams, k: string) => query.get(k) ?? undefined;

    this.on('GET', '/v1/auth/me', ({ user }) => e.me(user));
    this.on('POST', '/v1/auth/logout', () => undefined, 204);
    this.on('GET', '/v1/outlets/:id', ({ params }) => e.outlet(params.id!));
    this.on('GET', '/v1/menu', ({ query }) => e.menu(q(query, 'outlet_id') ?? ''));
    this.on('GET', '/v1/events', ({ query }) => e.events(Number(q(query, 'since') ?? 0)));

    this.on('GET', '/v1/tables', ({ query }) => e.tables(q(query, 'outlet_id') ?? ''));
    this.on('POST', '/v1/tables/:id/seat', ({ user, params, body }) =>
      e.seatTable(user, params.id!, z.object({ guest_count: z.number().int().min(1).max(100).optional(), waiter_id: uuid.nullable().optional() }).parse(body ?? {})),
    );
    this.on('POST', '/v1/tables/:id/clean', ({ user, params }) => e.cleanTable(user, params.id!));
    this.on('POST', '/v1/tables/:id/release', ({ user, params }) => e.releaseTable(user, params.id!));
    this.on('GET', '/v1/service-requests', () => []);

    this.on('GET', '/v1/orders', ({ query }) =>
      e.listOrders({
        outlet_id: q(query, 'outlet_id') ?? '',
        status: q(query, 'status'),
        table_session_id: q(query, 'table_session_id'),
        since: q(query, 'since'),
        limit: Math.min(Number(q(query, 'limit') ?? 100), 500),
      }),
    );
    this.on('GET', '/v1/orders/:id', ({ params }) => e.getOrder(params.id!));
    this.on(
      'POST',
      '/v1/orders',
      ({ user, body }) =>
        e.createOrder(
          user,
          z
            .object({
              outlet_id: uuid,
              type: z.enum(ORDER_TYPES),
              source: z.enum(['waiter', 'pos']).default('pos'),
              table_id: uuid.optional(),
              lines: z.array(line).min(1).max(100),
              note: z.string().max(300).nullable().optional(),
              customer_name: z.string().max(80).nullable().optional(),
              customer_phone: z.string().max(20).nullable().optional(),
              guest_count: z.number().int().min(1).max(100).optional(),
            })
            .parse(body),
        ),
      201,
    );
    this.on('PATCH', '/v1/orders/:id/status', ({ user, params, body }) => {
      const b = z.object({ status: z.enum(ORDER_STATUSES), reason: z.string().max(300).nullable().optional() }).parse(body);
      return e.transitionOrder(user, params.id!, b.status, b.reason);
    });
    this.on('PATCH', '/v1/orders/:id/items', ({ user, params, body }) =>
      e.editItems(
        user,
        params.id!,
        z
          .object({
            add: z.array(line).max(50).optional(),
            cancel: z.array(z.object({ order_item_id: uuid, reason: z.string().min(1).max(200) })).max(100).optional(),
            set_qty: z.array(z.object({ order_item_id: uuid, qty: z.number().int().min(1).max(99) })).max(100).optional(),
          })
          .parse(body),
      ),
    );
    this.on('PATCH', '/v1/order-items/:id/status', ({ user, params, body }) => e.setItemStatus(user, params.id!, z.object({ status: z.enum(ITEM_STATUSES) }).parse(body).status));
    this.on('POST', '/v1/orders/:id/reprint-kot', ({ user, params, body }) => e.reprintKot(user, params.id!, z.object({ station: z.string().max(30).optional() }).parse(body ?? {}).station));
    this.on('GET', '/v1/kds', ({ query }) => e.kds(q(query, 'outlet_id') ?? '', q(query, 'station') || undefined));

    this.on('GET', '/v1/bills', ({ query }) =>
      e.listBills({ outlet_id: q(query, 'outlet_id') ?? '', status: q(query, 'status'), table_session_id: q(query, 'table_session_id'), limit: Number(q(query, 'limit') ?? 100) }),
    );
    this.on('POST', '/v1/bills', ({ user, body }) => e.createBill(user, z.object({ table_session_id: uuid.nullable().optional(), order_id: uuid.nullable().optional() }).parse(body)), 201);
    this.on('GET', '/v1/bills/:id', ({ params }) => e.getBill(params.id!));
    this.on('PATCH', '/v1/bills/:id', ({ user, params, body }) => e.updateBill(user, params.id!, z.record(z.string(), z.unknown()).parse(body)));
    this.on('DELETE', '/v1/bills/:id', ({ user, params }) => e.discardDraft(user, params.id!), 204);
    this.on('GET', '/v1/bills/:id/invoice', ({ params }) => e.invoice(params.id!));
    this.on('POST', '/v1/bills/:id/finalise', ({ user, params }) => e.finalise(user, params.id!));
    this.on('POST', '/v1/bills/:id/print', ({ user, params }) => e.reprintBill(user, params.id!));
    this.on(
      'POST',
      '/v1/bills/:id/payments',
      ({ user, params, body }) =>
        e.recordPayment(
          user,
          params.id!,
          z
            .object({
              method: z.enum(PAYMENT_METHODS),
              amount_paise: z.number().int().min(1).max(100_000_000),
              tendered_paise: z.number().int().min(0).max(100_000_000).nullable().optional(),
              reference: z.string().max(80).nullable().optional(),
            })
            .parse(body),
        ),
      201,
    );
  }

  private send(res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}): void {
    if (status === 204 || body === undefined) {
      res.writeHead(status === 200 && body === undefined ? 204 : status, headers);
      res.end();
      return;
    }
    const json = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
    res.end(json);
  }

  private error(res: ServerResponse, status: number, code: string, message: string, details?: unknown): void {
    this.send(res, status, { error: { code, message, ...(details === undefined ? {} : { details }) } });
  }

  private async readBody(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > 1_000_000) throw new HubError(413, 'too_large', 'Request too large');
      chunks.push(chunk as Buffer);
    }
    if (!chunks.length) return undefined;
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new HubError(400, 'invalid_json', 'Body is not valid JSON');
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://hub.local');
    const path = url.pathname;
    if (path.startsWith('/socket.io/')) return; // handled by Socket.IO
    if (path === '/hub/status' || path === '/healthz') {
      return this.send(res, 200, this.opts.status(), { 'access-control-allow-origin': '*', 'cache-control': 'no-store' });
    }
    if (path === '/offline') return this.handoffPage(res);
    if (!path.startsWith('/v1/')) return this.proxy(req, res);

    // A write that fails halfway leaves nothing behind: it runs against a copy it can roll back to.
    const backup = req.method === 'GET' ? null : structuredClone(this.opts.engine.state);
    try {
      const route = this.routes.find((r) => r.method === req.method && r.pattern.test(path));
      if (!route) throw offlineUnsupported();
      const auth = req.headers.authorization;
      const user = auth?.startsWith('Bearer ') ? this.opts.engine.authenticate(auth.slice(7)) : null;
      if (!user) return this.error(res, 401, 'unauthorized', 'Sign in again on the cloud app before the internet goes down');

      // Same Idempotency-Key semantics as the cloud: a replayed request gets the first answer.
      const key = req.method !== 'GET' ? req.headers['idempotency-key'] : undefined;
      const store = this.opts.engine.state.idempotency;
      const idemKey = typeof key === 'string' && key ? `${user.id}:${key}` : null;
      if (idemKey && store[idemKey]) return this.send(res, store[idemKey].status, store[idemKey].body);

      const match = route.pattern.exec(path)!;
      const params = Object.fromEntries(route.keys.map((k, i) => [k, decodeURIComponent(match[i + 1]!)]));
      const body = req.method === 'GET' ? undefined : await this.readBody(req);
      const result = route.handler({ user, params, query: url.searchParams, body });
      const status = result === undefined ? 204 : (route.status ?? 200);
      if (idemKey) {
        store[idemKey] = { at: Date.now(), status, body: result };
        const cutoff = Date.now() - 2 * 86_400_000;
        for (const [k, v] of Object.entries(store)) if (v.at < cutoff) delete store[k];
        this.opts.persist();
      }
      this.send(res, status, result);
    } catch (err) {
      if (backup) this.opts.engine.state = backup;
      if (err instanceof HubError) return this.error(res, err.status, err.code, err.message, err.details);
      if (err instanceof ZodError) return this.error(res, 400, 'validation_error', err.issues[0]?.message ?? 'Invalid request', err.issues);
      this.opts.log(`error on ${req.method} ${path}: ${(err as Error).stack ?? err}`);
      this.error(res, 500, 'internal', 'Something went wrong on the outlet hub');
    }
  }

  /** Pages, scripts and images of the staff app come from the web app running beside the hub. */
  private proxy(req: IncomingMessage, res: ServerResponse): void {
    const upstream = this.opts.webUpstream;
    if (!upstream) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('The staff app is not installed on this hub.');
      return;
    }
    const target = new URL(req.url ?? '/', upstream);
    const out = httpRequest(target, { method: req.method, headers: { ...req.headers, host: target.host } }, (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    });
    out.on('error', () => {
      if (res.headersSent) return res.destroy();
      res.writeHead(502, { 'content-type': 'text/plain' });
      res.end('The staff app on this hub is not running.');
    });
    req.pipe(out);
  }

  /**
   * The cloud app sends staff here when the internet drops: http://<hub>/offline#token=...
   * The fragment never leaves the browser. This page keeps the session for the hub's address,
   * hands over changes still waiting on the device, and opens the same screen on the hub.
   */
  private handoffPage(res: ServerResponse): void {
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Switching to offline mode</title>
<style>body{font-family:system-ui,sans-serif;background:#faf8f5;color:#1c1917;display:grid;place-items:center;min-height:100vh;margin:0}main{max-width:22rem;padding:1.5rem;text-align:center}p{color:#57534e}</style></head>
<body><main><h1>Offline mode</h1><p id="m">Connecting this device to the outlet hub…</p></main>
<script>
(async () => {
  const msg = (t) => (document.getElementById('m').textContent = t);
  const p = new URLSearchParams(location.hash.slice(1));
  history.replaceState(null, '', location.pathname);
  const token = p.get('token');
  if (!token) return msg('Open this from DineOS on a signed-in device.');
  const set = (k, v) => localStorage.setItem(k, JSON.stringify(v));
  set('dineos.staff.token', token);
  if (p.get('outlet')) set('dineos.staff.outlet', p.get('outlet'));
  set('dineos.api_base', location.origin);
  for (const it of JSON.parse(p.get('outbox') || '[]')) {
    try {
      await fetch('/v1' + it.path, { method: it.method, headers: { authorization: 'Bearer ' + (it.token || token), 'idempotency-key': it.key, 'content-type': 'application/json' }, body: it.body === undefined ? undefined : JSON.stringify(it.body) });
    } catch {}
  }
  const to = p.get('to') || '/app/pos';
  location.replace(to.startsWith('/app') ? to : '/app/pos');
})();
</script></body></html>`;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(html);
  }
}

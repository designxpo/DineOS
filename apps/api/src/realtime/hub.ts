import type { FastifyInstance } from 'fastify';
import { Server, type Namespace } from 'socket.io';
import { roomName, SOCKET_NAMESPACES, type Channel } from '@dineos/shared/events';
import type { AppContext } from '../context';
import { accessibleOutletIds, authenticate, type Auth } from '../lib/auth';

declare module 'socket.io' {
  interface SocketData {
    auth: Auth;
  }
}

/**
 * Socket.IO is push-only: every mutation goes through REST (idempotent, testable), and committed
 * outlet events are forwarded here. Clients that reconnect call GET /v1/events?since=<seq>.
 */
export async function attachRealtime(app: FastifyInstance, ctx: AppContext): Promise<Server> {
  const io = new Server(app.server, {
    cors: { origin: ctx.config.corsOrigins, credentials: false },
    serveClient: false,
    pingInterval: 10_000,
    pingTimeout: 8_000,
  });

  if (ctx.config.REDIS_URL) {
    const [{ createAdapter }, { Redis }] = await Promise.all([import('@socket.io/redis-adapter'), import('ioredis')]);
    const pub = new Redis(ctx.config.REDIS_URL);
    const sub = pub.duplicate();
    io.adapter(createAdapter(pub, sub));
    app.addHook('onClose', async () => {
      await Promise.allSettled([pub.quit(), sub.quit()]);
    });
  }

  const staff = io.of(SOCKET_NAMESPACES.staff);
  const guest = io.of(SOCKET_NAMESPACES.guest);
  const device = io.of(SOCKET_NAMESPACES.device);

  function guard(ns: Namespace, kind: Auth['kind']) {
    ns.use(async (socket, next) => {
      try {
        const token = socket.handshake.auth?.token;
        const auth = typeof token === 'string' ? await authenticate(ctx, token) : null;
        if (!auth || auth.kind !== kind) return next(new Error('unauthorized'));
        socket.data.auth = auth;
        next();
      } catch {
        next(new Error('unauthorized'));
      }
    });
  }
  guard(staff, 'staff');
  guard(guest, 'guest');
  guard(device, 'device');

  staff.on('connection', async (socket) => {
    const auth = socket.data.auth;
    if (auth.kind !== 'staff') return;
    const outlets = await ctx.tx(auth.tenantId, (tx) => accessibleOutletIds(tx, auth));
    await socket.join(outlets.map((o) => roomName(auth.tenantId, o, 'outlet')));
    socket.emit('ready', { outlets });
  });

  guest.on('connection', async (socket) => {
    const auth = socket.data.auth;
    if (auth.kind !== 'guest') return;
    const session = await ctx.tx(auth.tenantId, (tx) =>
      tx.db.selectFrom('table_sessions').select('status').where('id', '=', auth.sessionId).executeTakeFirst(),
    );
    if (!session || session.status === 'closed') {
      socket.emit('event', { type: 'session.closed', payload: { session_id: auth.sessionId } });
      socket.disconnect(true);
      return;
    }
    await socket.join([
      roomName(auth.tenantId, auth.outletId, `session:${auth.sessionId}`),
      roomName(auth.tenantId, auth.outletId, 'menu'),
    ]);
    socket.emit('ready', { session_id: auth.sessionId });
  });

  device.on('connection', async (socket) => {
    const auth = socket.data.auth;
    if (auth.kind !== 'device') return;
    await socket.join(roomName(auth.tenantId, auth.outletId, 'print'));
    await ctx.tx(auth.tenantId, (tx) =>
      tx.db.updateTable('devices').set({ last_seen_at: new Date() }).where('id', '=', auth.deviceId).execute(),
    );
    socket.emit('ready', { outlet_id: auth.outletId });
  });

  function namespaceFor(channel: Channel): Namespace {
    if (channel === 'outlet' || channel.startsWith('station:')) return staff;
    if (channel === 'print') return device;
    return guest;
  }

  const unsubscribe = ctx.bus.subscribe((tenantId, events) => {
    for (const event of events) {
      for (const channel of event.channels) {
        namespaceFor(channel).to(roomName(tenantId, event.outlet_id, channel)).emit('event', event);
      }
    }
  });

  // Disconnect sockets before Fastify closes the HTTP server; io.close() would close it twice.
  app.addHook('preClose', async () => {
    unsubscribe();
    io.disconnectSockets(true);
    io.engine.close();
  });

  return io;
}

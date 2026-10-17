import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import { sql } from 'kysely';
import { loadConfig, type Config } from './config';
import { createContext, type AppContext } from './context';
import { bearerToken, registerAuth } from './lib/auth';
import { registerErrorHandler } from './lib/errors';
import { registerIdempotency } from './lib/idempotency';
import { registerSecurityHeaders } from './lib/security-headers';
import { registerFileRoute } from './lib/storage';
import { modules } from './modules';
import { registerPushAlerts } from './modules/push/alerts';

export interface BuildOptions {
  config?: Config;
  logger?: boolean;
  /** Requests per minute per caller. Tests raise it. */
  rateLimitMax?: number;
  /** Where rate-limit counts live; by default Redis when REDIS_URL is set. Tests pass their own. */
  rateLimitRedis?: Redis;
}

export interface RouteEntry {
  method: string;
  url: string;
}

export async function buildApp(
  opts: BuildOptions = {},
): Promise<{ app: FastifyInstance; ctx: AppContext; routes: RouteEntry[] }> {
  const config = opts.config ?? loadConfig();
  const app = Fastify({
    logger: opts.logger === false ? false : { level: config.LOG_LEVEL },
    trustProxy: true,
    bodyLimit: 1024 * 1024,
  });
  const ctx = createContext(config, app.log);
  // Recorded so the cross-tenant test suite can probe every endpoint, including future ones.
  const routes: RouteEntry[] = [];
  app.addHook('onRoute', (r) => {
    for (const method of [r.method].flat()) if (method !== 'HEAD') routes.push({ method, url: r.url });
  });

  registerErrorHandler(app);
  registerSecurityHeaders(app, config);
  await app.register(cors, {
    origin: config.corsOrigins,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
    allowedHeaders: ['authorization', 'content-type', 'idempotency-key', 'x-approval-token'],
    exposedHeaders: ['idempotent-replayed'],
  });
  await app.register(multipart, { limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
  // Several API servers run at once (Vercel starts more under load), so limits are counted in Redis
  // when there is one; otherwise each server's memory. If Redis is unreachable, requests go through
  // rather than locking restaurants out.
  let limitRedis = opts.rateLimitRedis;
  if (!limitRedis && config.REDIS_URL) {
    const { Redis } = await import('ioredis');
    const own = new Redis(config.REDIS_URL, { enableOfflineQueue: false, maxRetriesPerRequest: 1, commandTimeout: 1000 });
    own.on('error', (err) => app.log.warn({ err }, 'rate-limit redis unavailable'));
    app.addHook('onClose', async () => {
      own.disconnect();
    });
    limitRedis = own;
  }
  await app.register(rateLimit, {
    max: opts.rateLimitMax ?? config.RATE_LIMIT_MAX,
    timeWindow: '1 minute',
    keyGenerator: (req) => bearerToken(req) ?? req.ip,
    ...(limitRedis ? { redis: limitRedis, nameSpace: 'dineos-rate-', skipOnError: true } : {}),
  });

  registerAuth(app, ctx);
  registerIdempotency(app, ctx);
  registerFileRoute(app, config);

  app.get('/healthz', async () => {
    await sql`select 1`.execute(ctx.db);
    return { ok: true };
  });

  for (const [name, plugin] of Object.entries(modules)) {
    await app.register(plugin(ctx), { prefix: '/v1' });
    app.log.debug(`module ${name} registered`);
  }

  const stopPushAlerts = registerPushAlerts(ctx);
  app.addHook('onClose', async () => {
    stopPushAlerts();
    await ctx.close();
  });

  return { app, ctx, routes };
}

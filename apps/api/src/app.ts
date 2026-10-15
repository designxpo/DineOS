import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { loadConfig, type Config } from './config';
import { createContext, type AppContext } from './context';
import { bearerToken, registerAuth } from './lib/auth';
import { registerErrorHandler } from './lib/errors';
import { registerIdempotency } from './lib/idempotency';
import { registerFileRoute } from './lib/storage';
import { modules } from './modules';

export interface BuildOptions {
  config?: Config;
  logger?: boolean;
  /** Requests per minute per caller. Tests raise it. */
  rateLimitMax?: number;
}

export async function buildApp(opts: BuildOptions = {}): Promise<{ app: FastifyInstance; ctx: AppContext }> {
  const config = opts.config ?? loadConfig();
  const app = Fastify({
    logger: opts.logger === false ? false : { level: config.LOG_LEVEL },
    trustProxy: true,
    bodyLimit: 1024 * 1024,
  });
  const ctx = createContext(config, app.log);

  registerErrorHandler(app);
  await app.register(cors, {
    origin: config.corsOrigins,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
    allowedHeaders: ['authorization', 'content-type', 'idempotency-key', 'x-approval-token'],
    exposedHeaders: ['idempotent-replayed'],
  });
  await app.register(multipart, { limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
  await app.register(rateLimit, {
    max: opts.rateLimitMax ?? 600,
    timeWindow: '1 minute',
    keyGenerator: (req) => bearerToken(req) ?? req.ip,
  });

  registerAuth(app, ctx);
  registerIdempotency(app, ctx);
  registerFileRoute(app, config);

  app.get('/healthz', async () => {
    await sql`select 1`.execute(ctx.db);
    return { ok: true };
  });

  for (const [name, routes] of Object.entries(modules)) {
    await app.register(routes(ctx), { prefix: '/v1' });
    app.log.debug(`module ${name} registered`);
  }

  app.addHook('onClose', async () => {
    await ctx.close();
  });

  return { app, ctx };
}

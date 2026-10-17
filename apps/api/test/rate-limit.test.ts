// Rate limits must hold across API servers: Vercel runs several copies of the API at once, and a
// limit kept in each copy's memory lets a password guesser spread attempts over them.

import { Redis } from 'ioredis';
import RedisMock from 'ioredis-mock';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { testConfig } from './env';

const apps: Awaited<ReturnType<typeof buildApp>>['app'][] = [];
afterAll(async () => {
  await Promise.all(apps.map((a) => a.close()));
});

async function server(rateLimitRedis: Redis) {
  const { app } = await buildApp({ config: testConfig(), logger: false, rateLimitRedis });
  apps.push(app);
  return app;
}

const wrongLogin = { tenant_slug: 'no-such-restaurant', login: 'someone@example.com', password: 'guess-guess-guess' };

describe('rate limits', () => {
  it('counts sign-in attempts across API servers that share Redis', async () => {
    const shared = new RedisMock() as unknown as Redis;
    const [a, b] = [await server(shared), await server(shared)];
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await (i % 2 ? b : a).inject({ method: 'POST', url: '/v1/auth/login', payload: wrongLogin });
      codes.push(res.statusCode);
    }
    // Sign-in allows 10 tries a minute, whichever server they land on.
    expect(codes.slice(0, 10).every((c) => c !== 429)).toBe(true);
    expect(codes[10]).toBe(429);
  });

  it('keeps serving when Redis is down rather than locking the restaurant out', async () => {
    const down = new Redis({ port: 1, lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 0, retryStrategy: () => null });
    const app = await server(down);
    const res = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: wrongLogin });
    expect(res.statusCode).not.toBe(429);
    expect(res.statusCode).toBeLessThan(500);
    down.disconnect();
  });
});

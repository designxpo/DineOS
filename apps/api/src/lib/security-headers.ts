import type { FastifyInstance } from 'fastify';
import type { Config } from '../config';

/**
 * Security headers on every API response. Caddy adds some in front of a self-hosted server, but
 * on Vercel and other hosts nothing does. The API serves JSON and images, never pages, so the
 * policy is strict: no response can run script, be framed or leak a referrer. A route that sets
 * its own value (image files allow cross-origin embedding) keeps it.
 */
export function registerSecurityHeaders(app: FastifyInstance, config: Pick<Config, 'NODE_ENV'>): void {
  const headers: [string, string][] = [
    ['x-content-type-options', 'nosniff'],
    ['x-frame-options', 'DENY'],
    ['content-security-policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"],
    ['referrer-policy', 'no-referrer'],
    ['cross-origin-opener-policy', 'same-origin'],
    // Same site, not same origin: the web app may live on a sibling subdomain of the API.
    ['cross-origin-resource-policy', 'same-site'],
    ['permissions-policy', 'camera=(), microphone=(), geolocation=()'],
  ];
  if (config.NODE_ENV === 'production') headers.push(['strict-transport-security', 'max-age=31536000; includeSubDomains']);
  app.addHook('onSend', async (_req, reply, payload) => {
    for (const [name, value] of headers) if (!reply.hasHeader(name)) reply.header(name, value);
    return payload;
  });
}

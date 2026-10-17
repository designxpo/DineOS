import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

// Monorepo root: standalone output must include the hoisted node_modules and @dineos/shared.
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

// On Vercel the API shares the site's domain (vercel.json routes /v1 and /socket.io to it), so the
// default is the production domain, or the preview's own address. Elsewhere, set it explicitly.
const vercelHost = process.env.VERCEL_ENV === 'production' ? process.env.VERCEL_PROJECT_PRODUCTION_URL : process.env.VERCEL_URL;
const apiUrl = process.env.NEXT_PUBLIC_API_URL || (vercelHost ? `https://${vercelHost}` : 'http://localhost:4000');

const config: NextConfig = {
  env: { NEXT_PUBLIC_API_URL: apiUrl },
  transpilePackages: ['@dineos/shared'],
  output: 'standalone',
  outputFileTracingRoot: repoRoot,
  turbopack: { root: repoRoot },
  poweredByHeader: false,
  reactStrictMode: true,
  images: { unoptimized: true },
  async headers() {
    // Everything is served from our own origins; no third-party scripts, fonts or APIs.
    const csp = [
      "default-src 'self'",
      `connect-src 'self' ${apiUrl} ${apiUrl.replace(/^http/, 'ws')}`,
      `img-src 'self' data: blob: ${apiUrl} https:`,
      "style-src 'self' 'unsafe-inline'",
      "script-src 'self' 'unsafe-inline'" + (process.env.NODE_ENV === 'development' ? " 'unsafe-eval'" : ''),
      "font-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
    ].join('; ');
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: csp },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
      {
        // Print agent installers and download: plain text so `irm | iex` and `curl | sh` run them,
        // and never cached so a reinstall gets the current agent.
        source: '/agent/:file*',
        headers: [
          { key: 'Content-Type', value: 'text/plain; charset=utf-8' },
          { key: 'Cache-Control', value: 'no-cache' },
        ],
      },
    ];
  },
};

export default config;

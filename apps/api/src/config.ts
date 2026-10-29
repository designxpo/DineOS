import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const here = dirname(fileURLToPath(import.meta.url));
export const API_ROOT = resolve(here, '..');
export const REPO_ROOT = resolve(API_ROOT, '../..');

/** Loads the repo-root .env once. Real environment variables win over the file. */
/**
 * Reads the repo's .env, or another file named by MEZMITRA_ENV_FILE (e.g. .env.supabase.local).
 * DINEOS_ENV_FILE, the product's earlier name for it, still works.
 */
export function loadEnvFile(): void {
  const named = process.env.MEZMITRA_ENV_FILE ?? process.env.DINEOS_ENV_FILE;
  const file = resolve(REPO_ROOT, named ?? '.env');
  if (existsSync(file)) process.loadEnvFile(file);
  else if (named) throw new Error(`MEZMITRA_ENV_FILE ${file} not found`);
}

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(4000),
  LOG_LEVEL: z.string().default('info'),
  DATABASE_URL: z.string().min(1),
  DATABASE_ADMIN_URL: z.string().min(1),
  DATABASE_OWNER_URL: z.string().optional(),
  TOKEN_SECRET: z.string().min(32, 'TOKEN_SECRET must be at least 32 characters'),
  GUEST_URL_TEMPLATE: z.string().default('http://localhost:3000/t/{token}'),
  CORS_ORIGINS: z.string().default('http://localhost:3000'),
  REDIS_URL: z.string().optional(),
  /** Lets Vercel Cron (or any scheduler) run housekeeping through GET /v1/internal/maintenance. */
  CRON_SECRET: z.string().min(16).optional(),
  /** Joins per minute per IP (guests on one restaurant Wi-Fi share an IP). Raised for load tests. */
  GUEST_JOIN_RATE_LIMIT: z.coerce.number().int().min(1).default(120),
  /** Requests per minute per token or IP for everything else. */
  RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(600),
  STORAGE_DRIVER: z.enum(['fs', 's3']).default('fs'),
  STORAGE_DIR: z.string().default('./storage'),
  PUBLIC_API_URL: z.string().default('http://localhost:4000'),
  S3_ENDPOINT: z.string().optional(),
  /** Supabase Storage checks it: use the project's region, e.g. ap-southeast-2. */
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY: z.string().optional(),
  S3_SECRET_KEY: z.string().optional(),
  S3_PUBLIC_URL: z.string().optional(),
  /** MSG91 auth key and DLT OTP template: with both set, loyalty asks guests for a code by SMS. */
  MSG91_AUTH_KEY: z.string().optional(),
  MSG91_OTP_TEMPLATE_ID: z.string().optional(),
  /** Web Push (VAPID) keys: with both set, staff can turn on alerts on their phones. */
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  /** Contact the push services can reach about abuse, e.g. mailto:ops@yourcompany.in. */
  // Set VAPID_SUBJECT to your support address: push services contact it about problems.
  VAPID_SUBJECT: z.string().default('mailto:ops@example.com'),
  /**
   * Encrypts the keys other products give us (Talko AI's API key). 32+ random characters. Changing
   * it breaks every existing link: owners then reconnect.
   */
  INTEGRATION_ENC_KEY: z.string().min(32, 'INTEGRATION_ENC_KEY must be at least 32 characters').optional(),
  /** Talko AI's API, which receives bill, booking and order events, e.g. https://app.talkoai.com. */
  TALKO_API_URL: z.url().optional(),
  /**
   * Razorpay, for restaurants paying for a plan upgrade online (our own account, not the outlets').
   * Key id and secret from Dashboard → API keys; the webhook secret from the webhook pointed at
   * /v1/plan/razorpay/webhook with payment.captured and order.paid. Without the key, upgrades ask
   * the owner to contact support.
   */
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
  /** Tests point this at a fake. */
  RAZORPAY_API_URL: z.url().default('https://api.razorpay.com/v1'),
});

export type Config = z.infer<typeof schema> & { corsOrigins: string[]; storageDir: string };

export function loadConfig(overrides: Record<string, string | undefined> = {}): Config {
  loadEnvFile();
  const env = { ...process.env, ...overrides };
  for (const key of Object.keys(env)) if (env[key] === '') delete env[key];
  // The Vercel Marketplace Redis integration may name its connection string KV_URL.
  env.REDIS_URL ??= env.KV_URL;
  const parsed = schema.parse(env);
  return {
    ...parsed,
    corsOrigins: parsed.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
    storageDir: resolve(API_ROOT, parsed.STORAGE_DIR),
  };
}

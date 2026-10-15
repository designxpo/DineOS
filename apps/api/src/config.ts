import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const here = dirname(fileURLToPath(import.meta.url));
export const API_ROOT = resolve(here, '..');
export const REPO_ROOT = resolve(API_ROOT, '../..');

/** Loads the repo-root .env once. Real environment variables win over the file. */
/** Reads the repo's .env, or another file named by DINEOS_ENV_FILE (e.g. .env.supabase.local). */
export function loadEnvFile(): void {
  const file = resolve(REPO_ROOT, process.env.DINEOS_ENV_FILE ?? '.env');
  if (existsSync(file)) process.loadEnvFile(file);
  else if (process.env.DINEOS_ENV_FILE) throw new Error(`DINEOS_ENV_FILE ${file} not found`);
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
  /** Joins per minute per IP (guests on one restaurant Wi-Fi share an IP). Raised for load tests. */
  GUEST_JOIN_RATE_LIMIT: z.coerce.number().int().min(1).default(120),
  /** Requests per minute per token or IP for everything else. */
  RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(600),
  STORAGE_DRIVER: z.enum(['fs', 's3']).default('fs'),
  STORAGE_DIR: z.string().default('./storage'),
  PUBLIC_API_URL: z.string().default('http://localhost:4000'),
  S3_ENDPOINT: z.string().optional(),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY: z.string().optional(),
  S3_SECRET_KEY: z.string().optional(),
  S3_PUBLIC_URL: z.string().optional(),
});

export type Config = z.infer<typeof schema> & { corsOrigins: string[]; storageDir: string };

export function loadConfig(overrides: Record<string, string | undefined> = {}): Config {
  loadEnvFile();
  const env = { ...process.env, ...overrides };
  for (const key of Object.keys(env)) if (env[key] === '') delete env[key];
  const parsed = schema.parse(env);
  return {
    ...parsed,
    corsOrigins: parsed.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
    storageDir: resolve(API_ROOT, parsed.STORAGE_DIR),
  };
}

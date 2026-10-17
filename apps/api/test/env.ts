import { loadConfig, loadEnvFile, type Config } from '../src/config';

loadEnvFile();

function withDb(url: string | undefined, db: string, fallback: string): string {
  const u = new URL(url ?? fallback);
  u.pathname = `/${db}`;
  return u.toString();
}

export const TEST_DB = 'mezmitra_test';

export const testUrls = {
  owner: withDb(process.env.DATABASE_OWNER_URL, TEST_DB, 'postgres://localhost:5432/mezmitra_dev'),
  app: withDb(process.env.DATABASE_URL, TEST_DB, 'postgres://dineos_app:dineos_app_dev@localhost:5432/dineos_dev'),
  admin: withDb(process.env.DATABASE_ADMIN_URL, TEST_DB, 'postgres://dineos_admin:dineos_admin_dev@localhost:5432/dineos_dev'),
};

export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: testUrls.app,
    DATABASE_ADMIN_URL: testUrls.admin,
    DATABASE_OWNER_URL: testUrls.owner,
    TOKEN_SECRET: 'test-secret-test-secret-test-secret-0123456789',
    STORAGE_DIR: './storage-test',
    LOG_LEVEL: 'silent',
    REDIS_URL: '',
    ...overrides,
  });
}

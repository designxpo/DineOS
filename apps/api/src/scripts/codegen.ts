// Regenerates src/db/schema.ts from the migrated dev database. Run after adding a migration.
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { API_ROOT, loadEnvFile } from '../config';

loadEnvFile();

const url = process.env.DATABASE_OWNER_URL;
if (!url) throw new Error('DATABASE_OWNER_URL is not set');

execFileSync(
  'npx',
  [
    'kysely-codegen',
    '--dialect', 'postgres',
    '--url', url,
    '--out-file', resolve(API_ROOT, 'src/db/schema.ts'),
    '--date-parser', 'string',
    '--numeric-parser', 'number',
    '--exclude-pattern', 'schema_migrations',
    ...(process.argv.includes('--verify') ? ['--verify'] : []),
  ],
  { stdio: 'inherit', cwd: API_ROOT },
);

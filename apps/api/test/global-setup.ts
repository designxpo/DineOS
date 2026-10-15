import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from '../src/db/migrate';
import { testUrls } from './env';

/** Recreates dineos_test from scratch and applies every migration, once per test run. */
export default async function setup() {
  execFileSync('npx', ['tsx', resolve(dirname(fileURLToPath(import.meta.url)), '../src/scripts/db-setup.ts'), '--test'], { stdio: 'pipe' });
  await migrate(testUrls.owner, () => {});
}

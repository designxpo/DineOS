import { writeFile } from 'node:fs/promises';
import { defineConfig } from 'tsup';

// One bundle per entry point; @mezmitra/shared is inlined, npm dependencies stay external.
export default defineConfig({
  entry: {
    server: 'src/server.ts',
    migrate: 'src/scripts/migrate.ts',
    seed: 'src/scripts/seed.ts',
    'create-admin': 'src/scripts/create-admin.ts',
    'purge-tenant': 'src/scripts/purge-tenant.ts',
    maintenance: 'src/scripts/maintenance.ts',
  },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  splitting: true,
  noExternal: ['@mezmitra/shared'],
  // Vercel deploys dist/ as the function's root, away from apps/api/package.json, and would
  // otherwise load server.js as CommonJS.
  onSuccess: () => writeFile('dist/package.json', '{ "type": "module" }\n'),
});

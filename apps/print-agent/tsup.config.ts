import { defineConfig } from 'tsup';

// A single file the outlet PC can run with plain Node: `node dist/main.js`.
export default defineConfig({
  entry: ['src/main.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  clean: true,
  noExternal: ['@dineos/shared'],
  banner: { js: '#!/usr/bin/env node' },
});

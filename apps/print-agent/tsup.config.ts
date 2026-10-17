import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };
const define = { __AGENT_VERSION__: JSON.stringify(version) };

export default defineConfig([
  // For `node dist/main.js` inside this repo (dependencies from node_modules).
  {
    entry: ['src/main.ts'],
    format: ['esm'],
    target: 'node22',
    platform: 'node',
    clean: true,
    noExternal: ['@mezmitra/shared'],
    define,
    banner: { js: '#!/usr/bin/env node' },
  },
  // The download the installers fetch: one file with everything in it, run with plain Node 20+.
  // `npm run build:download` copies it to the web app (apps/web/public/agent).
  {
    entry: { 'mezmitra-agent': 'src/main.ts' },
    outDir: 'dist/download',
    outExtension: () => ({ js: '.mjs' }),
    format: ['esm'],
    target: 'node20',
    platform: 'node',
    noExternal: [/.*/],
    // Optional speed-ups of the WebSocket library, loaded only if present.
    external: ['bufferutil', 'utf-8-validate'],
    minify: true,
    define,
    // Bundled CommonJS dependencies call require().
    banner: { js: "#!/usr/bin/env node\nimport { createRequire as __mezmitraRequire } from 'node:module';\nconst require = __mezmitraRequire(import.meta.url);" },
  },
]);

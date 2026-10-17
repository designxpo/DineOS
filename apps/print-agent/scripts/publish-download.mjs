// Copies the bundled agent to the web app, which serves it to the installers, with its SHA-256
// beside it. The installers refuse a download that does not match.
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const out = new URL('../../web/public/agent/', import.meta.url);
mkdirSync(out, { recursive: true });
const file = new URL('dineos-agent.mjs', out);
copyFileSync(new URL('../dist/download/dineos-agent.mjs', import.meta.url), file);
const sum = createHash('sha256').update(readFileSync(file)).digest('hex');
writeFileSync(new URL('dineos-agent.mjs.sha256', out), `${sum}  dineos-agent.mjs\n`);
console.log(`published dineos-agent.mjs ${sum}`);

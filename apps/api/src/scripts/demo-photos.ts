// Puts a photo on every dish of the demo restaurant (Aurum Grand Hotel), so the QR menu can be
// shown the way guests see it. The photos and their credits are in ./demo-photos.
//   npm run demo:photos            (dishes that have no photo yet)
//   npm run demo:photos -- --force (replace every demo dish's photo)
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pino from 'pino';
import { loadConfig } from '../config';
import { createContext, type AppContext } from '../context';
import { bumpMenu } from '../modules/menu/service';

export const DEMO_SLUG = 'aurum-courtyard';
const DIR = join(dirname(fileURLToPath(import.meta.url)), 'demo-photos');

/** Every dish's photo file, by its name on the demo menu. */
const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** Attaches the demo photos to a tenant's dishes; returns how many dishes got one. */
export async function attachDemoPhotos(ctx: AppContext, tenantId: string, opts: { force?: boolean } = {}): Promise<number> {
  return ctx.tx(tenantId, async (tx) => {
    const items = await tx.db.selectFrom('menu_items').select(['id', 'name', 'outlet_id', 'photo_url']).where('deleted_at', 'is', null).execute();
    const outlets = new Set<string>();
    let done = 0;
    for (const item of items) {
      if (item.photo_url && !opts.force) continue;
      const file = join(DIR, `${slug(item.name)}.jpg`);
      const body = await readFile(file).catch(() => null);
      if (!body) continue;
      const url = await ctx.storage.put(`${tenantId}/menu/${item.id}-demo.jpg`, body, 'image/jpeg');
      await tx.db.updateTable('menu_items').set({ photo_url: url }).where('id', '=', item.id).execute();
      outlets.add(item.outlet_id);
      done++;
    }
    // Screens and guests' phones fetch the menu again.
    for (const outletId of outlets) await bumpMenu(tx, outletId);
    return done;
  });
}

async function main() {
  const ctx = createContext(loadConfig(), pino({ level: 'warn' }));
  try {
    const tenant = await ctx.adminDb.selectFrom('tenants').select('id').where('slug', '=', DEMO_SLUG).executeTakeFirst();
    if (!tenant) {
      console.log(`No demo restaurant "${DEMO_SLUG}" here. Run npm run db:seed first.`);
      return;
    }
    const n = await attachDemoPhotos(ctx, tenant.id, { force: process.argv.includes('--force') });
    console.log(`Photos added to ${n} dishes.`);
  } finally {
    await ctx.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

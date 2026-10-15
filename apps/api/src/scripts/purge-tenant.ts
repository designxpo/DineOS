// Permanently deletes every row a tenant owns (spec §12 data rights: delete on request).
// Deliberately CLI-only and slow to type:
//   npm run tenant:purge -w @dineos/api -- --slug the-courtyard --confirm the-courtyard
// Export first (GET /v1/tenant/export) if the restaurant wants a copy. Backups age out on their own schedule.
import { parseArgs } from 'node:util';
import { loadConfig } from '../config';
import { createDb } from '../db';
import { purgeTenant } from '../lib/purge';

const { values } = parseArgs({ options: { slug: { type: 'string' }, confirm: { type: 'string' } } });
if (!values.slug || values.confirm !== values.slug) {
  console.error('Usage: --slug <restaurant-code> --confirm <restaurant-code again>');
  process.exit(1);
}
const config = loadConfig();
const db = createDb(config.DATABASE_ADMIN_URL, 1);
const tenant = await db.selectFrom('tenants').select(['id', 'name', 'status']).where('slug', '=', values.slug).executeTakeFirst();
if (!tenant) {
  console.error(`No tenant with code ${values.slug}`);
  process.exit(1);
}
if (tenant.status === 'active') {
  console.error('Suspend or cancel the tenant in the admin console before purging.');
  process.exit(1);
}
const counts = await purgeTenant(db, tenant.id);
console.log(`Purged ${tenant.name}:`, counts);
await db.destroy();

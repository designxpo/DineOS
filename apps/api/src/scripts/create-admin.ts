// Creates (or resets the password of) a platform admin.
//   npm run admin:create -w @mezmitra/api -- --email ops@example.com --name "Ops" --password '...'
import { parseArgs } from 'node:util';
import { loadConfig } from '../config';
import { createDb } from '../db';
import { hashSecret } from '../lib/crypto';

const { values } = parseArgs({
  options: { email: { type: 'string' }, name: { type: 'string' }, password: { type: 'string' } },
});
if (!values.email || !values.password || values.password.length < 12) {
  console.error('Usage: --email <email> --name <name> --password <at least 12 characters>');
  process.exit(1);
}

const config = loadConfig();
const db = createDb(config.DATABASE_ADMIN_URL, 1);
const hash = await hashSecret(values.password);
const existing = await db.selectFrom('platform_admins').select('id').where('email', '=', values.email.toLowerCase()).executeTakeFirst();
if (existing) {
  await db.updateTable('platform_admins').set({ password_hash: hash, status: 'active' }).where('id', '=', existing.id).execute();
  console.log(`Reset password for ${values.email}`);
} else {
  await db.insertInto('platform_admins').values({ email: values.email.toLowerCase(), name: values.name ?? values.email, password_hash: hash }).execute();
  console.log(`Created platform admin ${values.email}`);
}
await db.destroy();

// Creates the database roles and the dev/test databases. Idempotent; safe to re-run.
//   npm run db:setup              -> dineos_dev
//   npm run db:setup -- --test    -> dineos_test (dropped and recreated)
import pg from 'pg';
import { loadEnvFile } from '../config';

loadEnvFile();

const ownerUrl = new URL(process.env.DATABASE_OWNER_URL ?? 'postgres://localhost:5432/dineos_dev');
const isTest = process.argv.includes('--test');
const dbName = isTest ? 'dineos_test' : ownerUrl.pathname.slice(1) || 'dineos_dev';
const appPassword = process.env.DINEOS_APP_PASSWORD ?? 'dineos_app_dev';
const adminPassword = process.env.DINEOS_ADMIN_PASSWORD ?? 'dineos_admin_dev';

function ident(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}
function literal(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

async function main() {
  const maintenance = new URL(ownerUrl);
  maintenance.pathname = '/postgres';
  const client = new pg.Client({ connectionString: maintenance.toString() });
  await client.connect();
  try {
    for (const [role, password, extra] of [
      ['dineos_app', appPassword, 'NOBYPASSRLS'],
      ['dineos_admin', adminPassword, 'BYPASSRLS'],
    ] as const) {
      const exists = await client.query('select 1 from pg_roles where rolname = $1', [role]);
      const verb = exists.rowCount ? 'ALTER' : 'CREATE';
      await client.query(`${verb} ROLE ${ident(role)} LOGIN PASSWORD ${literal(password)} ${extra} NOSUPERUSER NOCREATEDB NOCREATEROLE`);
    }
    if (isTest) {
      await client.query(`DROP DATABASE IF EXISTS ${ident(dbName)} WITH (FORCE)`);
    }
    const db = await client.query('select 1 from pg_database where datname = $1', [dbName]);
    if (!db.rowCount) {
      await client.query(`CREATE DATABASE ${ident(dbName)}`);
      console.log(`created database ${dbName}`);
    }
    console.log(`roles ready; database ${dbName} ready`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

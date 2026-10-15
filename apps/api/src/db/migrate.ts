import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { API_ROOT } from '../config';

const MIGRATIONS_DIR = resolve(API_ROOT, 'migrations');

/** Applies every migrations/*.sql not yet recorded, each in its own transaction, in filename order. */
export async function migrate(connectionString: string, log: (msg: string) => void = console.log): Promise<string[]> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query(
      'create table if not exists schema_migrations (version text primary key, applied_at timestamptz not null default now())',
    );
    const done = new Set(
      (await client.query<{ version: string }>('select version from schema_migrations')).rows.map((r) => r.version),
    );
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = readFileSync(resolve(MIGRATIONS_DIR, file), 'utf8');
      await client.query('begin');
      try {
        await client.query(sql);
        await client.query('insert into schema_migrations (version) values ($1)', [file]);
        await client.query('commit');
        applied.push(file);
        log(`applied ${file}`);
      } catch (err) {
        await client.query('rollback');
        throw new Error(`migration ${file} failed: ${(err as Error).message}`, { cause: err });
      }
    }
    return applied;
  } finally {
    await client.end();
  }
}

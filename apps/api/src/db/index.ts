import { Kysely, PostgresDialect, sql, type RawBuilder } from 'kysely';
import pg from 'pg';
import type { DB, Json } from './schema';

// int8 (count/sum results) and numeric come back as strings by default; our values fit in a JS number.
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));
// Keep DATE columns as 'YYYY-MM-DD' strings: business dates must not shift with the server timezone.
pg.types.setTypeParser(1082, (v) => v);

export type Database = Kysely<DB>;
export type { DB };

export function createDb(connectionString: string, max = 10): Database {
  return new Kysely<DB>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString, max }) }),
  });
}

/**
 * Wraps a value for a jsonb column. Required for arrays: node-postgres would otherwise send a JS
 * array as a Postgres array literal, not JSON.
 */
export function json(value: unknown): RawBuilder<Json> {
  return sql<Json>`${JSON.stringify(value)}::jsonb`;
}

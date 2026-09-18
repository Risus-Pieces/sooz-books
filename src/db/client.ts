import { sql as sqlTag, type ExtractTablesWithRelations } from 'drizzle-orm';
import type { PgTransaction } from 'drizzle-orm/pg-core';
import { drizzle, type PostgresJsDatabase, type PostgresJsQueryResultHKT } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import * as schema from './schema';

type Schema = typeof schema;

/** Reads DATABASE_URL, failing with something actionable rather than a driver error. */
export function assertDbEnv(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. Copy .env.example to .env.local and point it at the Supabase session-mode pooler.',
    );
  }
  return url;
}

// Next.js re-evaluates modules on every hot reload. Without this cache each edit
// would leak a fresh pool and exhaust the pooler within a few minutes of work.
const cache = globalThis as typeof globalThis & {
  __soozBooksSql?: postgres.Sql;
  __soozBooksDb?: PostgresJsDatabase<Schema>;
};

/** Raw postgres.js client, for the handful of queries Drizzle cannot express. */
export const sql: postgres.Sql =
  cache.__soozBooksSql ??
  postgres(assertDbEnv(), {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 30,
    // Session mode, so prepared statements survive between checkouts.
    prepare: true,
  });

export const db: PostgresJsDatabase<Schema> = cache.__soozBooksDb ?? drizzle(sql, { schema });

cache.__soozBooksSql = sql;
cache.__soozBooksDb = db;

/** The transaction handle handed to a `withActor` callback. */
export type Tx = PgTransaction<PostgresJsQueryResultHKT, Schema, ExtractTablesWithRelations<Schema>>;

/**
 * Runs `fn` inside one transaction with the acting user announced to Postgres.
 *
 * Every write path goes through here. The audit triggers on the financial tables
 * read `app.user_id` to attribute the rows they write, so the setting has to be
 * in place before the first data statement; `is_local = true` scopes it to this
 * transaction and nothing leaks onto the next checkout of the pooled connection.
 *
 * Keeping the whole unit of work in one transaction is also what makes posting
 * legal: the balance check is a deferred constraint trigger that fires at
 * COMMIT, so an entry may be inserted as a draft, given its lines and flipped to
 * 'posted' here, and is only judged once at the end.
 */
export async function withActor<T>(
  userId: string | null,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sqlTag`select set_config('app.user_id', ${userId ?? ''}, true)`);
    return fn(tx);
  });
}

/**
 * Fixtures for the ledger test suite.
 *
 * The suite runs against the live database, because the invariants it is
 * protecting live there: a deferred constraint trigger that judges an entry at
 * COMMIT cannot be exercised against a fake. Every test therefore runs inside a
 * transaction that is rolled back afterwards, so the seeded chart of accounts is
 * read but never changed and the database is left exactly as it was found. The
 * checks that normally wait for COMMIT are brought forward inside those
 * transactions with `set constraints all immediate`.
 *
 * Import this module FIRST in a test file. Its body reads `.env.local` into
 * `process.env`, and module bodies run before the imports that follow it are
 * evaluated — `@/db/client` builds its connection pool at import time and would
 * otherwise throw for a missing DATABASE_URL. That is also why the client is
 * reached through a dynamic import below rather than a static one.
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { asc, inArray, sql as sqlTag } from 'drizzle-orm';

import { accounts, channels } from '@/db/schema';

import type { LedgerDb } from './post';

function loadEnvLocal(): void {
  if (process.env.DATABASE_URL) return;
  const path = fileURLToPath(new URL('../../../.env.local', import.meta.url));
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const value = match[2].trim().replace(/^["']|["']$/g, '');
    if (process.env[match[1]] === undefined) process.env[match[1]] = value;
  }
}

loadEnvLocal();

export const hasDatabase = Boolean(process.env.DATABASE_URL);

type DbClient = typeof import('@/db/client');

let clientPromise: Promise<DbClient> | undefined;

function client(): Promise<DbClient> {
  clientPromise ??= import('@/db/client');
  return clientPromise;
}

/** Thrown to unwind the transaction a test ran in. Never escapes `withRollback`. */
const ROLLBACK = Symbol('rollback');

/**
 * Runs `fn` inside a transaction that is always rolled back, with `app.user_id`
 * announced the way `withActor` does it so the audit triggers behave normally.
 * The handle is passed on to the ledger functions as their `tx`.
 */
export async function withRollback<T>(fn: (tx: LedgerDb) => Promise<T>): Promise<T> {
  const { db } = await client();
  const box: { value?: T } = {};

  try {
    await db.transaction(async (tx) => {
      await tx.execute(sqlTag`select set_config('app.user_id', '', true)`);
      box.value = await fn(tx);
      throw ROLLBACK;
    });
  } catch (error) {
    if (error !== ROLLBACK) throw error;
  }

  return box.value as T;
}

/** Closes the pool so vitest can exit. Call from `afterAll`. */
export async function closeTestDb(): Promise<void> {
  if (clientPromise === undefined) return;
  const { sql } = await clientPromise;
  await sql.end({ timeout: 5 });
}

/** Account ids for a set of seeded codes, keyed by code. */
export async function accountIds(
  tx: LedgerDb,
  codes: readonly string[],
): Promise<Map<string, string>> {
  const rows = await tx
    .select({ id: accounts.id, code: accounts.code })
    .from(accounts)
    .where(inArray(accounts.code, [...codes]));
  return new Map(rows.map((row) => [row.code, row.id]));
}

export async function firstChannelId(tx: LedgerDb): Promise<string> {
  const [row] = await tx
    .select({ id: channels.id })
    .from(channels)
    .orderBy(asc(channels.sortOrder))
    .limit(1);
  return row.id;
}


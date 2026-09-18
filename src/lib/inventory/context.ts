import { inArray } from 'drizzle-orm';

import { db, withActor } from '@/db/client';
import { accounts } from '@/db/schema';
import type { LedgerDb } from '@/lib/ledger/post';

import { InventoryError } from './errors';

/** Who is acting, and optionally the transaction to act inside. */
export interface InventoryCtx {
  userId: string | null;
  /** An open transaction with `app.user_id` already set (see `withActor`). */
  tx?: LedgerDb;
}

/** Runs `fn` in the caller's transaction, or in a fresh one with the actor announced. */
export function inTx<T>(ctx: InventoryCtx, fn: (tx: LedgerDb) => Promise<T>): Promise<T> {
  return ctx.tx ? fn(ctx.tx) : withActor(ctx.userId, fn);
}

/** The executor for a read: the caller's transaction, or the pool. */
export function reader(exec?: LedgerDb): LedgerDb {
  return exec ?? db;
}

/** Account ids for seeded codes; throws if any is missing, which would mean a broken chart. */
export async function accountIdsByCode(
  exec: LedgerDb,
  codes: readonly string[],
): Promise<Map<string, string>> {
  const unique = [...new Set(codes)];
  const rows = await exec
    .select({ id: accounts.id, code: accounts.code })
    .from(accounts)
    .where(inArray(accounts.code, unique));
  const map = new Map(rows.map((r) => [r.code, r.id]));
  const missing = unique.filter((c) => !map.has(c));
  if (missing.length > 0) {
    throw new InventoryError('not_found', `Chart of accounts is missing ${missing.join(', ')}.`);
  }
  return map;
}

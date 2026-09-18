/**
 * The transaction plumbing shared by budgets, the cash forecast and recurring
 * entries.
 */

import { db, withActor } from '@/db/client';
import type { LedgerDb } from '@/lib/ledger/post';

export { PlanningError, type PlanningErrorCode, isPlanningError } from './errors';

/** Who is acting, and optionally the transaction to act inside. */
export interface PlanningCtx {
  userId: string | null;
  /** An open transaction with `app.user_id` already set (see `withActor`). */
  tx?: LedgerDb;
}

/** Runs `fn` in the caller's transaction, or in a fresh one with the actor announced. */
export function inTx<T>(ctx: PlanningCtx, fn: (tx: LedgerDb) => Promise<T>): Promise<T> {
  return ctx.tx ? fn(ctx.tx) : withActor(ctx.userId, fn);
}

/** The executor for a read: the caller's transaction, or the pool. */
export function reader(exec?: LedgerDb): LedgerDb {
  return exec ?? db;
}

/** Postgres hands bigint aggregates back as strings; every one must be whole cents. */
export function cents(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value ?? 0);
  if (!Number.isSafeInteger(n)) {
    throw new Error(`Expected a whole number of cents, received ${String(value)}.`);
  }
  return n;
}

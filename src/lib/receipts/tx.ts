import { type Tx, withActor } from '@/db/client';
import type { LedgerDb } from '@/lib/ledger/post';

/**
 * Who is acting, and optionally the transaction to act inside. A caller-supplied `tx` must
 * already carry `app.user_id` (`withActor` sets it); each operation then runs in a savepoint of
 * it, so a refusal never poisons the caller's transaction. This is the same shape as
 * `OpeningBalanceCtx` and `ArapContext`, and it is what lets the tests run inside `withRollback`.
 */
export interface ReceiptCtx {
  userId: string | null;
  tx?: LedgerDb;
}

/** Runs one unit of work atomically: its own transaction, or a savepoint of the caller's. */
export async function inReceiptTx<T>(ctx: ReceiptCtx, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (ctx.tx !== undefined) return ctx.tx.transaction(fn);
  return withActor(ctx.userId, fn);
}

/** Where plain reads go: the caller's transaction if there is one, else the shared pool. */
export async function readerOf(ctx: ReceiptCtx): Promise<LedgerDb> {
  return ctx.tx ?? (await import('@/db/client')).db;
}

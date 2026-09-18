/**
 * Who is acting, and the transaction to act inside.
 *
 * A caller-supplied `tx` must already carry `app.user_id` (`withActor` sets it); each
 * operation then runs in a savepoint of it, so one refused operation never poisons the
 * caller's transaction. Without one, the operation opens its own through `withActor`.
 */

import { postgresErrorOf } from '@/lib/db-errors';
import { isLedgerError } from '@/lib/ledger/errors';
import { type LedgerDb, translateLedgerDbError } from '@/lib/ledger/post';

import { ChannelError } from './errors';

export interface ChannelCtx {
  readonly userId: string | null;
  readonly tx?: LedgerDb;
}

const FROZEN = /is posted to the ledger|reported on filing|has been paid/;

function translate(error: unknown): unknown {
  if (error instanceof ChannelError || isLedgerError(error)) return error;
  const pg = postgresErrorOf(error);
  if (pg !== null && pg.code === '23514' && FROZEN.test(pg.message)) {
    return new ChannelError('filed', pg.message);
  }
  return translateLedgerDbError(error);
}

export async function inChannelTx<T>(ctx: ChannelCtx, fn: (tx: LedgerDb) => Promise<T>): Promise<T> {
  try {
    if (ctx.tx !== undefined) return await ctx.tx.transaction((sp) => fn(sp));
    const { withActor } = await import('@/db/client');
    return await withActor(ctx.userId, (tx) => fn(tx));
  } catch (error) {
    throw translate(error);
  }
}

/**
 * Stage, then confirm.
 *
 * Claude cannot change the books in one step. `stage_*` tools validate a change exactly as posting
 * would and store what they would do here; `commit_staged` carries out that stored change and nothing
 * else. So what Claude showed the person is what posts, it posts once, and it cannot post at all
 * without having been shown.
 *
 * A staging belongs to the person who made it, expires after a quarter of an hour, and is spent by
 * the commit that uses it. Spent, expired, unknown and someone else's stagings are indistinguishable
 * from "not yours" except for the first two, which say so: a person who confirms twice should be
 * told, not told it never existed.
 */
import { and, eq, sql } from 'drizzle-orm';

import { type McpStaging, type StageKind, mcpStagings } from '@/db/schema';
import type { LedgerDb } from '@/lib/ledger/post';

export const STAGE_TTL_MINUTES = 15;

export type StagingErrorCode = 'not_found' | 'expired' | 'used';

export class StagingError extends Error {
  readonly code: StagingErrorCode;

  constructor(code: StagingErrorCode, message: string) {
    super(message);
    this.name = 'StagingError';
    this.code = code;
  }
}

export function isStagingError(error: unknown): error is StagingError {
  return error instanceof StagingError;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface NewStaging {
  userId: string;
  clientId: string | null;
  kind: StageKind;
  /** Exactly what commit will do; account references already resolved to ids. */
  payload: unknown;
  /** What the person is shown. */
  preview: unknown;
}

export async function createStaging(exec: LedgerDb, input: NewStaging): Promise<{ id: string; expiresAt: Date }> {
  const [row] = await exec
    .insert(mcpStagings)
    .values({
      userId: input.userId,
      clientId: input.clientId,
      kind: input.kind,
      payload: input.payload,
      preview: input.preview,
      expiresAt: sql`now() + ${STAGE_TTL_MINUTES} * interval '1 minute'`,
    })
    .returning({ id: mcpStagings.id, expiresAt: mcpStagings.expiresAt });
  return row;
}

/**
 * Takes the staging for update, so two confirmations of the same id queue up and the second finds it
 * spent. Throws unless it exists, is the caller's, is unspent and has not expired.
 */
export async function lockStaging(tx: LedgerDb, id: string, userId: string): Promise<McpStaging> {
  const notFound = new StagingError('not_found', 'There is no staged change with that id for you. Stage it again.');
  if (!UUID.test(id)) throw notFound;

  const [row] = await tx
    .select({ staging: mcpStagings, expired: sql<boolean>`${mcpStagings.expiresAt} <= now()` })
    .from(mcpStagings)
    .where(and(eq(mcpStagings.id, id), eq(mcpStagings.userId, userId)))
    .for('update');
  if (row === undefined) throw notFound;
  if (row.staging.committedAt !== null) {
    throw new StagingError('used', 'That staged change has already been confirmed. It cannot be posted twice.');
  }
  if (row.expired) {
    throw new StagingError('expired', 'That staged change has expired. Stage it again to see it afresh.');
  }
  return row.staging;
}

export async function markCommitted(tx: LedgerDb, id: string, result: unknown): Promise<void> {
  await tx
    .update(mcpStagings)
    .set({ committedAt: sql`now()`, result })
    .where(eq(mcpStagings.id, id));
}

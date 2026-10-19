import { afterAll, describe, expect, it } from 'vitest';

// First: loads .env.local before '@/db/client' is imported anywhere below.
import { closeTestDb, hasDatabase, withRollback } from '@/lib/ledger/test-support';

import { randomUUID } from 'node:crypto';

import { eq, sql } from 'drizzle-orm';

import { mcpStagings } from '@/db/schema';
import { seededUserId } from '@/lib/receipts/test-support';

import { StagingError, createStaging, lockStaging, markCommitted } from './staging';

afterAll(closeTestDb);

async function staged(tx: Parameters<Parameters<typeof withRollback>[0]>[0]) {
  const userId = await seededUserId(tx);
  const { id } = await createStaging(tx, {
    userId,
    clientId: 'claude',
    kind: 'journal_entry',
    payload: { hello: 'world' },
    preview: { shown: true },
  });
  return { id, userId };
}

describe.skipIf(!hasDatabase)('staging', () => {
  it('stores what was staged and hands it back to its owner', async () => {
    await withRollback(async (tx) => {
      const { id, userId } = await staged(tx);
      const row = await lockStaging(tx, id, userId);
      expect(row.payload).toEqual({ hello: 'world' });
      expect(row.preview).toEqual({ shown: true });
      expect(row.committedAt).toBeNull();
    });
  });

  it('expires about a quarter of an hour out', async () => {
    await withRollback(async (tx) => {
      const { id } = await staged(tx);
      const [row] = await tx
        .select({ minutes: sql<number>`extract(epoch from (expires_at - created_at)) / 60` })
        .from(mcpStagings)
        .where(eq(mcpStagings.id, id));
      expect(Number(row.minutes)).toBe(15);
    });
  });

  it("is invisible to anyone but the person who staged it", async () => {
    await withRollback(async (tx) => {
      const { id } = await staged(tx);
      await expect(lockStaging(tx, id, randomUUID())).rejects.toMatchObject({ code: 'not_found' });
    });
  });

  it('refuses an id that is not an id, and one that does not exist', async () => {
    await withRollback(async (tx) => {
      const userId = await seededUserId(tx);
      await expect(lockStaging(tx, 'nope', userId)).rejects.toBeInstanceOf(StagingError);
      await expect(lockStaging(tx, randomUUID(), userId)).rejects.toMatchObject({ code: 'not_found' });
    });
  });

  it('can be used once', async () => {
    await withRollback(async (tx) => {
      const { id, userId } = await staged(tx);
      await lockStaging(tx, id, userId);
      await markCommitted(tx, id, { entryNo: 7 });
      await expect(lockStaging(tx, id, userId)).rejects.toMatchObject({ code: 'used' });
    });
  });

  it('cannot be used after it expires', async () => {
    await withRollback(async (tx) => {
      const { id, userId } = await staged(tx);
      await tx.update(mcpStagings).set({ expiresAt: sql`now() - interval '1 second'` }).where(eq(mcpStagings.id, id));
      await expect(lockStaging(tx, id, userId)).rejects.toMatchObject({ code: 'expired' });
    });
  });
});

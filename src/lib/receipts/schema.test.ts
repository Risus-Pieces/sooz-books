import { afterAll, describe, expect, it } from 'vitest';

// First: loads .env.local before '@/db/client' is imported anywhere below.
import { closeTestDb, hasDatabase, withRollback } from '@/lib/ledger/test-support';

import { randomUUID } from 'node:crypto';

import { eq, sql } from 'drizzle-orm';

import { appUsers, attachments, receiptProposals } from '@/db/schema';
import { sourceLabel } from '@/components/ledger/types';
import { SOURCE_TYPES } from '@/lib/ledger/post';
import type { LedgerDb } from '@/lib/ledger/post';

afterAll(closeTestDb);

describe('purchase_receipt source type', () => {
  it('is a known source type with a readable label', () => {
    expect(SOURCE_TYPES).toContain('purchase_receipt');
    expect(sourceLabel('purchase_receipt')).toBe('Receipt');
  });
});

async function seedUser(tx: LedgerDb): Promise<string> {
  const [row] = await tx.select({ id: appUsers.id }).from(appUsers).orderBy(appUsers.id).limit(1);
  return row.id;
}

async function seedAttachment(tx: LedgerDb, userId: string): Promise<string> {
  const [row] = await tx
    .insert(attachments)
    .values({
      entityType: 'receipt_proposal',
      entityId: randomUUID(),
      filename: 'receipt.pdf',
      storagePath: `test/${randomUUID()}/receipt.pdf`,
      mimeType: 'application/pdf',
      sizeBytes: 10,
      sha256: randomUUID(),
      uploadedBy: userId,
    })
    .returning({ id: attachments.id });
  return row.id;
}

describe.skipIf(!hasDatabase)('receipt_proposals', () => {
  it('stores a proposal with empty defaults', async () => {
    await withRollback(async (tx) => {
      const userId = await seedUser(tx);
      const attachmentId = await seedAttachment(tx, userId);

      const [row] = await tx
        .insert(receiptProposals)
        .values({ attachmentId, uploadedBy: userId })
        .returning();

      expect(row.status).toBe('proposed');
      expect(row.lines).toEqual([]);
      expect(row.warnings).toEqual([]);
      expect(row.entryId).toBeNull();
    });
  });

  it('allows one proposal per stored file', async () => {
    await withRollback(async (tx) => {
      const userId = await seedUser(tx);
      const attachmentId = await seedAttachment(tx, userId);
      await tx.insert(receiptProposals).values({ attachmentId, uploadedBy: userId });

      await expect(
        tx.transaction(async (inner) => {
          await inner.insert(receiptProposals).values({ attachmentId, uploadedBy: userId });
        }),
      ).rejects.toThrow();
    });
  });

  it('refuses a posted proposal that has no entry', async () => {
    await withRollback(async (tx) => {
      const userId = await seedUser(tx);
      const attachmentId = await seedAttachment(tx, userId);

      await expect(
        tx.transaction(async (inner) => {
          await inner.insert(receiptProposals).values({ attachmentId, uploadedBy: userId, status: 'posted' });
        }),
      ).rejects.toThrow();
    });
  });

  it('refuses a status it does not know', async () => {
    await withRollback(async (tx) => {
      const userId = await seedUser(tx);
      const attachmentId = await seedAttachment(tx, userId);
      const [row] = await tx.insert(receiptProposals).values({ attachmentId, uploadedBy: userId }).returning();

      await expect(
        tx.transaction(async (inner) => {
          await inner.execute(sql`update receipt_proposals set status = 'approved' where id = ${row.id}`);
        }),
      ).rejects.toThrow();
    });
  });

  it('writes an audit row when a proposal is created', async () => {
    await withRollback(async (tx) => {
      const userId = await seedUser(tx);
      const attachmentId = await seedAttachment(tx, userId);
      const [row] = await tx.insert(receiptProposals).values({ attachmentId, uploadedBy: userId }).returning();

      const rows = await tx.execute<{ n: number }>(
        sql`select count(*)::int as n from audit_log where table_name = 'receipt_proposals' and row_id = ${row.id}`,
      );
      expect(rows[0].n).toBe(1);

      const found = await tx.select().from(receiptProposals).where(eq(receiptProposals.id, row.id));
      expect(found).toHaveLength(1);
    });
  });
});

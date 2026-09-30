import { afterAll, describe, expect, it } from 'vitest';

// First: loads .env.local before '@/db/client' is imported anywhere below.
import { closeTestDb, hasDatabase, withRollback } from '@/lib/ledger/test-support';

import { randomUUID } from 'node:crypto';

import { attachments } from '@/db/schema';

import { receiptFilePath } from './file-access';
import { insertProposal, seededUserId } from './test-support';

afterAll(closeTestDb);

describe.skipIf(!hasDatabase)('receiptFilePath', () => {
  it('finds the stored path of a receipt', async () => {
    await withRollback(async (tx) => {
      const userId = await seededUserId(tx);
      const { attachmentId } = await insertProposal(tx, userId);

      const path = await receiptFilePath(tx, attachmentId);

      expect(path).toMatch(/^test\/.+\/receipt\.pdf$/);
    });
  });

  it('refuses a stored file that is not a receipt, such as a deduction backup', async () => {
    await withRollback(async (tx) => {
      const userId = await seededUserId(tx);
      const [other] = await tx
        .insert(attachments)
        .values({
          entityType: 'deduction',
          entityId: randomUUID(),
          filename: 'backup.pdf',
          storagePath: 'elsewhere/backup.pdf',
          uploadedBy: userId,
        })
        .returning({ id: attachments.id });

      expect(await receiptFilePath(tx, other.id)).toBeNull();
    });
  });

  it('returns null for an id that does not exist', async () => {
    await withRollback(async (tx) => {
      expect(await receiptFilePath(tx, '00000000-0000-4000-8000-00000000dead')).toBeNull();
    });
  });
});

import { sql } from 'drizzle-orm';

import type { LedgerDb } from '@/lib/ledger/post';

/**
 * The stored path of a receipt's file, or null.
 *
 * Only files that belong to a receipt proposal are ever found here. The `attachments` table also
 * holds other documents (a deduction's backup, say), which live elsewhere and must not be
 * reachable through the receipt viewer by guessing an id.
 */
export async function receiptFilePath(exec: LedgerDb, attachmentId: string): Promise<string | null> {
  const rows = await exec.execute<{ storage_path: string }>(sql`
    select a.storage_path
      from receipt_proposals rp
      join attachments a on a.id = rp.attachment_id
     where a.id = ${attachmentId}::uuid`);
  return rows[0]?.storage_path ?? null;
}

import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';

import { accounts, appUsers, attachments, receiptProposals, vendors } from '@/db/schema';
import type { NewReceiptProposal } from '@/db/schema';
import { ACCOUNTS } from '@/lib/ledger/coa';
import { type LedgerDb, postJournalEntry } from '@/lib/ledger/post';

/** `app_users.id` is a foreign key onto `auth.users`, so tests use the one seeded owner. */
export async function seededUserId(tx: LedgerDb): Promise<string> {
  const [row] = await tx.select({ id: appUsers.id }).from(appUsers).orderBy(appUsers.id).limit(1);
  return row.id;
}

export async function accountIdOf(tx: LedgerDb, code: string): Promise<string> {
  const [row] = await tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.code, code));
  if (row === undefined) throw new Error(`Account ${code} is not in the test chart.`);
  return row.id;
}

/** Nests a fresh contributions account under 3015 and assigns it to the member, as production has it. */
export async function giveContributionsAccount(
  tx: LedgerDb,
  userId: string,
): Promise<{ id: string; code: string }> {
  const tag = randomUUID().slice(0, 8);
  const parentId = await accountIdOf(tx, ACCOUNTS.MEMBER_CONTRIBUTIONS);
  const code = `TR-${tag}`;
  const [row] = await tx
    .insert(accounts)
    .values({ code, name: `Contributions ${tag}`, type: 'equity', subtype: 'equity', parentId })
    .returning({ id: accounts.id });
  await tx.update(appUsers).set({ contributionsAccountId: row.id }).where(eq(appUsers.id, userId));
  return { id: row.id, code };
}

/** A vendor with a name no seeded vendor can match. */
export async function newVendor(
  tx: LedgerDb,
  overrides: { name?: string; defaultExpenseAccountId?: string | null } = {},
): Promise<{ id: string; name: string }> {
  const name = overrides.name ?? `ZZ Receipt Test ${randomUUID().slice(0, 8)}`;
  const [row] = await tx
    .insert(vendors)
    .values({ name, defaultExpenseAccountId: overrides.defaultExpenseAccountId ?? null })
    .returning({ id: vendors.id });
  return { id: row.id, name };
}

/** A postable expense account of our own, so a test never depends on which seeded ones exist. */
export async function expenseLeaf(tx: LedgerDb, subtype = 'general_admin'): Promise<{ id: string; code: string }> {
  const code = `TE-${randomUUID().slice(0, 8)}`;
  const [row] = await tx
    .insert(accounts)
    .values({ code, name: `Test expense ${code}`, type: 'expense', subtype })
    .returning({ id: accounts.id });
  return { id: row.id, code };
}

/** A posted manual entry that debits `accountId` for this vendor: purchase history for the vendor. */
export async function postVendorSpend(
  tx: LedgerDb,
  vendorId: string,
  accountId: string,
  date: string,
  cents = 1000,
): Promise<void> {
  await postJournalEntry(
    {
      date,
      memo: 'history probe',
      sourceType: 'manual',
      lines: [
        { accountId, debitCents: cents, vendorId },
        { accountCode: ACCOUNTS.OPENING_BALANCE_EQUITY, creditCents: cents },
      ],
    },
    { userId: null, tx },
  );
}

/** A stored file and the proposal for it, as ingest would have left them. */
export async function insertProposal(
  tx: LedgerDb,
  userId: string,
  overrides: Partial<NewReceiptProposal> = {},
): Promise<{ id: string; attachmentId: string }> {
  const [attachment] = await tx
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
  const [row] = await tx
    .insert(receiptProposals)
    .values({ attachmentId: attachment.id, uploadedBy: userId, ...overrides })
    .returning({ id: receiptProposals.id });
  return { id: row.id, attachmentId: attachment.id };
}

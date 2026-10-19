import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';

import { accounts, bankAccounts, bankTransactions } from '@/db/schema';
import type { LedgerDb } from '@/lib/ledger/post';
import { seededUserId } from '@/lib/receipts/test-support';
import type { AppRole } from '@/lib/types';

import type { McpUser } from './types';

export { accountIdOf, expenseLeaf, seededUserId } from '@/lib/receipts/test-support';

/** The seeded member, as a connected user with the given role. */
export async function mcpUser(tx: LedgerDb, role: AppRole = 'owner'): Promise<McpUser> {
  return { id: await seededUserId(tx), email: 'unit-owner@sooz-books.invalid', fullName: 'Unit Owner', role, clientId: 'test-client' };
}

/** Lets a test post inside its transaction: the balance check normally waits for COMMIT. */
export async function immediate(tx: LedgerDb): Promise<void> {
  await tx.execute(sql`set constraints all immediate`);
}

export async function newBank(tx: LedgerDb): Promise<{ id: string; glId: string; name: string }> {
  const tag = randomUUID().slice(0, 8);
  const [gl] = await tx
    .insert(accounts)
    .values({ code: `TB-${tag}`, name: `Test bank ${tag}`, type: 'asset', subtype: 'bank', isBank: true })
    .returning({ id: accounts.id });
  const name = `TEST bank ${tag}`;
  const [bank] = await tx
    .insert(bankAccounts)
    .values({ accountId: gl.id, name, kind: 'checking', mask: tag.slice(0, 4) })
    .returning({ id: bankAccounts.id });
  return { id: bank.id, glId: gl.id, name };
}

export async function newTxn(
  tx: LedgerDb,
  bankId: string,
  date: string,
  amountCents: number,
  description = 'TEST PAYEE',
  overrides: { status?: 'unreviewed' | 'excluded' } = {},
): Promise<string> {
  const [row] = await tx
    .insert(bankTransactions)
    .values({
      bankAccountId: bankId,
      txnDate: date,
      description,
      descriptionNormalized: description.toUpperCase(),
      counterparty: description,
      amountCents,
      fingerprint: randomUUID(),
      status: overrides.status ?? 'unreviewed',
    })
    .returning({ id: bankTransactions.id });
  return row.id;
}

import { and, eq, sql } from 'drizzle-orm';

import { bankAccounts, bankTransactions, journalEntries, journalLines } from '@/db/schema';
import type { LedgerDb } from '@/lib/ledger/post';

import { McpInputError } from './errors';

export const ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'revenue', 'expense'] as const;

/** The facts about a bank row a person needs to recognise it. `description` is what the bank printed. */
export async function bankSummary(
  exec: LedgerDb,
  txnId: string,
): Promise<{ date: string; bank: string; amountCents: number; description: string }> {
  const [row] = await exec
    .select({
      date: bankTransactions.txnDate,
      bank: bankAccounts.name,
      amountCents: bankTransactions.amountCents,
      description: bankTransactions.description,
      journalEntryId: bankTransactions.journalEntryId,
      status: bankTransactions.status,
      reconciledAt: bankTransactions.reconciledAt,
      transferPairId: bankTransactions.transferPairId,
    })
    .from(bankTransactions)
    .innerJoin(bankAccounts, eq(bankAccounts.id, bankTransactions.bankAccountId))
    .where(eq(bankTransactions.id, txnId));
  if (row === undefined) throw new McpInputError(`There is no bank transaction ${txnId}.`);
  if (row.reconciledAt !== null) throw new McpInputError('That transaction is reconciled and locked.');
  if (row.journalEntryId !== null) throw new McpInputError('That transaction is already posted.');
  return { date: row.date, bank: row.bank, amountCents: row.amountCents, description: row.description };
}

/** Posted lines on an account — what makes turning it into a header worth a warning. */
export async function postedLineCount(exec: LedgerDb, accountId: string): Promise<number> {
  const [row] = await exec
    .select({ count: sql<number>`count(*)::int` })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
    .where(and(eq(journalLines.accountId, accountId), eq(journalEntries.status, 'posted')));
  return Number(row?.count ?? 0);
}

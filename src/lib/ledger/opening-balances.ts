/**
 * Opening balances for bank accounts.
 *
 * `bank_accounts.opening_balance_cents` is the balance the account held on
 * `opening_date`, before the first imported statement line — derived from the first
 * statement's running balance. It has to reach the ledger as an entry, or the bank's GL
 * balance never ties to the statement and the first reconciliation cannot complete.
 *
 * The founders' money is the only source of Sooz's opening cash, so a positive balance on a
 * cash account is credited to the contributions account of whoever posts it (see
 * `./member-equity`), which is the pooled 3015 until members have accounts of their own.
 * Anything else — an overdrawn account, a card that already owed money — was not a
 * contribution, and goes to Opening Balance Equity for the accountant to classify.
 *
 * Posted with source type `opening_balance` and `source_id` = the bank account id, which
 * is also how idempotency is checked: an account with an unreversed opening entry is
 * skipped. The bank account row is locked while it is checked, so two concurrent calls
 * cannot both post.
 */

import { and, eq, inArray, isNull, sql as sqlTag } from 'drizzle-orm';

import { type Tx, withActor } from '@/db/client';
import { accounts, bankAccounts, journalEntries } from '@/db/schema';
import type { CalendarDate } from '@/lib/dates';

import { ACCOUNTS } from './coa';
import { isLedgerError } from './errors';
import { memberEquityAccount } from './member-equity';
import { type LedgerDb, postJournalEntry, translateLedgerDbError } from './post';

export interface OpeningBalanceCtx {
  userId: string | null;
  /** Run inside the caller's transaction (as a savepoint per account). */
  tx?: LedgerDb;
}

export type OpeningBalanceOutcome =
  | { status: 'posted'; entryId: string; entryNo: number; equityAccountCode: string }
  | { status: 'already_posted'; entryId: string }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; error: string };

export type OpeningBalanceResult = {
  bankAccountId: string;
  name: string;
  openingBalanceCents: number;
  openingDate: CalendarDate | null;
} & OpeningBalanceOutcome;

const CASH_KINDS: ReadonlySet<string> = new Set(['checking', 'savings', 'merchant']);

async function inTx<T>(ctx: OpeningBalanceCtx, fn: (tx: Tx) => Promise<T>): Promise<T> {
  try {
    if (ctx.tx !== undefined) return await ctx.tx.transaction(fn);
    return await withActor(ctx.userId, fn);
  } catch (error) {
    throw translateLedgerDbError(error);
  }
}

async function accountIdByCode(tx: Tx, code: string): Promise<string> {
  const [row] = await tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.code, code));
  if (row === undefined) throw new Error(`Account ${code} is missing from the chart of accounts.`);
  return row.id;
}

async function postOne(tx: Tx, bankAccountId: string, userId: string | null): Promise<OpeningBalanceResult> {
  const [account] = await tx
    .select({
      id: bankAccounts.id,
      name: bankAccounts.name,
      kind: bankAccounts.kind,
      glAccountId: bankAccounts.accountId,
      openingBalanceCents: bankAccounts.openingBalanceCents,
      openingDate: bankAccounts.openingDate,
    })
    .from(bankAccounts)
    .where(eq(bankAccounts.id, bankAccountId))
    .for('update');

  const base = {
    bankAccountId: account.id,
    name: account.name,
    openingBalanceCents: account.openingBalanceCents,
    openingDate: account.openingDate,
  };

  const [existing] = await tx
    .select({ id: journalEntries.id })
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.sourceType, 'opening_balance'),
        eq(journalEntries.sourceId, account.id),
        eq(journalEntries.status, 'posted'),
        isNull(journalEntries.reversedById),
        // A reversal whose back-pointer a closed period prevented still counts.
        // Spelled out: drizzle renders a lone table's column unqualified, which the
        // subquery would read as its own.
        sqlTag`not exists (select 1 from journal_entries r where r.reverses_id = journal_entries.id)`,
      ),
    )
    .limit(1);
  if (existing !== undefined) return { ...base, status: 'already_posted', entryId: existing.id };

  if (account.openingBalanceCents === 0) return { ...base, status: 'skipped', reason: 'no opening balance' };
  if (account.openingDate === null) {
    return { ...base, status: 'skipped', reason: 'the opening balance has no date to post on' };
  }

  // Cash already in an account when the books open came from a member, so it is that
  // member's contribution — anything else is the unattributed opening-balance bucket.
  const contribution = account.openingBalanceCents > 0 && CASH_KINDS.has(account.kind);
  const equity = contribution
    ? await memberEquityAccount(tx, userId, 'contributions')
    : { id: await accountIdByCode(tx, ACCOUNTS.OPENING_BALANCE_EQUITY), code: ACCOUNTS.OPENING_BALANCE_EQUITY };
  const equityAccountId = equity.id;
  const amount = Math.abs(account.openingBalanceCents);
  const bankSide = account.openingBalanceCents > 0 ? { debitCents: amount } : { creditCents: amount };
  const equitySide = account.openingBalanceCents > 0 ? { creditCents: amount } : { debitCents: amount };
  const memo = `Opening balance — ${account.name}`;

  const posted = await postJournalEntry(
    {
      date: account.openingDate,
      memo,
      sourceType: 'opening_balance',
      sourceId: account.id,
      lines: [
        { accountId: account.glAccountId, ...bankSide, memo },
        {
          accountId: equityAccountId,
          ...equitySide,
          memo: contribution ? 'Founder funds held before the first statement' : memo,
        },
      ],
    },
    { userId, tx },
  );

  return { ...base, status: 'posted', entryId: posted.entryId, entryNo: posted.entryNo, equityAccountCode: equity.code };
}

/**
 * Posts the opening balance of every active bank account that has one and does not yet
 * have an opening entry. Each account posts in its own transaction; a refusal (a closed
 * period, say) is reported for that account and the rest still post. Calling it again
 * posts nothing. `bankAccountIds` narrows it to those accounts.
 */
export async function postOpeningBalances(
  ctx: OpeningBalanceCtx,
  options: { bankAccountIds?: readonly string[] } = {},
): Promise<OpeningBalanceResult[]> {
  const exec = ctx.tx ?? (await import('@/db/client')).db;
  const rows = await exec
    .select({
      id: bankAccounts.id,
      name: bankAccounts.name,
      openingBalanceCents: bankAccounts.openingBalanceCents,
      openingDate: bankAccounts.openingDate,
    })
    .from(bankAccounts)
    .where(
      and(
        eq(bankAccounts.active, true),
        options.bankAccountIds === undefined ? undefined : inArray(bankAccounts.id, [...options.bankAccountIds]),
      ),
    )
    .orderBy(bankAccounts.name, bankAccounts.id);

  const results: OpeningBalanceResult[] = [];
  for (const row of rows) {
    try {
      results.push(await inTx(ctx, (tx) => postOne(tx, row.id, ctx.userId)));
    } catch (error) {
      results.push({
        bankAccountId: row.id,
        name: row.name,
        openingBalanceCents: row.openingBalanceCents,
        openingDate: row.openingDate,
        status: 'failed',
        error: isLedgerError(error) ? error.message : 'The opening balance could not be posted.',
      });
    }
  }
  return results;
}

/**
 * The `commit_staged` half of stage-then-confirm.
 *
 * Takes only a stage id. What posts is whatever the stage stored: the accounts, amounts and dates
 * Claude was shown, resolved to ids at staging time. There is no way here to supply a different
 * account or amount, and the stage is spent in the same transaction as the posting, so it cannot be
 * confirmed twice. The capability is checked again at this moment, not trusted from staging.
 */
import { withActor } from '@/db/client';
import type { StageKind } from '@/db/schema';
import { type Capability, requireCapability } from '@/lib/auth/roles';
import { approveBankTransaction } from '@/lib/banking/post';
import { excludeTransactions } from '@/app/(app)/banking/data';
import { createAccount } from '@/lib/ledger/accounts';
import { type LedgerDb, postJournalEntry } from '@/lib/ledger/post';

import { assertNotKey, describeError } from './errors';
import { accountPayloadSchema, bankPayloadSchema, journalPayloadSchema } from './stage';
import { lockStaging, markCommitted } from './staging';
import type { McpUser } from './types';

export const KIND_CAPABILITY: Record<StageKind, Capability> = {
  bank_decisions: 'bank.approve',
  journal_entry: 'ledger.post',
  new_account: 'settings.manage',
};

export interface BankCommitResult {
  posted: { txnId: string; entryNo: number }[];
  excluded: string[];
  failed: { txnId: string; reason: string }[];
}

export interface JournalCommitResult {
  entryNo: number;
  entryId: string;
}

export interface AccountCommitResult {
  accountId: string;
  code: string;
}

export type CommitResult =
  | { kind: 'bank_decisions'; result: BankCommitResult }
  | { kind: 'journal_entry'; result: JournalCommitResult }
  | { kind: 'new_account'; result: AccountCommitResult };

async function commitBank(tx: LedgerDb, payload: unknown, user: McpUser): Promise<BankCommitResult> {
  const { items } = bankPayloadSchema.parse(payload);
  const ctx = { userId: user.id, tx };
  const result: BankCommitResult = { posted: [], excluded: [], failed: [] };

  // Each row is its own savepoint: one refusal never undoes the others.
  for (const item of items) {
    try {
      if (item.action === 'exclude') {
        await excludeTransactions([item.txnId], ctx);
        result.excluded.push(item.txnId);
      } else {
        // Accept and personal post alike: the choice stored at staging, every field explicit.
        const done = await approveBankTransaction(
          {
            txnId: item.txnId,
            ...(item.accountId === undefined ? {} : { accountId: item.accountId }),
            ...(item.vendorId === undefined ? {} : { vendorId: item.vendorId }),
            ...(item.customerId === undefined ? {} : { customerId: item.customerId }),
            ...(item.channelId === undefined ? {} : { channelId: item.channelId }),
            ...(item.memo === undefined ? {} : { memo: item.memo }),
            ...(item.confirmedNew === true ? { confirmedNew: true } : {}),
          },
          ctx,
        );
        result.posted.push({ txnId: item.txnId, entryNo: done.entryNo });
      }
    } catch (error) {
      result.failed.push({ txnId: item.txnId, reason: describeError(error) });
    }
  }
  return result;
}

async function commitJournal(tx: LedgerDb, payload: unknown, user: McpUser): Promise<JournalCommitResult> {
  const entry = journalPayloadSchema.parse(payload);
  const posted = await postJournalEntry(
    {
      date: entry.date,
      ...(entry.memo === undefined ? {} : { memo: entry.memo }),
      sourceType: 'manual',
      lines: entry.lines.map((line) => ({
        accountId: line.accountId,
        debitCents: line.debitCents,
        creditCents: line.creditCents,
        ...(line.memo === undefined ? {} : { memo: line.memo }),
      })),
    },
    { userId: user.id, tx },
  );
  return { entryNo: posted.entryNo, entryId: posted.entryId };
}

async function commitAccount(tx: LedgerDb, payload: unknown, user: McpUser): Promise<AccountCommitResult> {
  const account = accountPayloadSchema.parse(payload);
  const created = await createAccount(
    {
      code: account.code,
      name: account.name,
      type: account.type,
      subtype: account.subtype,
      parentCode: account.parentCode,
      description: account.description,
    },
    { userId: user.id, tx },
  );
  return { accountId: created.id, code: created.code };
}

export interface CommitCtx {
  /** Tests run inside a rolled-back transaction; production leaves this out. */
  tx?: LedgerDb;
}

export async function commitStaged(user: McpUser, stageId: string, ctx: CommitCtx = {}): Promise<CommitResult> {
  assertNotKey(user);
  const run = async (tx: LedgerDb): Promise<CommitResult> => {
    const row = await lockStaging(tx, stageId, user.id);
    requireCapability(user.role, KIND_CAPABILITY[row.kind]);

    let outcome: CommitResult;
    switch (row.kind) {
      case 'bank_decisions':
        outcome = { kind: row.kind, result: await commitBank(tx, row.payload, user) };
        break;
      case 'journal_entry':
        outcome = { kind: row.kind, result: await commitJournal(tx, row.payload, user) };
        break;
      case 'new_account':
        outcome = { kind: row.kind, result: await commitAccount(tx, row.payload, user) };
        break;
    }
    await markCommitted(tx, row.id, outcome.result);
    return outcome;
  };

  return ctx.tx === undefined ? withActor(user.id, run) : ctx.tx.transaction(run);
}

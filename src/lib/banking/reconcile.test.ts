import { afterAll, describe, expect, it } from 'vitest';

// First: loads .env.local before '@/db/client' is imported anywhere below.
import { closeTestDb, hasDatabase, withRollback } from '@/lib/ledger/test-support';

import { randomUUID } from 'node:crypto';

import { and, eq, sql } from 'drizzle-orm';

import { accounts, appUsers, bankAccounts, bankTransactions, reconciliations } from '@/db/schema';
import { postgresErrorOf } from '@/lib/db-errors';
import { ACCOUNTS } from '@/lib/ledger/coa';
import { postOpeningBalances } from '@/lib/ledger/opening-balances';
import type { LedgerDb } from '@/lib/ledger/post';
import { reverseEntry } from '@/lib/ledger/reverse';

import { approveBankTransaction, unpostBankTransaction } from './post';
import {
  abandonReconciliation,
  clearedBalance,
  completeReconciliation,
  proposeStatement,
  reconciliationLines,
  startReconciliation,
  toggleCleared,
  undoReconciliation,
} from './reconcile';

// Everything below runs inside a transaction that is rolled back, on a throwaway bank
// account dated 2031, so neither the real Relay rows nor a real period is touched.

interface Fixture {
  tx: LedgerDb;
  ownerId: string | null;
  bankId: string;
  glId: string;
  supplies: string;
}

async function fixture(tx: LedgerDb, openingCents = 1_000_00): Promise<Fixture> {
  await tx.execute(sql`set constraints all immediate`);
  const tag = randomUUID().slice(0, 8);
  const [gl] = await tx
    .insert(accounts)
    .values({ code: `TR-${tag}`, name: `Test recon bank ${tag}`, type: 'asset', subtype: 'bank', isBank: true })
    .returning({ id: accounts.id });
  const [bank] = await tx
    .insert(bankAccounts)
    .values({
      accountId: gl.id,
      name: `TEST recon ${tag}`,
      kind: 'checking',
      openingBalanceCents: openingCents,
      openingDate: '2031-04-30',
    })
    .returning({ id: bankAccounts.id });
  const [owner] = await tx
    .select({ id: appUsers.id })
    .from(appUsers)
    .where(and(eq(appUsers.role, 'owner'), eq(appUsers.active, true)))
    .limit(1);
  const [supplies] = await tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.code, ACCOUNTS.OFFICE_SUPPLIES));
  return { tx, ownerId: owner?.id ?? null, bankId: bank.id, glId: gl.id, supplies: supplies.id };
}

async function txn(f: Fixture, date: string, amountCents: number, balanceCents: number | null = null): Promise<string> {
  const [row] = await f.tx
    .insert(bankTransactions)
    .values({
      bankAccountId: f.bankId,
      txnDate: date,
      description: 'TEST',
      descriptionNormalized: 'TEST',
      counterparty: 'TEST',
      amountCents,
      balanceCents,
      fingerprint: randomUUID(),
    })
    .returning({ id: bankTransactions.id });
  return row.id;
}

/** A May statement: opening $1,000.00, three rows, closing $1,000 − 100 − 25 + 300 = $1,175.00. */
async function mayStatement(f: Fixture) {
  const ctx = { userId: f.ownerId, tx: f.tx };
  await postOpeningBalances(ctx, { bankAccountIds: [f.bankId] });
  // Inserted out of order on the same day: the chain has to find the day's last row.
  const second = await txn(f, '2031-05-10', -25_00, 875_00);
  const first = await txn(f, '2031-05-10', -100_00, 900_00);
  const deposit = await txn(f, '2031-05-20', 300_00, 1_175_00);
  const june = await txn(f, '2031-06-02', -5_00, 1_170_00);
  for (const id of [first, second, june]) await approveBankTransaction({ txnId: id, accountId: f.supplies }, ctx);
  await approveBankTransaction(
    { txnId: deposit, accountId: (await f.tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.code, ACCOUNTS.MEMBER_CONTRIBUTIONS)))[0].id },
    ctx,
  );
  return { ctx, first, second, deposit, june };
}

afterAll(closeTestDb);

const T = 90_000;

describe.skipIf(!hasDatabase)('proposeStatement', () => {
  it(
    "reads a month's opening and closing balance off the running balance chain",
    async () => {
      await withRollback(async (tx) => {
        const f = await fixture(tx);
        await mayStatement(f);

        const may = await proposeStatement(f.bankId, '2031-05', tx);
        expect(may).toMatchObject({
          statementStartDate: '2031-05-01',
          statementDate: '2031-05-31',
          openingBalanceCents: 1_000_00,
          closingBalanceCents: 1_175_00,
          transactionCount: 3,
          netChangeCents: 175_00,
          basis: 'balance_chain',
          chainOk: true,
          ledgerBalanceCents: 1_175_00,
        });

        const june = await proposeStatement(f.bankId, '2031-06', tx);
        expect(june).toMatchObject({ openingBalanceCents: 1_175_00, closingBalanceCents: 1_170_00, transactionCount: 1 });

        const july = await proposeStatement(f.bankId, '2031-07', tx);
        expect(july).toMatchObject({ openingBalanceCents: 1_170_00, closingBalanceCents: 1_170_00, basis: 'carried_forward' });

        const april = await proposeStatement(f.bankId, '2031-04', tx);
        expect(april.basis).toBe('no_data');

        // A missing row shows up as a break on the day it happens.
        await txn(f, '2031-06-20', -10_00, 1_150_00);
        const broken = await proposeStatement(f.bankId, '2031-06', tx);
        expect(broken.chainOk).toBe(false);
        expect(broken.breaks).toEqual([{ date: '2031-06-20', expectedCents: 1_160_00, actualCents: 1_150_00 }]);
      });
    },
    T,
  );
});

describe.skipIf(!hasDatabase)('reconciliation', () => {
  it(
    'computes the cleared balance from the GL, refuses a non-zero difference and completes at zero',
    async () => {
      await withRollback(async (tx) => {
        const f = await fixture(tx);
        const { ctx, first, second, deposit, june } = await mayStatement(f);

        const started = await startReconciliation(
          { bankAccountId: f.bankId, statementStartDate: '2031-05-01', statementDate: '2031-05-31', closingBalanceCents: 1_175_00 },
          ctx,
        );
        // The opening-balance entry is the balance per bank on day one: already cleared.
        expect(started).toMatchObject({
          openingBalanceCents: 1_000_00,
          previouslyClearedCents: 1_000_00,
          openingDifferenceCents: 0,
          clearedBalanceCents: 1_000_00,
          differenceCents: 175_00,
        });

        const lines = await reconciliationLines(started.id, tx);
        expect(lines.map((l) => l.bankTransactionId).sort()).toEqual([first, second, deposit].sort());
        expect(lines.some((l) => l.bankTransactionId === june)).toBe(false);

        await toggleCleared({ reconciliationId: started.id, bankTransactionId: first, cleared: true }, ctx);
        const partial = await toggleCleared({ reconciliationId: started.id, bankTransactionId: deposit, cleared: true }, ctx);
        expect(partial.clearedBalanceCents).toBe(1_200_00);
        expect(partial.differenceCents).toBe(-25_00);

        await expect(completeReconciliation(started.id, ctx)).rejects.toMatchObject({ code: 'reconciliation_not_tied' });
        await expect(completeReconciliation(started.id, ctx)).rejects.toThrow(/\$25\.00 cleared too much/);

        // June is after the statement; an unposted row cannot be cleared.
        await expect(
          toggleCleared({ reconciliationId: started.id, bankTransactionId: june, cleared: true }, ctx),
        ).rejects.toMatchObject({ code: 'reconciliation_invalid' });
        const unposted = await txn(f, '2031-05-15', -1_00);
        await expect(
          toggleCleared({ reconciliationId: started.id, bankTransactionId: unposted, cleared: true }, ctx),
        ).rejects.toThrow(/Post this transaction/);

        const tied = await toggleCleared({ reconciliationId: started.id, bankTransactionId: second, cleared: true }, ctx);
        expect(tied.differenceCents).toBe(0);
        const done = await completeReconciliation(started.id, ctx);
        expect(done).toMatchObject({ status: 'completed', differenceCents: 0, clearedBalanceCents: 1_175_00, clearedCount: 3 });

        for (const id of [first, second, deposit]) {
          const [row] = await tx.select().from(bankTransactions).where(eq(bankTransactions.id, id));
          expect(row.reconciliationId).toBe(started.id);
          expect(row.reconciledAt).not.toBeNull();
        }

        // The database itself refuses a completed reconciliation that does not tie.
        await expect(
          tx.transaction((sp) =>
            sp.update(reconciliations).set({ differenceCents: 1 }).where(eq(reconciliations.id, started.id)),
          ),
        ).rejects.toThrow();

        // A completed reconciliation's items are locked.
        await expect(
          toggleCleared({ reconciliationId: started.id, bankTransactionId: first, cleared: false }, ctx),
        ).rejects.toMatchObject({ code: 'reconciliation_state' });

        // The next statement picks up where this one ended.
        await approveBankTransaction({ txnId: unposted, accountId: f.supplies }, ctx);
        const next = await startReconciliation(
          { bankAccountId: f.bankId, statementStartDate: '2031-06-01', statementDate: '2031-06-30', closingBalanceCents: 1_169_00, autoClear: true },
          ctx,
        );
        expect(next.openingBalanceCents).toBe(1_175_00);
        expect(next.previouslyClearedCents).toBe(1_175_00);
        // Auto-clear took June's row only; the late-posted May row stays outstanding.
        expect(next.clearedThisPeriodCents).toBe(-5_00);
        expect(next.differenceCents).toBe(-1_00);
        const withLate = await toggleCleared({ reconciliationId: next.id, bankTransactionId: unposted, cleared: true }, ctx);
        expect(withLate.differenceCents).toBe(0);
        await abandonReconciliation(next.id, ctx);
        expect((await clearedBalance(next.id, tx)).clearedCount).toBe(0);
      });
    },
    T,
  );

  it(
    'locks reconciled rows until an owner undoes the reconciliation',
    async () => {
      await withRollback(async (tx) => {
        const f = await fixture(tx);
        const { ctx, first } = await mayStatement(f);
        const recon = await startReconciliation(
          {
            bankAccountId: f.bankId,
            statementStartDate: '2031-05-01',
            statementDate: '2031-05-31',
            closingBalanceCents: 1_175_00,
            autoClear: true,
          },
          ctx,
        );
        expect(recon.differenceCents).toBe(0);
        await completeReconciliation(recon.id, ctx);

        await expect(unpostBankTransaction(first, ctx)).rejects.toMatchObject({ code: 'reconciled' });
        await expect(
          approveBankTransaction({ txnId: first, accountId: f.supplies }, ctx),
        ).rejects.toMatchObject({ code: 'reconciled' });

        // Even the banking module's own reversal of a reconciled entry is refused by the database.
        const [row] = await tx.select().from(bankTransactions).where(eq(bankTransactions.id, first));
        const reversal = await tx
          .transaction((sp) => reverseEntry(row.journalEntryId as string, { userId: f.ownerId, tx: sp, owner: 'bank' }))
          .then(() => null, (error: unknown) => error);
        expect(postgresErrorOf(reversal)?.message ?? '').toMatch(/completed bank reconciliation/);

        // Only an owner may undo.
        await expect(undoReconciliation(recon.id, { userId: null, tx })).rejects.toMatchObject({ code: 'not_permitted' });

        if (f.ownerId !== null) {
          const undone = await undoReconciliation(recon.id, ctx);
          expect(undone.status).toBe('in_progress');
          const [after] = await tx.select().from(bankTransactions).where(eq(bankTransactions.id, first));
          expect(after.reconciledAt).toBeNull();
          // Unlocked: it can now be unposted, which also takes it out of the reconciliation.
          await unpostBankTransaction(first, ctx);
          const summary = await clearedBalance(recon.id, tx);
          expect(summary.differenceCents).toBe(-100_00);
        }
      });
    },
    T,
  );

  it(
    'allows one reconciliation in progress per account, and statements only after the last completed one',
    async () => {
      await withRollback(async (tx) => {
        const f = await fixture(tx);
        const { ctx } = await mayStatement(f);
        const input = {
          bankAccountId: f.bankId,
          statementStartDate: '2031-05-01',
          statementDate: '2031-05-31',
          closingBalanceCents: 1_175_00,
          autoClear: true,
        };
        const may = await startReconciliation(input, ctx);
        await expect(startReconciliation({ ...input, statementDate: '2031-06-30' }, ctx)).rejects.toMatchObject({
          code: 'reconciliation_state',
        });
        await completeReconciliation(may.id, ctx);
        await expect(startReconciliation(input, ctx)).rejects.toMatchObject({ code: 'reconciliation_invalid' });
      });
    },
    T,
  );
});

import { afterAll, describe, expect, it } from 'vitest';

// First: loads .env.local before '@/db/client' is imported anywhere below.
import { closeTestDb, hasDatabase, withRollback } from '@/lib/ledger/test-support';

import { eq, sql } from 'drizzle-orm';

import { bankAccounts, bankTransactions, closeTasks, journalEntries, journalLines, reconciliations } from '@/db/schema';
import { accountId, makeBankAccount, makeBankLine } from '@/lib/arap/test-support';
import { ACCOUNTS } from '@/lib/ledger/coa';
import { periodFor } from '@/lib/ledger/periods';
import { type LedgerDb, postJournalEntry } from '@/lib/ledger/post';

import { runCheck } from './checks';
import {
  type ChecklistView,
  STANDARD_TASKS,
  closeMonth,
  completeCloseTask,
  createCloseChecklist,
  runCloseChecks,
  skipCloseTask,
} from './checklist';
import { isCloseError } from './errors';

afterAll(closeTestDb);

const YEAR = 2036;
const MONTH = 3;
const END = '2036-03-31';

function task(view: ChecklistView, key: string) {
  const found = view.tasks.find((t) => t.key === key);
  if (found === undefined) throw new Error(`No task ${key}.`);
  return found;
}

async function makeDraft(tx: LedgerDb, date: string): Promise<string> {
  const [entry] = await tx
    .insert(journalEntries)
    .values({ entryDate: date, memo: 'close test draft', status: 'draft', sourceType: 'manual' })
    .returning({ id: journalEntries.id });
  await tx.insert(journalLines).values({
    entryId: entry.id,
    lineNo: 1,
    accountId: await accountId(tx, ACCOUNTS.RENT),
    debitCents: 100,
    creditCents: 0,
  });
  return entry.id;
}

/** Completed reconciliations through the month end for every active bank account. */
async function reconcileEverything(tx: LedgerDb): Promise<void> {
  const active = await tx.select({ id: bankAccounts.id }).from(bankAccounts).where(eq(bankAccounts.active, true));
  for (const account of active) {
    await tx.insert(reconciliations).values({
      bankAccountId: account.id,
      statementStartDate: '2036-03-01',
      statementDate: END,
      openingBalanceCents: 0,
      closingBalanceCents: 0,
      clearedBalanceCents: 0,
      differenceCents: 0,
      status: 'completed',
      completedAt: new Date(),
    });
  }
}

describe.skipIf(!hasDatabase)('month-end close', () => {
  it(
    'blocks the close until every blocking task is done or skipped with a reason, then closes the period',
    async () => {
      await withRollback(async (tx) => {
        const ctx = { userId: null, tx };
        const created = await createCloseChecklist(YEAR, MONTH, ctx);
        expect(created.tasks.map((t) => t.key)).toEqual(STANDARD_TASKS.map((t) => t.key));
        // Creating again is harmless.
        expect((await createCloseChecklist(YEAR, MONTH, ctx)).checklist.id).toBe(created.checklist.id);

        // A month with a draft, an unreviewed bank line and a Square sale still in clearing.
        const draftId = await makeDraft(tx, '2036-03-10');
        const bank = await makeBankAccount(tx);
        const lineId = await makeBankLine(tx, bank.id, { date: '2036-03-05', amountCents: -4_500, description: 'AMAZON MKTP' });
        // Whatever the live books already carry in Square Clearing (deposits posted before
        // their settlements are imported) is the starting point.
        const [clearingBefore] = (await tx.execute(sql`
          select coalesce(sum(jl.debit_cents - jl.credit_cents), 0)::bigint as b
            from journal_lines jl
            join journal_entries je on je.id = jl.entry_id and je.status = 'posted'
            join accounts a on a.id = jl.account_id
           where a.code = ${ACCOUNTS.CLEARING_SQUARE} and je.entry_date <= ${END}::date`)) as unknown as { b: string }[];
        await postJournalEntry(
          {
            date: '2036-03-15',
            sourceType: 'manual',
            lines: [
              { accountCode: ACCOUNTS.CLEARING_SQUARE, debitCents: 30_000 },
              { accountCode: ACCOUNTS.SALES_SQUARE, creditCents: 30_000 },
            ],
          },
          ctx,
        );

        const checked = await runCloseChecks(created.checklist.id, ctx);
        expect(checked.checklist.status).toBe('in_progress');
        expect(task(checked, 'no_draft_entries').status).toBe('blocked');
        expect(task(checked, 'no_draft_entries').result?.message).toMatch(/1 draft entry/);
        expect(task(checked, 'bank_transactions_reviewed').status).toBe('blocked');
        expect(task(checked, 'bank_transactions_reviewed').result?.values).toEqual({ count: 1, netCents: -4_500 });
        expect(task(checked, 'bank_recs_complete').status).toBe('blocked');
        expect(task(checked, 'clearing_zero').status).toBe('blocked');
        expect(task(checked, 'clearing_zero').result?.values?.[ACCOUNTS.CLEARING_SQUARE]).toBe(
          Number(clearingBefore.b) + 30_000,
        );
        for (const key of ['ar_ties', 'ap_ties', 'trial_balance_balances', 'cogs_posted', 'recurring_raised']) {
          expect(task(checked, key).status, `${key}: ${task(checked, key).result?.message}`).toBe('done');
        }

        const refused: unknown = await closeMonth(created.checklist.id, ctx).catch((e: unknown) => e);
        expect(isCloseError(refused) && refused.code).toBe('blocked');
        if (!isCloseError(refused)) return;
        expect(refused.outstanding.map((t) => t.key).sort()).toEqual(
          [
            'accruals_booked',
            'bank_recs_complete',
            'bank_transactions_reviewed',
            'clearing_zero',
            'no_draft_entries',
            'review_statements',
          ].sort(),
        );
        expect((await periodFor(END, tx)).status).toBe('open');

        // An automatic task cannot be ticked by hand, and a skip needs a reason —
        // in the library and in the database.
        await expect(completeCloseTask(task(checked, 'clearing_zero').id, ctx)).rejects.toThrow(/checked automatically/);
        await expect(skipCloseTask(task(checked, 'clearing_zero').id, '   ', ctx)).rejects.toThrow(/Say why/);
        await expect(
          tx.transaction((sp) =>
            sp.update(closeTasks).set({ status: 'skipped', notes: null }).where(eq(closeTasks.id, task(checked, 'clearing_zero').id)),
          ),
        ).rejects.toThrow();

        // Fix what can be fixed; skip, with a reason, what legitimately stands.
        await tx.delete(journalEntries).where(eq(journalEntries.id, draftId));
        await tx.update(bankTransactions).set({ status: 'excluded' }).where(eq(bankTransactions.id, lineId));
        await reconcileEverything(tx);
        await skipCloseTask(task(checked, 'clearing_zero').id, 'Square payout for 3/15 settles 4/2; in transit.', ctx);
        await completeCloseTask(task(checked, 'accruals_booked').id, ctx, 'Nothing to accrue.');
        await completeCloseTask(task(checked, 'review_statements').id, ctx);

        // The close re-runs the checks: a draft that appears after they last passed still blocks it.
        const lateDraft = await makeDraft(tx, '2036-03-30');
        const stale: unknown = await closeMonth(created.checklist.id, ctx).catch((e: unknown) => e);
        expect(isCloseError(stale) && stale.outstanding.map((t) => t.key)).toEqual(['no_draft_entries']);
        await tx.delete(journalEntries).where(eq(journalEntries.id, lateDraft));

        const closed = await closeMonth(created.checklist.id, ctx);
        expect(closed.outstanding).toEqual([]);
        expect(closed.checklist.status).toBe('complete');
        expect(closed.periodStatus).toBe('closed');
        expect(task(closed, 'clearing_zero').status).toBe('skipped');
        expect(task(closed, 'clearing_zero').notes).toMatch(/in transit/);
        expect(task(closed, 'bank_recs_complete').status).toBe('done');

        await expect(skipCloseTask(task(closed, 'cogs_posted').id, 'late', ctx)).rejects.toThrow(/already closed/);
        await expect(
          postJournalEntry(
            {
              date: '2036-03-20',
              sourceType: 'manual',
              lines: [
                { accountCode: ACCOUNTS.RENT, debitCents: 1 },
                { accountCode: ACCOUNTS.OPERATING_CHECKING, creditCents: 1 },
              ],
            },
            ctx,
          ),
        ).rejects.toThrow(/closed/i);
      });
    },
    // Four full runs of the ten automatic checks (each a handful of round trips to
    // the remote pooler) plus the fixtures: about 70 s alone, more under a full suite.
    180_000,
  );

  it(
    'fails the inventory tie-out when the ledger carries inventory and there is no count',
    async () => {
      await withRollback(async (tx) => {
        const checkCtx = { year: YEAR, month: 4, start: '2036-04-01', end: '2036-04-30', exec: tx, options: {} };
        const before = await runCheck('inventory_tieout', checkCtx);
        await postJournalEntry(
          {
            date: '2036-04-10',
            sourceType: 'manual',
            lines: [
              { accountCode: ACCOUNTS.INVENTORY_INGREDIENTS, debitCents: 77_602 },
              { accountCode: ACCOUNTS.OPERATING_CHECKING, creditCents: 77_602 },
            ],
          },
          { userId: null, tx },
        );
        const after = await runCheck('inventory_tieout', checkCtx);
        expect(after.ok).toBe(false);
        expect(after.message).toMatch(/no count dated in the month/);
        expect(Number(after.values?.ledgerCents) - Number(before.values?.ledgerCents ?? 0)).toBe(77_602);

        // Within tolerance there is nothing to count.
        const tolerant = await runCheck('inventory_tieout', {
          ...checkCtx,
          options: { inventoryToleranceCents: Math.abs(Number(after.values?.ledgerCents)) },
        });
        expect(tolerant.ok).toBe(true);

        // A check that fails in the database is reported, and does not poison the transaction.
        const [row] = await tx.execute<{ one: number }>(sql`select 1 as one`);
        expect(Number(row.one)).toBe(1);
      });
    },
    60_000,
  );
});

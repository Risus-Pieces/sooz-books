import { afterAll, describe, expect, it } from 'vitest';

// First: loads .env.local before '@/db/client' is imported anywhere below.
import { accountIds, closeTestDb, firstChannelId, hasDatabase, withRollback } from './test-support';

import { and, asc, eq, sql } from 'drizzle-orm';

import { accountBalances, auditLog, journalEntries, journalLines } from '@/db/schema';
import { allocateCents, sumCents } from '@/lib/money';

import {
  accountActivity,
  trialBalance,
  trialBalanceTotals,
  type TrialBalanceRow,
} from './balances';
import {
  buildAccountTree,
  createAccount,
  deactivateAccount,
  flattenAccountTree,
  listAccounts,
  updateAccount,
} from './accounts';
import { ACCOUNTS } from './coa';
import {
  AccountInUseError,
  ClosedPeriodError,
  ControlAccountError,
  DuplicateAccountError,
  InvalidAmountError,
  InvalidDateError,
  InvalidReferenceError,
  UnbalancedEntryError,
  UnknownAccountError,
} from './errors';
import { closePeriod } from './periods';
import { type DraftLine, type LedgerDb, postJournalEntries, postJournalEntry } from './post';

const DATE = '2026-03-15';

async function countEntries(tx: LedgerDb): Promise<number> {
  const [row] = await tx.select({ n: sql<number>`count(*)::int` }).from(journalEntries);
  return Number(row.n);
}

/**
 * The text of a database refusal. Drizzle wraps driver errors in its own
 * "Failed query" message and hangs the original off `cause`, so a trigger's
 * message is only visible one level down.
 */
async function refusalText(work: Promise<unknown>): Promise<string> {
  const error: unknown = await work.then(() => null).catch((caught: unknown) => caught);
  expect(error).not.toBeNull();
  return String((error as { cause?: unknown }).cause ?? error);
}

async function balanceOf(tx: LedgerDb, code: string): Promise<number> {
  const [row] = await tx
    .select({ balance: accountBalances.balanceCents })
    .from(accountBalances)
    .where(eq(accountBalances.code, code));
  return Number(row?.balance ?? 0);
}

function sale(amountCents: number): DraftLine[] {
  return [
    { accountCode: ACCOUNTS.OPERATING_CHECKING, debitCents: amountCents, memo: 'deposit' },
    { accountCode: ACCOUNTS.SALES_DTC, creditCents: amountCents },
  ];
}

afterAll(closeTestDb);

describe.skipIf(!hasDatabase)('postJournalEntry', () => {
  it(
    'posts a balanced two-line entry and moves account_balances',
    async () => {
      await withRollback(async (tx) => {
        const cashBefore = await balanceOf(tx, ACCOUNTS.OPERATING_CHECKING);
        const salesBefore = await balanceOf(tx, ACCOUNTS.SALES_DTC);

        const posted = await postJournalEntry(
          {
            date: DATE,
            memo: 'Shopify payout',
            sourceType: 'manual',
            lines: sale(125_00),
          },
          { userId: null, tx },
        );

        expect(posted.entryId).toMatch(/^[0-9a-f-]{36}$/);
        expect(posted.entryNo).toBeGreaterThan(0);

        const [entry] = await tx
          .select()
          .from(journalEntries)
          .where(eq(journalEntries.id, posted.entryId));
        expect(entry.status).toBe('posted');
        expect(entry.entryDate).toBe(DATE);
        expect(entry.sourceType).toBe('manual');
        expect(entry.postedAt).not.toBeNull();

        const lines = await tx
          .select()
          .from(journalLines)
          .where(eq(journalLines.entryId, posted.entryId))
          .orderBy(asc(journalLines.lineNo));
        expect(lines.map((l) => l.lineNo)).toEqual([1, 2]);
        expect(lines.map((l) => l.debitCents)).toEqual([125_00, 0]);
        expect(lines.map((l) => l.creditCents)).toEqual([0, 125_00]);
        expect(lines[0].memo).toBe('deposit');

        // Assets are debit-normal and revenue credit-normal, so both rise.
        expect(await balanceOf(tx, ACCOUNTS.OPERATING_CHECKING)).toBe(cashBefore + 125_00);
        expect(await balanceOf(tx, ACCOUNTS.SALES_DTC)).toBe(salesBefore + 125_00);
      });
    },
    30_000,
  );

  it(
    'carries the dimensions and the account id form of a line',
    async () => {
      await withRollback(async (tx) => {
        const channelId = await firstChannelId(tx);
        const ids = await accountIds(tx, [ACCOUNTS.OPERATING_CHECKING, ACCOUNTS.SALES_DTC]);

        const posted = await postJournalEntry(
          {
            date: DATE,
            sourceType: 'bank',
            lines: [
              { accountId: ids.get(ACCOUNTS.OPERATING_CHECKING), debitCents: 50_00, channelId },
              { accountCode: ACCOUNTS.SALES_DTC, creditCents: 50_00, channelId },
            ],
          },
          { userId: null, tx },
        );

        const lines = await tx
          .select()
          .from(journalLines)
          .where(eq(journalLines.entryId, posted.entryId))
          .orderBy(asc(journalLines.lineNo));
        expect(lines.map((l) => l.channelId)).toEqual([channelId, channelId]);
        expect(lines[0].accountId).toBe(ids.get(ACCOUNTS.OPERATING_CHECKING));
      });
    },
    30_000,
  );

  it(
    'rejects an unbalanced entry before it reaches the database',
    async () => {
      await withRollback(async (tx) => {
        const before = await countEntries(tx);

        await expect(
          postJournalEntry(
            {
              date: DATE,
              sourceType: 'manual',
              lines: [
                { accountCode: ACCOUNTS.OPERATING_CHECKING, debitCents: 100_00 },
                { accountCode: ACCOUNTS.SALES_DTC, creditCents: 99_00 },
              ],
            },
            { userId: null, tx },
          ),
        ).rejects.toBeInstanceOf(UnbalancedEntryError);

        // Nothing was written: the check happens before the first statement.
        expect(await countEntries(tx)).toBe(before);
      });
    },
    30_000,
  );

  it('reports both sides on an unbalanced entry', async () => {
    await expect(
      postJournalEntry(
        {
          date: DATE,
          sourceType: 'manual',
          lines: [
            { accountCode: ACCOUNTS.OPERATING_CHECKING, debitCents: 100_00 },
            { accountCode: ACCOUNTS.SALES_DTC, creditCents: 99_00 },
          ],
        },
        { userId: null },
      ),
    ).rejects.toMatchObject({ code: 'unbalanced_entry', debitCents: 100_00, creditCents: 99_00 });
  });

  it('rejects a one-line entry', async () => {
    await expect(
      postJournalEntry(
        {
          date: DATE,
          sourceType: 'manual',
          lines: [{ accountCode: ACCOUNTS.OPERATING_CHECKING, debitCents: 100_00 }],
        },
        { userId: null },
      ),
    ).rejects.toBeInstanceOf(UnbalancedEntryError);
  });

  it('rejects amounts that are not usable cents', async () => {
    const bad: DraftLine[][] = [
      [
        { accountCode: ACCOUNTS.OPERATING_CHECKING, debitCents: -100 },
        { accountCode: ACCOUNTS.SALES_DTC, creditCents: -100 },
      ],
      [
        { accountCode: ACCOUNTS.OPERATING_CHECKING, debitCents: 10.5 },
        { accountCode: ACCOUNTS.SALES_DTC, creditCents: 10.5 },
      ],
      [
        { accountCode: ACCOUNTS.OPERATING_CHECKING, debitCents: 100, creditCents: 100 },
        { accountCode: ACCOUNTS.SALES_DTC, creditCents: 100 },
      ],
      [
        { accountCode: ACCOUNTS.OPERATING_CHECKING },
        { accountCode: ACCOUNTS.SALES_DTC, creditCents: 100 },
      ],
    ];

    for (const lines of bad) {
      await expect(
        postJournalEntry({ date: DATE, sourceType: 'manual', lines }, { userId: null }),
      ).rejects.toBeInstanceOf(InvalidAmountError);
    }
  });

  it('rejects a date that is not a calendar date', async () => {
    await expect(
      postJournalEntry(
        { date: '2026-02-30', sourceType: 'manual', lines: sale(100) },
        { userId: null },
      ),
    ).rejects.toBeInstanceOf(InvalidDateError);
  });

  it(
    'rejects an account code that does not exist',
    async () => {
      await withRollback(async (tx) => {
        await expect(
          postJournalEntry(
            {
              date: DATE,
              sourceType: 'manual',
              lines: [
                { accountCode: '9999', debitCents: 100 },
                { accountCode: ACCOUNTS.SALES_DTC, creditCents: 100 },
              ],
            },
            { userId: null, tx },
          ),
        ).rejects.toBeInstanceOf(UnknownAccountError);
      });
    },
    30_000,
  );

  it(
    'refuses a manual entry against a control account',
    async () => {
      await withRollback(async (tx) => {
        const before = await countEntries(tx);

        await expect(
          postJournalEntry(
            {
              date: DATE,
              memo: 'nudge AR',
              sourceType: 'manual',
              lines: [
                { accountCode: ACCOUNTS.AR, debitCents: 500_00 },
                { accountCode: ACCOUNTS.SALES_DTC, creditCents: 500_00 },
              ],
            },
            { userId: null, tx },
          ),
        ).rejects.toBeInstanceOf(ControlAccountError);

        expect(await countEntries(tx)).toBe(before);
      });
    },
    30_000,
  );

  it(
    'allows a sub-ledger entry against the same control account',
    async () => {
      await withRollback(async (tx) => {
        const arBefore = await balanceOf(tx, ACCOUNTS.AR);

        const posted = await postJournalEntry(
          {
            date: DATE,
            memo: 'Invoice 1001',
            sourceType: 'invoice',
            lines: [
              { accountCode: ACCOUNTS.AR, debitCents: 500_00 },
              { accountCode: ACCOUNTS.SALES_DISTRIBUTOR, creditCents: 500_00 },
            ],
          },
          { userId: null, tx },
        );

        expect(posted.entryNo).toBeGreaterThan(0);
        expect(await balanceOf(tx, ACCOUNTS.AR)).toBe(arBefore + 500_00);
      });
    },
    30_000,
  );

  it(
    'refuses to post into a closed period',
    async () => {
      await withRollback(async (tx) => {
        await closePeriod(2026, 3, null, { tx });

        const error = await postJournalEntry(
          { date: DATE, sourceType: 'manual', lines: sale(100_00) },
          { userId: null, tx },
        ).catch((e: unknown) => e);

        expect(error).toBeInstanceOf(ClosedPeriodError);
        expect((error as ClosedPeriodError).year).toBe(2026);
        expect((error as ClosedPeriodError).month).toBe(3);
        expect((error as ClosedPeriodError).message).toContain('2026-03');
      });
    },
    30_000,
  );

  it(
    'keeps an allocated split in balance',
    async () => {
      await withRollback(async (tx) => {
        // A freight bill spread over three cost accounts by case count: the
        // remainder cent has to land somewhere, and the entry must still balance.
        const total = 1_000_01;
        const parts = allocateCents(total, [3, 1, 1]);
        expect(sumCents(parts)).toBe(total);

        const codes = [
          ACCOUNTS.OUTBOUND_FREIGHT,
          ACCOUNTS.WAREHOUSE_3PL_FEES,
          ACCOUNTS.PICK_PACK_FEES,
        ];

        const posted = await postJournalEntry(
          {
            date: DATE,
            memo: 'Freight allocation',
            sourceType: 'manual',
            lines: [
              ...parts.map((cents, i) => ({ accountCode: codes[i], debitCents: cents })),
              { accountCode: ACCOUNTS.OPERATING_CHECKING, creditCents: total },
            ],
          },
          { userId: null, tx },
        );

        const lines = await tx
          .select()
          .from(journalLines)
          .where(eq(journalLines.entryId, posted.entryId))
          .orderBy(asc(journalLines.lineNo));
        expect(lines.map((l) => l.lineNo)).toEqual([1, 2, 3, 4]);
        expect(sumCents(lines.map((l) => l.debitCents))).toBe(
          sumCents(lines.map((l) => l.creditCents)),
        );
      });
    },
    30_000,
  );

  it(
    'posts a batch atomically and writes nothing when one entry is bad',
    async () => {
      await withRollback(async (tx) => {
        const before = await countEntries(tx);

        await expect(
          postJournalEntries(
            [
              { date: DATE, sourceType: 'manual', lines: sale(10_00) },
              {
                date: DATE,
                sourceType: 'manual',
                lines: [
                  { accountCode: ACCOUNTS.OPERATING_CHECKING, debitCents: 10_00 },
                  { accountCode: ACCOUNTS.SALES_DTC, creditCents: 9_00 },
                ],
              },
            ],
            { userId: null, tx },
          ),
        ).rejects.toBeInstanceOf(UnbalancedEntryError);
        expect(await countEntries(tx)).toBe(before);

        const posted = await postJournalEntries(
          [
            { date: DATE, sourceType: 'manual', lines: sale(10_00) },
            { date: DATE, sourceType: 'manual', lines: sale(20_00) },
          ],
          { userId: null, tx },
        );
        expect(posted).toHaveLength(2);
        expect(await countEntries(tx)).toBe(before + 2);
      });
    },
    30_000,
  );

  it(
    'leaves the trial balance in balance and the register readable',
    async () => {
      await withRollback(async (tx) => {
        await postJournalEntry(
          { date: '2026-03-02', memo: 'first', sourceType: 'manual', lines: sale(40_00) },
          { userId: null, tx },
        );
        await postJournalEntry(
          { date: '2026-03-20', memo: 'second', sourceType: 'manual', lines: sale(60_00) },
          { userId: null, tx },
        );

        const rows = await trialBalance({ asOf: '2026-03-31' }, tx);
        const totals = trialBalanceTotals(rows);
        expect(totals.debitCents).toBe(totals.creditCents);

        const ids = await accountIds(tx, [ACCOUNTS.OPERATING_CHECKING]);
        const cashId = ids.get(ACCOUNTS.OPERATING_CHECKING) as string;

        const register = await accountActivity(
          { accountId: cashId, from: '2026-03-10', to: '2026-03-31' },
          tx,
        );
        // The 2 March entry is before the window, so it is the opening balance.
        expect(register.code).toBe(ACCOUNTS.OPERATING_CHECKING);
        expect(register.closingCents - register.openingCents).toBe(60_00);
        expect(register.lines.map((l) => l.debitCents)).toContain(60_00);
        expect(register.lines.every((l) => l.date >= '2026-03-10')).toBe(true);
      });
    },
    30_000,
  );
});

describe.skipIf(!hasDatabase)('the chart of accounts at runtime', () => {
  it(
    'creates an account, then refuses to retire it once it has history',
    async () => {
      await withRollback(async (tx) => {
        const created = await createAccount(
          {
            code: '6795',
            name: 'Courier Services',
            type: 'expense',
            parentCode: ACCOUNTS.GENERAL_ADMIN,
            subtype: 'opex',
          },
          { userId: null, tx },
        );
        expect(created.code).toBe('6795');
        expect(created.active).toBe(true);
        expect(created.parentId).not.toBeNull();

        await expect(
          createAccount({ code: '6795', name: 'Duplicate', type: 'expense' }, { userId: null, tx }),
        ).rejects.toBeInstanceOf(DuplicateAccountError);

        // A parent of a different type would misfile the child on every report.
        await expect(
          createAccount(
            { code: '6796', name: 'Wrong parent', type: 'expense', parentCode: ACCOUNTS.AR },
            { userId: null, tx },
          ),
        ).rejects.toBeInstanceOf(InvalidReferenceError);

        // Unused, so it can simply go.
        const retired = await deactivateAccount(created.id, { userId: null, tx });
        expect(retired.active).toBe(false);

        const reopened = await updateAccount(created.id, { active: true }, { userId: null, tx });
        expect(reopened.active).toBe(true);

        await postJournalEntry(
          {
            date: DATE,
            sourceType: 'manual',
            lines: [
              { accountCode: '6795', debitCents: 15_00 },
              { accountCode: ACCOUNTS.OPERATING_CHECKING, creditCents: 15_00 },
            ],
          },
          { userId: null, tx },
        );

        await expect(
          deactivateAccount(created.id, { userId: null, tx }),
        ).rejects.toBeInstanceOf(AccountInUseError);

        const succeeded = await deactivateAccount(created.id, {
          userId: null,
          tx,
          successorCode: ACCOUNTS.MISC_OPERATING_EXPENSE,
        });
        expect(succeeded.active).toBe(false);
        expect(succeeded.description).toContain(ACCOUNTS.MISC_OPERATING_EXPENSE);

        // And a deactivated account is no longer a place to post.
        await expect(
          postJournalEntry(
            {
              date: DATE,
              sourceType: 'manual',
              lines: [
                { accountCode: '6795', debitCents: 1_00 },
                { accountCode: ACCOUNTS.OPERATING_CHECKING, creditCents: 1_00 },
              ],
            },
            { userId: null, tx },
          ),
        ).rejects.toMatchObject({ code: 'unknown_account', reason: 'inactive' });
      });
    },
    30_000,
  );

  it(
    'nests the seeded chart under its parents',
    async () => {
      await withRollback(async (tx) => {
        const all = await listAccounts({}, tx);
        const tree = buildAccountTree(all);
        const flat = flattenAccountTree(tree);

        expect(flat).toHaveLength(all.length);
        expect(tree.every((node) => node.parentId === null)).toBe(true);
        expect(tree.map((node) => node.code)).toEqual(
          [...tree].map((node) => node.code).sort((a, b) => a.localeCompare(b)),
        );

        const inventory = flat.find((node) => node.code === ACCOUNTS.INVENTORY);
        expect(inventory?.children.map((child) => child.code)).toContain(
          ACCOUNTS.INVENTORY_FINISHED,
        );
        expect(flat.find((node) => node.code === ACCOUNTS.INVENTORY_FINISHED)?.depth).toBe(
          (inventory?.depth ?? 0) + 1,
        );
      });
    },
    30_000,
  );
});

describe.skipIf(!hasDatabase)('trial balance basis', () => {
  it(
    'leaves an accrual document out of the cash basis',
    async () => {
      await withRollback(async (tx) => {
        const accrualBefore = await trialBalance({ asOf: '2026-03-31', basis: 'accrual' }, tx);
        const cashBefore = await trialBalance({ asOf: '2026-03-31', basis: 'cash' }, tx);
        const balanceOfRow = (rows: readonly TrialBalanceRow[], code: string): number =>
          rows.find((row) => row.code === code)?.balanceCents ?? 0;
        const baseAccrualSales = balanceOfRow(accrualBefore, ACCOUNTS.SALES_DISTRIBUTOR);
        const baseCashSales = balanceOfRow(cashBefore, ACCOUNTS.SALES_DISTRIBUTOR);
        const baseAccrualCash = balanceOfRow(accrualBefore, ACCOUNTS.OPERATING_CHECKING);
        const baseCashCash = balanceOfRow(cashBefore, ACCOUNTS.OPERATING_CHECKING);
        const baseAccrualAr = balanceOfRow(accrualBefore, ACCOUNTS.AR);

        await postJournalEntry(
          {
            date: '2026-03-04',
            memo: 'Invoice 3003',
            sourceType: 'invoice',
            lines: [
              { accountCode: ACCOUNTS.AR, debitCents: 900_00 },
              { accountCode: ACCOUNTS.SALES_DISTRIBUTOR, creditCents: 900_00 },
            ],
          },
          { userId: null, tx },
        );
        await postJournalEntry(
          {
            date: '2026-03-05',
            memo: 'Payment on 3003',
            sourceType: 'receipt',
            lines: [
              { accountCode: ACCOUNTS.OPERATING_CHECKING, debitCents: 900_00 },
              { accountCode: ACCOUNTS.AR, creditCents: 900_00 },
            ],
          },
          { userId: null, tx },
        );

        const accrual = await trialBalance({ asOf: '2026-03-31', basis: 'accrual' }, tx);
        const cash = await trialBalance({ asOf: '2026-03-31', basis: 'cash' }, tx);

        const balanceIn = (rows: readonly TrialBalanceRow[], code: string): number =>
          rows.find((row) => row.code === code)?.balanceCents ?? 0;

        // The invoice never touched a bank account, so the cash basis never saw
        // the revenue; the payment did, so both bases see the deposit.
        // Revenue is credit-normal, so a sale reads positive here.
        expect(balanceIn(accrual, ACCOUNTS.SALES_DISTRIBUTOR) - baseAccrualSales).toBe(900_00);
        expect(balanceIn(cash, ACCOUNTS.SALES_DISTRIBUTOR) - baseCashSales).toBe(0);
        expect(balanceIn(accrual, ACCOUNTS.OPERATING_CHECKING) - baseAccrualCash).toBe(900_00);
        expect(balanceIn(cash, ACCOUNTS.OPERATING_CHECKING) - baseCashCash).toBe(900_00);

        // Invoice and payment cancel in receivables on the accrual basis.
        expect(balanceIn(accrual, ACCOUNTS.AR) - baseAccrualAr).toBe(0);

        expect(trialBalanceTotals(accrual).debitCents).toBe(
          trialBalanceTotals(accrual).creditCents,
        );
        expect(trialBalanceTotals(cash).debitCents).toBe(trialBalanceTotals(cash).creditCents);
      });
    },
    30_000,
  );
});

/**
 * The invariants live in the database, and the engine's whole shape — draft,
 * then lines, then post, inside one transaction — exists to satisfy them. The
 * balance check is a constraint trigger deferred to COMMIT, which a rolled-back
 * test would never fire; `set constraints all immediate` runs the pending checks
 * on the spot instead, so these tests exercise the real triggers and still leave
 * the database untouched.
 */
describe.skipIf(!hasDatabase)('the database invariants behind the engine', () => {
  it(
    'satisfies the deferred balance check when it is forced to run',
    async () => {
      await withRollback(async (tx) => {
        const posted = await postJournalEntry(
          { date: DATE, memo: 'deferred check', sourceType: 'manual', lines: sale(42_00) },
          { userId: null, tx },
        );

        await tx.execute(sql`set constraints all immediate`);

        const [entry] = await tx
          .select()
          .from(journalEntries)
          .where(eq(journalEntries.id, posted.entryId));
        expect(entry.status).toBe('posted');
      });
    },
    30_000,
  );

  it(
    'records the entry and every line in the audit log',
    async () => {
      await withRollback(async (tx) => {
        const posted = await postJournalEntry(
          { date: DATE, memo: 'audited', sourceType: 'manual', lines: sale(12_34) },
          { userId: null, tx },
        );

        const entryAudit = await tx
          .select({ op: auditLog.op })
          .from(auditLog)
          .where(and(eq(auditLog.tableName, 'journal_entries'), eq(auditLog.rowId, posted.entryId)))
          .orderBy(asc(auditLog.id));
        // Inserted as a draft, then updated to posted.
        expect(entryAudit.map((row) => row.op)).toEqual(['INSERT', 'UPDATE']);

        const lines = await tx
          .select({ id: journalLines.id })
          .from(journalLines)
          .where(eq(journalLines.entryId, posted.entryId));
        const lineAudit = await tx
          .select({ rowId: auditLog.rowId })
          .from(auditLog)
          .where(eq(auditLog.tableName, 'journal_lines'));
        for (const line of lines) {
          expect(lineAudit.map((row) => row.rowId)).toContain(line.id);
        }
      });
    },
    30_000,
  );

  it(
    'refuses a one-line entry and an unbalanced one at the constraint check',
    async () => {
      await withRollback(async (tx) => {
        const ids = await accountIds(tx, [ACCOUNTS.OPERATING_CHECKING, ACCOUNTS.SALES_DTC]);
        const cash = ids.get(ACCOUNTS.OPERATING_CHECKING) as string;
        const sales = ids.get(ACCOUNTS.SALES_DTC) as string;

        // Each attempt runs in its own savepoint: the failure aborts that
        // savepoint and leaves the surrounding test transaction usable.
        const attempt = (lines: { accountId: string; debitCents?: number; creditCents?: number }[]) =>
          tx.transaction(async (sp) => {
            const [entry] = await sp
              .insert(journalEntries)
              .values({ entryDate: DATE, status: 'draft', sourceType: 'manual' })
              .returning({ id: journalEntries.id });
            await sp.insert(journalLines).values(
              lines.map((line, index) => ({
                entryId: entry.id,
                lineNo: index + 1,
                accountId: line.accountId,
                debitCents: line.debitCents ?? 0,
                creditCents: line.creditCents ?? 0,
              })),
            );
            await sp
              .update(journalEntries)
              .set({ status: 'posted' })
              .where(eq(journalEntries.id, entry.id));
            await sp.execute(sql`set constraints all immediate`);
          });

        expect(await refusalText(attempt([{ accountId: cash, debitCents: 100 }]))).toMatch(
          /at least two lines/,
        );
        expect(
          await refusalText(
            attempt([
              { accountId: cash, debitCents: 100 },
              { accountId: sales, creditCents: 99 },
            ]),
          ),
        ).toMatch(/out of balance/);
      });
    },
    30_000,
  );

  it(
    'will not let a line be added to an entry that is already posted',
    async () => {
      await withRollback(async (tx) => {
        const posted = await postJournalEntry(
          { date: DATE, sourceType: 'manual', lines: sale(5_00) },
          { userId: null, tx },
        );
        const ids = await accountIds(tx, [ACCOUNTS.OPERATING_CHECKING]);

        // This is why the engine inserts the lines before flipping the status:
        // the other order is not available to it.
        expect(
          await refusalText(
            tx.transaction(async (sp) => {
              await sp.insert(journalLines).values({
                entryId: posted.entryId,
                lineNo: 3,
                accountId: ids.get(ACCOUNTS.OPERATING_CHECKING) as string,
                debitCents: 1,
              });
            }),
          ),
        ).toMatch(/lines of a posted journal entry/);

        const lines = await tx
          .select()
          .from(journalLines)
          .where(eq(journalLines.entryId, posted.entryId));
        expect(lines).toHaveLength(2);
      });
    },
    30_000,
  );
});

import { afterAll, describe, expect, it } from 'vitest';

// First: loads .env.local before '@/db/client' is imported anywhere below.
import { closeTestDb, hasDatabase, withRollback } from '@/lib/ledger/test-support';

import { eq } from 'drizzle-orm';

import { accounts, budgetVersions } from '@/db/schema';
import { ACCOUNTS } from '@/lib/ledger/coa';
import { type LedgerDb, postJournalEntry } from '@/lib/ledger/post';
import type { Report, ReportRow } from '@/lib/reports/types';

import {
  activateBudgetVersion,
  copyBudgetFromActuals,
  createBudgetVersion,
  importBudgetCsv,
  listBudgetLines,
  monthOfHeader,
  setBudgetLines,
} from './budget';
import { BVA_ROWS, budgetVsActual } from './budget-vs-actual';
import { isPlanningError } from './errors';

afterAll(closeTestDb);

/** Years no real or fixture activity uses. */
const YEAR = 2032;

function findRow(report: Report, predicate: (row: ReportRow) => boolean, what: string): ReportRow {
  const found = report.rows.find(predicate);
  if (found === undefined) throw new Error(`No row for ${what}. Rows: ${report.rows.map((r) => r.id).join(', ')}`);
  return found;
}

async function accountIdOf(tx: LedgerDb, code: string): Promise<string> {
  const [row] = await tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.code, code));
  return row.id;
}

async function postActuals(tx: LedgerDb): Promise<void> {
  const ctx = { userId: null, tx };
  const post = (date: string, lines: Array<{ accountCode: string; debitCents?: number; creditCents?: number }>) =>
    postJournalEntry({ date, sourceType: 'manual', lines }, ctx);
  await post(`${YEAR}-01-05`, [
    { accountCode: ACCOUNTS.RENT, debitCents: 160_000 },
    { accountCode: ACCOUNTS.OPERATING_CHECKING, creditCents: 160_000 },
  ]);
  await post(`${YEAR}-01-20`, [
    { accountCode: ACCOUNTS.CLEARING_SQUARE, debitCents: 28_000 },
    { accountCode: ACCOUNTS.SALES_SQUARE, creditCents: 28_000 },
  ]);
  await post(`${YEAR}-01-20`, [
    { accountCode: ACCOUNTS.MARKETPLACE_FEES, debitCents: 1_200 },
    { accountCode: ACCOUNTS.CLEARING_SQUARE, creditCents: 1_200 },
  ]);
  await post(`${YEAR}-02-11`, [
    { accountCode: ACCOUNTS.CLEARING_SQUARE, debitCents: 12_345 },
    { accountCode: ACCOUNTS.SALES_SQUARE, creditCents: 12_345 },
  ]);
}

describe('month headers', () => {
  it('reads the forms a spreadsheet uses', () => {
    expect(monthOfHeader('Jan', 2032)).toBe(1);
    expect(monthOfHeader('September', 2032)).toBe(9);
    expect(monthOfHeader('Sept', 2032)).toBe(9);
    expect(monthOfHeader('Mar 2032', 2032)).toBe(3);
    expect(monthOfHeader('2032-11', 2032)).toBe(11);
    expect(monthOfHeader('12/2032', 2032)).toBe(12);
    expect(monthOfHeader('7', 2032)).toBe(7);
    expect(monthOfHeader('Total', 2032)).toBeNull();
    expect(monthOfHeader('Notes', 2032)).toBeNull();
    expect(() => monthOfHeader('2031-01', 2032)).toThrow(/is for 2031/);
  });
});

describe.skipIf(!hasDatabase)('budget versions', () => {
  it(
    'keeps one active version per year',
    async () => {
      await withRollback(async (tx) => {
        const ctx = { userId: null, tx };
        const a = await createBudgetVersion({ name: 'Plan A', fiscalYear: YEAR }, ctx);
        const b = await createBudgetVersion({ name: 'Plan B', fiscalYear: YEAR }, ctx);
        await activateBudgetVersion(a.id, ctx);
        await activateBudgetVersion(b.id, ctx);
        const rows = await tx.select().from(budgetVersions).where(eq(budgetVersions.fiscalYear, YEAR));
        const status = new Map(rows.map((r) => [r.name, r.status]));
        expect(status.get('Plan A')).toBe('archived');
        expect(status.get('Plan B')).toBe('active');
        await expect(createBudgetVersion({ name: 'Plan A', fiscalYear: YEAR }, ctx)).rejects.toThrow(/already exists/);
      });
    },
    30_000,
  );
});

describe.skipIf(!hasDatabase)('budget CSV import and budget vs actual', () => {
  it(
    'refuses a file with any bad row and writes nothing',
    async () => {
      await withRollback(async (tx) => {
        const ctx = { userId: null, tx };
        const version = await createBudgetVersion({ name: 'Bad file', fiscalYear: YEAR }, ctx);
        const csv = ['Account,Jan,Feb', '6000 Operating Expenses,100,100', '9999,1,1', '6510,abc,5', '1011,5,5'].join('\n');
        const error: unknown = await importBudgetCsv(version.id, csv, ctx).catch((caught: unknown) => caught);
        expect(isPlanningError(error)).toBe(true);
        if (!isPlanningError(error)) return;
        expect(error.code).toBe('import_refused');
        expect(error.details.some((d) => d.includes('6000') && d.includes('heading'))).toBe(true);
        expect(error.details.some((d) => d.includes('9999'))).toBe(true);
        expect(error.details.some((d) => d.startsWith('Row 4, Jan'))).toBe(true);
        expect(error.details.some((d) => d.includes('1011') && d.includes('asset'))).toBe(true);
        expect(await listBudgetLines(version.id, tx)).toHaveLength(0);
      });
    },
    30_000,
  );

  it(
    'imports a grid and compares it with actuals, variance and variance % exact',
    async () => {
      await withRollback(async (tx) => {
        const ctx = { userId: null, tx };
        const version = await createBudgetVersion({ name: 'Launch plan', fiscalYear: YEAR }, ctx);
        await activateBudgetVersion(version.id, ctx);
        const csv = [
          'Account,Channel,Jan,Feb,2032-03',
          '6510 Rent & Occupancy,,"$1,500.00",1500,1500',
          '4015,,250,300,',
          '4570,,10.00,10,10',
        ].join('\n');
        const result = await importBudgetCsv(version.id, csv, ctx);
        expect(result).toEqual({ cellsWritten: 8, rowsRead: 3, cellsRemoved: 0 });

        // Re-importing the same cell replaces it rather than adding a second one.
        await setBudgetLines(version.id, [{ accountCode: ACCOUNTS.RENT, month: 1, amountCents: 150_000 }], ctx);
        expect(await listBudgetLines(version.id, tx)).toHaveLength(8);

        await postActuals(tx);
        const report = await budgetVsActual({ from: `${YEAR}-01-01`, to: `${YEAR}-01-31` }, tx);
        expect(report.version.id).toBe(version.id);
        expect(report.columns.map((c) => c.kind)).toEqual(['amount', 'amount', 'variance', 'variance_pct']);

        const rentId = await accountIdOf(tx, ACCOUNTS.RENT);
        const rent = findRow(report, (r) => r.accountId === rentId && r.style === 'detail', 'rent');
        // 10,000 / 150,000 = 6.667% → 667 basis points.
        expect(rent.values).toEqual([160_000, 150_000, 10_000, 667]);

        const salesId = await accountIdOf(tx, ACCOUNTS.SALES_SQUARE);
        expect(findRow(report, (r) => r.accountId === salesId && r.style === 'detail', 'sales').values).toEqual([
          28_000, 25_000, 3_000, 1_200,
        ]);
        // A contra-revenue deduction reads positive on both sides.
        const feeId = await accountIdOf(tx, ACCOUNTS.MARKETPLACE_FEES);
        expect(findRow(report, (r) => r.accountId === feeId && r.style === 'detail', 'fees').values).toEqual([
          1_200, 1_000, 200, 2_000,
        ]);
        expect(findRow(report, (r) => r.id === BVA_ROWS.netSales, 'net sales').values).toEqual([
          26_800, 24_000, 2_800, 1_167,
        ]);
        // −7,200 / |−126,000| = −5.714% → −571.
        expect(findRow(report, (r) => r.id === BVA_ROWS.netIncome, 'net income').values).toEqual([
          -133_200, -126_000, -7_200, -571,
        ]);
        expect(report.totals.netIncome).toEqual({ actualCents: -133_200, budgetCents: -126_000 });
        for (const r of report.rows) {
          if (r.style === 'section') continue;
          expect(r.values[2], r.label).toBe(r.values[0] - r.values[1]);
        }

        // A quarter picks up every month's budget.
        const quarter = await budgetVsActual({ from: `${YEAR}-01-01`, to: `${YEAR}-03-31`, versionId: version.id }, tx);
        expect(findRow(quarter, (r) => r.accountId === rentId && r.style === 'detail', 'rent').values.slice(0, 2)).toEqual([
          160_000, 450_000,
        ]);
        expect(quarter.meta.warnings).toHaveLength(0);
        const partial = await budgetVsActual({ from: `${YEAR}-01-10`, to: `${YEAR}-01-31` }, tx);
        expect(partial.meta.warnings.some((w) => w.includes('whole budget'))).toBe(true);
      });
    },
    60_000,
  );

  it(
    "seeds next year's budget from actuals with a growth factor",
    async () => {
      await withRollback(async (tx) => {
        const ctx = { userId: null, tx };
        await postActuals(tx);
        const next = await createBudgetVersion({ name: 'From actuals', fiscalYear: YEAR + 1 }, ctx);
        const result = await copyBudgetFromActuals({ versionId: next.id, sourceYear: YEAR, growthBps: 1_000 }, ctx);
        // 160,000 + 28,000 + 1,200 + 12,345 in statement sign.
        expect(result.sourceTotalCents).toBe(201_545);
        expect(result.cellsWritten).toBe(4);

        const lines = await listBudgetLines(next.id, tx);
        const byCell = new Map(lines.map((l) => [`${l.accountId}:${l.month}`, l]));
        const rentId = await accountIdOf(tx, ACCOUNTS.RENT);
        const salesId = await accountIdOf(tx, ACCOUNTS.SALES_SQUARE);
        const feeId = await accountIdOf(tx, ACCOUNTS.MARKETPLACE_FEES);
        expect(byCell.get(`${rentId}:1`)?.amountCents).toBe(176_000);
        expect(byCell.get(`${salesId}:1`)?.amountCents).toBe(30_800);
        expect(byCell.get(`${feeId}:1`)?.amountCents).toBe(1_320);
        // 12,345 × 1.1 = 13,579.5 → 13,580, half away from zero.
        expect(byCell.get(`${salesId}:2`)?.amountCents).toBe(13_580);
        expect(lines.every((l) => l.year === YEAR + 1 && l.channelId === null)).toBe(true);
      });
    },
    60_000,
  );
});

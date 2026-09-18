import { afterAll, describe, expect, it } from 'vitest';

// First: loads .env.local before '@/db/client' is imported anywhere below.
import { closeTestDb, hasDatabase, withRollback } from '@/lib/ledger/test-support';

import { listAccounts } from '@/lib/ledger/accounts';
import { ACCOUNTS } from '@/lib/ledger/coa';
import { type LedgerDb, type SourceType, postJournalEntry } from '@/lib/ledger/post';

import { CF_ROWS, cashFlowReport, classifyAccount } from './cash-flow';
import { type Report, type ReportRequest, indexAccounts } from './types';

afterAll(closeTestDb);

const JAN = { from: '2034-01-01', to: '2034-01-31' };
const FEB = { from: '2034-02-01', to: '2034-02-28' };

function request(overrides: Partial<ReportRequest> = {}): ReportRequest {
  return { from: JAN.from, to: FEB.to, columns: 'total', basis: 'accrual', includeZeroRows: false, ...overrides };
}

function valuesOf(report: Report, id: string): number[] {
  const found = report.rows.find((r) => r.id === id);
  if (found === undefined) throw new Error(`No row ${id}. Rows: ${report.rows.map((r) => r.id).join(', ')}`);
  return found.values;
}

/**
 * A month that touches every part of the statement: founder money, a loan, an
 * owner draw, equipment, depreciation, inventory bought on account and partly
 * paid, a receivable, a Square sale sitting in clearing, a card charge, an
 * accrual and a prepayment. February clears the Square payout into the bank.
 */
async function seed(tx: LedgerDb): Promise<void> {
  const ctx = { userId: null, tx };
  const post = (
    date: string,
    sourceType: SourceType,
    lines: Array<{ accountCode: string; debitCents?: number; creditCents?: number }>,
  ) => postJournalEntry({ date, sourceType, memo: 'cash flow fixture', lines }, ctx);

  const cash = ACCOUNTS.OPERATING_CHECKING;
  await post('2034-01-02', 'manual', [
    { accountCode: cash, debitCents: 500_000 },
    { accountCode: ACCOUNTS.MEMBER_CONTRIBUTIONS, creditCents: 500_000 },
  ]);
  await post('2034-01-03', 'bill', [
    { accountCode: ACCOUNTS.INVENTORY_INGREDIENTS, debitCents: 120_000 },
    { accountCode: ACCOUNTS.AP, creditCents: 120_000 },
  ]);
  await post('2034-01-04', 'invoice', [
    { accountCode: ACCOUNTS.AR, debitCents: 80_000 },
    { accountCode: ACCOUNTS.SALES_DISTRIBUTOR, creditCents: 80_000 },
  ]);
  await post('2034-01-05', 'manual', [
    { accountCode: ACCOUNTS.CLEARING_SQUARE, debitCents: 30_000 },
    { accountCode: ACCOUNTS.SALES_SQUARE, creditCents: 30_000 },
  ]);
  await post('2034-01-10', 'bill_payment', [
    { accountCode: ACCOUNTS.AP, debitCents: 50_000 },
    { accountCode: cash, creditCents: 50_000 },
  ]);
  await post('2034-01-11', 'manual', [
    { accountCode: ACCOUNTS.EQUIPMENT, debitCents: 240_000 },
    { accountCode: cash, creditCents: 240_000 },
  ]);
  await post('2034-01-31', 'depreciation', [
    { accountCode: ACCOUNTS.DEPRECIATION, debitCents: 4_000 },
    { accountCode: ACCOUNTS.ACCUMULATED_DEPRECIATION, creditCents: 4_000 },
  ]);
  await post('2034-01-15', 'manual', [
    { accountCode: cash, debitCents: 300_000 },
    { accountCode: ACCOUNTS.LOANS_LONG_TERM, creditCents: 300_000 },
  ]);
  await post('2034-01-20', 'manual', [
    { accountCode: ACCOUNTS.OWNER_DRAWS, debitCents: 20_000 },
    { accountCode: cash, creditCents: 20_000 },
  ]);
  await post('2034-01-21', 'manual', [
    { accountCode: ACCOUNTS.RENT, debitCents: 15_000 },
    { accountCode: ACCOUNTS.CREDIT_CARD_OPERATIONS, creditCents: 15_000 },
  ]);
  await post('2034-01-31', 'accrual', [
    { accountCode: ACCOUNTS.ACCOUNTING_FEES, debitCents: 7_000 },
    { accountCode: ACCOUNTS.ACCRUED_EXPENSES, creditCents: 7_000 },
  ]);
  await post('2034-01-25', 'manual', [
    { accountCode: ACCOUNTS.PREPAID_INSURANCE, debitCents: 12_000 },
    { accountCode: cash, creditCents: 12_000 },
  ]);
  await post('2034-02-03', 'manual', [
    { accountCode: cash, debitCents: 29_000 },
    { accountCode: ACCOUNTS.PAYMENT_PROCESSING_FEES, debitCents: 1_000 },
    { accountCode: ACCOUNTS.CLEARING_SQUARE, creditCents: 30_000 },
  ]);
}

describe.skipIf(!hasDatabase)('account classification', () => {
  it(
    'places every account of the chart in the statement line it belongs to',
    async () => {
      await withRollback(async (tx) => {
        const accounts = await listAccounts({}, tx);
        const index = indexAccounts(accounts);
        const line = (code: string): string => {
          const account = index.byCode.get(code);
          if (account === undefined) throw new Error(`Seeded account ${code} is missing.`);
          return classifyAccount(account, index);
        };
        expect(line(ACCOUNTS.OPERATING_CHECKING)).toBe('cash');
        expect(line('1011')).toBe('cash'); // Relay ••9726
        expect(line(ACCOUNTS.UNDEPOSITED_FUNDS)).toBe('cash');
        expect(line(ACCOUNTS.CLEARING_SQUARE)).toBe('clearing');
        expect(line(ACCOUNTS.AR)).toBe('receivables');
        expect(line(ACCOUNTS.ALLOWANCE_DOUBTFUL_ACCOUNTS)).toBe('receivables');
        expect(line(ACCOUNTS.INVENTORY_RESERVE)).toBe('inventory');
        expect(line(ACCOUNTS.INVENTORY_PACKAGING)).toBe('inventory');
        expect(line(ACCOUNTS.VENDOR_DEPOSITS)).toBe('prepaid');
        expect(line(ACCOUNTS.EQUIPMENT)).toBe('fixed_assets');
        expect(line(ACCOUNTS.ACCUMULATED_DEPRECIATION)).toBe('depreciation');
        expect(line(ACCOUNTS.AP)).toBe('payables');
        expect(line(ACCOUNTS.CREDIT_CARD_OPERATIONS)).toBe('credit_cards');
        expect(line(ACCOUNTS.ACCRUED_TRADE_SPEND)).toBe('accrued');
        expect(line(ACCOUNTS.SALES_TAX_PAYABLE)).toBe('taxes');
        expect(line(ACCOUNTS.DEFERRED_REVENUE)).toBe('deferred');
        expect(line(ACCOUNTS.GIFT_CARD_LIABILITY)).toBe('other_liabilities');
        expect(line(ACCOUNTS.ACCRUED_INTEREST)).toBe('debt');
        expect(line(ACCOUNTS.SAFE_AND_CONVERTIBLE_NOTES)).toBe('debt');
        expect(line(ACCOUNTS.MEMBER_CONTRIBUTIONS)).toBe('contributions');
        expect(line(ACCOUNTS.OWNER_DRAWS)).toBe('draws');
        expect(line(ACCOUNTS.RETAINED_EARNINGS)).toBe('retained_earnings');
        expect(line(ACCOUNTS.OPENING_BALANCE_EQUITY)).toBe('opening_equity');
        expect(line(ACCOUNTS.MARKETPLACE_FEES)).toBe('net_income');
        expect(line(ACCOUNTS.DEPRECIATION)).toBe('net_income');
      });
    },
    30_000,
  );
});

describe.skipIf(!hasDatabase)('statement of cash flows', () => {
  it(
    'walks net income to the change in cash, line by line, exactly',
    async () => {
      await withRollback(async (tx) => {
        const before = await cashFlowReport(request(), tx);
        expect(before.totals.netChange[0], '2034 already carries activity; move the window').toBe(0);
        await seed(tx);

        const jan = await cashFlowReport(request({ from: JAN.from, to: JAN.to }), tx);
        expect(valuesOf(jan, CF_ROWS.netIncome)).toEqual([84_000]); // 80,000 + 30,000 − 4,000 − 15,000 − 7,000
        expect(valuesOf(jan, 'cf:depreciation')).toEqual([4_000]);
        expect(valuesOf(jan, 'cf:receivables')).toEqual([-80_000]);
        expect(valuesOf(jan, 'cf:clearing')).toEqual([-30_000]);
        expect(valuesOf(jan, 'cf:inventory')).toEqual([-120_000]);
        expect(valuesOf(jan, 'cf:prepaid')).toEqual([-12_000]);
        expect(valuesOf(jan, 'cf:payables')).toEqual([70_000]);
        expect(valuesOf(jan, 'cf:credit_cards')).toEqual([15_000]);
        expect(valuesOf(jan, 'cf:accrued')).toEqual([7_000]);
        expect(valuesOf(jan, CF_ROWS.operating)).toEqual([-62_000]);
        expect(valuesOf(jan, 'cf:fixed_assets')).toEqual([-240_000]);
        expect(valuesOf(jan, CF_ROWS.investing)).toEqual([-240_000]);
        expect(valuesOf(jan, 'cf:contributions')).toEqual([500_000]);
        expect(valuesOf(jan, 'cf:draws')).toEqual([-20_000]);
        expect(valuesOf(jan, 'cf:debt')).toEqual([300_000]);
        expect(valuesOf(jan, CF_ROWS.financing)).toEqual([780_000]);
        expect(valuesOf(jan, CF_ROWS.netChange)).toEqual([478_000]);

        // THE IDENTITY: net change equals the movement in the cash accounts.
        expect(jan.totals.cashAccountChange).toEqual([478_000]);
        expect(jan.totals.netChange).toEqual(jan.totals.cashAccountChange);
        expect(valuesOf(jan, CF_ROWS.endingCash)).toEqual(jan.totals.endingCash);
        expect(jan.rows.some((r) => r.style === 'error')).toBe(false);
      });
    },
    60_000,
  );

  it(
    'splits by month with a total, each column tying to its own cash movement',
    async () => {
      await withRollback(async (tx) => {
        await seed(tx);
        const report = await cashFlowReport(request({ columns: 'months' }), tx);
        expect(report.columns.map((c) => c.label)).toEqual(['Jan 2034', 'Feb 2034', 'Total']);
        expect(valuesOf(report, CF_ROWS.netIncome)).toEqual([84_000, -1_000, 83_000]);
        expect(valuesOf(report, 'cf:clearing')).toEqual([-30_000, 30_000, 0]);
        expect(valuesOf(report, CF_ROWS.operating)).toEqual([-62_000, 29_000, -33_000]);
        expect(valuesOf(report, CF_ROWS.netChange)).toEqual([478_000, 29_000, 507_000]);
        expect(report.totals.netChange).toEqual(report.totals.cashAccountChange);
        // February opens where January closed.
        expect(report.totals.beginningCash[1]).toBe(report.totals.endingCash[0]);
        expect(report.totals.beginningCash[2]).toBe(report.totals.beginningCash[0]);
        expect(report.totals.endingCash[2]).toBe(report.totals.endingCash[1]);
      });
    },
    60_000,
  );

  it(
    'holds the identity on the live ledger and on a cash basis',
    async () => {
      await withRollback(async (tx) => {
        await seed(tx);
        for (const basis of ['accrual', 'cash'] as const) {
          const live = await cashFlowReport(
            request({ from: '2026-01-01', to: '2034-12-31', basis, columns: 'total' }),
            tx,
          );
          expect(live.totals.netChange, basis).toEqual(live.totals.cashAccountChange);
          expect(live.rows.some((r) => r.style === 'error'), basis).toBe(false);
        }
      });
    },
    60_000,
  );
});

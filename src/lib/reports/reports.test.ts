import { afterAll, describe, expect, it } from 'vitest';

// First: loads .env.local before '@/db/client' is imported anywhere below.
import { closeTestDb, hasDatabase, withRollback } from '@/lib/ledger/test-support';

import { asc, sql } from 'drizzle-orm';

import { channels } from '@/db/schema';
import { ACCOUNTS } from '@/lib/ledger/coa';
import { type LedgerDb, postJournalEntry } from '@/lib/ledger/post';

import { balanceSheetReport } from './balance-sheet';
import { generalLedgerData, generalLedgerReport } from './general-ledger';
import { PL_ROWS, profitAndLossReport } from './pnl';
import { trialBalanceData, trialBalanceReport } from './trial-balance';
import { type Report, type ReportRequest, type ReportRow } from './types';

/**
 * A window nothing else in the product uses. The fixtures below are the only
 * activity in it, which is what lets these tests assert absolute figures rather
 * than deltas; `assertWindowIsClear` fails loudly if that ever stops being true.
 */
const JAN = { from: '2029-01-01', to: '2029-01-31' };
const FEB = { from: '2029-02-01', to: '2029-02-28' };
const WINDOW = { from: JAN.from, to: FEB.to };

function request(overrides: Partial<ReportRequest> = {}): ReportRequest {
  return {
    from: WINDOW.from,
    to: WINDOW.to,
    columns: 'total',
    basis: 'accrual',
    includeZeroRows: false,
    ...overrides,
  };
}

function findRow(report: Report, id: string): ReportRow {
  const found = report.rows.find((row) => row.id === id);
  if (found === undefined) {
    throw new Error(`Report has no row "${id}". Rows: ${report.rows.map((r) => r.id).join(', ')}`);
  }
  return found;
}

interface Fixture {
  dtcChannelId: string;
  amazonChannelId: string;
}

/** Channel ids by code, from the seeded channel list. */
async function channelIds(tx: LedgerDb): Promise<Fixture> {
  const rows = await tx
    .select({ id: channels.id, code: channels.code })
    .from(channels)
    .orderBy(asc(channels.sortOrder));
  const byCode = new Map(rows.map((row) => [row.code, row.id]));
  const dtc = byCode.get('DTC');
  const amazon = byCode.get('AMAZON');
  if (dtc === undefined || amazon === undefined) {
    throw new Error('The seeded channels DTC and AMAZON are missing.');
  }
  return { dtcChannelId: dtc, amazonChannelId: amazon };
}

async function assertWindowIsClear(tx: LedgerDb): Promise<void> {
  const before = await profitAndLossReport(request(), tx);
  expect(
    before.totals.netSales[0],
    `${WINDOW.from}–${WINDOW.to} already carries activity; move the test window`,
  ).toBe(0);
  expect(before.totals.netIncome[0]).toBe(0);
}

/**
 * Two months of a small but complete CPG month: gross sales on two channels, a
 * coupon and a marketplace fee against revenue, product cost, outbound freight,
 * an ad spend, and a little interest income with no channel on it.
 *
 * Everything lands inside one rolled-back transaction, so the seeded chart of
 * accounts is read and never changed.
 */
async function seed(tx: LedgerDb): Promise<Fixture> {
  const fixture = await channelIds(tx);
  const { dtcChannelId, amazonChannelId } = fixture;
  const ctx = { userId: null, tx };

  const post = async (
    date: string,
    memo: string,
    sourceType: 'manual' | 'invoice' | 'receipt',
    lines: ReadonlyArray<{
      accountCode: string;
      debitCents?: number;
      creditCents?: number;
      channelId?: string;
    }>,
  ): Promise<void> => {
    await postJournalEntry({ date, memo, sourceType, lines }, ctx);
  };

  // January
  await post('2029-01-05', 'Shopify sales', 'manual', [
    { accountCode: ACCOUNTS.CLEARING_SHOPIFY, debitCents: 100_000, channelId: dtcChannelId },
    { accountCode: ACCOUNTS.SALES_DTC, creditCents: 100_000, channelId: dtcChannelId },
  ]);
  await post('2029-01-05', 'Launch coupon', 'manual', [
    { accountCode: ACCOUNTS.COUPONS_AND_PROMOS, debitCents: 5_000, channelId: dtcChannelId },
    { accountCode: ACCOUNTS.CLEARING_SHOPIFY, creditCents: 5_000, channelId: dtcChannelId },
  ]);
  await post('2029-01-31', 'Cost of goods sold', 'manual', [
    { accountCode: ACCOUNTS.COGS_PRODUCT, debitCents: 40_000, channelId: dtcChannelId },
    { accountCode: ACCOUNTS.INVENTORY_FINISHED, creditCents: 40_000, channelId: dtcChannelId },
  ]);
  await post('2029-01-20', 'Outbound freight', 'manual', [
    { accountCode: ACCOUNTS.OUTBOUND_FREIGHT, debitCents: 8_000, channelId: dtcChannelId },
    { accountCode: ACCOUNTS.OPERATING_CHECKING, creditCents: 8_000, channelId: dtcChannelId },
  ]);
  await post('2029-01-20', 'Meta ads', 'manual', [
    { accountCode: ACCOUNTS.ADS_META_GOOGLE, debitCents: 12_000, channelId: dtcChannelId },
    { accountCode: ACCOUNTS.CREDIT_CARD_OPERATIONS, creditCents: 12_000, channelId: dtcChannelId },
  ]);
  await post('2029-01-12', 'Amazon sales', 'manual', [
    { accountCode: ACCOUNTS.CLEARING_AMAZON, debitCents: 50_000, channelId: amazonChannelId },
    { accountCode: ACCOUNTS.SALES_AMAZON, creditCents: 50_000, channelId: amazonChannelId },
  ]);
  await post('2029-01-12', 'Amazon referral fees', 'manual', [
    { accountCode: ACCOUNTS.MARKETPLACE_FEES, debitCents: 7_500, channelId: amazonChannelId },
    { accountCode: ACCOUNTS.CLEARING_AMAZON, creditCents: 7_500, channelId: amazonChannelId },
  ]);
  await post('2029-01-31', 'Amazon cost of goods sold', 'manual', [
    { accountCode: ACCOUNTS.COGS_PRODUCT, debitCents: 20_000, channelId: amazonChannelId },
    { accountCode: ACCOUNTS.INVENTORY_FINISHED, creditCents: 20_000, channelId: amazonChannelId },
  ]);
  await post('2029-01-31', 'Interest on the reserve', 'manual', [
    { accountCode: ACCOUNTS.OPERATING_CHECKING, debitCents: 500 },
    { accountCode: ACCOUNTS.INTEREST_INCOME, creditCents: 500 },
  ]);

  // February
  await post('2029-02-10', 'Shopify sales', 'manual', [
    { accountCode: ACCOUNTS.CLEARING_SHOPIFY, debitCents: 60_000, channelId: dtcChannelId },
    { accountCode: ACCOUNTS.SALES_DTC, creditCents: 60_000, channelId: dtcChannelId },
  ]);
  await post('2029-02-28', 'Cost of goods sold', 'manual', [
    { accountCode: ACCOUNTS.COGS_PRODUCT, debitCents: 25_000, channelId: dtcChannelId },
    { accountCode: ACCOUNTS.INVENTORY_FINISHED, creditCents: 25_000, channelId: dtcChannelId },
  ]);

  return fixture;
}

afterAll(closeTestDb);

describe.skipIf(!hasDatabase)('profit and loss', () => {
  it(
    'builds the CPG statement down to net income',
    async () => {
      await withRollback(async (tx) => {
        await assertWindowIsClear(tx);
        await seed(tx);

        const report = await profitAndLossReport(request(), tx);
        const t = report.totals;

        expect(t.grossSales[0]).toBe(210_000);
        // Contra revenue is shown as a positive deduction, not as a negative revenue.
        expect(t.contraRevenue[0]).toBe(12_500);
        expect(t.netSales[0]).toBe(197_500);
        expect(t.cogs[0]).toBe(85_000);
        expect(t.grossProfit[0]).toBe(112_500);
        expect(t.fulfillment[0]).toBe(8_000);
        expect(t.contributionMargin[0]).toBe(104_500);
        expect(t.operatingExpenses[0]).toBe(12_000);
        expect(t.operatingIncome[0]).toBe(92_500);
        expect(t.otherIncome[0]).toBe(500);
        expect(t.netIncome[0]).toBe(93_000);

        expect(findRow(report, PL_ROWS.netSales).values[0]).toBe(197_500);
        expect(findRow(report, PL_ROWS.netIncome).values[0]).toBe(93_000);
        // Nothing may follow net income without the statement saying so.
        expect(report.rows.some((row) => row.style === 'error')).toBe(false);
      });
    },
    30_000,
  );

  it(
    'computes gross margin, contribution margin and net margin against net sales',
    async () => {
      await withRollback(async (tx) => {
        await seed(tx);
        const report = await profitAndLossReport(request(), tx);

        // 112,500 / 197,500 = 56.9620…%, half away from zero at the fourth place.
        expect(findRow(report, PL_ROWS.grossMarginPct).values[0]).toBe(5_696);
        expect(findRow(report, PL_ROWS.contributionMarginPct).values[0]).toBe(5_291);
        expect(findRow(report, PL_ROWS.netMarginPct).values[0]).toBe(4_709);
        expect(findRow(report, PL_ROWS.grossMarginPct).format).toBe('percent');
      });
    },
    30_000,
  );

  it(
    'agrees with itself month by month: the month columns add up to the total column',
    async () => {
      await withRollback(async (tx) => {
        await seed(tx);
        const report = await profitAndLossReport(request({ columns: 'months' }), tx);

        const total = report.columns.findIndex((column) => column.key === 'total');
        const months = report.columns
          .map((column, index) => ({ column, index }))
          .filter((entry) => entry.column.kind === 'amount' && entry.index !== total);

        expect(months).toHaveLength(2);
        for (const row of report.rows) {
          if (row.style === 'section' || row.style === 'group' || row.format === 'percent') continue;
          const summed = months.reduce((sum, entry) => sum + row.values[entry.index], 0);
          expect(summed, `row ${row.id} does not add across its months`).toBe(row.values[total]);
        }

        expect(findRow(report, PL_ROWS.netSales).values[months[0].index]).toBe(137_500);
        expect(findRow(report, PL_ROWS.netSales).values[months[1].index]).toBe(60_000);
      });
    },
    30_000,
  );

  it(
    'agrees with itself across channels: the channel columns add up to the total column',
    async () => {
      await withRollback(async (tx) => {
        const { dtcChannelId } = await seed(tx);
        const report = await profitAndLossReport(request({ columns: 'channels' }), tx);

        const total = report.columns.findIndex((column) => column.key === 'total');
        const parts = report.columns
          .map((column, index) => ({ column, index }))
          .filter((entry) => entry.column.kind === 'amount' && entry.index !== total);

        for (const row of report.rows) {
          if (row.style === 'section' || row.style === 'group' || row.format === 'percent') continue;
          const summed = parts.reduce((sum, entry) => sum + row.values[entry.index], 0);
          expect(summed, `row ${row.id} does not add across its channels`).toBe(row.values[total]);
        }

        // The interest income carries no channel, so it lands in Unallocated.
        const unallocated = report.columns.findIndex((column) => column.key === 'unallocated');
        expect(findRow(report, PL_ROWS.netIncome).values[unallocated]).toBe(500);

        // A channel-filtered statement equals that channel's column.
        const dtcColumn = report.columns.findIndex((column) => column.key === dtcChannelId);
        const filtered = await profitAndLossReport(request({ channelIds: [dtcChannelId] }), tx);
        expect(filtered.totals.netSales[0]).toBe(
          findRow(report, PL_ROWS.netSales).values[dtcColumn],
        );
        expect(filtered.totals.netIncome[0]).toBe(
          findRow(report, PL_ROWS.netIncome).values[dtcColumn],
        );
      });
    },
    30_000,
  );

  it(
    'shows a prior-period comparison with its variance',
    async () => {
      await withRollback(async (tx) => {
        await seed(tx);
        const report = await profitAndLossReport(
          request({ from: FEB.from, to: FEB.to, compareTo: 'prior_period' }),
          tx,
        );

        const current = report.columns.findIndex((column) => column.key === 'total');
        const compare = report.columns.findIndex((column) => column.key === 'compare');
        const variance = report.columns.findIndex((column) => column.key === 'variance');

        const netSales = findRow(report, PL_ROWS.netSales);
        expect(netSales.values[current]).toBe(60_000);
        expect(netSales.values[compare]).toBe(137_500);
        expect(netSales.values[variance]).toBe(-77_500);
      });
    },
    30_000,
  );
});

describe.skipIf(!hasDatabase)('trial balance', () => {
  it(
    'ties: total debits equal total credits',
    async () => {
      await withRollback(async (tx) => {
        await seed(tx);
        const data = await trialBalanceData(request(), tx);

        expect(data.debitTotalCents).toBe(data.creditTotalCents);
        expect(data.debitTotalCents).toBeGreaterThan(0);

        const report = await trialBalanceReport(request(), tx);
        const total = findRow(report, 'tb:total');
        expect(total.values[0]).toBe(total.values[1]);
        expect(report.rows.some((row) => row.id === 'tb:out-of-balance')).toBe(false);
      });
    },
    30_000,
  );

  it(
    'flags an account sitting on the wrong side, and leaves contra accounts alone',
    async () => {
      await withRollback(async (tx) => {
        await seed(tx);
        const data = await trialBalanceData(request(), tx);
        const byCode = new Map(data.lines.map((line) => [line.account.code, line]));

        // Inventory was relieved without ever being received, so the asset is in credit.
        expect(byCode.get(ACCOUNTS.INVENTORY_FINISHED)?.flagged).toBe(true);
        // A coupon is meant to carry a debit balance in a revenue account.
        expect(byCode.get(ACCOUNTS.COUPONS_AND_PROMOS)?.flagged).toBe(false);
        expect(byCode.get(ACCOUNTS.SALES_DTC)?.flagged).toBe(false);
      });
    },
    30_000,
  );
});

describe.skipIf(!hasDatabase)('balance sheet', () => {
  it(
    'balances, and carries the period result as its own equity line',
    async () => {
      await withRollback(async (tx) => {
        await assertWindowIsClear(tx);
        // A balance sheet is cumulative from the first entry ever posted, so the
        // fixtures are measured as a movement against whatever is already there.
        const before = await balanceSheetReport(request(), tx);
        await seed(tx);
        const after = await balanceSheetReport(request(), tx);

        expect(before.totals.outOfBalance).toEqual([0]);
        expect(after.totals.outOfBalance).toEqual([0]);
        expect(after.totals.assets[0]).toBe(after.totals.liabilities[0] + after.totals.equity[0]);

        expect(after.totals.assets[0] - before.totals.assets[0]).toBe(105_000);
        expect(after.totals.liabilities[0] - before.totals.liabilities[0]).toBe(12_000);
        expect(after.totals.netIncome[0] - before.totals.netIncome[0]).toBe(93_000);
        expect(after.rows.some((row) => row.style === 'error')).toBe(false);

        expect(findRow(after, 'bs:equity:net-income').values[0]).toBe(after.totals.netIncome[0]);
        expect(findRow(after, 'bs:liabilities-and-equity:total').values[0]).toBe(
          after.totals.assets[0],
        );
      });
    },
    30_000,
  );

  it(
    'retains February: earnings before the period start move into retained earnings',
    async () => {
      await withRollback(async (tx) => {
        const window = request({ from: FEB.from, to: FEB.to });
        const before = await balanceSheetReport(window, tx);
        await seed(tx);
        const after = await balanceSheetReport(window, tx);

        // January's result: 137,500 net sales less 60,000 COGS, 8,000 freight and
        // 12,000 ads, plus 500 of interest.
        expect(after.totals.retainedPrior[0] - before.totals.retainedPrior[0]).toBe(58_000);
        // February: 60,000 of sales less 25,000 of product cost.
        expect(after.totals.netIncome[0] - before.totals.netIncome[0]).toBe(35_000);
        expect(after.totals.outOfBalance).toEqual([0]);
      });
    },
    30_000,
  );

  it(
    'equals the P&L: net income is the movement in equity',
    async () => {
      await withRollback(async (tx) => {
        const before = await balanceSheetReport(request(), tx);
        await seed(tx);
        const after = await balanceSheetReport(request(), tx);
        const pnl = await profitAndLossReport(request(), tx);

        // The two statements agree on the period's result, exactly.
        expect(after.totals.netIncome[0]).toBe(pnl.totals.netIncome[0]);
        // The fixtures touch no equity account, so every cent of equity movement
        // is that result arriving through retained earnings.
        expect(after.totals.equity[0] - before.totals.equity[0]).toBe(
          after.totals.netIncome[0] - before.totals.netIncome[0],
        );
        expect(after.totals.assets[0] - after.totals.liabilities[0]).toBe(after.totals.equity[0]);
      });
    },
    30_000,
  );
});

describe.skipIf(!hasDatabase)('general ledger', () => {
  it(
    'reconciles each account: opening plus movement equals closing',
    async () => {
      await withRollback(async (tx) => {
        await seed(tx);
        const data = await generalLedgerData(request(), tx);

        expect(data.debitTotalCents).toBe(data.creditTotalCents);
        expect(data.accounts.length).toBeGreaterThan(0);

        for (const account of data.accounts) {
          if (account.lines.length === 0) continue;
          const last = account.lines[account.lines.length - 1];
          expect(last.balanceCents, `${account.code} closes on its last line`).toBe(
            account.closingCents,
          );
          expect(account.truncated).toBe(false);
        }
      });
    },
    30_000,
  );

  it(
    'names the accounts on the other side of each entry',
    async () => {
      await withRollback(async (tx) => {
        const salesOnly = {
          ...request(),
          codeFrom: ACCOUNTS.SALES_DTC,
          codeTo: ACCOUNTS.SALES_DTC,
          includeZeroRows: true,
        };
        const before = await generalLedgerData(salesOnly, tx);
        await seed(tx);
        const after = await generalLedgerData(salesOnly, tx);

        const [sales] = after.accounts;
        expect(sales.code).toBe(ACCOUNTS.SALES_DTC);
        expect(sales.lines).toHaveLength(before.accounts[0].lines.length + 2);
        expect(sales.lines[0].counterAccounts.join()).toContain(ACCOUNTS.CLEARING_SHOPIFY);
        // The register's own identity, whatever else is already on the account.
        expect(sales.closingCents - sales.openingCents).toBe(160_000);
      });
    },
    30_000,
  );

  it(
    'opens February with January on the books',
    async () => {
      await withRollback(async (tx) => {
        const february = {
          ...request({ from: FEB.from, to: FEB.to }),
          codeFrom: ACCOUNTS.SALES_DTC,
          codeTo: ACCOUNTS.SALES_DTC,
          includeZeroRows: true,
        };
        const before = await generalLedgerData(february, tx);
        await seed(tx);
        const after = await generalLedgerData(february, tx);

        // January's 100,000 of sales is carried in as opening, not repeated as movement.
        expect(after.accounts[0].openingCents - before.accounts[0].openingCents).toBe(100_000);
        expect(after.accounts[0].closingCents - before.accounts[0].closingCents).toBe(160_000);
      });
    },
    30_000,
  );

  it(
    'renders a register with an opening row, the lines and a closing row',
    async () => {
      await withRollback(async (tx) => {
        await seed(tx);
        const report = await generalLedgerReport(
          { ...request(), codeFrom: ACCOUNTS.SALES_DTC, codeTo: ACCOUNTS.SALES_DTC },
          tx,
        );

        const opening = findRow(report, `gl:${ACCOUNTS.SALES_DTC}:opening`);
        const closing = findRow(report, `gl:${ACCOUNTS.SALES_DTC}:closing`);
        expect(closing.values[7] - opening.values[7]).toBe(160_000);
        // Debits and credits are not stated on the opening line; only the balance is.
        expect(opening.blankColumns).toEqual([5, 6]);
        expect(closing.values[6]).toBe(160_000);
        // Balances from different accounts do not add up, so the grand total omits one.
        expect(findRow(report, 'gl:total').blankColumns).toEqual([7]);
      });
    },
    30_000,
  );
});

describe.skipIf(!hasDatabase)('cash basis', () => {
  /**
   * An invoiced sale in January and the receipt that settles it in February,
   * posted through the control account and recorded in the AR sub-ledger the way
   * the invoicing module records them: each document points at its entry, and
   * the receipt is applied to the invoice.
   */
  async function seedInvoiced(tx: LedgerDb): Promise<void> {
    const ctx = { userId: null, tx };
    const invoiceEntry = await postJournalEntry(
      {
        date: '2029-01-15',
        memo: 'UNFI invoice',
        sourceType: 'invoice',
        lines: [
          { accountCode: ACCOUNTS.AR, debitCents: 30_000 },
          { accountCode: ACCOUNTS.SALES_DISTRIBUTOR, creditCents: 30_000 },
        ],
      },
      ctx,
    );
    const receiptEntry = await postJournalEntry(
      {
        date: '2029-02-14',
        memo: 'UNFI payment',
        sourceType: 'receipt',
        lines: [
          { accountCode: ACCOUNTS.OPERATING_CHECKING, debitCents: 30_000 },
          { accountCode: ACCOUNTS.AR, creditCents: 30_000 },
        ],
      },
      ctx,
    );

    const [customer] = [
      ...(await tx.execute<{ id: string }>(
        sql`insert into customers (name) values ('UNFI (report test)') returning id`,
      )),
    ];
    const [invoice] = [
      ...(await tx.execute<{ id: string }>(
        sql`insert into invoices (invoice_no, customer_id, invoice_date, due_date, status, total_cents, journal_entry_id)
            values ('RPT-3003', ${customer.id}, '2029-01-15', '2029-02-14', 'open', 30000, ${invoiceEntry.entryId})
            returning id`,
      )),
    ];
    const [receipt] = [
      ...(await tx.execute<{ id: string }>(
        sql`insert into receipts (receipt_no, customer_id, receipt_date, amount_cents, deposit_account_id, journal_entry_id)
            values ('RPT-R-3003', ${customer.id}, '2029-02-14', 30000,
                    (select id from accounts where code = ${ACCOUNTS.OPERATING_CHECKING}), ${receiptEntry.entryId})
            returning id`,
      )),
    ];
    await tx.execute(
      sql`insert into receipt_applications (receipt_id, invoice_id, amount_cents)
          values (${receipt.id}, ${invoice.id}, 30000)`,
    );
  }

  it(
    'recognises an invoiced sale in the month it is paid',
    async () => {
      await withRollback(async (tx) => {
        await assertWindowIsClear(tx);
        await seed(tx);
        await seedInvoiced(tx);

        const accrual = await profitAndLossReport(request(), tx);
        const cash = await profitAndLossReport(request({ basis: 'cash' }), tx);
        expect(accrual.totals.grossSales[0]).toBe(240_000);
        expect(cash.totals.grossSales[0]).toBe(240_000);

        // January: the invoice is revenue on the accrual basis only.
        const janAccrual = await profitAndLossReport(request({ ...JAN }), tx);
        const janCash = await profitAndLossReport(request({ ...JAN, basis: 'cash' }), tx);
        expect(janAccrual.totals.grossSales[0]).toBe(180_000);
        expect(janCash.totals.grossSales[0]).toBe(150_000);

        // February: the payment brings it onto the cash basis.
        const febAccrual = await profitAndLossReport(request({ ...FEB }), tx);
        const febCash = await profitAndLossReport(request({ ...FEB, basis: 'cash' }), tx);
        expect(febAccrual.totals.grossSales[0]).toBe(60_000);
        expect(febCash.totals.grossSales[0]).toBe(90_000);

        // The settled receivable never appears in the cash-basis register.
        const ledger = await generalLedgerData(
          {
            ...request({ basis: 'cash' }),
            codeFrom: ACCOUNTS.AR,
            codeTo: ACCOUNTS.AR,
            includeZeroRows: true,
          },
          tx,
        );
        expect(ledger.accounts[0].lines).toHaveLength(0);
        expect(ledger.accounts[0].closingCents).toBe(0);
      });
    },
    30_000,
  );

  it(
    'still ties: the restated entries leave the trial balance in balance',
    async () => {
      await withRollback(async (tx) => {
        await seed(tx);
        await seedInvoiced(tx);

        const data = await trialBalanceData(request({ basis: 'cash' }), tx);
        expect(data.debitTotalCents).toBe(data.creditTotalCents);

        const sheet = await balanceSheetReport(request({ basis: 'cash' }), tx);
        expect(sheet.totals.outOfBalance).toEqual([0]);
      });
    },
    30_000,
  );

  it(
    'says on the face of the report how the cash basis was arrived at',
    async () => {
      await withRollback(async (tx) => {
        const cash = await profitAndLossReport(request({ basis: 'cash' }), tx);
        expect(cash.meta.warnings.join(' ')).toContain('Accounts Receivable');
        const accrual = await profitAndLossReport(request(), tx);
        expect(accrual.meta.warnings).toEqual([]);
      });
    },
    30_000,
  );
});

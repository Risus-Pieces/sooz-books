import { afterAll, describe, expect, it } from 'vitest';

// First: loads .env.local before '@/db/client' is imported anywhere below.
import { accountIds, closeTestDb, hasDatabase, withRollback } from '@/lib/ledger/test-support';

import { sql } from 'drizzle-orm';

import type { AccountingBasis } from '@/lib/ledger/balances';
import { ACCOUNTS } from '@/lib/ledger/coa';
import { type LedgerDb, type SourceType, postJournalEntry } from '@/lib/ledger/post';
import { reverseEntry } from '@/lib/ledger/reverse';

import { balanceSheetReport } from './balance-sheet';
import { fetchBalances } from './basis';
import { generalLedgerData } from './general-ledger';
import { profitAndLossReport } from './pnl';
import { trialBalanceData } from './trial-balance';
import type { ReportRequest } from './types';

/**
 * A year nothing else in the suite posts to, so every figure below is absolute.
 * Every test runs inside a transaction that is rolled back.
 */
const MAR = { from: '2032-03-01', to: '2032-03-31' };
const APR = { from: '2032-04-01', to: '2032-04-30' };
const SPRING = { from: MAR.from, to: APR.to };

const CODES = [
  ACCOUNTS.AR,
  ACCOUNTS.AP,
  ACCOUNTS.OPERATING_CHECKING,
  ACCOUNTS.CLEARING_SHOPIFY,
  ACCOUNTS.SALES_DISTRIBUTOR,
  ACCOUNTS.SALES_DTC,
  ACCOUNTS.SHIPPING_INCOME,
  ACCOUNTS.SALES_TAX_PAYABLE,
  ACCOUNTS.TRADE_BILLBACK,
  ACCOUNTS.RETURNS_AND_ALLOWANCES,
  ACCOUNTS.EARLY_PAYMENT_DISCOUNTS,
  ACCOUNTS.ACCOUNTING_FEES,
  ACCOUNTS.SOFTWARE,
  ACCOUNTS.ACCRUED_EXPENSES,
  ACCOUNTS.COGS_PRODUCT,
  ACCOUNTS.INVENTORY_FINISHED,
] as const;

type Line = readonly [code: string, debitCents: number, creditCents: number];

interface Books {
  tx: LedgerDb;
  ids: Map<string, string>;
  customerId: string;
  vendorId: string;
}

function id(books: Books, code: string): string {
  const found = books.ids.get(code);
  if (found === undefined) throw new Error(`Account ${code} is not seeded.`);
  return found;
}

async function returningId(tx: LedgerDb, query: ReturnType<typeof sql>): Promise<string> {
  const rows = [...(await tx.execute<{ id: string }>(query))];
  return String(rows[0].id);
}

async function openBooks(tx: LedgerDb): Promise<Books> {
  const ids = await accountIds(tx, CODES);
  const customerId = await returningId(
    tx,
    sql`insert into customers (name) values ('Cash basis test distributor') returning id`,
  );
  const vendorId = await returningId(
    tx,
    sql`insert into vendors (name) values ('Cash basis test vendor') returning id`,
  );
  return { tx, ids, customerId, vendorId };
}

async function post(
  books: Books,
  date: string,
  sourceType: SourceType,
  lines: readonly Line[],
): Promise<string> {
  const { entryId } = await postJournalEntry(
    {
      date,
      sourceType,
      memo: `${sourceType} ${date}`,
      lines: lines.map(([accountCode, debitCents, creditCents]) => ({
        accountCode,
        debitCents,
        creditCents,
      })),
    },
    { userId: null, tx: books.tx },
  );
  return entryId;
}

const sumOf = (values: readonly number[]): number => values.reduce((a, b) => a + b, 0);

/** An invoice: AR debited for the total, each line credited. */
async function invoice(
  books: Books,
  no: string,
  date: string,
  credits: readonly (readonly [code: string, cents: number])[],
): Promise<string> {
  const total = sumOf(credits.map(([, cents]) => cents));
  const entryId = await post(books, date, 'invoice', [
    [ACCOUNTS.AR, total, 0],
    ...credits.map(([code, cents]): Line => [code, 0, cents]),
  ]);
  return returningId(
    books.tx,
    sql`insert into invoices (invoice_no, customer_id, invoice_date, due_date, status, total_cents, journal_entry_id)
        values (${no}, ${books.customerId}, ${date}, ${date}, 'open', ${total}, ${entryId})
        returning id`,
  );
}

interface Application {
  invoiceId: string;
  amountCents: number;
  discountCents?: number;
}

/** A customer payment into the operating account, applied to invoices. Returns its entry id. */
async function receipt(
  books: Books,
  no: string,
  date: string,
  cashCents: number,
  applications: readonly Application[],
): Promise<string> {
  const discount = sumOf(applications.map((a) => a.discountCents ?? 0));
  const lines: Line[] = [[ACCOUNTS.OPERATING_CHECKING, cashCents, 0]];
  if (discount > 0) lines.push([ACCOUNTS.EARLY_PAYMENT_DISCOUNTS, discount, 0]);
  lines.push([ACCOUNTS.AR, 0, cashCents + discount]);
  const entryId = await post(books, date, 'receipt', lines);

  const receiptId = await returningId(
    books.tx,
    sql`insert into receipts (receipt_no, customer_id, receipt_date, amount_cents, deposit_account_id, journal_entry_id)
        values (${no}, ${books.customerId}, ${date}, ${cashCents}, ${id(books, ACCOUNTS.OPERATING_CHECKING)}, ${entryId})
        returning id`,
  );
  for (const application of applications) {
    await books.tx.execute(
      sql`insert into receipt_applications (receipt_id, invoice_id, amount_cents, discount_cents)
          values (${receiptId}, ${application.invoiceId}, ${application.amountCents}, ${application.discountCents ?? 0})`,
    );
  }
  return entryId;
}

async function deduction(
  books: Books,
  no: string,
  date: string,
  amountCents: number,
  invoiceId: string | null,
): Promise<void> {
  const entryId = await post(books, date, 'deduction', [
    [ACCOUNTS.TRADE_BILLBACK, amountCents, 0],
    [ACCOUNTS.AR, 0, amountCents],
  ]);
  await books.tx.execute(
    sql`insert into deductions (deduction_no, customer_id, deduction_date, amount_cents, invoice_id, treatment, journal_entry_id)
        values (${no}, ${books.customerId}, ${date}, ${amountCents}, ${invoiceId}, 'contra_revenue', ${entryId})`,
  );
}

async function creditMemo(
  books: Books,
  no: string,
  date: string,
  amountCents: number,
  applications: readonly Application[],
): Promise<void> {
  const entryId = await post(books, date, 'credit_memo', [
    [ACCOUNTS.RETURNS_AND_ALLOWANCES, amountCents, 0],
    [ACCOUNTS.AR, 0, amountCents],
  ]);
  const memoId = await returningId(
    books.tx,
    sql`insert into credit_memos (memo_no, customer_id, memo_date, reason, amount_cents, journal_entry_id)
        values (${no}, ${books.customerId}, ${date}, 'damaged in transit', ${amountCents}, ${entryId})
        returning id`,
  );
  for (const application of applications) {
    await books.tx.execute(
      sql`insert into credit_memo_applications (credit_memo_id, invoice_id, amount_cents)
          values (${memoId}, ${application.invoiceId}, ${application.amountCents})`,
    );
  }
}

/** A vendor bill: each line debited, AP credited for the total. */
async function bill(
  books: Books,
  no: string,
  date: string,
  debits: readonly (readonly [code: string, cents: number])[],
): Promise<string> {
  const total = sumOf(debits.map(([, cents]) => cents));
  const entryId = await post(books, date, 'bill', [
    ...debits.map(([code, cents]): Line => [code, cents, 0]),
    [ACCOUNTS.AP, 0, total],
  ]);
  return returningId(
    books.tx,
    sql`insert into bills (bill_no, vendor_id, bill_date, due_date, status, total_cents, journal_entry_id)
        values (${no}, ${books.vendorId}, ${date}, ${date}, 'open', ${total}, ${entryId})
        returning id`,
  );
}

async function billPayment(
  books: Books,
  no: string,
  date: string,
  amountCents: number,
  billId: string,
): Promise<void> {
  const entryId = await post(books, date, 'bill_payment', [
    [ACCOUNTS.AP, amountCents, 0],
    [ACCOUNTS.OPERATING_CHECKING, 0, amountCents],
  ]);
  const paymentId = await returningId(
    books.tx,
    sql`insert into bill_payments (payment_no, vendor_id, payment_date, amount_cents, payment_account_id, journal_entry_id)
        values (${no}, ${books.vendorId}, ${date}, ${amountCents}, ${id(books, ACCOUNTS.OPERATING_CHECKING)}, ${entryId})
        returning id`,
  );
  await books.tx.execute(
    sql`insert into bill_payment_applications (payment_id, bill_id, amount_cents)
        values (${paymentId}, ${billId}, ${amountCents})`,
  );
}

async function vendorCredit(
  books: Books,
  no: string,
  date: string,
  amountCents: number,
  billId: string,
): Promise<void> {
  const entryId = await post(books, date, 'vendor_credit', [
    [ACCOUNTS.AP, amountCents, 0],
    [ACCOUNTS.SOFTWARE, 0, amountCents],
  ]);
  const creditId = await returningId(
    books.tx,
    sql`insert into vendor_credits (credit_no, vendor_id, credit_date, reason, amount_cents, journal_entry_id)
        values (${no}, ${books.vendorId}, ${date}, 'overbilled', ${amountCents}, ${entryId})
        returning id`,
  );
  await books.tx.execute(
    sql`insert into vendor_credit_applications (credit_id, bill_id, amount_cents)
        values (${creditId}, ${billId}, ${amountCents})`,
  );
}

/** Signed balances by account code (positive = the account's normal side) for one window. */
async function balances(
  books: Books,
  basis: AccountingBasis,
  window: { from: string | null; to: string },
): Promise<(code: string) => number> {
  const matrix = await fetchBalances([{ key: 'w', ...window }], { basis }, books.tx);
  return (code) => matrix.valuesFor(id(books, code))?.[0] ?? 0;
}

function request(overrides: Partial<ReportRequest> = {}): ReportRequest {
  return {
    from: SPRING.from,
    to: SPRING.to,
    columns: 'total',
    basis: 'cash',
    includeZeroRows: false,
    ...overrides,
  };
}

/** The restated books must still balance, line for line and on the balance sheet. */
async function expectCashBooksBalance(books: Books): Promise<void> {
  const trial = await trialBalanceData(request(), books.tx);
  expect(trial.debitTotalCents).toBe(trial.creditTotalCents);
  const sheet = await balanceSheetReport(request(), books.tx);
  expect(sheet.totals.outOfBalance).toEqual([0]);
}

afterAll(closeTestDb);

describe.skipIf(!hasDatabase)('cash basis restatement', () => {
  it(
    'starts from an empty window',
    async () => {
      await withRollback(async (tx) => {
        const report = await profitAndLossReport(request({ basis: 'accrual' }), tx);
        expect(
          report.totals.netIncome[0],
          `${SPRING.from}–${SPRING.to} already carries activity; move the test window`,
        ).toBe(0);
      });
    },
    30_000,
  );

  it(
    'recognises a deducted, paid invoice when it is paid, gross and net',
    async () => {
      await withRollback(async (tx) => {
        const books = await openBooks(tx);
        // UNFI invoices $10,000 in March, short-pays an $800 billback in April.
        const unfi = await invoice(books, 'CB-1001', '2032-03-10', [
          [ACCOUNTS.SALES_DISTRIBUTOR, 1_000_000],
        ]);
        await deduction(books, 'CB-D-1', '2032-04-05', 80_000, unfi);
        await receipt(books, 'CB-R-1', '2032-04-06', 920_000, [
          { invoiceId: unfi, amountCents: 920_000 },
        ]);

        const march = await profitAndLossReport(request({ ...MAR }), tx);
        expect(march.totals.grossSales[0]).toBe(0);
        expect(march.totals.netSales[0]).toBe(0);

        const april = await profitAndLossReport(request({ ...APR }), tx);
        expect(april.totals.grossSales[0]).toBe(1_000_000);
        expect(april.totals.contraRevenue[0]).toBe(80_000);
        expect(april.totals.netSales[0]).toBe(920_000);

        // Accrual basis tells the same story on the invoice's own dates.
        const accrual = await profitAndLossReport(request({ ...MAR, basis: 'accrual' }), tx);
        expect(accrual.totals.grossSales[0]).toBe(1_000_000);

        const position = await balances(books, 'cash', { from: null, to: APR.to });
        expect(position(ACCOUNTS.AR)).toBe(0);
        expect(position(ACCOUNTS.OPERATING_CHECKING)).toBe(
          (await balances(books, 'accrual', { from: null, to: APR.to }))(ACCOUNTS.OPERATING_CHECKING),
        );
        await expectCashBooksBalance(books);
      });
    },
    30_000,
  );

  it(
    'spreads a partial payment across every line of the invoice, to the cent',
    async () => {
      await withRollback(async (tx) => {
        const books = await openBooks(tx);
        const inv = await invoice(books, 'CB-1002', '2032-03-12', [
          [ACCOUNTS.SALES_DISTRIBUTOR, 3_333],
          [ACCOUNTS.SHIPPING_INCOME, 3_333],
          [ACCOUNTS.SALES_TAX_PAYABLE, 3_334],
        ]);
        await receipt(books, 'CB-R-2', '2032-04-02', 1_000, [{ invoiceId: inv, amountCents: 1_000 }]);

        const april = await balances(books, 'cash', APR);
        expect(april(ACCOUNTS.SALES_DISTRIBUTOR)).toBe(333);
        expect(april(ACCOUNTS.SHIPPING_INCOME)).toBe(334);
        expect(april(ACCOUNTS.SALES_TAX_PAYABLE)).toBe(333);
        expect(april(ACCOUNTS.OPERATING_CHECKING)).toBe(1_000);
        // Nothing of the unpaid $90 reaches the cash books, and AR is not left holding the $10.
        expect((await balances(books, 'cash', MAR))(ACCOUNTS.SALES_DISTRIBUTOR)).toBe(0);
        expect(april(ACCOUNTS.AR)).toBe(0);
        await expectCashBooksBalance(books);
      });
    },
    30_000,
  );

  it(
    'recognises an early-payment discount with the revenue it reduced',
    async () => {
      await withRollback(async (tx) => {
        const books = await openBooks(tx);
        const inv = await invoice(books, 'CB-1003', '2032-03-15', [
          [ACCOUNTS.SALES_DISTRIBUTOR, 50_000],
        ]);
        await receipt(books, 'CB-R-3', '2032-04-01', 49_000, [
          { invoiceId: inv, amountCents: 49_000, discountCents: 1_000 },
        ]);

        const april = await profitAndLossReport(request({ ...APR }), tx);
        expect(april.totals.grossSales[0]).toBe(50_000);
        expect(april.totals.contraRevenue[0]).toBe(1_000);
        expect(april.totals.netSales[0]).toBe(49_000);
        await expectCashBooksBalance(books);
      });
    },
    30_000,
  );

  it(
    'nets a credit memo against the invoice it was applied to',
    async () => {
      await withRollback(async (tx) => {
        const books = await openBooks(tx);
        const inv = await invoice(books, 'CB-1004', '2032-03-01', [
          [ACCOUNTS.SALES_DISTRIBUTOR, 100_000],
        ]);
        await creditMemo(books, 'CB-CM-1', '2032-04-03', 20_000, [
          { invoiceId: inv, amountCents: 20_000 },
        ]);
        await receipt(books, 'CB-R-4', '2032-04-20', 80_000, [{ invoiceId: inv, amountCents: 80_000 }]);
        // A credit memo nobody has applied yet changes nothing in cash terms.
        await creditMemo(books, 'CB-CM-2', '2032-04-21', 5_000, []);

        const april = await profitAndLossReport(request({ ...APR }), tx);
        expect(april.totals.grossSales[0]).toBe(100_000);
        expect(april.totals.contraRevenue[0]).toBe(20_000);
        expect(april.totals.netSales[0]).toBe(80_000);
        await expectCashBooksBalance(books);
      });
    },
    30_000,
  );

  it(
    'keeps unapplied cash on the receivable, and leaves unpaid invoices out',
    async () => {
      await withRollback(async (tx) => {
        const books = await openBooks(tx);
        await invoice(books, 'CB-1005', '2032-03-20', [[ACCOUNTS.SALES_DISTRIBUTOR, 70_000]]);
        await receipt(books, 'CB-R-5', '2032-04-10', 25_000, []);

        const april = await balances(books, 'cash', { from: null, to: APR.to });
        expect(april(ACCOUNTS.SALES_DISTRIBUTOR)).toBe(0);
        expect(april(ACCOUNTS.OPERATING_CHECKING)).toBe(
          (await balances(books, 'accrual', { from: null, to: APR.to }))(ACCOUNTS.OPERATING_CHECKING),
        );
        // A customer credit: the money arrived, and there is no invoice to say what for.
        expect(april(ACCOUNTS.AR)).toBe(-25_000);
        await expectCashBooksBalance(books);
      });
    },
    30_000,
  );

  it(
    'shares a payment between its applications when they claim more than it paid',
    async () => {
      await withRollback(async (tx) => {
        const books = await openBooks(tx);
        const a = await invoice(books, 'CB-1006', '2032-03-02', [[ACCOUNTS.SALES_DISTRIBUTOR, 30_000]]);
        const b = await invoice(books, 'CB-1007', '2032-03-03', [[ACCOUNTS.SHIPPING_INCOME, 30_000]]);
        // $400 hit AR, but the applications add up to $600.
        const entryId = await receipt(books, 'CB-R-6', '2032-04-04', 40_000, []);
        const [receiptRow] = [
          ...(await tx.execute<{ id: string }>(
            sql`select id from receipts where journal_entry_id = ${entryId}`,
          )),
        ];
        for (const [invoiceId, cents] of [
          [a, 30_000],
          [b, 30_000],
        ] as const) {
          await tx.execute(
            sql`insert into receipt_applications (receipt_id, invoice_id, amount_cents)
                values (${receiptRow.id}, ${invoiceId}, ${cents})`,
          );
        }

        const april = await balances(books, 'cash', APR);
        expect(april(ACCOUNTS.SALES_DISTRIBUTOR) + april(ACCOUNTS.SHIPPING_INCOME)).toBe(40_000);
        expect(april(ACCOUNTS.SALES_DISTRIBUTOR)).toBe(20_000);
        expect(april(ACCOUNTS.AR)).toBe(0);
        await expectCashBooksBalance(books);
      });
    },
    30_000,
  );

  it(
    'undoes a bounced payment through the same invoice lines it recognised',
    async () => {
      await withRollback(async (tx) => {
        const books = await openBooks(tx);
        const inv = await invoice(books, 'CB-1008', '2032-03-05', [[ACCOUNTS.SALES_DISTRIBUTOR, 60_000]]);
        const paid = await receipt(books, 'CB-R-7', '2032-03-25', 60_000, [
          { invoiceId: inv, amountCents: 60_000 },
        ]);
        await reverseEntry(paid, { date: '2032-04-02', userId: null, tx });

        expect((await balances(books, 'cash', MAR))(ACCOUNTS.SALES_DISTRIBUTOR)).toBe(60_000);
        const april = await balances(books, 'cash', APR);
        expect(april(ACCOUNTS.SALES_DISTRIBUTOR)).toBe(-60_000);
        expect(april(ACCOUNTS.OPERATING_CHECKING)).toBe(-60_000);
        const position = await balances(books, 'cash', { from: null, to: APR.to });
        expect(position(ACCOUNTS.AR)).toBe(0);
        await expectCashBooksBalance(books);
      });
    },
    30_000,
  );

  it(
    'expenses a bill when it is paid, net of a vendor credit, and not before',
    async () => {
      await withRollback(async (tx) => {
        const books = await openBooks(tx);
        const saas = await bill(books, 'CB-B-1', '2032-03-08', [[ACCOUNTS.SOFTWARE, 12_000]]);
        await vendorCredit(books, 'CB-VC-1', '2032-04-01', 2_000, saas);
        await billPayment(books, 'CB-P-1', '2032-04-09', 10_000, saas);
        await bill(books, 'CB-B-2', '2032-04-11', [[ACCOUNTS.ACCOUNTING_FEES, 45_000]]);

        expect((await balances(books, 'cash', MAR))(ACCOUNTS.SOFTWARE)).toBe(0);
        const april = await balances(books, 'cash', APR);
        // The $120 bill, less the $20 credit, paid with $100.
        expect(april(ACCOUNTS.SOFTWARE)).toBe(10_000);
        expect(april(ACCOUNTS.OPERATING_CHECKING)).toBe(-10_000);
        // The unpaid bill is not an expense yet.
        expect(april(ACCOUNTS.ACCOUNTING_FEES)).toBe(0);
        expect((await balances(books, 'cash', { from: null, to: APR.to }))(ACCOUNTS.AP)).toBe(0);
        await expectCashBooksBalance(books);
      });
    },
    30_000,
  );

  it(
    'leaves out an accrual that was reversed, and its reversal',
    async () => {
      await withRollback(async (tx) => {
        const books = await openBooks(tx);
        const accrual = await post(books, '2032-03-31', 'manual', [
          [ACCOUNTS.ACCOUNTING_FEES, 300_000, 0],
          [ACCOUNTS.ACCRUED_EXPENSES, 0, 300_000],
        ]);
        await reverseEntry(accrual, { date: '2032-04-01', userId: null, tx });
        await post(books, '2032-04-15', 'bank', [
          [ACCOUNTS.ACCOUNTING_FEES, 300_000, 0],
          [ACCOUNTS.OPERATING_CHECKING, 0, 300_000],
        ]);

        expect((await balances(books, 'accrual', MAR))(ACCOUNTS.ACCOUNTING_FEES)).toBe(300_000);
        expect((await balances(books, 'cash', MAR))(ACCOUNTS.ACCOUNTING_FEES)).toBe(0);
        expect((await balances(books, 'cash', APR))(ACCOUNTS.ACCOUNTING_FEES)).toBe(300_000);
        expect(
          (await balances(books, 'cash', { from: null, to: APR.to }))(ACCOUNTS.ACCRUED_EXPENSES),
        ).toBe(0);
        await expectCashBooksBalance(books);
      });
    },
    30_000,
  );

  it(
    'shows an accrual settled by payment on the date it was booked, so the expense is not lost',
    async () => {
      await withRollback(async (tx) => {
        const books = await openBooks(tx);
        await post(books, '2032-03-31', 'manual', [
          [ACCOUNTS.ACCOUNTING_FEES, 300_000, 0],
          [ACCOUNTS.ACCRUED_EXPENSES, 0, 300_000],
        ]);
        await post(books, '2032-04-15', 'bank', [
          [ACCOUNTS.ACCRUED_EXPENSES, 300_000, 0],
          [ACCOUNTS.OPERATING_CHECKING, 0, 300_000],
        ]);

        const spring = await balances(books, 'cash', SPRING);
        expect(spring(ACCOUNTS.ACCOUNTING_FEES)).toBe(300_000);
        expect(spring(ACCOUNTS.ACCRUED_EXPENSES)).toBe(0);
        await expectCashBooksBalance(books);
      });
    },
    30_000,
  );

  it(
    'takes clearing-account sales, cost of goods sold and bank activity as posted',
    async () => {
      await withRollback(async (tx) => {
        const books = await openBooks(tx);
        await post(books, '2032-04-03', 'manual', [
          [ACCOUNTS.CLEARING_SHOPIFY, 40_000, 0],
          [ACCOUNTS.SALES_DTC, 0, 40_000],
        ]);
        await post(books, '2032-04-30', 'manual', [
          [ACCOUNTS.COGS_PRODUCT, 15_000, 0],
          [ACCOUNTS.INVENTORY_FINISHED, 0, 15_000],
        ]);

        const accrual = await profitAndLossReport(request({ ...APR, basis: 'accrual' }), tx);
        const cash = await profitAndLossReport(request({ ...APR }), tx);
        expect(cash.totals.netSales).toEqual(accrual.totals.netSales);
        expect(cash.totals.cogs).toEqual(accrual.totals.cogs);
        expect(cash.totals.netIncome[0]).toBe(25_000);
      });
    },
    30_000,
  );

  it(
    'lists the restated lines in the register, and the register reconciles',
    async () => {
      await withRollback(async (tx) => {
        const books = await openBooks(tx);
        const inv = await invoice(books, 'CB-1009', '2032-03-06', [
          [ACCOUNTS.SALES_DISTRIBUTOR, 8_000],
          [ACCOUNTS.SHIPPING_INCOME, 2_000],
        ]);
        await receipt(books, 'CB-R-9', '2032-04-07', 10_000, [{ invoiceId: inv, amountCents: 10_000 }]);

        const register = await generalLedgerData(
          {
            ...request(),
            codeFrom: ACCOUNTS.SALES_DISTRIBUTOR,
            codeTo: ACCOUNTS.SALES_DISTRIBUTOR,
            includeZeroRows: true,
          },
          tx,
        );
        const [sales] = register.accounts;
        expect(sales.lines).toHaveLength(1);
        expect(sales.lines[0]).toMatchObject({
          date: '2032-04-07',
          sourceType: 'receipt',
          creditCents: 8_000,
          debitCents: 0,
        });
        expect(sales.closingCents - sales.openingCents).toBe(8_000);

        const receivables = await generalLedgerData(
          { ...request(), codeFrom: ACCOUNTS.AR, codeTo: ACCOUNTS.AR, includeZeroRows: true },
          tx,
        );
        expect(receivables.accounts[0].lines).toHaveLength(0);
      });
    },
    30_000,
  );

  it(
    'describes what the cash basis does on the face of the report',
    async () => {
      await withRollback(async (tx) => {
        const cash = await profitAndLossReport(request(), tx);
        expect(cash.meta.warnings.join(' ')).toMatch(/applied to/);
        const accrual = await profitAndLossReport(request({ basis: 'accrual' }), tx);
        expect(accrual.meta.warnings).toEqual([]);
      });
    },
    30_000,
  );
});

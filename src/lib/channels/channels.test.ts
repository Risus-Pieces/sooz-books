/**
 * Channel settlements and sales tax, against the live database.
 *
 * Every test runs inside a transaction that is rolled back (`withRollback`), so the
 * settlements, deposits, invoices and filings written here never outlive the test and
 * nothing real — the Relay rows, the chart, the rules — is changed. Deposits land in a
 * throwaway bank account created inside the same transaction. Synthetic settlements come
 * from the research fixtures (2026 dates) or are dated 2031, after every real statement.
 */

import { afterAll, describe, expect, it } from 'vitest';

// First: loads .env.local before '@/db/client' is imported anywhere below.
import { closeTestDb, hasDatabase, withRollback } from '@/lib/ledger/test-support';

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { and, eq, inArray, sql } from 'drizzle-orm';

import {
  accounts,
  appUsers,
  bankAccounts,
  bankTransactions,
  channels,
  customers,
  invoiceLines,
  invoices,
  journalEntries,
  journalLines,
  payoutImports,
  payoutLines,
  salesTaxEntries,
} from '@/db/schema';
import { approveBankTransaction } from '@/lib/banking/post';
import { ACCOUNTS } from '@/lib/ledger/coa';
import type { LedgerDb } from '@/lib/ledger/post';
import { sumCents } from '@/lib/money';

import { clearingStatus } from './clearing';
import { ChannelError } from './errors';
import { importChannelSettlements } from './intake';
import { linkDepositsToPayout, postPayout, unpostPayout } from './post';
import { fileSalesTaxReturn, paySalesTax, recordInvoiceTax, salesTaxLiability } from './sales-tax';

afterAll(closeTestDb);

const T = 90_000;

function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url))));
}

interface World {
  tx: LedgerDb;
  userId: string | null;
  bankId: string;
  bankGlId: string;
  code: (code: string) => Promise<string>;
}

async function world(tx: LedgerDb): Promise<World> {
  await tx.execute(sql`set constraints all immediate`);
  const [owner] = await tx
    .select({ id: appUsers.id })
    .from(appUsers)
    .where(and(eq(appUsers.role, 'owner'), eq(appUsers.active, true)))
    .limit(1);
  const tag = randomUUID().slice(0, 8);
  const [gl] = await tx
    .insert(accounts)
    .values({ code: `TB-${tag}`, name: `Test bank channels ${tag}`, type: 'asset', subtype: 'bank', isBank: true })
    .returning({ id: accounts.id });
  const [bank] = await tx
    .insert(bankAccounts)
    .values({ accountId: gl.id, name: `TEST channels ${tag}`, kind: 'checking', mask: tag.slice(0, 4) })
    .returning({ id: bankAccounts.id });
  const cache = new Map<string, string>();
  return {
    tx,
    userId: owner?.id ?? null,
    bankId: bank.id,
    bankGlId: gl.id,
    code: async (code) => {
      const hit = cache.get(code);
      if (hit !== undefined) return hit;
      const [row] = await tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.code, code));
      cache.set(code, row.id);
      return row.id;
    },
  };
}

async function deposit(w: World, date: string, amountCents: number, payee: string): Promise<string> {
  const [row] = await w.tx
    .insert(bankTransactions)
    .values({
      bankAccountId: w.bankId,
      txnDate: date,
      description: payee,
      descriptionNormalized: payee.toUpperCase(),
      counterparty: payee,
      amountCents,
      fingerprint: randomUUID(),
      status: 'unreviewed',
    })
    .returning({ id: bankTransactions.id });
  return row.id;
}

async function linesOf(tx: LedgerDb, entryIds: readonly string[]) {
  return tx
    .select({ entryId: journalLines.entryId, code: accounts.code, debit: journalLines.debitCents, credit: journalLines.creditCents })
    .from(journalLines)
    .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
    .where(inArray(journalLines.entryId, [...entryIds]));
}

type Line = Awaited<ReturnType<typeof linesOf>>[number];
const netDebit = (lines: readonly Line[], code: string) =>
  sumCents(lines.filter((l) => l.code === code).map((l) => l.debit - l.credit));

/**
 * The whole cycle for one settlement: link its deposit, post the deposit to clearing from
 * the bank side (as the owner would approve it), post the settlement. Returns both entries.
 */
async function settleAndDeposit(w: World, payoutImportId: string, clearingCode: string, payee: string, depositDate: string) {
  const [payout] = await w.tx.select().from(payoutImports).where(eq(payoutImports.id, payoutImportId));
  const depositId = await deposit(w, depositDate, payout.netCents, payee);
  await linkDepositsToPayout(payout.id, [depositId], { userId: w.userId, tx: w.tx });
  const bankSide = await approveBankTransaction({ txnId: depositId, accountId: await w.code(clearingCode) }, { userId: w.userId, tx: w.tx });
  const posted = await postPayout(payout.id, { userId: w.userId, tx: w.tx });
  const lines = await linesOf(w.tx, [posted.entryId, bankSide.entryId]);
  return { payout, posted, bankSide, lines, depositId };
}

function balanced(lines: readonly Line[], entryId: string): void {
  const own = lines.filter((l) => l.entryId === entryId);
  expect(own.length).toBeGreaterThanOrEqual(2);
  expect(sumCents(own.map((l) => l.debit))).toBe(sumCents(own.map((l) => l.credit)));
}

describe.skipIf(!hasDatabase)('channel settlements post balanced and clear to zero', () => {
  it(
    'Shopify: the payout posts gross detail, the deposit clears 1110, facilitator tax never reaches 2200',
    async () => {
      await withRollback(async (tx) => {
        const w = await world(tx);
        const before = await salesTaxLiability({ from: '2026-09-01', to: '2026-09-30', state: 'CA' }, tx);
        const imported = await importChannelSettlements(
          {
            provider: 'shopify',
            balance: { filename: 'TEST shopify balance.csv', bytes: fixture('shopify-balance-transactions-2026-09-14.csv') },
            orders: { filename: 'TEST shopify orders.csv', bytes: fixture('shopify-orders-2026-09-10.csv') },
          },
          { userId: w.userId, tx },
        );
        expect(imported.inserted).toBe(1);
        const payoutId = imported.settlements[0].payoutImportId;
        expect(payoutId).not.toBeNull();

        const { posted, bankSide, lines } = await settleAndDeposit(w, payoutId ?? '', ACCOUNTS.CLEARING_SHOPIFY, 'SHOPIFY PAYOUTS', '2026-09-16');
        balanced(lines, posted.entryId);
        expect(posted.clearingAccountCode).toBe(ACCOUNTS.CLEARING_SHOPIFY);
        expect(posted.netCents).toBe(560_28);
        // Settlement debits clearing 560.28, the deposit credits it 560.28.
        expect(netDebit(lines, ACCOUNTS.CLEARING_SHOPIFY)).toBe(0);
        expect(netDebit(lines.filter((l) => l.entryId === bankSide.entryId), ACCOUNTS.CLEARING_SHOPIFY)).toBe(-560_28);
        // Revenue is gross, never net.
        expect(-netDebit(lines, ACCOUNTS.SALES_DTC)).toBe(968_01);
        // 2200 carries only what Sooz collected; the Shop app's 11.72 is not in it.
        expect(-netDebit(lines, ACCOUNTS.SALES_TAX_PAYABLE)).toBe(56_77);
        expect(posted.facilitatorGrossCents).toBe(23_44);

        // The register: CA facilitator tax is reported but not owed.
        const after = await salesTaxLiability({ from: '2026-09-01', to: '2026-09-30', state: 'CA' }, tx);
        expect(after.totals.facilitatorCents - before.totals.facilitatorCents).toBe(11_72);
        expect(after.totals.owedCents - before.totals.owedCents).toBe(19_40);
        const entries = await tx.select().from(salesTaxEntries).where(eq(salesTaxEntries.sourceId, payoutId ?? ''));
        expect(entries.find((e) => e.facilitatorRemitted)).toMatchObject({ state: 'CA', taxCents: 11_72 });
        // GST/HST is posted to 2200 but reported on no state return.
        expect(posted.foreignTaxCents).toBe(20_57);

        const status = await clearingStatus('shopify', { asOf: '2026-09-30' }, tx);
        expect(status.balanceCents).toBe(0);
        expect(status.unmatchedSettlements).toHaveLength(0);
        expect(status.blocking).toBe(false);
      });
    },
    T,
  );

  it(
    'Amazon: Σ amount == total-amount, the settlement clears 1120, and no facilitator tax touches 2200',
    async () => {
      await withRollback(async (tx) => {
        const w = await world(tx);
        const imported = await importChannelSettlements(
          { provider: 'amazon', file: { filename: 'TEST amazon.txt', bytes: fixture('amazon-settlement-22558491237.txt') } },
          { userId: w.userId, tx },
        );
        const payoutId = imported.settlements[0].payoutImportId ?? '';
        const [stored] = await tx.select().from(payoutImports).where(eq(payoutImports.id, payoutId));
        expect(stored).toMatchObject({ reportedTotalCents: 368_02, computedTotalCents: 368_02, externalId: '22558491237' });

        const { posted, lines } = await settleAndDeposit(w, payoutId, ACCOUNTS.CLEARING_AMAZON, 'AMAZON.COM SERVICES PAYMENTS', '2026-03-20');
        balanced(lines, posted.entryId);
        expect(netDebit(lines, ACCOUNTS.CLEARING_AMAZON)).toBe(0);
        expect(lines.some((l) => l.entryId === posted.entryId && l.code === ACCOUNTS.SALES_TAX_PAYABLE)).toBe(false);
        expect(-netDebit(lines, ACCOUNTS.SALES_AMAZON)).toBe(224_93);
        expect(netDebit(lines, ACCOUNTS.FBA_FEES)).toBe(125_12);
        expect(netDebit(lines, ACCOUNTS.OTHER_RECEIVABLES)).toBe(-(612_87 - 189_55));
        // Amazon names no state, so the facilitator half is noted but not in the register.
        expect(posted.facilitatorUnrecordedCents).toBe(17_08);
        expect(posted.salesTaxEntries).toBe(0);

        // Re-importing the same settlement is a no-op.
        const again = await importChannelSettlements(
          { provider: 'amazon', file: { filename: 'TEST amazon.txt', bytes: fixture('amazon-settlement-22558491237.txt') } },
          { userId: w.userId, tx },
        );
        expect(again).toMatchObject({ inserted: 0, alreadyImported: 1 });
      });
    },
    T,
  );

  it(
    'Faire: each payout batch posts to 1130 and the batch deposit clears it',
    async () => {
      await withRollback(async (tx) => {
        const w = await world(tx);
        // A deposit already in the bank feed for the 2026-08-11 batch is found and linked at import.
        const waiting = await deposit(w, '2026-08-13', 8796_58, 'FAIRE WHOLESALE PAYOUT');
        const imported = await importChannelSettlements(
          { provider: 'faire', file: { filename: 'TEST faire.csv', bytes: fixture('faire-payout-summary.csv') } },
          { userId: w.userId, tx },
        );
        expect(imported.inserted).toBe(3);
        expect(imported.depositsLinked).toBe(1);
        expect(imported.settlements.find((s) => s.periodEnd === '2026-08-11')?.depositId).toBe(waiting);
        const first = imported.settlements.find((s) => s.periodEnd === '2026-08-04');
        const { posted, lines } = await settleAndDeposit(w, first?.payoutImportId ?? '', ACCOUNTS.CLEARING_FAIRE, 'FAIRE WHOLESALE PAYOUT', '2026-08-06');
        balanced(lines, posted.entryId);
        expect(posted.netCents).toBe(4385_56);
        expect(netDebit(lines, ACCOUNTS.CLEARING_FAIRE)).toBe(0);
        expect(-netDebit(lines, ACCOUNTS.SALES_WHOLESALE)).toBe(5140_00);
        expect(netDebit(lines, ACCOUNTS.RETURNS_AND_ALLOWANCES)).toBe(32_00);
        expect(lines.some((l) => l.code === ACCOUNTS.SALES_TAX_PAYABLE)).toBe(false);
      });
    },
    T,
  );

  it(
    'Square: a settlement shaped like the Square intake posts to 1150, records Texas tax, and its three deposits clear it',
    async () => {
      await withRollback(async (tx) => {
        const w = await world(tx);
        const [dtc] = await tx.select({ id: channels.id }).from(channels).where(eq(channels.code, 'DTC'));
        const [payout] = await tx
          .insert(payoutImports)
          .values({
            provider: 'square',
            channelId: dtc.id,
            externalId: `TEST-square-${randomUUID()}`,
            periodStart: '2031-01-26',
            periodEnd: '2031-01-26',
            reportedTotalCents: 165_74,
            computedTotalCents: 165_74,
            grossCents: 162_00,
            feesCents: -4_94,
            netCents: 165_74,
          })
          .returning();
        const role = (accountRole: string) => ({ accountRole });
        await tx.insert(payoutLines).values([
          { payoutImportId: payout.id, lineNo: 1, lineType: 'gross_sales', amountCents: 162_00, description: 'Gross Sales', raw: role('square_sales') },
          { payoutImportId: payout.id, lineNo: 2, lineType: 'discount', amountCents: -4_00, description: 'Discounts & Comps', raw: role('coupons_and_promotions') },
          { payoutImportId: payout.id, lineNo: 3, lineType: 'sales_tax_collected', amountCents: 12_68, description: 'Tax', raw: role('sales_tax_payable') },
          { payoutImportId: payout.id, lineNo: 4, lineType: 'processing_fee', amountCents: -4_94, description: 'Fees', raw: role('payment_processing_fees') },
        ]);

        // Square splits one payout across several deposits (the real SQ260126 was three).
        const ids = [await deposit(w, '2031-01-26', 161_67, 'Square Inc'), await deposit(w, '2031-01-26', 3_25, 'Square Inc'), await deposit(w, '2031-01-26', 82, 'Square Inc')];
        await expect(linkDepositsToPayout(payout.id, ids.slice(0, 2), { userId: w.userId, tx })).rejects.toMatchObject({ code: 'deposit_mismatch' });
        await linkDepositsToPayout(payout.id, ids, { userId: w.userId, tx });
        const clearing = await w.code(ACCOUNTS.CLEARING_SQUARE);
        const bankEntries: string[] = [];
        for (const id of ids) bankEntries.push((await approveBankTransaction({ txnId: id, accountId: clearing }, { userId: w.userId, tx })).entryId);

        const posted = await postPayout(payout.id, { userId: w.userId, tx });
        const lines = await linesOf(tx, [posted.entryId, ...bankEntries]);
        balanced(lines, posted.entryId);
        expect(netDebit(lines, ACCOUNTS.CLEARING_SQUARE)).toBe(0);
        expect(-netDebit(lines, ACCOUNTS.SALES_SQUARE)).toBe(162_00);
        expect(netDebit(lines, ACCOUNTS.COUPONS_AND_PROMOS)).toBe(4_00);
        expect(netDebit(lines, ACCOUNTS.PAYMENT_PROCESSING_FEES)).toBe(4_94);
        expect(-netDebit(lines, ACCOUNTS.SALES_TAX_PAYABLE)).toBe(12_68);
        const [entry] = await tx.select().from(salesTaxEntries).where(eq(salesTaxEntries.sourceId, payout.id));
        expect(entry).toMatchObject({ state: 'TX', taxCents: 12_68, taxableCents: 158_00, facilitatorRemitted: false });

        // Posting twice is refused.
        await expect(postPayout(payout.id, { userId: w.userId, tx })).rejects.toMatchObject({ code: 'already_posted' });
      });
    },
    T,
  );
});

describe.skipIf(!hasDatabase)('what refuses to post', () => {
  it(
    'refuses a settlement whose lines do not sum to its reported total, and writes nothing',
    async () => {
      await withRollback(async (tx) => {
        const w = await world(tx);
        const [amazon] = await tx.select({ id: channels.id }).from(channels).where(eq(channels.code, 'AMAZON'));
        const [payout] = await tx
          .insert(payoutImports)
          .values({ provider: 'amazon', channelId: amazon.id, externalId: `TEST-${randomUUID()}`, periodEnd: '2031-02-14', reportedTotalCents: 100_00, netCents: 100_00 })
          .returning();
        await tx.insert(payoutLines).values([
          { payoutImportId: payout.id, lineNo: 1, lineType: 'gross_sales', amountCents: 120_00 },
          { payoutImportId: payout.id, lineNo: 2, lineType: 'referral_fee', amountCents: -20_01 },
        ]);
        const refused = await postPayout(payout.id, { userId: w.userId, tx }).catch((error: unknown) => error);
        expect(refused).toBeInstanceOf(ChannelError);
        expect(refused).toMatchObject({ code: 'unbalanced' });
        const entries = await tx.select({ id: journalEntries.id }).from(journalEntries).where(eq(journalEntries.sourceId, payout.id));
        expect(entries).toHaveLength(0);
        const [after] = await tx.select().from(payoutImports).where(eq(payoutImports.id, payout.id));
        expect(after.journalEntryId).toBeNull();
      });
    },
    T,
  );

  it(
    'refuses facilitator tax that does not net to zero, rather than letting it reach 2200',
    async () => {
      await withRollback(async (tx) => {
        const w = await world(tx);
        const [amazon] = await tx.select({ id: channels.id }).from(channels).where(eq(channels.code, 'AMAZON'));
        const [payout] = await tx
          .insert(payoutImports)
          .values({ provider: 'amazon', channelId: amazon.id, externalId: `TEST-${randomUUID()}`, periodEnd: '2031-02-14', reportedTotalCents: 108_25, netCents: 108_25 })
          .returning();
        await tx.insert(payoutLines).values([
          { payoutImportId: payout.id, lineNo: 1, lineType: 'gross_sales', amountCents: 100_00 },
          { payoutImportId: payout.id, lineNo: 2, lineType: 'facilitator_tax', amountCents: 8_25 },
        ]);
        await expect(postPayout(payout.id, { userId: w.userId, tx })).rejects.toMatchObject({ code: 'facilitator_not_netted' });
      });
    },
    T,
  );

  it(
    'freezes a posted settlement, and unposting reverses it and clears its tax',
    async () => {
      await withRollback(async (tx) => {
        const w = await world(tx);
        const imported = await importChannelSettlements(
          {
            provider: 'shopify',
            balance: { filename: 'TEST shopify balance.csv', bytes: fixture('shopify-balance-transactions-2026-09-14.csv') },
            orders: { filename: 'TEST shopify orders.csv', bytes: fixture('shopify-orders-2026-09-10.csv') },
          },
          { userId: w.userId, tx },
        );
        const payoutId = imported.settlements[0].payoutImportId ?? '';
        const posted = await postPayout(payoutId, { userId: w.userId, tx });

        const edit = await tx
          .transaction((sp) => sp.update(payoutLines).set({ amountCents: 1 }).where(eq(payoutLines.payoutImportId, payoutId)))
          .catch((error: unknown) => error);
        expect(String((edit as Error).cause ?? edit)).toMatch(/posted to the ledger/);
        const remove = await tx.transaction((sp) => sp.delete(payoutImports).where(eq(payoutImports.id, payoutId))).catch((error: unknown) => error);
        expect(String((remove as Error).cause ?? remove)).toMatch(/cannot be deleted/);

        const undone = await unpostPayout(payoutId, { userId: w.userId, tx }, { reason: 'test' });
        expect(undone.salesTaxEntriesRemoved).toBeGreaterThan(0);
        const [after] = await tx.select().from(payoutImports).where(eq(payoutImports.id, payoutId));
        expect(after.journalEntryId).toBeNull();
        const lines = await linesOf(tx, [posted.entryId, undone.reversalEntryId]);
        for (const code of [ACCOUNTS.CLEARING_SHOPIFY, ACCOUNTS.SALES_DTC, ACCOUNTS.SALES_TAX_PAYABLE]) {
          expect(netDebit(lines, code)).toBe(0);
        }
        const remaining = await tx.select().from(salesTaxEntries).where(eq(salesTaxEntries.sourceId, payoutId));
        expect(remaining).toHaveLength(0);
      });
    },
    T,
  );
});

describe.skipIf(!hasDatabase)('sales tax from invoices, filed and paid', () => {
  it(
    'records an invoice, files the return, freezes what it reported and posts the payment Dr 2200 / Cr bank',
    async () => {
      await withRollback(async (tx) => {
        const w = await world(tx);
        const [customer] = await tx
          .insert(customers)
          .values({ name: `TEST customer ${randomUUID().slice(0, 8)}`, shippingAddress: { state: 'Texas', city: 'Houston' } })
          .returning({ id: customers.id });
        const [invoice] = await tx
          .insert(invoices)
          .values({
            invoiceNo: `TEST-${randomUUID().slice(0, 8)}`,
            customerId: customer.id,
            invoiceDate: '2031-05-12',
            dueDate: '2031-06-11',
            status: 'open',
            subtotalCents: 150_00,
            taxCents: 8_25,
            totalCents: 158_25,
          })
          .returning({ id: invoices.id });
        await tx.insert(invoiceLines).values([
          { invoiceId: invoice.id, lineNo: 1, description: 'Taxable beverage', amountCents: 100_00, taxCents: 8_25 },
          { invoiceId: invoice.id, lineNo: 2, description: 'Resale case', amountCents: 50_00, taxCents: 0 },
        ]);

        const ctx = { userId: w.userId, tx };
        const recorded = await recordInvoiceTax(invoice.id, ctx);
        expect(recorded).toMatchObject({ action: 'recorded', state: 'TX', taxCents: 8_25, taxableCents: 100_00, exemptCents: 50_00 });
        expect(await recordInvoiceTax(invoice.id, ctx)).toMatchObject({ action: 'unchanged' });

        const filed = await fileSalesTaxReturn({ state: 'TX', periodStart: '2031-05-01', periodEnd: '2031-05-31', confirmation: 'TEST' }, ctx);
        expect(filed.filing).toMatchObject({ state: 'TX', taxDueCents: 8_25, taxableCents: 100_00, grossSalesCents: 150_00 });
        await expect(fileSalesTaxReturn({ state: 'TX', periodStart: '2031-05-01', periodEnd: '2031-05-31' }, ctx)).rejects.toMatchObject({ code: 'already_filed' });

        const edit = await tx
          .transaction((sp) => sp.update(salesTaxEntries).set({ taxCents: 1 }).where(eq(salesTaxEntries.sourceId, invoice.id)))
          .catch((error: unknown) => error);
        expect(String((edit as Error).cause ?? edit)).toMatch(/reported on filing/);

        await expect(
          paySalesTax({ filingId: filed.filing.id, bankAccountId: w.bankGlId, date: '2031-06-20', amountCents: 8_00 }, ctx),
        ).rejects.toMatchObject({ code: 'payment_mismatch' });
        await expect(
          paySalesTax({ filingId: filed.filing.id, bankAccountId: await w.code(ACCOUNTS.SALES_DTC), date: '2031-06-20', amountCents: 8_25 }, ctx),
        ).rejects.toMatchObject({ code: 'not_a_bank_account' });

        // Texas lets a timely filer keep 0.5%: 8.25 × 0.5% rounds to 0.04.
        const paid = await paySalesTax({ filingId: filed.filing.id, bankAccountId: w.bankGlId, date: '2031-06-20', amountCents: 8_21, discountCents: 4 }, ctx);
        const lines = await linesOf(tx, [paid.entryId]);
        expect(netDebit(lines, ACCOUNTS.SALES_TAX_PAYABLE)).toBe(8_25);
        expect(sumCents(lines.filter((l) => l.code.startsWith('TB-')).map((l) => l.credit))).toBe(8_21);
        expect(-netDebit(lines, ACCOUNTS.MISC_INCOME)).toBe(4);
        expect(paid.filing).toMatchObject({ taxPaidCents: 8_21, paidAt: '2031-06-20' });
        await expect(
          paySalesTax({ filingId: filed.filing.id, bankAccountId: w.bankGlId, date: '2031-06-21', amountCents: 8_25 }, ctx),
        ).rejects.toMatchObject({ code: 'already_paid' });

        // Voiding the invoice after filing writes the difference on its own date, never over the filed entry.
        await tx.update(invoices).set({ status: 'void' }).where(eq(invoices.id, invoice.id));
        const adjusted = await recordInvoiceTax(invoice.id, ctx, { asOf: '2031-07-02' });
        expect(adjusted.action).toBe('adjusted');
        const register = await tx.select().from(salesTaxEntries).where(eq(salesTaxEntries.sourceId, invoice.id));
        expect(sumCents(register.map((e) => e.taxCents))).toBe(0);
        expect(register.find((e) => e.filingId === null)).toMatchObject({ taxDate: '2031-07-02', taxCents: -8_25 });
      });
    },
    T,
  );

  it(
    'refuses to guess a state for an invoice that carries tax',
    async () => {
      await withRollback(async (tx) => {
        const w = await world(tx);
        const [customer] = await tx.insert(customers).values({ name: `TEST no address ${randomUUID().slice(0, 8)}` }).returning({ id: customers.id });
        const [invoice] = await tx
          .insert(invoices)
          .values({ invoiceNo: `TEST-${randomUUID().slice(0, 8)}`, customerId: customer.id, invoiceDate: '2031-05-12', dueDate: '2031-06-11', status: 'open', subtotalCents: 10_00, taxCents: 83, totalCents: 10_83 })
          .returning({ id: invoices.id });
        await tx.insert(invoiceLines).values({ invoiceId: invoice.id, lineNo: 1, description: 'Case', amountCents: 10_00, taxCents: 83 });
        await expect(recordInvoiceTax(invoice.id, { userId: w.userId, tx })).rejects.toMatchObject({ code: 'tax_state_unknown' });
        expect(await recordInvoiceTax(invoice.id, { userId: w.userId, tx }, { state: 'TX' })).toMatchObject({ action: 'recorded', state: 'TX' });
      });
    },
    T,
  );
});

// Sooz's real books are in exactly this state: seven Square deposits in 1150 and no settlement
// imported yet. The unit suite runs against a disposable database, so it reproduces the state
// with fixtures — here the three deposits Relay really shows on 2026-01-26 under SQ260126.
// scripts/post-authorized.ts checks the live $272.00 itself.
describe.skipIf(!hasDatabase)('Square deposits with no settlement behind them', () => {
  it(
    'leave a credit in 1150 that clearingStatus explains, flags per deposit, and treats as blocking',
    async () => {
      await withRollback(async (tx) => {
        const w = await world(tx);
        const clearing = await w.code(ACCOUNTS.CLEARING_SQUARE);
        for (const cents of [161_67, 3_25, 82]) {
          const id = await deposit(w, '2026-01-26', cents, 'Square Inc');
          await approveBankTransaction({ txnId: id, accountId: clearing }, { userId: w.userId, tx });
        }

        const status = await clearingStatus('square', { asOf: '2026-01-31' }, tx);
        expect(status.account.code).toBe(ACCOUNTS.CLEARING_SQUARE);
        expect(status.settlements).toHaveLength(0);
        expect(sumCents(status.deposits.map((d) => d.amountCents))).toBe(165_74);
        expect(status.projectedBalanceCents).toBe(-165_74);
        expect(status.unmatchedDeposits).toHaveLength(3);
        expect(status.blocking).toBe(true);
        expect(status.explanation).toMatch(/\$165\.74/);
        expect(status.exceptions.filter((e) => e.code === 'deposit_without_settlement')).toHaveLength(3);
      });
    },
    T,
  );
});

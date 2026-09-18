import { afterAll, describe, expect, it } from 'vitest';

// First: loads .env.local before '@/db/client' is imported anywhere below.
import { closeTestDb, hasDatabase, withRollback } from '@/lib/ledger/test-support';

import { asc, eq } from 'drizzle-orm';

import { accounts, invoices, journalLines, receipts } from '@/db/schema';
import { ACCOUNTS } from '@/lib/ledger/coa';
import type { LedgerDb } from '@/lib/ledger/post';

import { arAging } from './aging';
import { applyCreditMemo, issueCreditMemo, voidCreditMemo } from './credit-memos';
import { ArapError } from './errors';
import { createAndIssueInvoice, createInvoice, issueInvoice, voidInvoice } from './invoices';
import { applyReceiptCredit, recordReceipt, voidReceipt } from './receipts';
import { accountId, channelId, checkNow, makeCustomer } from './test-support';

afterAll(closeTestDb);

/** Runs `work` in a savepoint and returns what it threw, leaving the outer transaction usable. */
async function refusal(tx: LedgerDb, work: (sp: LedgerDb) => Promise<unknown>): Promise<ArapError> {
  let caught: unknown = null;
  try {
    await tx.transaction(async (sp) => {
      await work(sp);
    });
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ArapError);
  return caught as ArapError;
}

async function entryLines(tx: LedgerDb, entryId: string) {
  return tx
    .select({
      code: accounts.code,
      debit: journalLines.debitCents,
      credit: journalLines.creditCents,
      customerId: journalLines.customerId,
      channelId: journalLines.channelId,
    })
    .from(journalLines)
    .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
    .where(eq(journalLines.entryId, entryId))
    .orderBy(asc(journalLines.lineNo));
}

async function invoiceRow(tx: LedgerDb, id: string) {
  const [row] = await tx.select().from(invoices).where(eq(invoices.id, id));
  return row;
}

const ctx = (tx: LedgerDb) => ({ userId: null, tx });

describe.skipIf(!hasDatabase)('invoices', { timeout: 120_000 }, () => {
  it('numbers drafts in sequence and posts gross revenue, discounts, shipping and tax on the channel', async () => {
    await withRollback(async (tx) => {
      const wholesale = await channelId(tx, 'WHOLESALE');
      const customer = await makeCustomer(tx, { customerType: 'wholesale' });

      const first = await createInvoice(
        {
          customerId: customer.id,
          invoiceDate: '2026-03-02',
          shippingCents: 1_500,
          lines: [
            { description: 'Case of 12, Original', quantity: '2.5', unitPriceCents: 1_999, discountCents: 500, taxCents: 400 },
            { description: 'Case of 12, Ginger', quantity: 3, unitPriceCents: 3_000 },
          ],
        },
        ctx(tx),
      );
      const second = await createInvoice(
        { customerId: customer.id, invoiceDate: '2026-03-02', lines: [{ description: 'Sample', unitPriceCents: 100 }] },
        ctx(tx),
      );
      const n1 = Number(first.invoice.invoiceNo.replace(/\D/g, ''));
      const n2 = Number(second.invoice.invoiceNo.replace(/\D/g, ''));
      expect(first.invoice.invoiceNo).toMatch(/^INV-\d+$/);
      expect(n2).toBe(n1 + 1);

      // 2.5 × $19.99 = $49.975, rounded half up to $49.98.
      expect(first.lines[0].amountCents).toBe(4_998);
      expect(first.invoice.subtotalCents).toBe(4_998 + 9_000);
      expect(first.invoice.discountCents).toBe(500);
      expect(first.invoice.taxCents).toBe(400);
      expect(first.invoice.totalCents).toBe(13_998 - 500 + 1_500 + 400);
      expect(first.invoice.status).toBe('draft');
      expect(first.invoice.channelId).toBe(wholesale);
      expect(first.invoice.dueDate).toBe('2026-04-01');

      const issued = await issueInvoice(first.invoice.id, ctx(tx));
      await checkNow(tx);
      expect(issued.status).toBe('open');
      expect(issued.journalEntryId).not.toBeNull();

      const lines = await entryLines(tx, issued.journalEntryId ?? '');
      expect(lines.map((l) => [l.code, l.debit, l.credit])).toEqual([
        [ACCOUNTS.AR, 15_398, 0],
        [ACCOUNTS.SALES_WHOLESALE, 0, 4_998],
        [ACCOUNTS.TRADE_OFF_INVOICE, 500, 0],
        [ACCOUNTS.SALES_WHOLESALE, 0, 9_000],
        [ACCOUNTS.SHIPPING_INCOME, 0, 1_500],
        [ACCOUNTS.SALES_TAX_PAYABLE, 0, 400],
      ]);
      for (const line of lines) {
        expect(line.customerId).toBe(customer.id);
        expect(line.channelId).toBe(wholesale);
      }

      const again = await refusal(tx, (sp) => issueInvoice(first.invoice.id, ctx(sp)));
      expect(again.code).toBe('invalid_state');
    });
  });

  it('refuses a line with no revenue account when the customer has no channel', async () => {
    await withRollback(async (tx) => {
      const customer = await makeCustomer(tx, { customerType: 'other' });
      const error = await refusal(tx, (sp) =>
        createInvoice({ customerId: customer.id, invoiceDate: '2026-03-02', lines: [{ description: 'x', unitPriceCents: 100 }] }, ctx(sp)),
      );
      expect(error.code).toBe('invalid_input');

      const other = await accountId(tx, ACCOUNTS.OTHER_SALES_INCOME);
      const ok = await createInvoice(
        {
          customerId: customer.id,
          invoiceDate: '2026-03-02',
          lines: [{ description: 'Pallet sale', unitPriceCents: 100, revenueAccountId: other }],
        },
        ctx(tx),
      );
      expect(ok.lines[0].revenueAccountId).toBe(other);

      const contra = await accountId(tx, ACCOUNTS.RETURNS_AND_ALLOWANCES);
      const wrong = await refusal(tx, (sp) =>
        createInvoice(
          { customerId: customer.id, invoiceDate: '2026-03-02', lines: [{ description: 'x', unitPriceCents: 100, revenueAccountId: contra }] },
          ctx(sp),
        ),
      );
      expect(wrong.code).toBe('invalid_input');
    });
  });

  it('voids an unpaid invoice by reversal, keeps its number, and never reissues it', async () => {
    await withRollback(async (tx) => {
      const customer = await makeCustomer(tx);
      const invoice = await createAndIssueInvoice(
        { customerId: customer.id, invoiceDate: '2026-03-02', lines: [{ description: 'Case', unitPriceCents: 10_000 }] },
        ctx(tx),
      );
      const voided = await voidInvoice(invoice.id, { date: '2026-03-05', reason: 'Order cancelled' }, ctx(tx));
      await checkNow(tx);
      expect(voided.status).toBe('void');
      expect(voided.invoiceNo).toBe(invoice.invoiceNo);

      const next = await createInvoice(
        { customerId: customer.id, invoiceDate: '2026-03-06', lines: [{ description: 'Case', unitPriceCents: 10_000 }] },
        ctx(tx),
      );
      expect(next.invoice.invoiceNo).not.toBe(invoice.invoiceNo);

      // Voided on the 5th: still receivable on the 4th, gone on the 5th.
      const on4th = await arAging('2026-03-04', tx);
      const on5th = await arAging('2026-03-05', tx);
      expect(on4th.parties.find((p) => p.partyId === customer.id)?.buckets.total).toBe(10_000);
      expect(on5th.parties.find((p) => p.partyId === customer.id)).toBeUndefined();
      expect(on4th.differenceCents).toBe(0);
      expect(on5th.differenceCents).toBe(0);
    });
  });
});

describe.skipIf(!hasDatabase)('receipts', { timeout: 120_000 }, () => {
  it('applies partially, keeps unapplied cash as a customer credit, refuses over-application', async () => {
    await withRollback(async (tx) => {
      const customer = await makeCustomer(tx);
      const a = await createAndIssueInvoice(
        { customerId: customer.id, invoiceDate: '2026-04-01', lines: [{ description: 'A', unitPriceCents: 10_000 }] },
        ctx(tx),
      );
      const b = await createAndIssueInvoice(
        { customerId: customer.id, invoiceDate: '2026-04-02', lines: [{ description: 'B', unitPriceCents: 4_000 }] },
        ctx(tx),
      );

      const over = await refusal(tx, (sp) =>
        recordReceipt(
          { customerId: customer.id, receiptDate: '2026-04-10', amountCents: 20_000, applications: [{ invoiceId: a.id, amountCents: 10_001 }] },
          ctx(sp),
        ),
      );
      expect(over.code).toBe('over_application');

      const more = await refusal(tx, (sp) =>
        recordReceipt(
          { customerId: customer.id, receiptDate: '2026-04-10', amountCents: 5_000, applications: [{ invoiceId: a.id, amountCents: 6_000 }] },
          ctx(sp),
        ),
      );
      expect(more.code).toBe('over_application');

      const { receipt, entryId, unappliedCents } = await recordReceipt(
        {
          customerId: customer.id,
          receiptDate: '2026-04-10',
          amountCents: 12_000,
          applications: [{ invoiceId: a.id, amountCents: 6_000 }],
        },
        ctx(tx),
      );
      await checkNow(tx);
      expect(receipt.receiptNo).toMatch(/^RCPT-\d+$/);
      expect(unappliedCents).toBe(6_000);
      expect((await invoiceRow(tx, a.id)).status).toBe('partial');
      expect((await invoiceRow(tx, a.id)).paidCents).toBe(6_000);

      const lines = await entryLines(tx, entryId);
      expect(lines.map((l) => [l.code, l.debit, l.credit])).toEqual([
        [ACCOUNTS.UNDEPOSITED_FUNDS, 12_000, 0],
        [ACCOUNTS.AR, 0, 6_000],
        [ACCOUNTS.AR, 0, 6_000],
      ]);

      const aging = await arAging('2026-04-10', tx);
      const party = aging.parties.find((p) => p.partyId === customer.id);
      expect(party?.buckets.total).toBe(10_000 + 4_000 - 12_000);
      expect(party?.items.find((i) => i.kind === 'receipt')?.balanceCents).toBe(-6_000);
      expect(aging.differenceCents).toBe(0);

      const tooMuch = await refusal(tx, (sp) =>
        applyReceiptCredit(receipt.id, { date: '2026-04-12', applications: [{ invoiceId: b.id, amountCents: 6_001 }] }, ctx(sp)),
      );
      expect(tooMuch.code).toBe('over_application');

      const c = await createAndIssueInvoice(
        { customerId: customer.id, invoiceDate: '2026-04-11', lines: [{ description: 'C', unitPriceCents: 5_000 }] },
        ctx(tx),
      );
      await applyReceiptCredit(
        receipt.id,
        {
          date: '2026-04-12',
          applications: [
            { invoiceId: a.id, amountCents: 1_000 },
            { invoiceId: b.id, amountCents: 4_000 },
            { invoiceId: c.id, amountCents: 1_000 },
          ],
        },
        ctx(tx),
      );
      expect((await invoiceRow(tx, a.id)).status).toBe('partial');
      expect((await invoiceRow(tx, b.id)).status).toBe('paid');
      expect((await invoiceRow(tx, c.id)).status).toBe('partial');
      const [r] = await tx.select().from(receipts).where(eq(receipts.id, receipt.id));
      expect(r.appliedCents).toBe(12_000);

      // The application is dated the 12th: on the 11th the credit is still unapplied.
      const on11 = await arAging('2026-04-11', tx);
      const items11 = on11.parties.find((p) => p.partyId === customer.id)?.items ?? [];
      expect(items11.map((i) => [i.docNo, i.balanceCents])).toEqual([
        [receipt.receiptNo, -6_000],
        [a.invoiceNo, 4_000],
        [b.invoiceNo, 4_000],
        [c.invoiceNo, 5_000],
      ]);
      const on12 = await arAging('2026-04-12', tx);
      const items12 = on12.parties.find((p) => p.partyId === customer.id)?.items ?? [];
      expect(items12.map((i) => [i.docNo, i.balanceCents])).toEqual([
        [a.invoiceNo, 3_000],
        [c.invoiceNo, 4_000],
      ]);
      // A second application of the same receipt to the same invoice is its own dated row.
      expect((await invoiceRow(tx, a.id)).paidCents).toBe(7_000);
      expect(on11.differenceCents).toBe(0);
      expect(on12.differenceCents).toBe(0);

      const paid = await refusal(tx, (sp) => voidInvoice(a.id, {}, ctx(sp)));
      expect(paid.code).toBe('invalid_state');
    });
  });

  it('takes an early-payment discount within terms to 4580 and refuses one outside them', async () => {
    await withRollback(async (tx) => {
      const customer = await makeCustomer(tx, { termsDiscountPct: '2.00', termsDiscountDays: 10, termsDays: 30 });
      const invoice = await createAndIssueInvoice(
        { customerId: customer.id, invoiceDate: '2026-05-01', lines: [{ description: 'Pallet', unitPriceCents: 50_000 }] },
        ctx(tx),
      );

      const late = await refusal(tx, (sp) =>
        recordReceipt(
          {
            customerId: customer.id,
            receiptDate: '2026-05-12',
            amountCents: 49_000,
            applications: [{ invoiceId: invoice.id, amountCents: 49_000, discountCents: 1_000 }],
          },
          ctx(sp),
        ),
      );
      expect(late.code).toBe('discount_not_allowed');

      const greedy = await refusal(tx, (sp) =>
        recordReceipt(
          {
            customerId: customer.id,
            receiptDate: '2026-05-08',
            amountCents: 48_000,
            applications: [{ invoiceId: invoice.id, amountCents: 48_000, discountCents: 2_000 }],
          },
          ctx(sp),
        ),
      );
      expect(greedy.code).toBe('discount_not_allowed');

      const { entryId } = await recordReceipt(
        {
          customerId: customer.id,
          receiptDate: '2026-05-08',
          amountCents: 49_000,
          applications: [{ invoiceId: invoice.id, amountCents: 49_000, discountCents: 1_000 }],
        },
        ctx(tx),
      );
      await checkNow(tx);
      const lines = await entryLines(tx, entryId);
      expect(lines.map((l) => [l.code, l.debit, l.credit])).toEqual([
        [ACCOUNTS.UNDEPOSITED_FUNDS, 49_000, 0],
        [ACCOUNTS.EARLY_PAYMENT_DISCOUNTS, 1_000, 0],
        [ACCOUNTS.AR, 0, 50_000],
      ]);
      const row = await invoiceRow(tx, invoice.id);
      expect(row.status).toBe('paid');
      expect(row.totalCents - row.paidCents - row.creditedCents - row.deductedCents).toBe(0);
    });
  });

  it('voids a receipt: reverses it and reopens the invoice it paid', async () => {
    await withRollback(async (tx) => {
      const customer = await makeCustomer(tx);
      const invoice = await createAndIssueInvoice(
        { customerId: customer.id, invoiceDate: '2026-06-01', lines: [{ description: 'Case', unitPriceCents: 7_500 }] },
        ctx(tx),
      );
      const { receipt } = await recordReceipt(
        { customerId: customer.id, receiptDate: '2026-06-03', amountCents: 7_500, applications: [{ invoiceId: invoice.id, amountCents: 7_500 }] },
        ctx(tx),
      );
      expect((await invoiceRow(tx, invoice.id)).status).toBe('paid');

      await voidReceipt(receipt.id, { date: '2026-06-09', reason: 'Check bounced' }, ctx(tx));
      await checkNow(tx);
      const row = await invoiceRow(tx, invoice.id);
      expect(row.status).toBe('open');
      expect(row.paidCents).toBe(0);

      for (const asOf of ['2026-06-02', '2026-06-05', '2026-06-09']) {
        const aging = await arAging(asOf, tx);
        expect(aging.differenceCents, asOf).toBe(0);
      }
      expect((await arAging('2026-06-05', tx)).parties.find((p) => p.partyId === customer.id)).toBeUndefined();
      expect((await arAging('2026-06-09', tx)).parties.find((p) => p.partyId === customer.id)?.buckets.total).toBe(7_500);

      const twice = await refusal(tx, (sp) => voidReceipt(receipt.id, {}, ctx(sp)));
      expect(twice.code).toBe('invalid_state');
    });
  });
});

describe.skipIf(!hasDatabase)('credit memos', { timeout: 120_000 }, () => {
  it('posts Dr contra revenue / Cr AR, applies to an invoice, and cannot be voided once applied', async () => {
    await withRollback(async (tx) => {
      const customer = await makeCustomer(tx, { customerType: 'distributor' });
      const distributor = await channelId(tx, 'DISTRIBUTOR');
      const invoice = await createAndIssueInvoice(
        { customerId: customer.id, invoiceDate: '2026-07-01', lines: [{ description: 'Pallet', unitPriceCents: 30_000 }] },
        ctx(tx),
      );
      const issued = await createInvoice(
        { customerId: customer.id, invoiceDate: '2026-07-01', lines: [{ description: 'Pallet', unitPriceCents: 30_000 }] },
        ctx(tx),
      );
      expect(issued.lines[0].revenueAccountId).toBe(await accountId(tx, ACCOUNTS.SALES_DISTRIBUTOR));

      const memo = await issueCreditMemo(
        {
          customerId: customer.id,
          memoDate: '2026-07-10',
          reason: 'Two damaged cases',
          amountCents: 2_000,
          applications: [{ invoiceId: invoice.id, amountCents: 2_000 }],
        },
        ctx(tx),
      );
      await checkNow(tx);
      expect(memo.memoNo).toMatch(/^CM-\d+$/);
      const lines = await entryLines(tx, memo.journalEntryId ?? '');
      expect(lines.map((l) => [l.code, l.debit, l.credit, l.channelId])).toEqual([
        [ACCOUNTS.RETURNS_AND_ALLOWANCES, 2_000, 0, distributor],
        [ACCOUNTS.AR, 0, 2_000, distributor],
      ]);
      const row = await invoiceRow(tx, invoice.id);
      expect(row.creditedCents).toBe(2_000);
      expect(row.status).toBe('partial');

      const locked = await refusal(tx, (sp) => voidCreditMemo(memo.id, {}, ctx(sp)));
      expect(locked.code).toBe('invalid_state');
      const noInvoiceVoid = await refusal(tx, (sp) => voidInvoice(invoice.id, {}, ctx(sp)));
      expect(noInvoiceVoid.code).toBe('invalid_state');

      const loose = await issueCreditMemo(
        { customerId: customer.id, memoDate: '2026-07-11', reason: 'Goodwill', amountCents: 1_500 },
        ctx(tx),
      );
      const tooMuch = await refusal(tx, (sp) =>
        applyCreditMemo(loose.id, { date: '2026-07-12', applications: [{ invoiceId: invoice.id, amountCents: 1_501 }] }, ctx(sp)),
      );
      expect(tooMuch.code).toBe('over_application');
      await applyCreditMemo(loose.id, { date: '2026-07-12', applications: [{ invoiceId: invoice.id, amountCents: 1_500 }] }, ctx(tx));
      expect((await invoiceRow(tx, invoice.id)).creditedCents).toBe(3_500);

      const other = await issueCreditMemo(
        { customerId: customer.id, memoDate: '2026-07-11', reason: 'Entered twice', amountCents: 900 },
        ctx(tx),
      );
      await voidCreditMemo(other.id, { date: '2026-07-11' }, ctx(tx));
      await checkNow(tx);

      for (const asOf of ['2026-07-01', '2026-07-10', '2026-07-11', '2026-07-12', '2026-12-31']) {
        expect((await arAging(asOf, tx)).differenceCents, asOf).toBe(0);
      }
    });
  });
});

describe.skipIf(!hasDatabase)('AR aging', { timeout: 120_000 }, () => {
  it('buckets by days past due on the as-of date and ties to the AR control account', async () => {
    await withRollback(async (tx) => {
      const customer = await makeCustomer(tx, { termsDays: 30 });
      const dates: [string, number][] = [
        ['2026-01-02', 1_000], // due 02-01: 118 days past due on 05-30 -> 90+
        ['2026-02-20', 2_000], // due 03-22: 69 -> 61–90
        ['2026-03-20', 3_000], // due 04-19: 41 -> 31–60
        ['2026-04-20', 4_000], // due 05-20: 10 -> 1–30
        ['2026-05-15', 5_000], // due 06-14: not yet due -> current
      ];
      for (const [date, cents] of dates) {
        await createAndIssueInvoice(
          { customerId: customer.id, invoiceDate: date, lines: [{ description: date, unitPriceCents: cents }] },
          ctx(tx),
        );
      }
      const aging = await arAging('2026-05-30', tx);
      const party = aging.parties.find((p) => p.partyId === customer.id);
      expect(party?.buckets).toEqual({
        current: 5_000,
        days1to30: 4_000,
        days31to60: 3_000,
        days61to90: 2_000,
        over90: 1_000,
        total: 15_000,
      });
      expect(aging.totals.total).toBe(aging.controlBalanceCents);
      expect(aging.differenceCents).toBe(0);
    });
  });
});

describe.skipIf(!hasDatabase)('database guards', { timeout: 120_000 }, () => {
  it('refuses a write that would settle an invoice past its total, even around the engine', async () => {
    await withRollback(async (tx) => {
      const customer = await makeCustomer(tx);
      const invoice = await createAndIssueInvoice(
        { customerId: customer.id, invoiceDate: '2026-03-02', lines: [{ description: 'Case', unitPriceCents: 1_000 }] },
        ctx(tx),
      );
      let caught: unknown = null;
      try {
        await tx.transaction(async (sp) => {
          await sp.update(invoices).set({ paidCents: 1_001 }).where(eq(invoices.id, invoice.id));
        });
      } catch (error) {
        caught = error;
      }
      expect(String((caught as { cause?: unknown } | null)?.cause ?? caught)).toContain('invoice_not_overapplied');
    });
  });
});

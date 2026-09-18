import { afterAll, describe, expect, it } from 'vitest';

// First: loads .env.local before '@/db/client' is imported anywhere below.
import { closeTestDb, hasDatabase, withRollback } from '@/lib/ledger/test-support';

import { ACCOUNTS } from '@/lib/ledger/coa';
import { type LedgerDb, postJournalEntry } from '@/lib/ledger/post';
import { reverseEntry } from '@/lib/ledger/reverse';

import { payBills, voidBillPayment } from './bill-payments';
import { createAndApproveBill } from './bills';
import { form1099NecThresholdCents, form1099Report } from './form-1099';
import { accountId, checkNow, makeVendor } from './test-support';

afterAll(closeTestDb);

const ctx = (tx: LedgerDb) => ({ userId: null, tx });

describe('form1099NecThresholdCents', () => {
  it('is $600 through 2025 and $2,000 from 2026', () => {
    expect(form1099NecThresholdCents(2024)).toBe(60_000);
    expect(form1099NecThresholdCents(2025)).toBe(60_000);
    expect(form1099NecThresholdCents(2026)).toBe(200_000);
  });
});

async function directPayment(tx: LedgerDb, vendorId: string, date: string, cents: number, expenseCode: string, bankCode: string) {
  return postJournalEntry(
    {
      date,
      memo: 'Direct bank payment',
      sourceType: 'bank',
      // The vendor is tagged on the expense line only, as a bank categorization leaves it.
      lines: [
        { accountCode: expenseCode, debitCents: cents, vendorId },
        { accountCode: bankCode, creditCents: cents },
      ],
    },
    { userId: null, tx },
  );
}

describe.skipIf(!hasDatabase)('form1099Report', { timeout: 120_000 }, () => {
  it('totals reportable payments per vendor per year, excluding card and voided payments', async () => {
    await withRollback(async (tx) => {
      const legal = await accountId(tx, ACCOUNTS.LEGAL_FEES);
      const checking = await accountId(tx, ACCOUNTS.OPERATING_CHECKING);
      const card = await accountId(tx, ACCOUNTS.CREDIT_CARD_OPERATIONS);
      const formulation = await accountId(tx, ACCOUNTS.FORMULATION);

      const flagged = await makeVendor(tx, { vendorType: 'professional', defaultExpenseAccountId: legal, is1099: true });
      const withW9 = await makeVendor(tx, { vendorType: 'professional', defaultExpenseAccountId: legal, is1099: true, w9OnFile: true });
      const unflagged = await makeVendor(tx, { vendorType: 'professional', defaultExpenseAccountId: formulation });
      const supplies = await accountId(tx, ACCOUNTS.OFFICE_SUPPLIES);
      const retailer = await makeVendor(tx, { vendorType: 'other', defaultExpenseAccountId: supplies });

      const bill = await createAndApproveBill(
        { vendorId: flagged.id, billNo: 'F-1', billDate: '2026-01-15', lines: [{ description: 'Retainer', amountCents: 300_000 }] },
        ctx(tx),
      );
      await payBills(
        { vendorId: flagged.id, paymentDate: '2026-02-01', amountCents: 150_000, paymentAccountId: checking, applications: [{ billId: bill.id, amountCents: 150_000 }] },
        ctx(tx),
      );
      await payBills(
        { vendorId: flagged.id, paymentDate: '2026-02-02', amountCents: 50_000, paymentAccountId: card, applications: [{ billId: bill.id, amountCents: 50_000 }] },
        ctx(tx),
      );
      const bounced = await payBills(
        { vendorId: flagged.id, paymentDate: '2026-02-03', amountCents: 40_000, paymentAccountId: checking, applications: [{ billId: bill.id, amountCents: 40_000 }] },
        ctx(tx),
      );
      await voidBillPayment(bounced.payment.id, { date: '2026-02-10' }, ctx(tx));

      await directPayment(tx, flagged.id, '2026-03-01', 70_000, ACCOUNTS.LEGAL_FEES, ACCOUNTS.OPERATING_CHECKING);
      const mistake = await directPayment(tx, flagged.id, '2026-03-02', 10_000, ACCOUNTS.LEGAL_FEES, ACCOUNTS.OPERATING_CHECKING);
      await reverseEntry(mistake.entryId, { userId: null, tx, owner: 'bank' });
      await directPayment(tx, flagged.id, '2026-03-03', 9_000, ACCOUNTS.LEGAL_FEES, ACCOUNTS.CREDIT_CARD_OPERATIONS);
      await directPayment(tx, flagged.id, '2025-11-20', 70_000, ACCOUNTS.LEGAL_FEES, ACCOUNTS.OPERATING_CHECKING);

      await directPayment(tx, withW9.id, '2026-04-01', 250_000, ACCOUNTS.LEGAL_FEES, ACCOUNTS.OPERATING_CHECKING);
      await directPayment(tx, unflagged.id, '2026-05-31', 45_000, ACCOUNTS.FORMULATION, ACCOUNTS.OPERATING_CHECKING);
      await directPayment(tx, unflagged.id, '2026-08-12', 53_544, ACCOUNTS.FORMULATION, ACCOUNTS.OPERATING_CHECKING);
      await directPayment(tx, retailer.id, '2026-04-01', 99_000, ACCOUNTS.OFFICE_SUPPLIES, ACCOUNTS.OPERATING_CHECKING);
      await checkNow(tx);

      const report = await form1099Report(2026, {}, tx);
      expect(report.thresholdCents).toBe(200_000);
      const row = report.vendors.find((v) => v.vendorId === flagged.id);
      expect(row).toMatchObject({
        billPaymentCents: 150_000,
        directPaymentCents: 70_000,
        reportableCents: 220_000,
        cardPaymentCents: 59_000,
        meetsThreshold: true,
        status: 'needs_w9',
      });
      expect(report.vendors.find((v) => v.vendorId === withW9.id)?.status).toBe('file');
      expect(report.warnings.some((w) => w.includes(flagged.name))).toBe(true);

      const candidate = report.candidates.find((v) => v.vendorId === unflagged.id);
      expect(candidate).toMatchObject({ reportableCents: 98_544, meetsThreshold: false, status: 'review_flag' });
      expect(report.candidates.find((v) => v.vendorId === retailer.id)).toBeUndefined();
      expect(report.vendors.find((v) => v.vendorId === retailer.id)).toBeUndefined();

      const atOldLine = await form1099Report(2026, { thresholdCents: 60_000 }, tx);
      expect(atOldLine.candidates.find((v) => v.vendorId === unflagged.id)?.meetsThreshold).toBe(true);

      const prior = await form1099Report(2025, {}, tx);
      expect(prior.thresholdCents).toBe(60_000);
      expect(prior.vendors.find((v) => v.vendorId === flagged.id)).toMatchObject({
        reportableCents: 70_000,
        meetsThreshold: true,
        status: 'needs_w9',
      });
      expect(prior.vendors.find((v) => v.vendorId === withW9.id)).toMatchObject({
        reportableCents: 0,
        status: 'below_threshold',
      });
    });
  });
});

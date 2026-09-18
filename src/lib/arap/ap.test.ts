import { afterAll, describe, expect, it } from 'vitest';

// First: loads .env.local before '@/db/client' is imported anywhere below.
import { closeTestDb, hasDatabase, withRollback } from '@/lib/ledger/test-support';

import { asc, eq } from 'drizzle-orm';

import { accounts, billPayments, bills, journalLines } from '@/db/schema';
import { ACCOUNTS } from '@/lib/ledger/coa';
import type { LedgerDb } from '@/lib/ledger/post';

import { apAging } from './aging';
import { applyVendorPrepayment, payBills, voidBillPayment } from './bill-payments';
import { approveBill, createAndApproveBill, createBill, voidBill } from './bills';
import { ArapError } from './errors';
import { applyVendorCredit, issueVendorCredit, voidVendorCredit } from './vendor-credits';
import { accountId, checkNow, makeVendor } from './test-support';

afterAll(closeTestDb);

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
      vendorId: journalLines.vendorId,
    })
    .from(journalLines)
    .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
    .where(eq(journalLines.entryId, entryId))
    .orderBy(asc(journalLines.lineNo));
}

async function billRow(tx: LedgerDb, id: string) {
  const [row] = await tx.select().from(bills).where(eq(bills.id, id));
  return row;
}

const ctx = (tx: LedgerDb) => ({ userId: null, tx });

describe.skipIf(!hasDatabase)('bills', { timeout: 120_000 }, () => {
  it('capitalizes ingredient and packaging lines, expenses the rest, and credits AP with the vendor on every line', async () => {
    await withRollback(async (tx) => {
      const ingredients = await accountId(tx, ACCOUNTS.INVENTORY_INGREDIENTS);
      const packaging = await accountId(tx, ACCOUNTS.INVENTORY_PACKAGING);
      const freightIn = await accountId(tx, ACCOUNTS.COGS_FREIGHT_IN);
      const formulation = await accountId(tx, ACCOUNTS.FORMULATION);
      const vendor = await makeVendor(tx, { vendorType: 'ingredients', defaultExpenseAccountId: ingredients });

      const draft = await createBill(
        {
          vendorId: vendor.id,
          billNo: 'PO-7781',
          billDate: '2026-04-03',
          lines: [
            { description: 'Ginger extract, 25 kg', quantity: '25', unitCostCents: 1_840 },
            { description: '12 oz cans', accountId: packaging, amountCents: 36_000 },
            { description: 'Freight', accountId: freightIn, amountCents: 4_500 },
          ],
        },
        ctx(tx),
      );
      expect(draft.bill.status).toBe('draft');
      expect(draft.bill.totalCents).toBe(46_000 + 36_000 + 4_500);
      expect(draft.bill.dueDate).toBe('2026-05-03');
      expect(draft.lines.map((l) => [l.accountId, l.amountCents, l.isInventory])).toEqual([
        [ingredients, 46_000, true],
        [packaging, 36_000, true],
        [freightIn, 4_500, false],
      ]);

      const approved = await approveBill(draft.bill.id, ctx(tx));
      await checkNow(tx);
      expect(approved.status).toBe('open');
      const lines = await entryLines(tx, approved.journalEntryId ?? '');
      expect(lines.map((l) => [l.code, l.debit, l.credit])).toEqual([
        [ACCOUNTS.INVENTORY_INGREDIENTS, 46_000, 0],
        [ACCOUNTS.INVENTORY_PACKAGING, 36_000, 0],
        [ACCOUNTS.COGS_FREIGHT_IN, 4_500, 0],
        [ACCOUNTS.AP, 0, 86_500],
      ]);
      for (const line of lines) expect(line.vendorId).toBe(vendor.id);

      const duplicate = await refusal(tx, (sp) =>
        createBill({ vendorId: vendor.id, billNo: 'PO-7781', billDate: '2026-04-04', lines: [{ description: 'x', amountCents: 100 }] }, ctx(sp)),
      );
      expect(duplicate.code).toBe('duplicate_document');

      const mislabeled = await refusal(tx, (sp) =>
        createBill(
          {
            vendorId: vendor.id,
            billNo: 'PO-7782',
            billDate: '2026-04-04',
            lines: [{ description: 'Lab time', accountId: formulation, amountCents: 100, isInventory: true }],
          },
          ctx(sp),
        ),
      );
      expect(mislabeled.code).toBe('invalid_input');

      const bank = await accountId(tx, ACCOUNTS.OPERATING_CHECKING);
      const moneyLine = await refusal(tx, (sp) =>
        createBill(
          { vendorId: vendor.id, billNo: 'PO-7783', billDate: '2026-04-04', lines: [{ description: 'x', accountId: bank, amountCents: 100 }] },
          ctx(sp),
        ),
      );
      expect(moneyLine.code).toBe('invalid_input');
    });
  });
});

describe.skipIf(!hasDatabase)('bill payments and vendor credits', { timeout: 120_000 }, () => {
  it('pays across bills, refuses over-application, marks card payments not 1099-reportable, and ties AP aging', async () => {
    await withRollback(async (tx) => {
      const legal = await accountId(tx, ACCOUNTS.LEGAL_FEES);
      const checking = await accountId(tx, ACCOUNTS.OPERATING_CHECKING);
      const card = await accountId(tx, ACCOUNTS.CREDIT_CARD_OPERATIONS);
      const vendor = await makeVendor(tx, { vendorType: 'professional', defaultExpenseAccountId: legal, termsDays: 15 });

      const one = await createAndApproveBill(
        { vendorId: vendor.id, billNo: 'A-1', billDate: '2026-02-01', lines: [{ description: 'Trademark filing', amountCents: 30_000 }] },
        ctx(tx),
      );
      const two = await createAndApproveBill(
        { vendorId: vendor.id, billNo: 'A-2', billDate: '2026-02-10', lines: [{ description: 'Contract review', amountCents: 20_000 }] },
        ctx(tx),
      );

      const over = await refusal(tx, (sp) =>
        payBills(
          {
            vendorId: vendor.id,
            paymentDate: '2026-02-20',
            amountCents: 40_000,
            paymentAccountId: checking,
            applications: [{ billId: one.id, amountCents: 30_001 }],
          },
          ctx(sp),
        ),
      );
      expect(over.code).toBe('over_application');

      const ach = await payBills(
        {
          vendorId: vendor.id,
          paymentDate: '2026-02-20',
          amountCents: 45_000,
          paymentAccountId: checking,
          applications: [
            { billId: one.id, amountCents: 30_000 },
            { billId: two.id, amountCents: 10_000 },
          ],
        },
        ctx(tx),
      );
      await checkNow(tx);
      expect(ach.payment.paymentNo).toMatch(/^BPMT-\d+$/);
      expect(ach.payment.is1099Reportable).toBe(true);
      expect(ach.unappliedCents).toBe(5_000);
      expect((await billRow(tx, one.id)).status).toBe('paid');
      expect((await billRow(tx, two.id)).status).toBe('partial');
      const lines = await entryLines(tx, ach.entryId);
      expect(lines.map((l) => [l.code, l.debit, l.credit])).toEqual([
        [ACCOUNTS.AP, 30_000, 0],
        [ACCOUNTS.AP, 10_000, 0],
        [ACCOUNTS.AP, 5_000, 0],
        [ACCOUNTS.OPERATING_CHECKING, 0, 45_000],
      ]);
      for (const line of lines) expect(line.vendorId).toBe(vendor.id);

      const aging = await apAging('2026-02-20', tx);
      const party = aging.parties.find((p) => p.partyId === vendor.id);
      expect(party?.items.map((i) => [i.kind, i.balanceCents])).toEqual([
        ['bill_payment', -5_000],
        ['bill', 10_000],
      ]);
      expect(aging.differenceCents).toBe(0);

      await applyVendorPrepayment(ach.payment.id, { date: '2026-02-21', applications: [{ billId: two.id, amountCents: 5_000 }] }, ctx(tx));
      expect((await billRow(tx, two.id)).paidCents).toBe(15_000);

      const three = await createAndApproveBill(
        { vendorId: vendor.id, billNo: 'A-3', billDate: '2026-03-01', lines: [{ description: 'Filing fee', amountCents: 5_000 }] },
        ctx(tx),
      );
      const byCard = await payBills(
        {
          vendorId: vendor.id,
          paymentDate: '2026-03-02',
          amountCents: 5_000,
          paymentAccountId: card,
          applications: [{ billId: three.id, amountCents: 5_000 }],
        },
        ctx(tx),
      );
      expect(byCard.payment.method).toBe('card');
      expect(byCard.payment.is1099Reportable).toBe(false);

      const paidVoid = await refusal(tx, (sp) => voidBill(one.id, {}, ctx(sp)));
      expect(paidVoid.code).toBe('invalid_state');

      await voidBillPayment(byCard.payment.id, { date: '2026-03-05' }, ctx(tx));
      await checkNow(tx);
      expect((await billRow(tx, three.id)).status).toBe('open');
      const [voided] = await tx.select().from(billPayments).where(eq(billPayments.id, byCard.payment.id));
      expect(voided.memo).toContain('Void 2026-03-05');

      for (const asOf of ['2026-02-01', '2026-02-20', '2026-02-21', '2026-03-02', '2026-03-05', '2026-12-31']) {
        expect((await apAging(asOf, tx)).differenceCents, asOf).toBe(0);
      }
      const march = await apAging('2026-03-31', tx);
      const items = march.parties.find((p) => p.partyId === vendor.id)?.items ?? [];
      expect(items.map((i) => [i.docNo, i.balanceCents, i.bucket])).toEqual([
        ['A-2', 5_000, 'days31to60'],
        ['A-3', 5_000, 'days1to30'],
      ]);
    });
  });

  it('issues a vendor credit against the original account, applies it, and voids an unapplied one', async () => {
    await withRollback(async (tx) => {
      const packaging = await accountId(tx, ACCOUNTS.INVENTORY_PACKAGING);
      const vendor = await makeVendor(tx, { vendorType: 'packaging', defaultExpenseAccountId: packaging });
      const bill = await createAndApproveBill(
        { vendorId: vendor.id, billNo: 'L-900', billDate: '2026-05-01', lines: [{ description: 'Labels', amountCents: 12_000 }] },
        ctx(tx),
      );
      const credit = await issueVendorCredit(
        { vendorId: vendor.id, creditDate: '2026-05-04', reason: 'Misprinted roll returned', amountCents: 3_000 },
        ctx(tx),
      );
      await checkNow(tx);
      expect(credit.creditNo).toMatch(/^VC-\d+$/);
      const lines = await entryLines(tx, credit.journalEntryId ?? '');
      expect(lines.map((l) => [l.code, l.debit, l.credit])).toEqual([
        [ACCOUNTS.AP, 3_000, 0],
        [ACCOUNTS.INVENTORY_PACKAGING, 0, 3_000],
      ]);

      const tooMuch = await refusal(tx, (sp) =>
        applyVendorCredit(credit.id, { date: '2026-05-05', applications: [{ billId: bill.id, amountCents: 3_001 }] }, ctx(sp)),
      );
      expect(tooMuch.code).toBe('over_application');
      await applyVendorCredit(credit.id, { date: '2026-05-05', applications: [{ billId: bill.id, amountCents: 3_000 }] }, ctx(tx));
      const row = await billRow(tx, bill.id);
      expect(row.creditedCents).toBe(3_000);
      expect(row.status).toBe('partial');

      const applied = await refusal(tx, (sp) => voidVendorCredit(credit.id, {}, ctx(sp)));
      expect(applied.code).toBe('invalid_state');

      const spare = await issueVendorCredit(
        { vendorId: vendor.id, creditDate: '2026-05-06', reason: 'Entered in error', amountCents: 500 },
        ctx(tx),
      );
      await voidVendorCredit(spare.id, { date: '2026-05-06' }, ctx(tx));
      await checkNow(tx);

      const draft = await createBill(
        { vendorId: vendor.id, billNo: 'L-901', billDate: '2026-05-07', lines: [{ description: 'Labels', amountCents: 1_000 }] },
        ctx(tx),
      );
      const voidedDraft = await voidBill(draft.bill.id, {}, ctx(tx));
      expect(voidedDraft.status).toBe('void');
      expect(voidedDraft.journalEntryId).toBeNull();

      for (const asOf of ['2026-05-01', '2026-05-04', '2026-05-05', '2026-05-06', '2026-06-30']) {
        expect((await apAging(asOf, tx)).differenceCents, asOf).toBe(0);
      }
      const may5 = await apAging('2026-05-05', tx);
      expect(may5.parties.find((p) => p.partyId === vendor.id)?.buckets.total).toBe(9_000);
    });
  });
});

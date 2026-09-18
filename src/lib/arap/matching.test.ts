import { afterAll, describe, expect, it } from 'vitest';

// First: loads .env.local before '@/db/client' is imported anywhere below.
import { closeTestDb, hasDatabase, withRollback } from '@/lib/ledger/test-support';

import { asc, eq } from 'drizzle-orm';

import { accounts, bankTransactions, billPayments, bills, invoices, journalLines, receipts } from '@/db/schema';
import { ACCOUNTS } from '@/lib/ledger/coa';
import type { LedgerDb } from '@/lib/ledger/post';

import { arAging } from './aging';
import { createAndApproveBill } from './bills';
import { businessDaysBetween, isBusinessDay } from './business-days';
import { ArapError } from './errors';
import { createAndIssueInvoice } from './invoices';
import { type MatchDocument, applyMatch, findSubsets, matchCandidates, rankCandidates } from './matching';
import { voidReceipt } from './receipts';
import { accountId, checkNow, makeBankAccount, makeBankLine, makeCustomer, makeVendor } from './test-support';

afterAll(closeTestDb);

const ctx = (tx: LedgerDb) => ({ userId: null, tx });

describe('business days', () => {
  it('skips weekends and Federal Reserve holidays', () => {
    expect(isBusinessDay('2026-09-18')).toBe(true); // Friday
    expect(isBusinessDay('2026-09-19')).toBe(false); // Saturday
    expect(isBusinessDay('2026-09-07')).toBe(false); // Labor Day
    expect(isBusinessDay('2026-06-19')).toBe(false); // Juneteenth
    expect(isBusinessDay('2026-11-26')).toBe(false); // Thanksgiving
    expect(isBusinessDay('2026-01-19')).toBe(false); // MLK Day
    // 4 July 2026 is a Saturday: the Fed does not move it, so Friday the 3rd settles.
    expect(isBusinessDay('2026-07-03')).toBe(true);
    // 19 June 2022 was a Sunday: observed Monday the 20th.
    expect(isBusinessDay('2022-06-20')).toBe(false);
  });

  it('counts banking days between two dates, signed', () => {
    expect(businessDaysBetween('2026-09-18', '2026-09-21')).toBe(1);
    expect(businessDaysBetween('2026-11-25', '2026-11-30')).toBe(2);
    expect(businessDaysBetween('2026-06-19', '2026-06-15')).toBe(-3);
    expect(businessDaysBetween('2026-06-15', '2026-06-15')).toBe(0);
  });
});

describe('findSubsets', () => {
  it('finds exact combinations, smallest first, within the size bounds', () => {
    expect(findSubsets([5_000, 7_000, 12_000, 3_000, 4_000], 12_000)).toEqual([
      [0, 1],
      [0, 3, 4],
    ]);
    expect(findSubsets([5_000, 7_000], 11_999)).toEqual([]);
    expect(findSubsets([1, 1, 1, 1], 4, { maxSize: 3 })).toEqual([]);
    expect(findSubsets([6_000, 6_000], 6_000)).toEqual([]);
  });

  it('stays bounded on a large pool', () => {
    const amounts = Array.from({ length: 30 }, (_, i) => 1_000 + i * 7);
    const started = Date.now();
    findSubsets(amounts, 999_999, { maxNodes: 50_000 });
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe('rankCandidates', () => {
  const doc = (id: string, partyId: string, balanceCents: number, businessDaysFromDue: number): MatchDocument => ({
    kind: 'invoice',
    id,
    docNo: id,
    partyId,
    partyName: partyId,
    docDate: '2026-05-01',
    dueDate: '2026-05-31',
    balanceCents,
    businessDaysFromDue,
  });

  it('puts an exact match on a named party first, then combinations, then strangers', () => {
    const ranked = rankCandidates(
      [
        { doc: doc('A', 'p1', 12_000, 1), hint: true },
        { doc: doc('B', 'p1', 5_000, 4), hint: true },
        { doc: doc('C', 'p1', 7_000, -3), hint: true },
        { doc: doc('D', 'p1', 7_000, 30), hint: true },
        { doc: doc('E', 'p2', 12_000, 2), hint: false },
      ],
      12_000,
      10,
    );
    expect(ranked.map((c) => [c.kind, c.documents.map((d) => d.id).join('+')])).toEqual([
      ['exact', 'A'],
      ['exact', 'E'],
      ['combination', 'B+C'],
    ]);
  });
});

// Around a hundred round trips to the remote pooler in one transaction: ~100 s under
// the full suite's parallel workers, so the limit sits well clear of that.
describe.skipIf(!hasDatabase)('matchCandidates / applyMatch', { timeout: 240_000 }, () => {
  it('proposes invoices for a deposit, records the receipt on match, and never lets the line post twice', async () => {
    await withRollback(async (tx) => {
      const bank = await makeBankAccount(tx);
      const customer = await makeCustomer(tx, { name: 'Zeta Grocers Test' });
      const stranger = await makeCustomer(tx, { name: 'Other Market Test' });
      const i1 = await createAndIssueInvoice(
        { customerId: customer.id, invoiceDate: '2026-05-15', lines: [{ description: 'I1', unitPriceCents: 12_000 }] },
        ctx(tx),
      );
      const i2 = await createAndIssueInvoice(
        { customerId: customer.id, invoiceDate: '2026-05-10', lines: [{ description: 'I2', unitPriceCents: 5_000 }] },
        ctx(tx),
      );
      const i3 = await createAndIssueInvoice(
        { customerId: customer.id, invoiceDate: '2026-05-20', lines: [{ description: 'I3', unitPriceCents: 7_000 }] },
        ctx(tx),
      );
      // Due 1 May: too far from the bank date to join a combination.
      await createAndIssueInvoice(
        { customerId: customer.id, invoiceDate: '2026-04-01', lines: [{ description: 'I4', unitPriceCents: 7_000 }] },
        ctx(tx),
      );
      await createAndIssueInvoice(
        { customerId: stranger.id, invoiceDate: '2026-05-16', lines: [{ description: 'S1', unitPriceCents: 12_000 }] },
        ctx(tx),
      );

      const lineId = await makeBankLine(tx, bank.id, {
        date: '2026-06-15',
        amountCents: 12_000,
        description: 'ACH DEPOSIT ZETA GROCERS TEST PMT',
      });

      const proposals = await matchCandidates(lineId, {}, tx);
      expect(proposals.direction).toBe('inflow');
      expect(proposals.blockedReason).toBeNull();
      const mine = proposals.candidates.filter((c) => c.documents.every((d) => [customer.id, stranger.id].includes(d.partyId)));
      expect(mine.map((c) => [c.kind, c.documents.map((d) => d.docNo)])).toEqual([
        ['exact', [i1.invoiceNo]],
        ['exact', [expect.any(String)]],
        ['combination', [i2.invoiceNo, i3.invoiceNo]],
      ]);
      expect(mine[0].reasons.join(' ')).toContain('Zeta Grocers Test');

      const matched = await applyMatch({ bankTransactionId: lineId, documents: [{ id: i2.id }, { id: i3.id }] }, ctx(tx));
      await checkNow(tx);
      expect(matched.matchedType).toBe('receipt');
      expect(matched.unappliedCents).toBe(0);

      const [line] = await tx.select().from(bankTransactions).where(eq(bankTransactions.id, lineId));
      expect(line.status).toBe('matched');
      expect(line.matchedType).toBe('receipt');
      expect(line.matchedId).toBe(matched.matchedId);
      expect(line.journalEntryId).toBe(matched.entryId);

      const [receipt] = await tx.select().from(receipts).where(eq(receipts.id, matched.matchedId));
      expect(receipt.bankTransactionId).toBe(lineId);
      expect(receipt.receiptDate).toBe('2026-06-15');
      expect(receipt.depositAccountId).toBe(bank.accountId);

      const lines = await tx
        .select({ code: accounts.code, debit: journalLines.debitCents, credit: journalLines.creditCents })
        .from(journalLines)
        .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
        .where(eq(journalLines.entryId, matched.entryId))
        .orderBy(asc(journalLines.lineNo));
      expect(lines.map((l) => [l.code, l.debit, l.credit])).toEqual([
        [ACCOUNTS.SAVINGS_RESERVE, 12_000, 0],
        [ACCOUNTS.AR, 0, 5_000],
        [ACCOUNTS.AR, 0, 7_000],
      ]);
      for (const id of [i2.id, i3.id]) {
        const [row] = await tx.select().from(invoices).where(eq(invoices.id, id));
        expect(row.status).toBe('paid');
      }

      const again = await matchCandidates(lineId, {}, tx);
      expect(again.blockedReason).toMatch(/already posted/);
      expect(again.candidates).toEqual([]);
      let refused: unknown = null;
      try {
        await tx.transaction(async (sp) => {
          await applyMatch({ bankTransactionId: lineId, documents: [{ id: i1.id }] }, ctx(sp));
        });
      } catch (error) {
        refused = error;
      }
      expect(refused).toBeInstanceOf(ArapError);
      expect((refused as ArapError).code).toBe('already_posted');

      expect((await arAging('2026-06-15', tx)).differenceCents).toBe(0);

      await voidReceipt(matched.matchedId, { date: '2026-06-16' }, ctx(tx));
      await checkNow(tx);
      const [released] = await tx.select().from(bankTransactions).where(eq(bankTransactions.id, lineId));
      expect(released.status).toBe('unreviewed');
      expect(released.journalEntryId).toBeNull();
      expect(released.matchedId).toBeNull();
    });
  });

  it('pays a bill from an outflow and refuses documents from two parties', async () => {
    await withRollback(async (tx) => {
      const bank = await makeBankAccount(tx);
      const packaging = await accountId(tx, ACCOUNTS.INVENTORY_PACKAGING);
      const vendor = await makeVendor(tx, { name: 'Quokka Labels Test', vendorType: 'packaging', defaultExpenseAccountId: packaging });
      const other = await makeVendor(tx, { vendorType: 'packaging', defaultExpenseAccountId: packaging });
      const bill = await createAndApproveBill(
        { vendorId: vendor.id, billNo: 'QL-1', billDate: '2026-06-01', lines: [{ description: 'Labels', amountCents: 8_000 }] },
        ctx(tx),
      );
      const otherBill = await createAndApproveBill(
        { vendorId: other.id, billNo: 'X-1', billDate: '2026-06-01', lines: [{ description: 'Cartons', amountCents: 1_000 }] },
        ctx(tx),
      );
      const lineId = await makeBankLine(tx, bank.id, {
        date: '2026-06-16',
        amountCents: -8_000,
        description: 'QUOKKA LABELS TEST ACH',
      });

      const proposals = await matchCandidates(lineId, {}, tx);
      expect(proposals.direction).toBe('outflow');
      const top = proposals.candidates.find((c) => c.documents[0].id === bill.id);
      expect(top?.kind).toBe('exact');
      expect(top?.reasons.join(' ')).toContain('Quokka Labels Test');

      let refused: unknown = null;
      try {
        await tx.transaction(async (sp) => {
          await applyMatch({ bankTransactionId: lineId, documents: [{ id: bill.id }, { id: otherBill.id, amountCents: 0 }] }, ctx(sp));
        });
      } catch (error) {
        refused = error;
      }
      expect((refused as ArapError).code).toBe('party_mismatch');

      const matched = await applyMatch({ bankTransactionId: lineId, documents: [{ id: bill.id }] }, ctx(tx));
      await checkNow(tx);
      expect(matched.matchedType).toBe('bill_payment');
      const [payment] = await tx.select().from(billPayments).where(eq(billPayments.id, matched.matchedId));
      expect(payment.is1099Reportable).toBe(true);
      expect(payment.method).toBe('ach');
      expect(payment.bankTransactionId).toBe(lineId);
      const [paid] = await tx.select().from(bills).where(eq(bills.id, bill.id));
      expect(paid.status).toBe('paid');
      const [line] = await tx.select().from(bankTransactions).where(eq(bankTransactions.id, lineId));
      expect([line.status, line.matchedType, line.journalEntryId]).toEqual(['matched', 'bill_payment', matched.entryId]);
    });
  });
});

import { afterAll, describe, expect, it } from 'vitest';

// First: loads .env.local before '@/db/client' is imported anywhere below.
import { closeTestDb, hasDatabase, withRollback } from '@/lib/ledger/test-support';

import { eq, sql } from 'drizzle-orm';

import { bankTransactions, invoices, journalEntries } from '@/db/schema';
import { applyMatch } from '@/lib/arap/matching';
import { createAndIssueInvoice } from '@/lib/arap/invoices';
import { recordReceipt, voidReceipt } from '@/lib/arap/receipts';
import { accountId, checkNow, makeBankAccount, makeBankLine, makeCustomer } from '@/lib/arap/test-support';
import { ACCOUNTS } from '@/lib/ledger/coa';
import { OwnedEntryError } from '@/lib/ledger/errors';
import { type LedgerDb, postJournalEntry } from '@/lib/ledger/post';
import { reverseEntry } from '@/lib/ledger/reverse';

import { bookedCandidatesForTxn } from './booked';
import {
  BankingError,
  approveBankTransaction,
  linkBankTransactionToEntry,
  postAutoPostMatches,
  unpostBankTransaction,
} from './post';
import { listQueue } from './queue';

afterAll(closeTestDb);

const T = 240_000;
const ctx = (tx: LedgerDb) => ({ userId: null, tx });

async function glBalance(tx: LedgerDb, glId: string): Promise<number> {
  const [row] = (await tx.execute(sql`
    select coalesce(sum(jl.debit_cents - jl.credit_cents), 0)::bigint as b
      from journal_lines jl join journal_entries je on je.id = jl.entry_id and je.status = 'posted'
     where jl.account_id = ${glId}::uuid`)) as unknown as { b: string }[];
  return Number(row.b);
}

async function bankRow(tx: LedgerDb, id: string) {
  const [row] = await tx.select().from(bankTransactions).where(eq(bankTransactions.id, id));
  return row;
}

/** A $100.00 wholesale receipt recorded by hand into the bank's own GL account, plus the statement line for it. */
async function receiptAndLine(tx: LedgerDb) {
  const bank = await makeBankAccount(tx);
  const customer = await makeCustomer(tx, { name: `ZZ Booked Test ${Date.now()}` });
  const invoice = await createAndIssueInvoice(
    { customerId: customer.id, invoiceDate: '2031-04-01', lines: [{ description: 'Cases', unitPriceCents: 100_00 }] },
    ctx(tx),
  );
  const receipt = await recordReceipt(
    {
      customerId: customer.id,
      receiptDate: '2031-04-10',
      amountCents: 100_00,
      method: 'ach',
      depositAccountId: bank.accountId,
      applications: [{ invoiceId: invoice.id, amountCents: 100_00 }],
    },
    ctx(tx),
  );
  const lineId = await makeBankLine(tx, bank.id, { date: '2031-04-12', amountCents: 100_00, description: 'ACH DEPOSIT ZZ BOOKED' });
  return { bank, customer, invoice, receipt, lineId };
}

describe.skipIf(!hasDatabase)('money already in the ledger', { timeout: T }, () => {
  it('refuses to post a deposit a hand-recorded receipt already booked, and links it instead', async () => {
    await withRollback(async (tx) => {
      const { bank, receipt, lineId } = await receiptAndLine(tx);
      const revenue = await accountId(tx, ACCOUNTS.SALES_DTC);
      const before = await glBalance(tx, bank.accountId);

      // The defect: approving the line to revenue booked the $100 a second time.
      let refused: unknown = null;
      try {
        await tx.transaction((sp) => approveBankTransaction({ txnId: lineId, accountId: revenue }, ctx(sp)));
      } catch (error) {
        refused = error;
      }
      expect(refused).toBeInstanceOf(BankingError);
      expect((refused as BankingError).code).toBe('already_booked');
      expect(await glBalance(tx, bank.accountId)).toBe(before);

      // The queue says so, and offers the receipt's entry.
      const page = await listQueue({ bankAccountId: bank.id }, tx);
      expect(page.rows.find((r) => r.id === lineId)?.flags).toContain('already_booked');
      const candidates = await bookedCandidatesForTxn(lineId, tx);
      expect(candidates.map((c) => c.entryId)).toEqual([receipt.entryId]);
      expect(candidates[0]).toMatchObject({ sourceType: 'receipt', documentNo: receipt.receipt.receiptNo, daysApart: 2 });

      // Linking records the line as that entry: nothing new posts, the cash counts once.
      const linked = await linkBankTransactionToEntry(lineId, receipt.entryId, ctx(tx));
      await checkNow(tx);
      expect(linked.entryId).toBe(receipt.entryId);
      expect(await glBalance(tx, bank.accountId)).toBe(before);
      expect(await bankRow(tx, lineId)).toMatchObject({
        status: 'matched',
        matchedType: 'entry',
        matchedId: receipt.entryId,
        journalEntryId: receipt.entryId,
      });
      const posted = await listQueue({ bankAccountId: bank.id, stage: 'posted' }, tx);
      expect(posted.rows.map((r) => r.id)).toContain(lineId);
      // Claimed: no other line can take it, and the row no longer counts as booked-elsewhere.
      expect(await bookedCandidatesForTxn(lineId, tx)).toEqual([]);

      // Unmatching releases the line and leaves the receipt's entry alone.
      const released = await unpostBankTransaction(lineId, ctx(tx));
      expect(released.reversalEntryId).toBeNull();
      expect(released.unlinkedEntryNo).not.toBeNull();
      expect(await glBalance(tx, bank.accountId)).toBe(before);
      expect(await bankRow(tx, lineId)).toMatchObject({ status: 'unreviewed', matchedType: null, journalEntryId: null });

      // A reviewer who says it is a different deposit can still post it.
      await approveBankTransaction({ txnId: lineId, accountId: revenue, confirmedNew: true }, ctx(tx));
      await checkNow(tx);
      expect(await glBalance(tx, bank.accountId)).toBe(before + 100_00);
    });
  });

  it('sends a linked line back to review when the receipt it was linked to is voided', async () => {
    await withRollback(async (tx) => {
      const { receipt, lineId } = await receiptAndLine(tx);
      await linkBankTransactionToEntry(lineId, receipt.entryId, ctx(tx));
      await voidReceipt(receipt.receipt.id, { date: '2031-04-15' }, ctx(tx));
      await checkNow(tx);
      expect(await bankRow(tx, lineId)).toMatchObject({ status: 'unreviewed', matchedType: null, journalEntryId: null });
    });
  });

  it('keeps an auto-post rule from posting money already booked', async () => {
    await withRollback(async (tx) => {
      const { bank, lineId } = await receiptAndLine(tx);
      const revenue = await accountId(tx, ACCOUNTS.SALES_DTC);
      const [rule] = (await tx.execute(sql`
        insert into categorization_rules (name, priority, conditions, direction, account_id, auto_post)
        values ('ZZ booked test', 1, '[{"field":"description","op":"contains","value":"ZZ BOOKED"}]'::jsonb, 'in',
                ${revenue}::uuid, true)
        returning id`)) as unknown as { id: string }[];
      await tx
        .update(bankTransactions)
        .set({ status: 'categorized', ruleId: rule.id, suggestedAccountId: revenue })
        .where(eq(bankTransactions.id, lineId));
      const report = await postAutoPostMatches(ctx(tx), { bankAccountId: bank.id });
      expect(report.posted).toEqual([]);
      expect(report.failed.map((f) => f.code)).toEqual(['already_booked']);
    });
  });

  it('refuses to unpost a line matched to an invoice; voiding the receipt reopens the invoice and frees the line', async () => {
    await withRollback(async (tx) => {
      const bank = await makeBankAccount(tx);
      const customer = await makeCustomer(tx);
      const invoice = await createAndIssueInvoice(
        { customerId: customer.id, invoiceDate: '2031-05-01', lines: [{ description: 'Cases', unitPriceCents: 50_00 }] },
        ctx(tx),
      );
      const lineId = await makeBankLine(tx, bank.id, { date: '2031-05-20', amountCents: 50_00, description: 'ACH ZZ PAYER' });
      const matched = await applyMatch({ bankTransactionId: lineId, documents: [{ id: invoice.id }] }, ctx(tx));

      let refused: unknown = null;
      try {
        await tx.transaction((sp) => unpostBankTransaction(lineId, ctx(sp)));
      } catch (error) {
        refused = error;
      }
      expect(refused).toBeInstanceOf(BankingError);
      expect((refused as BankingError).message).toMatch(/Void the receipt/);
      const [stillPaid] = await tx.select().from(invoices).where(eq(invoices.id, invoice.id));
      expect(stillPaid).toMatchObject({ status: 'paid', paidCents: 50_00 });

      await voidReceipt(matched.matchedId, { date: '2031-05-21' }, ctx(tx));
      await checkNow(tx);
      const [reopened] = await tx.select().from(invoices).where(eq(invoices.id, invoice.id));
      expect(reopened).toMatchObject({ status: 'open', paidCents: 0 });
      expect(await bankRow(tx, lineId)).toMatchObject({
        status: 'unreviewed',
        matchedType: null,
        matchedId: null,
        journalEntryId: null,
      });
    });
  });
});

describe.skipIf(!hasDatabase)('reversing an entry a module owns', { timeout: T }, () => {
  it('refuses a ledger reversal of a bank-posted entry, in code and in the database; unpost still works', async () => {
    await withRollback(async (tx) => {
      const bank = await makeBankAccount(tx);
      const supplies = await accountId(tx, ACCOUNTS.OFFICE_SUPPLIES);
      const lineId = await makeBankLine(tx, bank.id, { date: '2031-06-03', amountCents: -12_00, description: 'ZZ STAPLES' });
      const posted = await approveBankTransaction({ txnId: lineId, accountId: supplies }, ctx(tx));

      // The ledger screen's path: no owner.
      let refused: unknown = null;
      try {
        await tx.transaction((sp) => reverseEntry(posted.entryId, { userId: null, tx: sp }));
      } catch (error) {
        refused = error;
      }
      expect(refused).toBeInstanceOf(OwnedEntryError);
      expect((refused as OwnedEntryError).message).toMatch(/belongs to Banking/);

      // The database refuses a hand-built reversal just the same.
      let dbRefused: unknown = null;
      try {
        await tx.transaction((sp) =>
          postJournalEntry(
            {
              date: '2031-06-03',
              memo: 'sneaky reversal',
              sourceType: 'reversal',
              reversesId: posted.entryId,
              lines: [
                { accountId: supplies, creditCents: 12_00 },
                { accountId: bank.accountId, debitCents: 12_00 },
              ],
            },
            { userId: null, tx: sp },
          ),
        );
      } catch (error) {
        dbRefused = error;
      }
      expect(dbRefused).toBeInstanceOf(OwnedEntryError);

      // The row is still posted and still unpostable from Banking.
      const unposted = await unpostBankTransaction(lineId, ctx(tx));
      await checkNow(tx);
      expect(unposted.reversalEntryId).not.toBeNull();
      expect(await bankRow(tx, lineId)).toMatchObject({ status: 'unreviewed', journalEntryId: null });
    });
  });

  it('releases a row whose entry was already reversed instead of failing on a second reversal', async () => {
    await withRollback(async (tx) => {
      const bank = await makeBankAccount(tx);
      const supplies = await accountId(tx, ACCOUNTS.OFFICE_SUPPLIES);
      const lineId = await makeBankLine(tx, bank.id, { date: '2031-06-04', amountCents: -7_00, description: 'ZZ OLD REVERSAL' });
      const posted = await approveBankTransaction({ txnId: lineId, accountId: supplies }, ctx(tx));
      // As a ledger reversal made before the guard existed would have left it.
      const earlier = await reverseEntry(posted.entryId, { userId: null, tx, owner: 'bank' });

      const result = await unpostBankTransaction(lineId, ctx(tx));
      await checkNow(tx);
      expect(result.reversalEntryId).toBe(earlier.entryId);
      const reversals = await tx.select().from(journalEntries).where(eq(journalEntries.reversesId, posted.entryId));
      expect(reversals).toHaveLength(1);
      expect(await bankRow(tx, lineId)).toMatchObject({ status: 'unreviewed', journalEntryId: null });
    });
  });

  it('still lets the ledger reverse a manual entry', async () => {
    await withRollback(async (tx) => {
      const supplies = await accountId(tx, ACCOUNTS.OFFICE_SUPPLIES);
      const capital = await accountId(tx, ACCOUNTS.PAID_IN_CAPITAL);
      const entry = await postJournalEntry(
        {
          date: '2031-06-05',
          memo: 'ZZ manual',
          sourceType: 'manual',
          lines: [
            { accountId: supplies, debitCents: 1_00 },
            { accountId: capital, creditCents: 1_00 },
          ],
        },
        { userId: null, tx },
      );
      const reversal = await reverseEntry(entry.entryId, { userId: null, tx });
      await checkNow(tx);
      expect(reversal.reversedEntryId).toBe(entry.entryId);
    });
  });
});

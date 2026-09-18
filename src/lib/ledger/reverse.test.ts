import { afterAll, describe, expect, it } from 'vitest';

// First: loads .env.local before '@/db/client' is imported anywhere below.
import { closeTestDb, hasDatabase, withRollback } from './test-support';

import { asc, eq } from 'drizzle-orm';

import { journalEntries, journalLines } from '@/db/schema';

import { balancesByAccount, trialBalance, trialBalanceTotals } from './balances';
import { ACCOUNTS } from './coa';
import { AlreadyReversedError, EntryNotFoundError, EntryNotPostedError } from './errors';
import { closePeriod } from './periods';
import { type DraftLine, type LedgerDb, postJournalEntry } from './post';
import { reverseEntry } from './reverse';

const DATE = '2026-04-12';

function sale(amountCents: number): DraftLine[] {
  return [
    { accountCode: ACCOUNTS.OPERATING_CHECKING, debitCents: amountCents, memo: 'deposit' },
    { accountCode: ACCOUNTS.SALES_DTC, creditCents: amountCents },
  ];
}

async function balanceOf(tx: LedgerDb, code: string): Promise<number> {
  const rows = await trialBalance({ asOf: '2099-12-31' }, tx);
  return rows.find((row) => row.code === code)?.balanceCents ?? 0;
}

afterAll(closeTestDb);

describe.skipIf(!hasDatabase)('reverseEntry', () => {
  it(
    'posts an exactly offsetting mirror and the pair nets to zero',
    async () => {
      await withRollback(async (tx) => {
        const before = await balancesByAccount({}, tx);
        const cashBefore = await balanceOf(tx, ACCOUNTS.OPERATING_CHECKING);
        const salesBefore = await balanceOf(tx, ACCOUNTS.SALES_DTC);

        const original = await postJournalEntry(
          { date: DATE, memo: 'Duplicate deposit', sourceType: 'manual', lines: sale(321_45) },
          { userId: null, tx },
        );

        expect(await balanceOf(tx, ACCOUNTS.OPERATING_CHECKING)).toBe(cashBefore + 321_45);

        const reversal = await reverseEntry(original.entryId, { userId: null, tx });

        expect(reversal.date).toBe(DATE);
        expect(reversal.requestedDate).toBeNull();
        expect(reversal.reversedEntryNo).toBe(original.entryNo);

        const originalLines = await tx
          .select()
          .from(journalLines)
          .where(eq(journalLines.entryId, original.entryId))
          .orderBy(asc(journalLines.lineNo));
        const mirrorLines = await tx
          .select()
          .from(journalLines)
          .where(eq(journalLines.entryId, reversal.entryId))
          .orderBy(asc(journalLines.lineNo));

        expect(mirrorLines).toHaveLength(originalLines.length);
        for (const [i, line] of mirrorLines.entries()) {
          expect(line.accountId).toBe(originalLines[i].accountId);
          expect(line.debitCents).toBe(originalLines[i].creditCents);
          expect(line.creditCents).toBe(originalLines[i].debitCents);
          expect(line.memo).toBe(originalLines[i].memo);
        }

        expect(await balanceOf(tx, ACCOUNTS.OPERATING_CHECKING)).toBe(cashBefore);
        expect(await balanceOf(tx, ACCOUNTS.SALES_DTC)).toBe(salesBefore);

        const after = await balancesByAccount({}, tx);
        for (const [accountId, balance] of after) {
          expect(balance).toBe(before.get(accountId) ?? 0);
        }

        const totals = trialBalanceTotals(await trialBalance({ asOf: '2099-12-31' }, tx));
        expect(totals.debitCents).toBe(totals.creditCents);
      });
    },
    30_000,
  );

  it(
    'links the two entries and labels the reversal',
    async () => {
      await withRollback(async (tx) => {
        const original = await postJournalEntry(
          { date: DATE, memo: 'Rent', sourceType: 'manual', lines: sale(100_00) },
          { userId: null, tx },
        );
        const reversal = await reverseEntry(original.entryId, { userId: null, tx });

        const [originalRow] = await tx
          .select()
          .from(journalEntries)
          .where(eq(journalEntries.id, original.entryId));
        const [mirrorRow] = await tx
          .select()
          .from(journalEntries)
          .where(eq(journalEntries.id, reversal.entryId));

        expect(originalRow.reversedById).toBe(reversal.entryId);
        expect(mirrorRow.reversesId).toBe(original.entryId);
        expect(mirrorRow.sourceType).toBe('reversal');
        expect(mirrorRow.status).toBe('posted');
        expect(mirrorRow.memo).toContain(`#${original.entryNo}`);
        expect(mirrorRow.memo).toContain('Rent');
      });
    },
    30_000,
  );

  it(
    'refuses to reverse the same entry twice',
    async () => {
      await withRollback(async (tx) => {
        const original = await postJournalEntry(
          { date: DATE, sourceType: 'manual', lines: sale(25_00) },
          { userId: null, tx },
        );
        await reverseEntry(original.entryId, { userId: null, tx });

        const error = await reverseEntry(original.entryId, { userId: null, tx }).catch(
          (e: unknown) => e,
        );
        expect(error).toBeInstanceOf(AlreadyReversedError);
        expect((error as AlreadyReversedError).entryNo).toBe(original.entryNo);
      });
    },
    30_000,
  );

  it(
    'refuses to reverse a draft, and refuses an entry that does not exist',
    async () => {
      await withRollback(async (tx) => {
        const [draft] = await tx
          .insert(journalEntries)
          .values({ entryDate: DATE, memo: 'unfinished', status: 'draft', sourceType: 'manual' })
          .returning({ id: journalEntries.id });

        await expect(reverseEntry(draft.id, { userId: null, tx })).rejects.toBeInstanceOf(
          EntryNotPostedError,
        );

        await expect(
          reverseEntry('00000000-0000-4000-8000-000000000000', { userId: null, tx }),
        ).rejects.toBeInstanceOf(EntryNotFoundError);
      });
    },
    30_000,
  );

  it(
    'moves a reversal out of a closed period and says so in the memo',
    async () => {
      await withRollback(async (tx) => {
        const original = await postJournalEntry(
          { date: '2026-05-10', memo: 'May bill', sourceType: 'manual', lines: sale(80_00) },
          { userId: null, tx },
        );

        await closePeriod(2026, 5, null, { tx });

        const reversal = await reverseEntry(original.entryId, {
          date: '2026-05-10',
          userId: null,
          tx,
        });

        expect(reversal.date).toBe('2026-06-01');
        expect(reversal.requestedDate).toBe('2026-05-10');
        // The original is in a closed period, so the database will not accept a
        // back-pointer on it; the mirror's reverses_id carries the link.
        expect(reversal.linked).toBe(false);

        const [mirrorRow] = await tx
          .select()
          .from(journalEntries)
          .where(eq(journalEntries.id, reversal.entryId));
        expect(mirrorRow.entryDate).toBe('2026-06-01');
        expect(mirrorRow.memo).toContain('closed period 2026-05');
        expect(mirrorRow.reversesId).toBe(original.entryId);

        // And that link is enough to stop a second reversal.
        await expect(
          reverseEntry(original.entryId, { date: '2026-06-01', userId: null, tx }),
        ).rejects.toBeInstanceOf(AlreadyReversedError);
      });
    },
    30_000,
  );

  it(
    'may reverse a sub-ledger entry that moves a control account',
    async () => {
      await withRollback(async (tx) => {
        const arBefore = await balanceOf(tx, ACCOUNTS.AR);

        const invoice = await postJournalEntry(
          {
            date: DATE,
            memo: 'Invoice 2002',
            sourceType: 'invoice',
            lines: [
              { accountCode: ACCOUNTS.AR, debitCents: 250_00 },
              { accountCode: ACCOUNTS.SALES_DISTRIBUTOR, creditCents: 250_00 },
            ],
          },
          { userId: null, tx },
        );

        const reversal = await reverseEntry(invoice.entryId, {
          memo: 'Invoice 2002 voided',
          userId: null,
          tx,
        });

        const [mirrorRow] = await tx
          .select()
          .from(journalEntries)
          .where(eq(journalEntries.id, reversal.entryId));
        expect(mirrorRow.memo).toBe('Invoice 2002 voided');
        expect(await balanceOf(tx, ACCOUNTS.AR)).toBe(arBefore);
      });
    },
    30_000,
  );
});

import { afterAll, describe, expect, it } from 'vitest';

// First: loads .env.local before '@/db/client' is imported anywhere below.
import { closeTestDb, hasDatabase, withRollback } from './test-support';

import { eq } from 'drizzle-orm';

import { journalEntries } from '@/db/schema';

import { ACCOUNTS } from './coa';
import { ClosedPeriodError, NotPermittedError, PeriodHasDraftsError } from './errors';
import {
  closePeriod,
  earliestOpenPeriod,
  ensurePeriod,
  isPeriodOpen,
  listPeriods,
  reopenPeriod,
} from './periods';
import { type DraftLine, postJournalEntry } from './post';

function sale(amountCents: number): DraftLine[] {
  return [
    { accountCode: ACCOUNTS.OPERATING_CHECKING, debitCents: amountCents },
    { accountCode: ACCOUNTS.SALES_DTC, creditCents: amountCents },
  ];
}

afterAll(closeTestDb);

describe.skipIf(!hasDatabase)('periods', () => {
  it(
    'creates a period once and returns the same row afterwards',
    async () => {
      await withRollback(async (tx) => {
        const first = await ensurePeriod(2027, 1, { userId: null, tx });
        expect(first.year).toBe(2027);
        expect(first.month).toBe(1);
        expect(first.status).toBe('open');

        const again = await ensurePeriod(2027, 1, { userId: null, tx });
        expect(again.id).toBe(first.id);
      });
    },
    30_000,
  );

  it(
    'treats a month with no row as open and a closed month as shut',
    async () => {
      await withRollback(async (tx) => {
        expect(await isPeriodOpen('2027-02-14', tx)).toBe(true);

        const closed = await closePeriod(2027, 2, null, { tx });
        expect(closed.status).toBe('closed');
        expect(closed.closedAt).not.toBeNull();

        expect(await isPeriodOpen('2027-02-14', tx)).toBe(false);
        expect(await isPeriodOpen('2027-03-01', tx)).toBe(true);
      });
    },
    30_000,
  );

  it(
    'refuses to close a month that still holds a draft, and names it',
    async () => {
      await withRollback(async (tx) => {
        const [draft] = await tx
          .insert(journalEntries)
          .values({
            entryDate: '2027-04-09',
            memo: 'half-typed adjustment',
            status: 'draft',
            sourceType: 'manual',
          })
          .returning({ id: journalEntries.id, entryNo: journalEntries.entryNo });

        const error = await closePeriod(2027, 4, null, { tx }).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(PeriodHasDraftsError);
        const drafts = (error as PeriodHasDraftsError).drafts;
        expect(drafts.map((d) => d.id)).toEqual([draft.id]);
        expect(drafts[0].memo).toBe('half-typed adjustment');
        expect((error as PeriodHasDraftsError).message).toContain(`#${draft.entryNo}`);

        // The month is untouched: nothing was closed behind the draft.
        expect(await isPeriodOpen('2027-04-09', tx)).toBe(true);

        await tx.delete(journalEntries).where(eq(journalEntries.id, draft.id));
        const closed = await closePeriod(2027, 4, null, { tx });
        expect(closed.status).toBe('closed');
      });
    },
    30_000,
  );

  it(
    'ignores drafts dated in other months',
    async () => {
      await withRollback(async (tx) => {
        await tx.insert(journalEntries).values({
          entryDate: '2027-06-01',
          status: 'draft',
          sourceType: 'manual',
        });

        const closed = await closePeriod(2027, 5, null, { tx });
        expect(closed.status).toBe('closed');
      });
    },
    30_000,
  );

  it(
    'stops a posting into a closed month',
    async () => {
      await withRollback(async (tx) => {
        await postJournalEntry(
          { date: '2027-07-05', sourceType: 'manual', lines: sale(10_00) },
          { userId: null, tx },
        );
        await closePeriod(2027, 7, null, { tx });

        await expect(
          postJournalEntry(
            { date: '2027-07-31', sourceType: 'manual', lines: sale(10_00) },
            { userId: null, tx },
          ),
        ).rejects.toBeInstanceOf(ClosedPeriodError);
      });
    },
    30_000,
  );

  it(
    'lets only an owner reopen a period',
    async () => {
      await withRollback(async (tx) => {
        await closePeriod(2027, 8, null, { tx });

        await expect(reopenPeriod(2027, 8, null, { tx })).rejects.toBeInstanceOf(NotPermittedError);
        // A user id that is not an active owner is refused just the same.
        await expect(
          reopenPeriod(2027, 8, '00000000-0000-4000-8000-000000000000', { tx }),
        ).rejects.toBeInstanceOf(NotPermittedError);

        expect(await isPeriodOpen('2027-08-15', tx)).toBe(false);
      });
    },
    30_000,
  );

  it(
    'finds the earliest open period on or after a date',
    async () => {
      await withRollback(async (tx) => {
        expect(await earliestOpenPeriod('2027-09-15', tx)).toEqual({ year: 2027, month: 9 });

        await closePeriod(2027, 9, null, { tx });
        expect(await earliestOpenPeriod('2027-09-15', tx)).toEqual({ year: 2027, month: 10 });

        await closePeriod(2027, 10, null, { tx });
        await closePeriod(2027, 11, null, { tx });
        expect(await earliestOpenPeriod('2027-09-15', tx)).toEqual({ year: 2027, month: 12 });

        // A December close rolls the answer into the next year.
        await closePeriod(2027, 12, null, { tx });
        expect(await earliestOpenPeriod('2027-09-15', tx)).toEqual({ year: 2028, month: 1 });
      });
    },
    30_000,
  );

  it(
    'lists every month in a range, row or no row',
    async () => {
      await withRollback(async (tx) => {
        await closePeriod(2028, 2, null, { tx });

        const rows = await listPeriods(
          { from: { year: 2027, month: 12 }, to: { year: 2028, month: 3 } },
          tx,
        );

        expect(rows.map((r) => `${r.year}-${r.month}`)).toEqual([
          '2027-12',
          '2028-1',
          '2028-2',
          '2028-3',
        ]);
        expect(rows.map((r) => r.status)).toEqual(['open', 'open', 'closed', 'open']);
        expect(rows.map((r) => r.exists)).toEqual([false, false, true, false]);
        expect(rows[2].start).toBe('2028-02-01');
        expect(rows[2].end).toBe('2028-02-29');
      });
    },
    30_000,
  );
});

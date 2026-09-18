import { afterAll, describe, expect, it } from 'vitest';

// First: loads .env.local before '@/db/client' is imported anywhere below.
import { closeTestDb, hasDatabase, withRollback } from '@/lib/ledger/test-support';

import { asc, eq } from 'drizzle-orm';

import { journalEntries, journalLines, recurringEntries } from '@/db/schema';
import { ACCOUNTS } from '@/lib/ledger/coa';
import { closePeriod } from '@/lib/ledger/periods';
import type { LedgerDb } from '@/lib/ledger/post';

import {
  createRecurringEntry,
  firstOccurrence,
  generateDueRecurringEntries,
  nextOccurrence,
  overdueRecurringEntries,
} from './recurring';

afterAll(closeTestDb);

const RENT = [
  { accountCode: ACCOUNTS.RENT, debitCents: 150_000, creditCents: 0, memo: 'Kitchen rent' },
  { accountCode: ACCOUNTS.OPERATING_CHECKING, debitCents: 0, creditCents: 150_000 },
];

async function entriesFor(tx: LedgerDb, recurringId: string) {
  return tx
    .select({ id: journalEntries.id, date: journalEntries.entryDate, status: journalEntries.status })
    .from(journalEntries)
    .where(eq(journalEntries.sourceId, recurringId))
    .orderBy(asc(journalEntries.entryDate));
}

describe('schedules', () => {
  it('keep their anchor day through short months', () => {
    expect(nextOccurrence('2035-01-31', 'monthly', 31)).toBe('2035-02-28');
    expect(nextOccurrence('2035-02-28', 'monthly', 31)).toBe('2035-03-31');
    expect(nextOccurrence('2035-11-30', 'quarterly', 30)).toBe('2036-02-29');
    expect(nextOccurrence('2036-02-29', 'annually', 29)).toBe('2037-02-28');
    expect(nextOccurrence('2035-12-29', 'weekly', 29)).toBe('2036-01-05');
    expect(firstOccurrence('2035-01-20', 'monthly', 15)).toBe('2035-02-15');
    expect(firstOccurrence('2035-01-10', 'monthly', 15)).toBe('2035-01-15');
  });
});

describe.skipIf(!hasDatabase)('recurring entries', () => {
  it(
    'raises due dates as drafts, advances next_date, and is idempotent',
    async () => {
      await withRollback(async (tx) => {
        const ctx = { userId: null, tx };
        const rent = await createRecurringEntry(
          { name: 'Kitchen rent', frequency: 'monthly', startDate: '2035-01-31', template: RENT },
          ctx,
        );
        expect(rent.nextDate).toBe('2035-01-31');

        const [first] = await generateDueRecurringEntries(ctx, { asOf: '2035-03-31', recurringIds: [rent.id] });
        expect(first.error).toBeNull();
        expect(first.generated.map((g) => [g.date, g.status])).toEqual([
          ['2035-01-31', 'draft'],
          ['2035-02-28', 'draft'],
          ['2035-03-31', 'draft'],
        ]);
        expect(first.nextDate).toBe('2035-04-30');

        const lines = await tx
          .select({ debit: journalLines.debitCents, credit: journalLines.creditCents, memo: journalLines.memo })
          .from(journalLines)
          .where(eq(journalLines.entryId, first.generated[0].entryId))
          .orderBy(asc(journalLines.lineNo));
        expect(lines).toEqual([
          { debit: 150_000, credit: 0, memo: 'Kitchen rent' },
          { debit: 0, credit: 150_000, memo: null },
        ]);

        // Running again raises nothing.
        const again = await generateDueRecurringEntries(ctx, { asOf: '2035-03-31', recurringIds: [rent.id] });
        expect(again).toHaveLength(0);

        // Even with next_date wound back by hand, an existing date is not raised twice.
        await tx.update(recurringEntries).set({ nextDate: '2035-02-28' }).where(eq(recurringEntries.id, rent.id));
        const [rewound] = await generateDueRecurringEntries(ctx, { asOf: '2035-03-31', recurringIds: [rent.id] });
        expect(rewound.generated).toHaveLength(0);
        expect(rewound.alreadyRaised).toEqual(['2035-02-28', '2035-03-31']);
        expect(rewound.nextDate).toBe('2035-04-30');

        const raised = await entriesFor(tx, rent.id);
        expect(raised.map((e) => [e.date, e.status])).toEqual([
          ['2035-01-31', 'draft'],
          ['2035-02-28', 'draft'],
          ['2035-03-31', 'draft'],
        ]);
      });
    },
    60_000,
  );

  it(
    'posts only when the template is auto_post, and retires at its end date',
    async () => {
      await withRollback(async (tx) => {
        const ctx = { userId: null, tx };
        const depreciation = await createRecurringEntry(
          {
            name: 'Equipment depreciation',
            frequency: 'quarterly',
            startDate: '2035-01-15',
            endDate: '2035-06-30',
            autoPost: true,
            template: [
              { accountCode: ACCOUNTS.DEPRECIATION, debitCents: 5_000, creditCents: 0 },
              { accountCode: ACCOUNTS.ACCUMULATED_DEPRECIATION, debitCents: 0, creditCents: 5_000 },
            ],
          },
          ctx,
        );
        const [run] = await generateDueRecurringEntries(ctx, { asOf: '2035-12-31', recurringIds: [depreciation.id] });
        expect(run.generated.map((g) => [g.date, g.status])).toEqual([
          ['2035-01-15', 'posted'],
          ['2035-04-15', 'posted'],
        ]);
        expect(run.active).toBe(false);
        const [row] = await tx.select().from(recurringEntries).where(eq(recurringEntries.id, depreciation.id));
        expect(row.active).toBe(false);
        expect(row.lastPostedDate).toBe('2035-04-15');
        expect(row.nextDate).toBe('2035-07-15');
        expect((await entriesFor(tx, depreciation.id)).every((e) => e.status === 'posted')).toBe(true);
        expect(await overdueRecurringEntries('2035-12-31', tx)).not.toContainEqual(
          expect.objectContaining({ id: depreciation.id }),
        );
      });
    },
    60_000,
  );

  it(
    'stops at a closed period without advancing, and reports it as overdue',
    async () => {
      await withRollback(async (tx) => {
        const ctx = { userId: null, tx };
        await closePeriod(2035, 5, null, { tx });
        const weekly = await createRecurringEntry(
          {
            name: 'Demo staff',
            frequency: 'weekly',
            startDate: '2035-05-01',
            autoPost: true,
            template: [
              { accountCode: ACCOUNTS.CONTRACT_LABOR, debitCents: 5_000, creditCents: 0 },
              { accountCode: ACCOUNTS.OPERATING_CHECKING, debitCents: 0, creditCents: 5_000 },
            ],
          },
          ctx,
        );
        const [run] = await generateDueRecurringEntries(ctx, { asOf: '2035-05-20', recurringIds: [weekly.id] });
        expect(run.generated).toHaveLength(0);
        expect(run.error).toMatch(/closed period/);
        expect(run.nextDate).toBe('2035-05-01');
        expect(await overdueRecurringEntries('2035-05-31', tx)).toContainEqual(
          expect.objectContaining({ id: weekly.id, nextDate: '2035-05-01' }),
        );
      });
    },
    60_000,
  );

  it(
    'refuses a template that could not post',
    async () => {
      await withRollback(async (tx) => {
        const ctx = { userId: null, tx };
        const base = { name: 'Bad', frequency: 'monthly' as const, startDate: '2035-01-01' };
        await expect(
          createRecurringEntry(
            {
              ...base,
              template: [
                { accountCode: ACCOUNTS.RENT, debitCents: 100, creditCents: 0 },
                { accountCode: ACCOUNTS.OPERATING_CHECKING, debitCents: 0, creditCents: 99 },
              ],
            },
            ctx,
          ),
        ).rejects.toThrow(/does not balance/);
        await expect(
          createRecurringEntry(
            {
              ...base,
              template: [
                { accountCode: ACCOUNTS.AR, debitCents: 100, creditCents: 0 },
                { accountCode: ACCOUNTS.SALES_SQUARE, debitCents: 0, creditCents: 100 },
              ],
            },
            ctx,
          ),
        ).rejects.toThrow(/control account/);
        await expect(
          createRecurringEntry(
            {
              ...base,
              template: [
                { accountCode: ACCOUNTS.OPEX, debitCents: 100, creditCents: 0 },
                { accountCode: ACCOUNTS.OPERATING_CHECKING, debitCents: 0, creditCents: 100 },
              ],
            },
            ctx,
          ),
        ).rejects.toThrow(/heading/);
      });
    },
    30_000,
  );
});

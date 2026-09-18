import { afterAll, describe, expect, it } from 'vitest';

// First: loads .env.local before '@/db/client' is imported anywhere below.
import { accountIds, closeTestDb, hasDatabase, withRollback } from './test-support';

import { randomUUID } from 'node:crypto';

import { and, eq, sql } from 'drizzle-orm';

import { accounts, journalEntries, journalLines, periods } from '@/db/schema';
import { isUniqueViolation, postgresErrorOf } from '@/lib/db-errors';

import { createAccount } from './accounts';
import { ACCOUNTS } from './coa';
import {
  ClosedPeriodError,
  ImmutableEntryError,
  InvalidReferenceError,
  RollupAccountError,
} from './errors';
import { type DraftLine, type LedgerDb, postJournalEntry, translateLedgerDbError } from './post';
import { reverseEntry } from './reverse';

/**
 * The ways round the ledger's invariants that the database used to leave open,
 * each tried against the live triggers inside a transaction that is rolled back.
 * Every attempt runs in its own savepoint, so a refusal aborts only that attempt.
 */

const DATE = '2031-06-15';

function sale(amountCents: number): DraftLine[] {
  return [
    { accountCode: ACCOUNTS.OPERATING_CHECKING, debitCents: amountCents },
    { accountCode: ACCOUNTS.SALES_DTC, creditCents: amountCents },
  ];
}

async function failureOf(work: Promise<unknown>): Promise<unknown> {
  const error: unknown = await work.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error, 'expected the database to refuse this').not.toBeNull();
  return error;
}

function messageOf(error: unknown): string {
  return postgresErrorOf(error)?.message ?? String(error);
}

async function draftEntry(tx: LedgerDb, date = DATE): Promise<string> {
  const [entry] = await tx
    .insert(journalEntries)
    .values({ entryDate: date, status: 'draft', sourceType: 'manual' })
    .returning({ id: journalEntries.id });
  return entry.id;
}

afterAll(closeTestDb);

describe.skipIf(!hasDatabase)('a posted entry stays whole', () => {
  it(
    'will not let a line be moved out of a posted entry into a draft',
    async () => {
      await withRollback(async (tx) => {
        const posted = await postJournalEntry(
          { date: DATE, sourceType: 'manual', lines: sale(100_00) },
          { userId: null, tx },
        );
        const draft = await draftEntry(tx);

        const error = await failureOf(
          tx.transaction(async (sp) => {
            await sp
              .update(journalLines)
              .set({ entryId: draft })
              .where(and(eq(journalLines.entryId, posted.entryId), eq(journalLines.lineNo, 2)));
          }),
        );
        expect(messageOf(error)).toMatch(/cannot be moved to another entry/);
        expect(translateLedgerDbError(error)).toBeInstanceOf(ImmutableEntryError);

        const lines = await tx
          .select({ id: journalLines.id })
          .from(journalLines)
          .where(eq(journalLines.entryId, posted.entryId));
        expect(lines).toHaveLength(2);
        // The check COMMIT runs still passes: the entry is as it was posted.
        await tx.execute(sql`set constraints all immediate`);
      });
    },
    30_000,
  );

  it(
    'will not let a line hop between drafts either',
    async () => {
      await withRollback(async (tx) => {
        const ids = await accountIds(tx, [ACCOUNTS.OPERATING_CHECKING]);
        const from = await draftEntry(tx);
        const to = await draftEntry(tx);
        await tx.insert(journalLines).values({
          entryId: from,
          lineNo: 1,
          accountId: ids.get(ACCOUNTS.OPERATING_CHECKING) as string,
          debitCents: 5_00,
        });

        const error = await failureOf(
          tx.transaction(async (sp) => {
            await sp.update(journalLines).set({ entryId: to }).where(eq(journalLines.entryId, from));
          }),
        );
        expect(messageOf(error)).toMatch(/cannot be moved to another entry/);

        // Editing a draft's line in place is still ordinary work.
        await tx.update(journalLines).set({ debitCents: 6_00 }).where(eq(journalLines.entryId, from));
      });
    },
    30_000,
  );

  it(
    'freezes every column of a posted entry, and links a reversal only once and only to itself',
    async () => {
      await withRollback(async (tx) => {
        const posted = await postJournalEntry(
          { date: DATE, sourceType: 'manual', lines: sale(20_00) },
          { userId: null, tx },
        );
        const unrelated = await draftEntry(tx);

        const restamp = await failureOf(
          tx.transaction(async (sp) => {
            await sp
              .update(journalEntries)
              .set({ postedAt: new Date('2020-01-01T00:00:00Z') })
              .where(eq(journalEntries.id, posted.entryId));
          }),
        );
        expect(messageOf(restamp)).toMatch(/is immutable/);

        const falseLink = await failureOf(
          tx.transaction(async (sp) => {
            await sp
              .update(journalEntries)
              .set({ reversedById: unrelated })
              .where(eq(journalEntries.id, posted.entryId));
          }),
        );
        expect(messageOf(falseLink)).toMatch(/only be linked to an entry that reverses it/);

        const reversal = await reverseEntry(posted.entryId, { userId: null, tx });
        expect(reversal.linked).toBe(true);

        const unlink = await failureOf(
          tx.transaction(async (sp) => {
            await sp
              .update(journalEntries)
              .set({ reversedById: null })
              .where(eq(journalEntries.id, posted.entryId));
          }),
        );
        expect(messageOf(unlink)).toMatch(/already linked to its reversal/);
      });
    },
    30_000,
  );
});

describe.skipIf(!hasDatabase)('nothing posts to a rollup', () => {
  it(
    'is refused by the posting engine with the account named',
    async () => {
      await withRollback(async (tx) => {
        const error = await failureOf(
          postJournalEntry(
            {
              date: DATE,
              sourceType: 'manual',
              lines: [
                { accountCode: ACCOUNTS.INVENTORY, debitCents: 1_00 },
                { accountCode: ACCOUNTS.OPERATING_CHECKING, creditCents: 1_00 },
              ],
            },
            { userId: null, tx },
          ),
        );
        expect(error).toBeInstanceOf(RollupAccountError);
        expect(error).toMatchObject({ code: 'rollup_account', accountCode: ACCOUNTS.INVENTORY, lineNo: 1 });
      });
    },
    30_000,
  );

  it(
    'is refused by the database for a caller that goes round the engine',
    async () => {
      await withRollback(async (tx) => {
        const ids = await accountIds(tx, [ACCOUNTS.OPERATING_CHECKING, ACCOUNTS.CASH_AND_BANK]);
        const entryId = await draftEntry(tx);
        await tx.insert(journalLines).values([
          {
            entryId,
            lineNo: 1,
            accountId: ids.get(ACCOUNTS.OPERATING_CHECKING) as string,
            debitCents: 1_00,
          },
          {
            entryId,
            lineNo: 2,
            accountId: ids.get(ACCOUNTS.CASH_AND_BANK) as string,
            creditCents: 1_00,
          },
        ]);

        const error = await failureOf(
          tx.transaction(async (sp) => {
            await sp
              .update(journalEntries)
              .set({ status: 'posted' })
              .where(eq(journalEntries.id, entryId));
          }),
        );
        expect(messageOf(error)).toMatch(new RegExp(`account ${ACCOUNTS.CASH_AND_BANK} .* is a rollup`));
        const translated = translateLedgerDbError(error);
        expect(translated).toBeInstanceOf(RollupAccountError);
        expect(translated).toMatchObject({ accountCode: ACCOUNTS.CASH_AND_BANK });
      });
    },
    30_000,
  );

  it(
    'still reverses an entry whose account has since become a rollup',
    async () => {
      await withRollback(async (tx) => {
        await createAccount(
          { code: '6996', name: 'Integrity test leaf', type: 'expense', parentCode: ACCOUNTS.OPEX },
          { userId: null, tx },
        );
        const original = await postJournalEntry(
          {
            date: DATE,
            sourceType: 'manual',
            lines: [
              { accountCode: '6996', debitCents: 7_00 },
              { accountCode: ACCOUNTS.OPERATING_CHECKING, creditCents: 7_00 },
            ],
          },
          { userId: null, tx },
        );
        // Restructuring the chart turns the leaf into a header.
        await createAccount(
          { code: '69961', name: 'Integrity test child', type: 'expense', parentCode: '6996' },
          { userId: null, tx },
        );

        await expect(
          postJournalEntry(
            {
              date: DATE,
              sourceType: 'manual',
              lines: [
                { accountCode: '6996', debitCents: 1_00 },
                { accountCode: ACCOUNTS.OPERATING_CHECKING, creditCents: 1_00 },
              ],
            },
            { userId: null, tx },
          ),
        ).rejects.toBeInstanceOf(RollupAccountError);

        const reversal = await reverseEntry(original.entryId, { userId: null, tx });
        expect(reversal.reversedEntryId).toBe(original.entryId);
        await tx.execute(sql`set constraints all immediate`);
      });
    },
    30_000,
  );
});

describe.skipIf(!hasDatabase)('database refusals reach the caller typed', () => {
  it(
    'reads a closed-period refusal through drizzle’s query-error wrapper',
    async () => {
      await withRollback(async (tx) => {
        const ids = await accountIds(tx, [ACCOUNTS.OPERATING_CHECKING, ACCOUNTS.SALES_DTC]);
        const entryId = await draftEntry(tx, '2031-07-10');
        await tx.insert(journalLines).values([
          { entryId, lineNo: 1, accountId: ids.get(ACCOUNTS.OPERATING_CHECKING) as string, debitCents: 1_00 },
          { entryId, lineNo: 2, accountId: ids.get(ACCOUNTS.SALES_DTC) as string, creditCents: 1_00 },
        ]);
        // The month closes between the engine's own check and the flip to posted.
        await tx.insert(periods).values({ year: 2031, month: 7, status: 'closed' });

        const error = await failureOf(
          tx.transaction(async (sp) => {
            await sp
              .update(journalEntries)
              .set({ status: 'posted' })
              .where(eq(journalEntries.id, entryId));
          }),
        );
        // What used to defeat the translation: the wrapper has no SQLSTATE of its own.
        expect((error as { code?: unknown }).code).toBeUndefined();
        expect(postgresErrorOf(error)?.code).toBe('23514');

        const translated = translateLedgerDbError(error);
        expect(translated).toBeInstanceOf(ClosedPeriodError);
        expect(translated).toMatchObject({ year: 2031, month: 7, date: '2031-07-01' });
      });
    },
    30_000,
  );

  it(
    'names a dimension that does not exist rather than returning the failed SQL',
    async () => {
      await withRollback(async (tx) => {
        const error = await failureOf(
          postJournalEntry(
            {
              date: DATE,
              sourceType: 'manual',
              lines: [
                { accountCode: ACCOUNTS.OPERATING_CHECKING, debitCents: 3_00, channelId: randomUUID() },
                { accountCode: ACCOUNTS.SALES_DTC, creditCents: 3_00 },
              ],
            },
            { userId: null, tx },
          ),
        );
        expect(error).toBeInstanceOf(InvalidReferenceError);
        expect(error).toMatchObject({ field: 'channelId' });
        expect(String((error as Error).message)).not.toMatch(/Failed query|insert into/i);
      });
    },
    30_000,
  );

  it(
    'recognises a duplicate account code however drizzle wraps it',
    async () => {
      await withRollback(async (tx) => {
        const error = await failureOf(
          tx.transaction(async (sp) => {
            await sp
              .insert(accounts)
              .values({ code: ACCOUNTS.OPERATING_CHECKING, name: 'Duplicate', type: 'asset' });
          }),
        );
        expect((error as { code?: unknown }).code).toBeUndefined();
        expect(isUniqueViolation(error, 'accounts_code_key')).toBe(true);
      });
    },
    30_000,
  );
});

describe.skipIf(!hasDatabase)('the audit trail is append-only', () => {
  it(
    'refuses to delete, rewrite or truncate audit rows',
    async () => {
      await withRollback(async (tx) => {
        const posted = await postJournalEntry(
          { date: DATE, sourceType: 'manual', lines: sale(9_00) },
          { userId: null, tx },
        );
        const count = async (): Promise<number> => {
          const [row] = [
            ...(await tx.execute<{ n: number }>(
              sql`select count(*)::int as n from audit_log where row_id = ${posted.entryId}`,
            )),
          ];
          return Number(row.n);
        };
        const before = await count();
        expect(before).toBeGreaterThan(0);

        for (const statement of [
          sql`delete from audit_log where row_id = ${posted.entryId}`,
          sql`update audit_log set actor_id = null where row_id = ${posted.entryId}`,
          sql`truncate audit_log`,
        ]) {
          const error = await failureOf(
            tx.transaction(async (sp) => {
              await sp.execute(statement);
            }),
          );
          expect(messageOf(error)).toMatch(/permission denied|append-only/);
        }

        expect(await count()).toBe(before);
      });
    },
    30_000,
  );
});

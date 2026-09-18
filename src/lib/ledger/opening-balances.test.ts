import { afterAll, describe, expect, it } from 'vitest';

// First: loads .env.local before '@/db/client' is imported anywhere below.
import { closeTestDb, hasDatabase, withRollback } from './test-support';

import { randomUUID } from 'node:crypto';

import { asc, eq, sql } from 'drizzle-orm';

import { accounts, bankAccounts, journalEntries, journalLines } from '@/db/schema';

import { ACCOUNTS } from './coa';
import { postOpeningBalances } from './opening-balances';
import { closePeriod } from './periods';
import type { LedgerDb } from './post';
import { reverseEntry } from './reverse';

async function bank(
  tx: LedgerDb,
  openingBalanceCents: number,
  openingDate: string | null,
  kind: 'checking' | 'credit_card' = 'checking',
): Promise<{ id: string; glId: string }> {
  const tag = randomUUID().slice(0, 8);
  const [gl] = await tx
    .insert(accounts)
    .values({ code: `TO-${tag}`, name: `Test opening ${tag}`, type: 'asset', subtype: 'bank', isBank: true })
    .returning({ id: accounts.id });
  const [row] = await tx
    .insert(bankAccounts)
    .values({ accountId: gl.id, name: `TEST opening ${tag}`, kind, openingBalanceCents, openingDate })
    .returning({ id: bankAccounts.id });
  return { id: row.id, glId: gl.id };
}

async function codeOf(tx: LedgerDb, accountId: string): Promise<string> {
  const [row] = await tx.select({ code: accounts.code }).from(accounts).where(eq(accounts.id, accountId));
  return row.code;
}

afterAll(closeTestDb);

describe.skipIf(!hasDatabase)('postOpeningBalances', () => {
  it(
    'posts Dr bank / Cr Member Contributions on the opening date, once',
    async () => {
      await withRollback(async (tx) => {
        await tx.execute(sql`set constraints all immediate`);
        const founder = await bank(tx, 1_000_00, '2031-01-14');
        const empty = await bank(tx, 0, '2031-01-01');
        const undated = await bank(tx, 5_00, null);
        const ids = [founder.id, empty.id, undated.id];

        const first = await postOpeningBalances({ userId: null, tx }, { bankAccountIds: ids });
        const byId = new Map(first.map((r) => [r.bankAccountId, r]));
        const posted = byId.get(founder.id);
        expect(posted).toMatchObject({ status: 'posted', equityAccountCode: ACCOUNTS.MEMBER_CONTRIBUTIONS });
        expect(byId.get(empty.id)?.status).toBe('skipped');
        expect(byId.get(undated.id)?.status).toBe('skipped');

        if (posted?.status !== 'posted') throw new Error('expected a posting');
        const [entry] = await tx.select().from(journalEntries).where(eq(journalEntries.id, posted.entryId));
        expect(entry).toMatchObject({
          entryDate: '2031-01-14',
          sourceType: 'opening_balance',
          sourceId: founder.id,
          status: 'posted',
        });
        const lines = await tx
          .select()
          .from(journalLines)
          .where(eq(journalLines.entryId, posted.entryId))
          .orderBy(asc(journalLines.lineNo));
        expect(lines.map((l) => [l.accountId === founder.glId ? 'bank' : 'equity', l.debitCents, l.creditCents])).toEqual([
          ['bank', 1_000_00, 0],
          ['equity', 0, 1_000_00],
        ]);
        expect(await codeOf(tx, lines[1].accountId)).toBe(ACCOUNTS.MEMBER_CONTRIBUTIONS);

        const second = await postOpeningBalances({ userId: null, tx }, { bankAccountIds: ids });
        expect(second.find((r) => r.bankAccountId === founder.id)).toMatchObject({
          status: 'already_posted',
          entryId: posted.entryId,
        });
        const count = await tx
          .select({ id: journalEntries.id })
          .from(journalEntries)
          .where(eq(journalEntries.sourceId, founder.id));
        expect(count).toHaveLength(1);

        // A reversed opening entry no longer counts, so the corrected balance can post.
        await reverseEntry(posted.entryId, { userId: null, tx });
        const third = await postOpeningBalances({ userId: null, tx }, { bankAccountIds: [founder.id] });
        expect(third[0].status).toBe('posted');
      });
    },
    60_000,
  );

  it(
    'sends a balance that was not founder cash to Opening Balance Equity, and reports a closed period',
    async () => {
      await withRollback(async (tx) => {
        await tx.execute(sql`set constraints all immediate`);
        const card = await bank(tx, -250_00, '2031-01-14', 'credit_card');
        const closed = await bank(tx, 10_00, '2031-02-10');
        await closePeriod(2031, 2, null, { tx });

        const results = await postOpeningBalances({ userId: null, tx }, { bankAccountIds: [card.id, closed.id] });
        const byId = new Map(results.map((r) => [r.bankAccountId, r]));
        const cardResult = byId.get(card.id);
        expect(cardResult).toMatchObject({ status: 'posted', equityAccountCode: ACCOUNTS.OPENING_BALANCE_EQUITY });
        if (cardResult?.status !== 'posted') throw new Error('expected a posting');
        const lines = await tx.select().from(journalLines).where(eq(journalLines.entryId, cardResult.entryId));
        expect(lines.find((l) => l.accountId === card.glId)).toMatchObject({ creditCents: 250_00, debitCents: 0 });

        expect(byId.get(closed.id)).toMatchObject({ status: 'failed' });
        const failed = byId.get(closed.id);
        if (failed?.status !== 'failed') throw new Error('expected a failure');
        expect(failed.error).toMatch(/2031-02/);
      });
    },
    60_000,
  );
});

/**
 * The settlement screen's promise: the entry it shows before posting is exactly the entry
 * posting writes. Against the live database, inside a transaction that is rolled back, using
 * the channel engine's synthetic fixtures — nothing real is read into or changed.
 */

import { afterAll, describe, expect, it } from 'vitest';

// First: loads .env.local before '@/db/client' is imported anywhere below.
import { closeTestDb, hasDatabase, withRollback } from '@/lib/ledger/test-support';

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { and, eq, sql } from 'drizzle-orm';

import { appUsers } from '@/db/schema';
import { importChannelSettlements } from '@/lib/channels/intake';
import { postPayout } from '@/lib/channels/post';
import type { LedgerDb } from '@/lib/ledger/post';

import { channelCards, settlementDetail, settlementRows } from './queries';

afterAll(closeTestDb);

const T = 90_000;

function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(fileURLToPath(new URL(`../../../lib/channels/__fixtures__/${name}`, import.meta.url))));
}

async function owner(tx: LedgerDb): Promise<string | null> {
  await tx.execute(sql`set constraints all immediate`);
  const [row] = await tx
    .select({ id: appUsers.id })
    .from(appUsers)
    .where(and(eq(appUsers.role, 'owner'), eq(appUsers.active, true)))
    .limit(1);
  return row?.id ?? null;
}

type Line = { accountCode: string; debitCents: number; creditCents: number };

function normalise(lines: readonly Line[]): string[] {
  return lines.map((l) => `${l.accountCode}|${l.debitCents}|${l.creditCents}`).sort();
}

describe.skipIf(!hasDatabase)('channel screens — settlement detail', () => {
  it(
    'shows, before posting, exactly the entry that posting writes (Amazon, with facilitator tax)',
    async () => {
      await withRollback(async (tx) => {
        const userId = await owner(tx);
        const imported = await importChannelSettlements(
          { provider: 'amazon', file: { filename: 'amazon-settlement-22558491237.txt', bytes: fixture('amazon-settlement-22558491237.txt') } },
          { userId, tx },
        );
        const id = imported.settlements[0]?.payoutImportId;
        expect(id).toBeTruthy();

        const before = await settlementDetail(id as string, tx);
        expect(before).not.toBeNull();
        expect(before?.entry.kind).toBe('planned');
        expect(before?.identity.ties).toBe(true);
        expect(before?.entry.clearingAccountCode).toBe('1120');
        // Facilitator tax is shown as pass-through and never lands on an account.
        const facilitator = before?.lines.filter((l) => l.facilitator) ?? [];
        expect(facilitator.length).toBeGreaterThan(0);
        expect(facilitator.every((l) => l.accountCode === null)).toBe(true);
        expect(before?.entry.lines.some((l) => l.accountCode === '2200')).toBe(false);
        expect(before?.entry.lines.every((l) => l.accountName !== '')).toBe(true);

        const posted = await postPayout(id as string, { userId, tx });
        const after = await settlementDetail(id as string, tx);
        expect(after?.entry.kind).toBe('posted');
        expect(after?.row.entryNo).toBe(posted.entryNo);
        expect(normalise(after?.entry.lines ?? [])).toEqual(normalise(before?.entry.lines ?? []));

        const rows = await settlementRows('amazon', tx);
        const row = rows.find((r) => r.id === id);
        expect(row?.entryNo).toBe(posted.entryNo);
        expect(row?.depositState).not.toBe('matched');
      });
    },
    T,
  );

  it(
    'shows why a settlement that does not tie cannot post, and offers no entry',
    async () => {
      await withRollback(async (tx) => {
        const userId = await owner(tx);
        const imported = await importChannelSettlements(
          { provider: 'faire', file: { filename: 'faire-payout-summary.csv', bytes: fixture('faire-payout-summary.csv') } },
          { userId, tx },
        );
        const id = imported.settlements[0]?.payoutImportId as string;
        // Knock the reported total a cent off, as an edited file would.
        await tx.execute(sql`update payout_imports set reported_total_cents = reported_total_cents + 1 where id = ${id}::uuid`);
        const detail = await settlementDetail(id, tx);
        expect(detail?.identity.ties).toBe(false);
        expect(detail?.identity.differenceCents).toBe(-1);
        expect(detail?.entry.kind).toBe('refused');
        expect(detail?.entry.refusal?.code).toBe('unbalanced');
      });
    },
    T,
  );

  it(
    'reads the live Square clearing account as deposits with no settlement behind them',
    async () => {
      await withRollback(async (tx) => {
        const cards = await channelCards(tx);
        const square = cards.find((c) => c.provider === 'square');
        expect(square?.accountCode).toBe('1150');
        const unmatched = square?.deposits.filter((d) => d.payoutImportId === null) ?? [];
        expect(square?.unmatchedDepositCount).toBe(unmatched.length);
        expect(square?.unmatchedDepositCents).toBe(unmatched.reduce((s, d) => s + d.amountCents, 0));
        if (square !== undefined && square.settlements.length === 0 && square.deposits.length > 0) {
          expect(square.connected).toBe(true);
          expect(square.blocking).toBe(true);
          expect(square.projectedBalanceCents).toBe(square.balanceCents - square.pendingDepositsCents);
        }
      });
    },
    T,
  );
});

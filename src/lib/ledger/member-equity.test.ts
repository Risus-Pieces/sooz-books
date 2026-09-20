import { afterAll, describe, expect, it } from 'vitest';

// First: loads .env.local before '@/db/client' is imported anywhere below.
import { closeTestDb, hasDatabase, withRollback } from './test-support';

import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';

import { accounts, appUsers } from '@/db/schema';

import { ACCOUNTS } from './coa';
import { memberEquityAccount } from './member-equity';
import type { LedgerDb } from './post';

/**
 * An account of this member's own, nested under the pooled one it replaces — which is what
 * turns the pooled account into a rollup.
 */
async function memberAccount(tx: LedgerDb, parentCode: string, name: string): Promise<string> {
  const tag = randomUUID().slice(0, 8);
  const [parent] = await tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.code, parentCode));
  const [row] = await tx
    .insert(accounts)
    .values({
      code: `TM-${tag}`,
      name: `${name} ${tag}`,
      type: 'equity',
      subtype: parentCode === ACCOUNTS.OWNER_DRAWS ? 'contra_equity' : 'equity',
      parentId: parent.id,
    })
    .returning({ id: accounts.id });
  return row.id;
}

/** A real member: `app_users.id` is a foreign key onto `auth.users`, so tests use the seeded one. */
async function seededMember(tx: LedgerDb): Promise<string> {
  const [row] = await tx.select({ id: appUsers.id }).from(appUsers).limit(1);
  return row.id;
}

async function assign(
  tx: LedgerDb,
  userId: string,
  accountIds: { contributions?: string | null; draws?: string | null },
): Promise<void> {
  await tx
    .update(appUsers)
    .set({
      ...(accountIds.contributions === undefined ? {} : { contributionsAccountId: accountIds.contributions }),
      ...(accountIds.draws === undefined ? {} : { drawsAccountId: accountIds.draws }),
    })
    .where(eq(appUsers.id, userId));
}

afterAll(closeTestDb);

describe.skipIf(!hasDatabase)('memberEquityAccount', () => {
  it('falls back to the pooled accounts for a member with none of their own', async () => {
    await withRollback(async (tx) => {
      const userId = await seededMember(tx);
      await assign(tx, userId, { contributions: null, draws: null });

      await expect(memberEquityAccount(tx, userId, 'contributions')).resolves.toMatchObject({
        code: ACCOUNTS.MEMBER_CONTRIBUTIONS,
      });
      await expect(memberEquityAccount(tx, userId, 'draws')).resolves.toMatchObject({
        code: ACCOUNTS.OWNER_DRAWS,
      });
    });
  });

  it('uses the pooled accounts when nobody is acting', async () => {
    await withRollback(async (tx) => {
      await expect(memberEquityAccount(tx, null, 'contributions')).resolves.toMatchObject({
        code: ACCOUNTS.MEMBER_CONTRIBUTIONS,
      });
      await expect(memberEquityAccount(tx, null, 'draws')).resolves.toMatchObject({
        code: ACCOUNTS.OWNER_DRAWS,
      });
    });
  });

  it("returns the member's own accounts once they are assigned", async () => {
    await withRollback(async (tx) => {
      const contributions = await memberAccount(tx, ACCOUNTS.MEMBER_CONTRIBUTIONS, 'Contributions —');
      const draws = await memberAccount(tx, ACCOUNTS.OWNER_DRAWS, 'Draws —');
      const userId = await seededMember(tx);
      await assign(tx, userId, { contributions, draws });

      await expect(memberEquityAccount(tx, userId, 'contributions')).resolves.toMatchObject({ id: contributions });
      await expect(memberEquityAccount(tx, userId, 'draws')).resolves.toMatchObject({ id: draws });
    });
  });

  it('follows the assignment rather than a fixed account', async () => {
    await withRollback(async (tx) => {
      const first = await memberAccount(tx, ACCOUNTS.MEMBER_CONTRIBUTIONS, 'Contributions — one');
      const second = await memberAccount(tx, ACCOUNTS.MEMBER_CONTRIBUTIONS, 'Contributions — two');
      const userId = await seededMember(tx);

      await assign(tx, userId, { contributions: first });
      await expect(memberEquityAccount(tx, userId, 'contributions')).resolves.toMatchObject({ id: first });

      await assign(tx, userId, { contributions: second });
      await expect(memberEquityAccount(tx, userId, 'contributions')).resolves.toMatchObject({ id: second });
    });
  });

  it('refuses to fall back onto a pooled account that has become a rollup', async () => {
    await withRollback(async (tx) => {
      // Somebody else has an account of their own, so 3015 now only totals what is under it.
      await memberAccount(tx, ACCOUNTS.MEMBER_CONTRIBUTIONS, 'Contributions — someone');
      const userId = await seededMember(tx);
      await assign(tx, userId, { contributions: null });

      await expect(memberEquityAccount(tx, userId, 'contributions')).rejects.toThrow(
        /only totals the accounts under it/,
      );
    });
  });
});

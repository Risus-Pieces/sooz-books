import { afterAll, describe, expect, it } from 'vitest';

// First: loads .env.local before '@/db/client' is imported anywhere below.
import { closeTestDb, hasDatabase, withRollback } from '@/lib/ledger/test-support';

import { eq } from 'drizzle-orm';

import { appUsers } from '@/db/schema';

import { type Payer, defaultPayer, listPayers } from './payers';
import { giveContributionsAccount, seededUserId } from './test-support';

afterAll(closeTestDb);

describe.skipIf(!hasDatabase)('listPayers', () => {
  it('lists a member once they have accounts of their own, with their name', async () => {
    await withRollback(async (tx) => {
      const userId = await seededUserId(tx);
      await tx.update(appUsers).set({ contributionsAccountId: null }).where(eq(appUsers.id, userId));
      expect((await listPayers(tx)).map((p) => p.userId)).not.toContain(userId);

      const account = await giveContributionsAccount(tx, userId);
      const listed = (await listPayers(tx)).find((p) => p.userId === userId);

      expect(listed).toMatchObject({ userId, contributionsAccountId: account.id });
      expect(listed?.name).toBeTruthy();
    });
  });

  it('does not list a deactivated member', async () => {
    await withRollback(async (tx) => {
      const userId = await seededUserId(tx);
      await giveContributionsAccount(tx, userId);
      await tx.update(appUsers).set({ active: false }).where(eq(appUsers.id, userId));

      expect((await listPayers(tx)).map((p) => p.userId)).not.toContain(userId);
    });
  });
});

describe('defaultPayer', () => {
  const risus: Payer = { userId: 'u-risus', name: 'Risus', email: 'r@x.test', contributionsAccountId: 'a-1' };
  const mo: Payer = { userId: 'u-mo', name: 'Mo', email: 'm@x.test', contributionsAccountId: 'a-2' };

  it('is the uploader when they are a member', () => {
    expect(defaultPayer([risus, mo], 'u-mo')).toBe('u-mo');
  });

  it('is nobody when the uploader is not a member, even with one member to guess from', () => {
    expect(defaultPayer([risus, mo], 'u-bookkeeper')).toBeNull();
    expect(defaultPayer([risus], 'u-bookkeeper')).toBeNull();
    expect(defaultPayer([], 'u-mo')).toBeNull();
  });
});

import { closeTestDb, hasDatabase, withRollback } from '@/lib/ledger/test-support';

import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { booksAreUnclaimed } from './owner';

afterAll(closeTestDb);

// Before this, "unclaimed" meant "app_users is empty". An end-to-end test account created
// before the founder signed up made the books look claimed, so the login page hid the only form
// the founder could use to create their own owner account.
describe.skipIf(!hasDatabase)('booksAreUnclaimed', () => {
  it('stays true while other accounts exist but the configured owner has not signed up', async () => {
    await withRollback(async (tx) => {
      // Production before go-live: a test account exists, the founder has not signed up.
      await tx.execute(sql`update app_settings set owner_email = 'founder-not-yet-signed-up@example.com'`);
      const [others] = await tx.execute<{ n: number }>(sql`select count(*)::int as n from app_users`);
      expect(others.n).toBeGreaterThan(0);
      expect(await booksAreUnclaimed(tx)).toBe(true);
    });
  });

  it('turns false once an account matches the owner email, ignoring case and spacing', async () => {
    await withRollback(async (tx) => {
      const [user] = await tx.execute<{ email: string }>(sql`select email from app_users limit 1`);
      await tx.execute(sql`update app_settings set owner_email = ${`  ${user.email.toUpperCase()} `}`);
      expect(await booksAreUnclaimed(tx)).toBe(false);
    });
  });
});

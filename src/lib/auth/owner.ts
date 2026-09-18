import { sql } from 'drizzle-orm';

import { db } from '@/db/client';
import type { LedgerDb } from '@/lib/ledger/post';

/**
 * True until the owner named in `app_settings.owner_email` has an account.
 *
 * Sign-up is invite-only (migration 0017): the database accepts a new account only for the
 * configured owner or an invited address. "Unclaimed" therefore means the owner has not signed
 * up yet — not that `app_users` is empty. The difference matters: a test or support account can
 * exist before the owner arrives, and treating "anyone exists" as "claimed" would hide the only
 * form the owner can use to open their own books.
 */
export async function booksAreUnclaimed(exec: LedgerDb = db): Promise<boolean> {
  const rows = await exec.execute<{ claimed: boolean }>(sql`
    select exists (
      select 1
        from app_users u
        join app_settings s on lower(btrim(u.email)) = lower(btrim(s.owner_email))
    ) as claimed`);
  return rows[0]?.claimed !== true;
}

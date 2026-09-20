/**
 * Whose money it was.
 *
 * An LLC's members each carry their own capital balance: what they put in, what they took out,
 * and therefore what they are owed. Pooling that into one pair of accounts loses the only fact
 * those accounts exist to record.
 *
 * So each member points at two accounts of their own, and the modules that move founder money —
 * a bank line marked personal, a bank account's opening balance — ask here which account to use
 * instead of naming 3015 / 3020 outright.
 *
 * A member with nothing assigned falls back to the pooled accounts, which is correct for a
 * single-member company and is what the test fixtures rely on. Once per-member accounts are
 * nested under the pooled ones, the pooled ones become rollups and stop accepting postings; a
 * fallback that lands on one of those is a member nobody assigned accounts to, and saying so
 * is more use than the database's generic refusal.
 */
import { eq } from 'drizzle-orm';

import { accounts, appUsers } from '@/db/schema/ledger';

import { ACCOUNTS } from './coa';
import { RollupAccountError, UnknownAccountError } from './errors';
import type { LedgerDb } from './post';

export type MemberEquitySide = 'contributions' | 'draws';

const POOLED: Record<MemberEquitySide, string> = {
  contributions: ACCOUNTS.MEMBER_CONTRIBUTIONS,
  draws: ACCOUNTS.OWNER_DRAWS,
};

export interface MemberEquityAccount {
  id: string;
  code: string;
}

/**
 * The account to post a member's contribution or draw to: their own if they have one,
 * otherwise the pooled account.
 */
export async function memberEquityAccount(
  exec: LedgerDb,
  userId: string | null,
  side: MemberEquitySide,
): Promise<MemberEquityAccount> {
  if (userId !== null) {
    const [member] = await exec
      .select({
        contributions: appUsers.contributionsAccountId,
        draws: appUsers.drawsAccountId,
      })
      .from(appUsers)
      .where(eq(appUsers.id, userId));
    const own = side === 'contributions' ? member?.contributions : member?.draws;
    if (own !== null && own !== undefined) {
      const [row] = await exec.select({ code: accounts.code }).from(accounts).where(eq(accounts.id, own));
      if (row === undefined) throw new UnknownAccountError({ accountId: own }, 'missing');
      return { id: own, code: row.code };
    }
  }

  const code = POOLED[side];
  const [pooled] = await exec
    .select({ id: accounts.id, name: accounts.name })
    .from(accounts)
    .where(eq(accounts.code, code));
  if (pooled === undefined) throw new UnknownAccountError({ accountCode: code }, 'missing');

  // Asked as its own query on purpose: a correlated `exists` here renders the outer
  // column unqualified, and the subquery reads it as its own.
  const [child] = await exec
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.parentId, pooled.id))
    .limit(1);
  if (child !== undefined) throw new RollupAccountError(code, pooled.name);
  return { id: pooled.id, code };
}

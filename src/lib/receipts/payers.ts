import { and, eq, isNotNull } from 'drizzle-orm';

import { appUsers } from '@/db/schema';
import type { LedgerDb } from '@/lib/ledger/post';

export interface Payer {
  userId: string;
  name: string;
  email: string;
  contributionsAccountId: string;
}

/**
 * Members who can be credited for something they paid personally: active users with a
 * contributions account of their own. The pooled 3015 is a rollup and refuses postings, so a
 * user with no account of their own is never offered.
 */
export async function listPayers(exec: LedgerDb): Promise<Payer[]> {
  const rows = await exec
    .select({
      id: appUsers.id,
      name: appUsers.fullName,
      email: appUsers.email,
      account: appUsers.contributionsAccountId,
    })
    .from(appUsers)
    .where(and(eq(appUsers.active, true), isNotNull(appUsers.contributionsAccountId)))
    .orderBy(appUsers.fullName, appUsers.email);

  return rows.map((row) => ({
    userId: row.id,
    name: row.name ?? row.email,
    email: row.email,
    contributionsAccountId: row.account as string,
  }));
}

/**
 * Whoever uploaded, when they are a member; otherwise nobody, so a person has to choose. A
 * bookkeeper uploading a member's receipt must not silently credit the wrong member.
 */
export function defaultPayer(payers: readonly Payer[], uploaderId: string): string | null {
  return payers.find((payer) => payer.userId === uploaderId)?.userId ?? null;
}

import { eq, or, sql } from 'drizzle-orm';

import { accounts } from '@/db/schema';
import type { LedgerDb } from '@/lib/ledger/post';

import { McpInputError } from './errors';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AccountRef {
  id: string;
  code: string;
  name: string;
  active: boolean;
  isRollup: boolean;
}

/**
 * An account named the way a person names it: by code ("1450") or, for convenience, by id. Codes are
 * what Claude sees in `list_accounts` and what the owner says out loud.
 */
export async function resolveAccount(exec: LedgerDb, ref: string): Promise<AccountRef> {
  const wanted = ref.trim();
  if (wanted === '') throw new McpInputError('Name an account by its code, for example 6740.');
  const [row] = await exec
    .select({
      id: accounts.id,
      code: accounts.code,
      name: accounts.name,
      active: accounts.active,
      isRollup: sql<boolean>`exists (select 1 from accounts child where child.parent_id = accounts.id)`,
    })
    .from(accounts)
    .where(UUID.test(wanted) ? eq(accounts.id, wanted) : or(eq(accounts.code, wanted)));
  if (row === undefined) {
    throw new McpInputError(`There is no account "${wanted}". Use list_accounts to find the code.`);
  }
  return row;
}

export function accountLabel(account: { code: string; name: string }): string {
  return `${account.code} ${account.name}`;
}

import { sql } from 'drizzle-orm';

import { ACCOUNTS } from '@/lib/ledger/coa';
import type { LedgerDb } from '@/lib/ledger/post';

// A type alias, not an interface: `execute<T>` requires T to be assignable to Record<string, unknown>,
// which an interface is not.
export type AllowedAccount = {
  id: string;
  code: string;
  name: string;
  description: string | null;
};

/**
 * The accounts a receipt may debit: postable expense accounts, the two inventory accounts that
 * ingredients and packaging capitalize to, and the asset accounts that are things a business buys
 * (prepaids, deposits, equipment, and any account the owner has made of their own, such as Merch).
 *
 * Never a rollup (something nests under it), a bank or control account, or an inactive one. Never
 * cost of goods: those accounts are released from inventory as units ship, not bought into.
 * Never suspense, depreciation or income tax, which no receipt belongs to. Never the other
 * inventory accounts, cash, clearing, receivables or contra-assets, which money moves through
 * rather than being spent on.
 */
export async function loadAllowedAccounts(exec: LedgerDb): Promise<AllowedAccount[]> {
  const rows = await exec.execute<AllowedAccount>(sql`
    select a.id, a.code, a.name, a.description
      from accounts a
     where a.active
       and not a.is_bank
       and not a.is_control
       and not exists (select 1 from accounts c where c.parent_id = a.id)
       and (
         (a.type = 'expense' and coalesce(a.subtype, '') not in ('cogs', 'suspense', 'depreciation', 'income_tax'))
         or a.code in (${ACCOUNTS.INVENTORY_INGREDIENTS}, ${ACCOUNTS.INVENTORY_PACKAGING})
         or (
           a.type = 'asset'
           and coalesce(a.subtype, '') not in (
             'cash', 'bank', 'undeposited_funds', 'clearing',
             'accounts_receivable', 'other_receivable', 'contra_asset', 'inventory'
           )
         )
       )
     order by a.code`);
  return [...rows];
}

/**
 * The allowed account this vendor's most recent posted purchase was debited to, or null.
 * The vendor's own default account is checked first by the caller; this is the fallback.
 */
export async function vendorHistoryAccount(
  exec: LedgerDb,
  vendorId: string,
  allowedIds: readonly string[],
): Promise<string | null> {
  if (allowedIds.length === 0) return null;
  const list = sql.join(
    allowedIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const rows = await exec.execute<{ account_id: string }>(sql`
    select l.account_id
      from journal_lines l
      join journal_entries e on e.id = l.entry_id and e.status = 'posted'
     where l.vendor_id = ${vendorId}
       and l.debit_cents > 0
       and l.account_id in (${list})
     group by l.account_id
     order by max(e.entry_date) desc, count(*) desc
     limit 1`);
  return rows[0]?.account_id ?? null;
}

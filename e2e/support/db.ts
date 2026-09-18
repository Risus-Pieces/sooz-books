/**
 * Direct access to the e2e database, for what the UI cannot do: creating the throwaway bank
 * accounts a statement is imported into, and reading back what the flows wrote so a test can
 * assert on the ledger itself rather than only on what a page chose to show.
 *
 * Only ever the local e2e database (see ./local-db.ts). Nothing here can reach the real books.
 */
import { randomInt, randomUUID } from 'node:crypto';

import postgres from 'postgres';

import { E2E_ADMIN_URL } from './local-db';

export type Sql = postgres.Sql;

export function connect(): Sql {
  return postgres(E2E_ADMIN_URL, { max: 2, idle_timeout: 5, connect_timeout: 10, onnotice: () => undefined });
}

export interface ThrowawayBank {
  id: string;
  glAccountId: string;
  glCode: string;
  name: string;
  mask: string;
}

/** Four digits no seeded Relay account uses and no other throwaway account in this run has taken. */
async function freeMask(sql: Sql): Promise<string> {
  for (;;) {
    const mask = String(randomInt(1000, 9999));
    const taken = await sql`select 1 from bank_accounts where mask = ${mask}`;
    if (taken.length === 0) return mask;
  }
}

/**
 * A checking account of its own, with its own GL account under 1000 Cash, so a flow's
 * statement, postings and reconciliation touch nothing another flow or the seed data owns.
 */
export async function createThrowawayBank(sql: Sql, label: string): Promise<ThrowawayBank> {
  const mask = await freeMask(sql);
  const tag = randomUUID().slice(0, 6);
  const name = `E2E ${label} ${tag}`;
  const glCode = `E2E-${mask}`;
  const [gl] = await sql<{ id: string }[]>`
    insert into accounts (code, name, type, subtype, parent_id, is_bank, description)
    values (${glCode}, ${`${name} ••${mask}`}, 'asset', 'bank',
            (select id from accounts where code = '1000'), true, 'Created by the end-to-end suite.')
    returning id`;
  const [bank] = await sql<{ id: string }[]>`
    insert into bank_accounts (account_id, name, institution, kind, mask, statement_sign, opening_balance_cents, opening_date)
    values (${gl.id}, ${name}, 'Relay', 'checking', ${mask}, 1, 0, null)
    returning id`;
  return { id: bank.id, glAccountId: gl.id, glCode, name, mask };
}

/** Sum of posted debits minus credits on one account, over an inclusive date range. */
export async function postedBalance(sql: Sql, accountCode: string, from: string, to: string): Promise<number> {
  const [row] = await sql<{ cents: string }[]>`
    select coalesce(sum(l.debit_cents - l.credit_cents), 0)::text as cents
      from journal_lines l
      join journal_entries e on e.id = l.entry_id
      join accounts a on a.id = l.account_id
     where a.code = ${accountCode}
       and e.status = 'posted'
       and e.entry_date between ${from}::date and ${to}::date`;
  return Number(row.cents);
}

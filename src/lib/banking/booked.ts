/**
 * Sooz Books — money the ledger already holds before its bank row is reviewed.
 *
 * A receipt recorded from Sales into ••9726, a bill paid from Purchases, a sales-tax
 * payment, a manual journal entry: each posts to the bank's GL account with no bank row
 * behind it. When the Relay statement brings in the same money, the row must be *linked*
 * to that entry, not approved into a second one — approving it would book the cash twice
 * (and the revenue or expense with it), and nothing downstream would notice until a
 * reconciliation refused to tie.
 *
 * An entry line is a candidate for a bank row when it is
 *   - on the row's bank GL account, same direction, same amount to the cent;
 *   - posted, not reversed, not itself a reversal, not the opening balance;
 *   - dated from `BOOKED_DAYS_BEFORE` days before the bank date to `BOOKED_DAYS_AFTER`
 *     after (a check clears weeks after it was written; a receipt is sometimes entered
 *     a few days after the deposit);
 *   - not already claimed by a bank row on that GL account.
 *
 * `bookedCandidates` lists them for the reviewer. The banking engine refuses to post a
 * row that has one unless the reviewer says it is a different transaction.
 */

import { type SQL, sql as sqlTag } from 'drizzle-orm';

import type { CalendarDate } from '@/lib/dates';
import type { LedgerDb } from '@/lib/ledger/post';

/** How far before the bank date an existing entry may be dated and still match. */
export const BOOKED_DAYS_BEFORE = 45;
/** How far after the bank date an existing entry may be dated and still match. */
export const BOOKED_DAYS_AFTER = 10;

export interface BookedCandidate {
  entryId: string;
  entryNo: number;
  entryDate: CalendarDate;
  memo: string | null;
  sourceType: string;
  sourceId: string | null;
  /** The receipt or payment number, when the entry came from one. */
  documentNo: string | null;
  /** Who the money came from or went to, when the entry names a party. */
  partyName: string | null;
  /** Signed from the bank's side: positive is money in. */
  amountCents: number;
  /** Days from the entry date to the bank date; negative when the entry is later. */
  daysApart: number;
}

/**
 * The candidate lines for one bank row, as a SQL predicate over `jl` / `je`. The row's
 * GL account, signed amount and date are passed as SQL so the same predicate serves a
 * single row and the queue's per-row flag.
 */
export function bookedLinePredicate(glAccountId: SQL, amountCents: SQL, txnDate: SQL): SQL {
  return sqlTag`
        jl.account_id = ${glAccountId}
    and je.status = 'posted'
    and je.source_type not in ('opening_balance', 'reversal')
    and je.reverses_id is null
    and je.reversed_by_id is null
    and not exists (select 1 from journal_entries rv where rv.reverses_id = je.id)
    and (jl.debit_cents - jl.credit_cents) = ${amountCents}
    and je.entry_date between (${txnDate})::date - ${BOOKED_DAYS_BEFORE}::int
                          and (${txnDate})::date + ${BOOKED_DAYS_AFTER}::int
    and not exists (
      select 1
        from bank_transactions claim
        join bank_accounts claim_ba on claim_ba.id = claim.bank_account_id
       where claim.journal_entry_id = je.id
         and claim_ba.account_id = jl.account_id)`;
}

/**
 * True for an unposted row (aliased `bt`, its bank account `ba`) that an existing entry
 * already records. For the queue's `already_booked` flag.
 */
export const HAS_BOOKED_CANDIDATE = sqlTag`exists (
  select 1
    from journal_lines jl
    join journal_entries je on je.id = jl.entry_id
   where ${bookedLinePredicate(sqlTag`ba.account_id`, sqlTag`bt.amount_cents`, sqlTag`bt.txn_date`)})`;

interface CandidateSqlRow {
  entry_id: string;
  entry_no: string;
  entry_date: string;
  memo: string | null;
  source_type: string;
  source_id: string | null;
  document_no: string | null;
  party_name: string | null;
  amount_cents: string;
  days_apart: number;
}

async function run<T>(exec: LedgerDb | undefined, query: SQL): Promise<T[]> {
  const runner = exec ?? (await import('@/db/client')).db;
  return (await runner.execute(query)) as unknown as T[];
}

/** Existing entries that could already record this bank row's money, closest date first. */
export async function bookedCandidates(
  row: { glAccountId: string; amountCents: number; txnDate: CalendarDate },
  exec?: LedgerDb,
  options: { excludeEntryIds?: readonly string[]; limit?: number } = {},
): Promise<BookedCandidate[]> {
  const exclude = options.excludeEntryIds ?? [];
  const rows = await run<CandidateSqlRow>(
    exec,
    sqlTag`
      select distinct on (je.id)
             je.id as entry_id, je.entry_no::text, je.entry_date::text, je.memo,
             je.source_type, je.source_id,
             coalesce(r.receipt_no, bp.payment_no) as document_no,
             coalesce(c.name, v.name, jlc.name, jlv.name) as party_name,
             (jl.debit_cents - jl.credit_cents)::text as amount_cents,
             (${row.txnDate}::date - je.entry_date)::int as days_apart
        from journal_lines jl
        join journal_entries je on je.id = jl.entry_id
        left join receipts r on je.source_type = 'receipt' and r.id = je.source_id
        left join customers c on c.id = r.customer_id
        left join bill_payments bp on je.source_type = 'bill_payment' and bp.id = je.source_id
        left join vendors v on v.id = bp.vendor_id
        left join customers jlc on jlc.id = jl.customer_id
        left join vendors jlv on jlv.id = jl.vendor_id
       where ${bookedLinePredicate(sqlTag`${row.glAccountId}::uuid`, sqlTag`${row.amountCents}::bigint`, sqlTag`${row.txnDate}::date`)}
         ${exclude.length === 0 ? sqlTag`` : sqlTag`and je.id not in (${sqlTag.join(exclude.map((id) => sqlTag`${id}::uuid`), sqlTag`, `)})`}
       order by je.id, jl.line_no`,
  );
  return rows
    .map((r) => ({
      entryId: r.entry_id,
      entryNo: Number(r.entry_no),
      entryDate: r.entry_date,
      memo: r.memo,
      sourceType: r.source_type,
      sourceId: r.source_id,
      documentNo: r.document_no,
      partyName: r.party_name,
      amountCents: Number(r.amount_cents),
      daysApart: r.days_apart,
    }))
    .sort((a, b) => Math.abs(a.daysApart) - Math.abs(b.daysApart) || a.entryNo - b.entryNo)
    .slice(0, options.limit ?? 10);
}

/** `bookedCandidates` for a bank row by id; empty for a row that is posted or excluded. */
export async function bookedCandidatesForTxn(txnId: string, exec?: LedgerDb): Promise<BookedCandidate[]> {
  const [row] = await run<{ gl: string; amount_cents: string; txn_date: string; live: boolean }>(
    exec,
    sqlTag`
      select ba.account_id as gl, bt.amount_cents::text, bt.txn_date::text,
             (bt.journal_entry_id is null and bt.status <> 'excluded') as live
        from bank_transactions bt
        join bank_accounts ba on ba.id = bt.bank_account_id
       where bt.id = ${txnId}::uuid`,
  );
  if (row === undefined || !row.live) return [];
  return bookedCandidates({ glAccountId: row.gl, amountCents: Number(row.amount_cents), txnDate: row.txn_date }, exec);
}

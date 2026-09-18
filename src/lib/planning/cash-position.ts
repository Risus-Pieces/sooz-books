/**
 * Where the cash actually is, and how it has been moving.
 *
 * Cash is the money in the accounts listed in `bank_accounts` (the Relay
 * accounts), measured the way the books will measure it once every bank line is
 * posted:
 *
 *     posted ledger balance of the bank's GL account
 *   + the opening balance, if its opening entry has not been posted yet
 *   + imported bank lines that have not reached the ledger yet
 *
 * The last two terms exist because a forecast that waits for the bookkeeping to
 * catch up is a forecast of the bookkeeping, not of the cash. Each is reported
 * separately so the reader can see how much of the figure the ledger does not
 * carry yet, and the bank's own running balance is returned beside it as the
 * cross-check. A bank line counts as posted when it points at a posted entry;
 * an `excluded` line (a returned ACH and its twin) never moved money.
 *
 * Flows are classified for the burn rate: `financing` is money in or out of the
 * owners or lenders (member contributions, draws, loans), `transfer` is money
 * moving between Sooz's own accounts, and everything else is `operating`. A
 * posted entry is classified by its non-cash lines; a bank line that is not
 * posted yet is classified by its suggested account, which is a suggestion — the
 * result says how much of the burn rests on unreviewed suggestions.
 */

import { sql } from 'drizzle-orm';

import { type CalendarDate, addDays } from '@/lib/dates';
import type { LedgerDb } from '@/lib/ledger/post';

import { cents, reader } from './context';

export interface BankCashPosition {
  bankAccountId: string;
  name: string;
  mask: string | null;
  glAccountId: string;
  glCode: string;
  /** Posted lines on the GL account dated on or before the as-of date. */
  ledgerCents: number;
  /** `bank_accounts.opening_balance_cents` when its opening entry is not posted yet, else 0. */
  unpostedOpeningCents: number;
  /** Imported, non-excluded bank lines not yet in the ledger. */
  unpostedActivityCents: number;
  unpostedCount: number;
  /** ledger + unposted opening + unposted activity. */
  cashCents: number;
  /** The bank's own running balance on its last line on or before the as-of date. */
  statementBalanceCents: number | null;
  statementDate: CalendarDate | null;
}

export interface CashPosition {
  asOf: CalendarDate;
  accounts: BankCashPosition[];
  ledgerCents: number;
  unpostedOpeningCents: number;
  unpostedActivityCents: number;
  unpostedCount: number;
  cashCents: number;
  /** The most recent imported bank line across all accounts, on or before the as-of date. */
  bankDataThrough: CalendarDate | null;
}

interface PositionRow extends Record<string, unknown> {
  bank_account_id: string;
  name: string;
  mask: string | null;
  gl_account_id: string;
  gl_code: string;
  ledger_cents: string | number;
  unposted_opening_cents: string | number;
  unposted_activity_cents: string | number;
  unposted_count: string | number;
  statement_balance_cents: string | number | null;
  statement_date: string | null;
}

/** A bank line that has not reached the ledger: no entry, or an entry that is not posted. */
const UNPOSTED_BANK_LINE = sql`(
  t.status <> 'excluded'
  and (t.journal_entry_id is null
       or not exists (select 1 from journal_entries je
                       where je.id = t.journal_entry_id and je.status = 'posted'))
  and (b.opening_date is null or t.txn_date >= b.opening_date)
)`;

/** An opening entry for the bank account, posted on or before `asOf`. */
function openingPostedBy(asOf: CalendarDate) {
  return sql`exists (
    select 1 from journal_entries oe
     where oe.source_type = 'opening_balance'
       and oe.source_id = b.id
       and oe.status = 'posted'
       and oe.entry_date <= ${asOf}
  )`;
}

/** Cash per bank account at close of business on `asOf`. */
export async function cashPosition(asOf: CalendarDate, exec?: LedgerDb): Promise<CashPosition> {
  const rows = await reader(exec).execute<PositionRow>(sql`
    select b.id as bank_account_id, b.name, b.mask, a.id as gl_account_id, a.code as gl_code,
           coalesce((select sum(l.debit_cents - l.credit_cents)
                       from journal_lines l
                       join journal_entries e on e.id = l.entry_id
                      where l.account_id = a.id and e.status = 'posted' and e.entry_date <= ${asOf}), 0)
             as ledger_cents,
           case when b.opening_date is not null and b.opening_date <= ${asOf}
                     and not ${openingPostedBy(asOf)}
                then b.opening_balance_cents else 0 end as unposted_opening_cents,
           coalesce((select sum(t.amount_cents) from bank_transactions t
                      where t.bank_account_id = b.id and t.txn_date <= ${asOf} and ${UNPOSTED_BANK_LINE}), 0)
             as unposted_activity_cents,
           (select count(*) from bank_transactions t
             where t.bank_account_id = b.id and t.txn_date <= ${asOf} and ${UNPOSTED_BANK_LINE})
             as unposted_count,
           s.balance_cents as statement_balance_cents,
           s.txn_date::text as statement_date
      from bank_accounts b
      join accounts a on a.id = b.account_id
      left join lateral (
        select t.balance_cents, t.txn_date
          from bank_transactions t
         where t.bank_account_id = b.id and t.txn_date <= ${asOf} and t.balance_cents is not null
         order by t.txn_date desc, t.created_at desc, t.id desc
         limit 1
      ) s on true
     where a.type = 'asset'
     order by a.code, b.name
  `);

  const accounts: BankCashPosition[] = [...rows].map((r) => {
    const ledgerCents = cents(r.ledger_cents);
    const unpostedOpeningCents = cents(r.unposted_opening_cents);
    const unpostedActivityCents = cents(r.unposted_activity_cents);
    return {
      bankAccountId: r.bank_account_id,
      name: r.name,
      mask: r.mask,
      glAccountId: r.gl_account_id,
      glCode: r.gl_code,
      ledgerCents,
      unpostedOpeningCents,
      unpostedActivityCents,
      unpostedCount: Number(r.unposted_count),
      cashCents: ledgerCents + unpostedOpeningCents + unpostedActivityCents,
      statementBalanceCents: r.statement_balance_cents === null ? null : cents(r.statement_balance_cents),
      statementDate: r.statement_date,
    };
  });

  const total = (pick: (a: BankCashPosition) => number): number =>
    accounts.reduce((sum, account) => sum + pick(account), 0);
  const dates = accounts.map((a) => a.statementDate).filter((d): d is string => d !== null);

  return {
    asOf,
    accounts,
    ledgerCents: total((a) => a.ledgerCents),
    unpostedOpeningCents: total((a) => a.unpostedOpeningCents),
    unpostedActivityCents: total((a) => a.unpostedActivityCents),
    unpostedCount: total((a) => a.unpostedCount),
    cashCents: total((a) => a.cashCents),
    bankDataThrough: dates.length === 0 ? null : dates.sort()[dates.length - 1],
  };
}

/* --------------------------------------------------------------------- flows */

export type CashFlowClass = 'operating' | 'financing' | 'transfer';

export interface ActualCashFlow {
  date: CalendarDate;
  /** Signed: positive is money in. */
  amountCents: number;
  cls: CashFlowClass;
  origin: 'ledger' | 'bank' | 'opening';
  /** True when the class came from a bank line's suggested account rather than a posted entry. */
  suggested: boolean;
}

interface FlowRow extends Record<string, unknown> {
  date: string;
  amount_cents: string | number;
  cls: CashFlowClass;
  origin: 'ledger' | 'bank' | 'opening';
  suggested: boolean;
}

/**
 * Every movement of cash dated in `(after, through]`, measured on the same terms
 * as `cashPosition`, so `cashPosition(through) − cashPosition(after)` is exactly
 * the sum of the flows. A posted entry that touches several bank accounts counts
 * once, at its net; a transfer between them nets to nothing and is dropped.
 */
export async function actualCashFlows(
  after: CalendarDate,
  through: CalendarDate,
  exec?: LedgerDb,
): Promise<ActualCashFlow[]> {
  const rows = await reader(exec).execute<FlowRow>(sql`
    with cash as (
      select b.id as bank_account_id, b.account_id, b.opening_date, b.opening_balance_cents
        from bank_accounts b join accounts a on a.id = b.account_id
       where a.type = 'asset'
    ),
    ledger as (
      select e.id, e.entry_date,
             sum(l.debit_cents - l.credit_cents) filter (where l.account_id in (select account_id from cash)) as net,
             bool_or(l.account_id not in (select account_id from cash)
                     and (a.type = 'equity' or a.subtype = 'debt')) as financing,
             bool_and(l.account_id in (select account_id from cash)) as internal
        from journal_entries e
        join journal_lines l on l.entry_id = e.id
        join accounts a on a.id = l.account_id
       where e.status = 'posted' and e.entry_date > ${after} and e.entry_date <= ${through}
       group by e.id, e.entry_date
    )
    select entry_date::text as date, net as amount_cents,
           case when internal then 'transfer' when financing then 'financing' else 'operating' end as cls,
           'ledger' as origin, false as suggested
      from ledger
     where net is not null and net <> 0
    union all
    select t.txn_date::text, t.amount_cents,
           case when t.status = 'transfer' or t.transfer_pair_id is not null then 'transfer'
                when sa.type = 'equity' or sa.subtype = 'debt' then 'financing'
                else 'operating' end,
           'bank', true
      from bank_transactions t
      join bank_accounts b on b.id = t.bank_account_id
      join accounts ga on ga.id = b.account_id and ga.type = 'asset'
      left join accounts sa on sa.id = t.suggested_account_id
     where t.txn_date > ${after} and t.txn_date <= ${through}
       and ${UNPOSTED_BANK_LINE}
    union all
    select c.opening_date::text, c.opening_balance_cents, 'financing', 'opening', false
      from cash c
      join bank_accounts b on b.id = c.bank_account_id
     where c.opening_date > ${after} and c.opening_date <= ${through}
       and c.opening_balance_cents <> 0
       and not ${openingPostedBy(through)}
     order by 1, 3, 2
  `);

  return [...rows].map((r) => ({
    date: r.date,
    amountCents: cents(r.amount_cents),
    cls: r.cls,
    origin: r.origin,
    suggested: r.suggested === true,
  }));
}

export interface TrailingBurn {
  from: CalendarDate;
  through: CalendarDate;
  windowDays: number;
  operatingInflowCents: number;
  operatingOutflowCents: number;
  /** Outflows minus inflows, operating only. Positive means cash is being consumed. */
  netBurnCents: number;
  financingInflowCents: number;
  financingOutflowCents: number;
  /** Operating movement whose class rests on a bank line's suggestion rather than a posted entry. */
  suggestedCents: number;
}

/** Operating cash burn over the `windowDays` days ending on `through`. */
export async function trailingBurn(
  through: CalendarDate,
  windowDays: number,
  exec?: LedgerDb,
): Promise<TrailingBurn> {
  const after = addDays(through, -windowDays);
  const flows = await actualCashFlows(after, through, exec);

  let operatingInflowCents = 0;
  let operatingOutflowCents = 0;
  let financingInflowCents = 0;
  let financingOutflowCents = 0;
  let suggestedCents = 0;
  for (const flow of flows) {
    if (flow.cls === 'transfer') continue;
    if (flow.cls === 'financing') {
      if (flow.amountCents > 0) financingInflowCents += flow.amountCents;
      else financingOutflowCents -= flow.amountCents;
      continue;
    }
    if (flow.amountCents > 0) operatingInflowCents += flow.amountCents;
    else operatingOutflowCents -= flow.amountCents;
    if (flow.suggested) suggestedCents += Math.abs(flow.amountCents);
  }

  return {
    from: addDays(after, 1),
    through,
    windowDays,
    operatingInflowCents,
    operatingOutflowCents,
    netBurnCents: operatingOutflowCents - operatingInflowCents,
    financingInflowCents,
    financingOutflowCents,
    suggestedCents,
  };
}

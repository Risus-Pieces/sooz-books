/**
 * Accounting basis, and the one query every report reads its figures from.
 *
 * The basis decides which journal lines a report sees. Accrual basis reads the
 * ledger as posted; cash basis reads it restated so that income and expense land
 * when money moves (see `@/lib/ledger/basis-lines` for the rules). Either way the
 * report gets a set of lines shaped like `journal_lines`, so no report builder
 * branches on the basis and a cash-basis trial balance still balances.
 *
 * `fetchBalances` lives here for the same reason. It is the only place the basis
 * is applied to a balance query, and it answers every report's question in one
 * round trip: signed balances per account for an arbitrary set of windows, each
 * window optionally narrowed to a channel.
 */

import { type SQL, sql } from 'drizzle-orm';

import { db } from '@/db/client';
import type { CalendarDate } from '@/lib/dates';
import type { AccountingBasis } from '@/lib/ledger/balances';
import { basisLinesSql } from '@/lib/ledger/basis-lines';
import type { LedgerDb } from '@/lib/ledger/post';

export type { AccountingBasis };

/* ------------------------------------------------------------------ strategy */

export interface BasisStrategy {
  readonly basis: AccountingBasis;
  readonly label: string;
  /** Shown under a report's title, so the reader knows what they are looking at. */
  readonly description: string;
  /**
   * The lines a report reads, as a derived table with the columns of
   * `journal_lines` (`line_key` standing in for `id`). Write it as
   * `join ${strategy.lines()} l on l.entry_id = e.id`.
   */
  lines(): SQL;
  /**
   * What the reader has to know about how this basis was arrived at, in the
   * reader's words. Surfaced on the report itself — an approximation nobody is
   * told about is an error, not a caveat.
   */
  readonly caveats: readonly string[];
}

const ACCRUAL: BasisStrategy = {
  basis: 'accrual',
  label: 'Accrual',
  description: 'Every posted entry, recognised on its entry date.',
  lines: () => basisLinesSql('accrual'),
  caveats: [],
};

const CASH: BasisStrategy = {
  basis: 'cash',
  label: 'Cash',
  description:
    'Income and expenses when money moves: an invoice or a bill counts as it is paid, credited or deducted.',
  lines: () => basisLinesSql('cash'),
  caveats: [
    'Cash basis spreads each payment, credit memo, vendor credit and deduction across the lines of the ' +
      'invoice or bill it is applied to. Money received or paid that is not applied to a document stays ' +
      'on Accounts Receivable or Accounts Payable, and unpaid invoices and bills are left out.',
    'Accruals that were reversed are left out together with their reversals. An accrual settled by a ' +
      'payment instead of a reversal is shown on the date it was booked, because the payment does not ' +
      'say which expense it settles.',
  ],
};

const STRATEGIES: Readonly<Record<AccountingBasis, BasisStrategy>> = Object.freeze({
  accrual: ACCRUAL,
  cash: CASH,
});

export function basisStrategy(basis: AccountingBasis): BasisStrategy {
  return STRATEGIES[basis];
}

/* ------------------------------------------------------------------ balances */

export interface BalanceBucket {
  key: string;
  /** `null` means "since the ledger began" — what a balance sheet asks for. */
  from: CalendarDate | null;
  to: CalendarDate;
  /** Only lines tagged with this channel. */
  channelId?: string | null;
  /** Only lines carrying no channel at all. Mutually exclusive with `channelId`. */
  unallocated?: boolean;
}

export interface BalanceQueryOptions {
  basis: AccountingBasis;
  /** A report-wide channel filter, applied on top of each bucket's own scope. */
  channelIds?: readonly string[];
  /** Restricts to entries raised by these sources. Used by the general ledger filter. */
  sourceTypes?: readonly string[];
}

export interface BalanceMatrix {
  readonly width: number;
  readonly buckets: readonly BalanceBucket[];
  /** Signed cents per bucket, in bucket order. Positive means the account's normal balance. */
  valuesFor(accountId: string): readonly number[] | undefined;
  accountIds(): readonly string[];
}

interface BalanceQueryRow extends Record<string, unknown> {
  idx: number;
  account_id: string;
  balance_cents: string | number;
}

function toCents(value: unknown): number {
  const cents = typeof value === 'number' ? value : Number(value ?? 0);
  if (!Number.isSafeInteger(cents)) {
    throw new Error(`Ledger returned an amount that is not a whole number of cents: ${String(value)}`);
  }
  return cents;
}

/** `l.channel_id in (…)`, or nothing when the report is not channel filtered. */
export function channelFilterSql(channelIds: readonly string[] | undefined): SQL {
  if (channelIds === undefined || channelIds.length === 0) return sql``;
  return sql`and l.channel_id in (${sql.join(
    channelIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  )})`;
}

export function sourceFilterSql(sourceTypes: readonly string[] | undefined): SQL {
  if (sourceTypes === undefined || sourceTypes.length === 0) return sql``;
  return sql`and e.source_type in (${sql.join(
    sourceTypes.map((type) => sql`${type}`),
    sql`, `,
  )})`;
}

/**
 * Signed balances per account for every bucket, in one query.
 *
 * The buckets are joined as a values list rather than fetched one at a time: a
 * twelve-month P&L with a comparison is fourteen windows, and fourteen round
 * trips to a pooled connection is how a report page becomes slow enough that
 * nobody runs it.
 */
export async function fetchBalances(
  buckets: readonly BalanceBucket[],
  options: BalanceQueryOptions,
  exec: LedgerDb = db,
): Promise<BalanceMatrix> {
  const width = buckets.length;
  const values = new Map<string, number[]>();

  if (width === 0) {
    return {
      width,
      buckets,
      valuesFor: () => undefined,
      accountIds: () => [],
    };
  }

  const bucketValues = sql.join(
    buckets.map(
      (bucket, index) => sql`(
        ${index}::int,
        ${bucket.from ?? null}::date,
        ${bucket.to}::date,
        ${bucket.channelId ?? null}::uuid,
        ${bucket.unallocated === true}::boolean
      )`,
    ),
    sql`, `,
  );

  const rows = await exec.execute<BalanceQueryRow>(sql`
    with bucket (idx, from_date, to_date, channel_id, unallocated) as (
      values ${bucketValues}
    )
    select b.idx as idx,
           l.account_id as account_id,
           account_sign(a.type) *
             (coalesce(sum(l.debit_cents), 0) - coalesce(sum(l.credit_cents), 0)) as balance_cents
      from bucket b
      join journal_entries e
        on e.status = 'posted'
       and (b.from_date is null or e.entry_date >= b.from_date)
       and e.entry_date <= b.to_date
      join ${basisStrategy(options.basis).lines()} l on l.entry_id = e.id
      join accounts a on a.id = l.account_id
     where (b.channel_id is null or l.channel_id = b.channel_id)
       and (not b.unallocated or l.channel_id is null)
       ${channelFilterSql(options.channelIds)}
       ${sourceFilterSql(options.sourceTypes)}
     group by b.idx, l.account_id, a.type
  `);

  for (const queryRow of rows) {
    const accountId = String(queryRow.account_id);
    let slots = values.get(accountId);
    if (slots === undefined) {
      slots = new Array<number>(width).fill(0);
      values.set(accountId, slots);
    }
    slots[Number(queryRow.idx)] = toCents(queryRow.balance_cents);
  }

  return {
    width,
    buckets,
    valuesFor: (accountId) => values.get(accountId),
    accountIds: () => [...values.keys()],
  };
}

/**
 * The read layer every report sits on: trial balance, account registers and
 * dimensional balances.
 *
 * Three rules hold throughout. Only posted entries count — a draft has not
 * happened. Every figure is a whole number of cents. And each function is one
 * round trip: the aggregation happens in Postgres, because a report that walks
 * accounts in JavaScript becomes a thousand queries the first time the ledger
 * gets real volume.
 */

import { sql } from 'drizzle-orm';

import { db } from '@/db/client';
import type { AccountType } from '@/db/schema';
import { type CalendarDate, today } from '@/lib/dates';

import { basisLinesSql } from './basis-lines';
import { UnknownAccountError } from './errors';
import type { LedgerDb } from './post';

/**
 * `accrual` counts every posted entry as posted.
 *
 * `cash` restates the ledger so income and expense land when money moves: an
 * invoice or a bill counts as it is paid, through the sub-ledger's payment
 * applications, and reversed accruals drop out. `./basis-lines` holds the rules.
 */
export type AccountingBasis = 'accrual' | 'cash';

export interface TrialBalanceRow {
  accountId: string;
  code: string;
  name: string;
  type: AccountType;
  /** Net debit for the account, or 0 when it nets to a credit. */
  debitCents: number;
  /** Net credit for the account, or 0 when it nets to a debit. */
  creditCents: number;
  /** Signed by the account's normal balance: positive means a normal balance. */
  balanceCents: number;
}

export interface TrialBalanceOptions {
  asOf?: CalendarDate;
  basis?: AccountingBasis;
}

export interface AccountActivityLine {
  lineId: string;
  lineNo: number;
  entryId: string;
  entryNo: number;
  date: CalendarDate;
  sourceType: string;
  entryMemo: string | null;
  memo: string | null;
  debitCents: number;
  creditCents: number;
  /** Running balance including this line, in the account's normal sign. */
  balanceCents: number;
  channelId: string | null;
  customerId: string | null;
  vendorId: string | null;
  productId: string | null;
}

export interface AccountActivity {
  accountId: string;
  code: string;
  name: string;
  type: AccountType;
  from: CalendarDate | null;
  to: CalendarDate | null;
  openingCents: number;
  closingCents: number;
  debitCents: number;
  creditCents: number;
  lines: AccountActivityLine[];
}

export interface BalanceFilter {
  from?: CalendarDate;
  to?: CalendarDate;
  channelId?: string;
  productId?: string;
  customerId?: string;
  vendorId?: string;
}

function toCents(value: unknown): number {
  const cents = typeof value === 'number' ? value : Number(value ?? 0);
  if (!Number.isSafeInteger(cents)) {
    throw new Error(`Ledger returned an amount that is not a whole number of cents: ${String(value)}`);
  }
  return cents;
}

function text(value: unknown): string {
  return String(value);
}

function nullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

interface TrialBalanceQueryRow extends Record<string, unknown> {
  account_id: string;
  code: string;
  name: string;
  type: string;
  debit_cents: string | number;
  credit_cents: string | number;
  sign: number;
}

/**
 * Every account with posted activity through `asOf`, netted the way a trial
 * balance reads: one column per account, and the two columns agree in total.
 */
export async function trialBalance(
  options: TrialBalanceOptions = {},
  exec: LedgerDb = db,
): Promise<TrialBalanceRow[]> {
  const asOf = options.asOf ?? today();
  const basis = options.basis ?? 'accrual';

  const rows = await exec.execute<TrialBalanceQueryRow>(sql`
    select a.id            as account_id,
           a.code          as code,
           a.name          as name,
           a.type::text    as type,
           account_sign(a.type) as sign,
           coalesce(sum(l.debit_cents), 0)  as debit_cents,
           coalesce(sum(l.credit_cents), 0) as credit_cents
      from ${basisLinesSql(basis)} l
      join journal_entries e on e.id = l.entry_id
      join accounts a on a.id = l.account_id
     where e.status = 'posted'
       and e.entry_date <= ${asOf}
     group by a.id, a.code, a.name, a.type
     order by a.code
  `);

  return [...rows].map((row) => {
    const net = toCents(row.debit_cents) - toCents(row.credit_cents);
    return {
      accountId: text(row.account_id),
      code: text(row.code),
      name: text(row.name),
      type: row.type as AccountType,
      debitCents: net > 0 ? net : 0,
      creditCents: net < 0 ? -net : 0,
      // `net === 0` short-circuits the multiply: -1 * 0 is negative zero, which
      // then fails every identity comparison a caller makes against 0.
      balanceCents: net === 0 ? 0 : Number(row.sign) * net,
    };
  });
}

/** Column totals, which are equal in a ledger that balances. */
export function trialBalanceTotals(rows: readonly TrialBalanceRow[]): {
  debitCents: number;
  creditCents: number;
} {
  let debitCents = 0;
  let creditCents = 0;
  for (const row of rows) {
    debitCents += row.debitCents;
    creditCents += row.creditCents;
  }
  return { debitCents, creditCents };
}

interface ActivityQueryRow extends Record<string, unknown> {
  code: string;
  name: string;
  type: string;
  opening_cents: string | number;
  line_id: string | null;
  line_no: number | null;
  entry_id: string | null;
  entry_no: string | number | null;
  entry_date: string | null;
  source_type: string | null;
  entry_memo: string | null;
  line_memo: string | null;
  debit_cents: string | number | null;
  credit_cents: string | number | null;
  balance_cents: string | number | null;
  channel_id: string | null;
  customer_id: string | null;
  vendor_id: string | null;
  product_id: string | null;
}

/**
 * An account register: the balance carried into `from`, every posted line in the
 * window with a running balance, and the balance carried out.
 *
 * The opening balance, the lines and the running total come back in one query —
 * the account row is cross joined to its opening balance and left joined to the
 * lines, so an account with no activity in the window still reports its opening
 * and closing figures.
 */
export async function accountActivity(
  params: { accountId: string; from?: CalendarDate; to?: CalendarDate },
  exec: LedgerDb = db,
): Promise<AccountActivity> {
  const { accountId, from, to } = params;

  const rows = await exec.execute<ActivityQueryRow>(sql`
    with target as (
      select id, code, name, type from accounts where id = ${accountId}
    ),
    opening as (
      select coalesce(sum(l.debit_cents - l.credit_cents), 0) as delta
        from journal_lines l
        join journal_entries e on e.id = l.entry_id
       where l.account_id = ${accountId}
         and e.status = 'posted'
         ${from === undefined ? sql`and false` : sql`and e.entry_date < ${from}`}
    ),
    activity as (
      select l.id as line_id, l.line_no, e.id as entry_id, e.entry_no, e.entry_date,
             e.source_type, e.memo as entry_memo, l.memo as line_memo,
             l.debit_cents, l.credit_cents,
             l.channel_id, l.customer_id, l.vendor_id, l.product_id,
             sum(l.debit_cents - l.credit_cents) over (
               order by e.entry_date, e.entry_no, l.line_no
               rows between unbounded preceding and current row
             ) as running
        from journal_lines l
        join journal_entries e on e.id = l.entry_id
       where l.account_id = ${accountId}
         and e.status = 'posted'
         ${from === undefined ? sql`` : sql`and e.entry_date >= ${from}`}
         ${to === undefined ? sql`` : sql`and e.entry_date <= ${to}`}
    )
    select t.code, t.name, t.type::text as type,
           account_sign(t.type) * o.delta as opening_cents,
           a.line_id, a.line_no, a.entry_id, a.entry_no, a.entry_date::text as entry_date,
           a.source_type, a.entry_memo, a.line_memo,
           a.debit_cents, a.credit_cents,
           account_sign(t.type) * (o.delta + a.running) as balance_cents,
           a.channel_id, a.customer_id, a.vendor_id, a.product_id
      from target t
      cross join opening o
      left join activity a on true
     order by a.entry_date, a.entry_no, a.line_no
  `);

  const list = [...rows];
  if (list.length === 0) throw new UnknownAccountError({ accountId }, 'missing');

  const head = list[0];
  const openingCents = toCents(head.opening_cents);

  const lines: AccountActivityLine[] = [];
  let debitCents = 0;
  let creditCents = 0;
  for (const row of list) {
    if (row.line_id === null) continue;
    const debit = toCents(row.debit_cents);
    const credit = toCents(row.credit_cents);
    debitCents += debit;
    creditCents += credit;
    lines.push({
      lineId: text(row.line_id),
      lineNo: Number(row.line_no),
      entryId: text(row.entry_id),
      entryNo: Number(row.entry_no),
      date: text(row.entry_date),
      sourceType: text(row.source_type),
      entryMemo: nullableText(row.entry_memo),
      memo: nullableText(row.line_memo),
      debitCents: debit,
      creditCents: credit,
      balanceCents: toCents(row.balance_cents),
      channelId: nullableText(row.channel_id),
      customerId: nullableText(row.customer_id),
      vendorId: nullableText(row.vendor_id),
      productId: nullableText(row.product_id),
    });
  }

  return {
    accountId,
    code: text(head.code),
    name: text(head.name),
    type: head.type as AccountType,
    from: from ?? null,
    to: to ?? null,
    openingCents,
    closingCents: lines.length === 0 ? openingCents : lines[lines.length - 1].balanceCents,
    debitCents,
    creditCents,
    lines,
  };
}

interface BalanceQueryRow extends Record<string, unknown> {
  account_id: string;
  balance_cents: string | number;
}

/**
 * Signed balances per account for a window, optionally narrowed to one channel,
 * product, customer or vendor. Positive means the account's normal balance.
 * This is what the channel P&L, the product margin report and the customer
 * statement all read.
 */
export async function balancesByAccount(
  filter: BalanceFilter = {},
  exec: LedgerDb = db,
): Promise<Map<string, number>> {
  const { from, to, channelId, productId, customerId, vendorId } = filter;

  const rows = await exec.execute<BalanceQueryRow>(sql`
    select l.account_id as account_id,
           account_sign(a.type) *
             (coalesce(sum(l.debit_cents), 0) - coalesce(sum(l.credit_cents), 0)) as balance_cents
      from journal_lines l
      join journal_entries e on e.id = l.entry_id
      join accounts a on a.id = l.account_id
     where e.status = 'posted'
       ${from === undefined ? sql`` : sql`and e.entry_date >= ${from}`}
       ${to === undefined ? sql`` : sql`and e.entry_date <= ${to}`}
       ${channelId === undefined ? sql`` : sql`and l.channel_id = ${channelId}`}
       ${productId === undefined ? sql`` : sql`and l.product_id = ${productId}`}
       ${customerId === undefined ? sql`` : sql`and l.customer_id = ${customerId}`}
       ${vendorId === undefined ? sql`` : sql`and l.vendor_id = ${vendorId}`}
     group by l.account_id, a.type
  `);

  const balances = new Map<string, number>();
  for (const row of rows) {
    balances.set(text(row.account_id), toCents(row.balance_cents));
  }
  return balances;
}

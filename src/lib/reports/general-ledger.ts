/**
 * The general ledger: every posted line on an account, in order, with the
 * balance running through it.
 *
 * This is where every other report ends up. A figure on a P&L is only as
 * trustworthy as the drill-down behind it, so the register carries the opening
 * balance, each line with its entry number, source and memo, the accounts on the
 * other side of that entry, and the closing balance — which is what makes a
 * number on a statement something a bookkeeper can actually check.
 *
 * All of it comes back in one query. A register that asked the database once per
 * account would issue a hundred round trips to render a month.
 */

import { type SQL, sql } from 'drizzle-orm';

import { db } from '@/db/client';
import { type CalendarDate, today } from '@/lib/dates';
import type { LedgerDb } from '@/lib/ledger/post';

import { basisStrategy, channelFilterSql, sourceFilterSql } from './basis';
import {
  type ColumnDef,
  type Report,
  type ReportRequest,
  type ReportRow,
  type SearchParams,
  formatWindow,
  parseReportRequest,
  row,
} from './types';

/** Beyond this the page stops being a register and starts being an export. */
const DEFAULT_LINE_LIMIT = 5_000;

/** How many of an entry's other accounts are named before the rest are counted. */
const COUNTER_ACCOUNTS_SHOWN = 3;

export interface GeneralLedgerRequest extends ReportRequest {
  /** Restrict to these accounts. */
  accountIds?: readonly string[];
  /**
   * Inclusive account-code range. Codes are compared as text, which orders the
   * fixed-width numeric codes this chart uses exactly as a reader expects.
   */
  codeFrom?: string;
  codeTo?: string;
  /** Restrict to entries raised by these sources, e.g. `['bank', 'manual']`. */
  sourceTypes?: readonly string[];
  limit?: number;
}

function first(params: SearchParams, key: string): string | undefined {
  const value = params[key];
  const single = Array.isArray(value) ? value[0] : value;
  return single === undefined || single === '' ? undefined : single;
}

function list(params: SearchParams, key: string): string[] | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  const items = (Array.isArray(value) ? value : [value]).flatMap((item) => item.split(','));
  const cleaned = items.filter((item) => item !== '');
  return cleaned.length > 0 ? cleaned : undefined;
}

/**
 * Reads the register's own filters out of a URL, on top of the shared report
 * request. The account parameter is named `account` because that is what every
 * drill-down link in the product builds.
 */
export function parseGeneralLedgerRequest(params: SearchParams): GeneralLedgerRequest {
  return {
    ...parseReportRequest(params),
    accountIds: list(params, 'account'),
    codeFrom: first(params, 'code_from'),
    codeTo: first(params, 'code_to'),
    sourceTypes: list(params, 'source'),
  };
}

export interface GeneralLedgerLine {
  lineId: string;
  entryId: string;
  entryNo: number;
  date: CalendarDate;
  sourceType: string;
  memo: string | null;
  counterAccounts: string[];
  debitCents: number;
  creditCents: number;
  /** Running balance through this line, in the account's normal sign. */
  balanceCents: number;
}

export interface GeneralLedgerAccount {
  accountId: string;
  code: string;
  name: string;
  openingCents: number;
  closingCents: number;
  debitCents: number;
  creditCents: number;
  lineCount: number;
  /** True when the register hit the line limit before this account's lines ran out. */
  truncated: boolean;
  lines: GeneralLedgerLine[];
}

export interface GeneralLedgerData {
  accounts: GeneralLedgerAccount[];
  debitTotalCents: number;
  creditTotalCents: number;
  truncated: boolean;
}

interface LedgerQueryRow extends Record<string, unknown> {
  account_id: string;
  code: string;
  name: string;
  opening_cents: string | number;
  closing_cents: string | number;
  total_debit_cents: string | number | null;
  total_credit_cents: string | number | null;
  total_line_count: string | number | null;
  line_id: string | null;
  entry_id: string | null;
  entry_no: string | number | null;
  entry_date: string | null;
  source_type: string | null;
  entry_memo: string | null;
  line_memo: string | null;
  debit_cents: string | number | null;
  credit_cents: string | number | null;
  balance_cents: string | number | null;
  counter_accounts: string[] | null;
}

function toCents(value: unknown): number {
  const cents = typeof value === 'number' ? value : Number(value ?? 0);
  if (!Number.isSafeInteger(cents)) {
    throw new Error(`Ledger returned an amount that is not a whole number of cents: ${String(value)}`);
  }
  return cents;
}

function accountScopeSql(request: GeneralLedgerRequest): SQL {
  const clauses: SQL[] = [];
  if (request.accountIds !== undefined && request.accountIds.length > 0) {
    clauses.push(
      sql`and a.id in (${sql.join(
        request.accountIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})`,
    );
  }
  if (request.codeFrom !== undefined && request.codeFrom !== '') {
    clauses.push(sql`and a.code >= ${request.codeFrom}`);
  }
  if (request.codeTo !== undefined && request.codeTo !== '') {
    clauses.push(sql`and a.code <= ${request.codeTo}`);
  }
  return clauses.length === 0 ? sql`` : sql.join(clauses, sql` `);
}

export async function generalLedgerData(
  request: GeneralLedgerRequest,
  exec: LedgerDb = db,
): Promise<GeneralLedgerData> {
  const limit = request.limit ?? DEFAULT_LINE_LIMIT;
  const lines = basisStrategy(request.basis).lines();
  const channel = channelFilterSql(request.channelIds);
  const source = sourceFilterSql(request.sourceTypes);

  const rows = await exec.execute<LedgerQueryRow>(sql`
    with scope as (
      select a.id, a.code, a.name, a.type
        from accounts a
       where true
       ${accountScopeSql(request)}
    ),
    opening as (
      select l.account_id as account_id,
             coalesce(sum(l.debit_cents - l.credit_cents), 0) as delta
        from ${lines} l
        join journal_entries e on e.id = l.entry_id
       where e.status = 'posted'
         and e.entry_date < ${request.from}
         and l.account_id in (select id from scope)
         ${channel}
         ${source}
       group by l.account_id
    ),
    movement as (
      select s.code as account_code,
             l.account_id as account_id,
             l.line_key as line_id,
             l.line_no as line_no,
             e.id as entry_id,
             e.entry_no as entry_no,
             e.entry_date as entry_date,
             e.source_type as source_type,
             e.memo as entry_memo,
             l.memo as line_memo,
             l.debit_cents as debit_cents,
             l.credit_cents as credit_cents,
             sum(l.debit_cents - l.credit_cents) over (
               partition by l.account_id
               order by e.entry_date, e.entry_no, l.line_no
               rows between unbounded preceding and current row
             ) as running
        from ${lines} l
        join journal_entries e on e.id = l.entry_id
        join scope s on s.id = l.account_id
       where e.status = 'posted'
         and e.entry_date >= ${request.from}
         and e.entry_date <= ${request.to}
         ${channel}
         ${source}
    ),
    totals as (
      select account_id,
             sum(debit_cents) as total_debit_cents,
             sum(credit_cents) as total_credit_cents,
             sum(debit_cents - credit_cents) as delta,
             count(*) as total_line_count
        from movement
       group by account_id
    ),
    page as (
      select *
        from movement
       order by account_code, entry_date, entry_no, line_no
       limit ${limit}
    )
    select s.id as account_id,
           s.code as code,
           s.name as name,
           account_sign(s.type) * coalesce(o.delta, 0) as opening_cents,
           account_sign(s.type) * (coalesce(o.delta, 0) + coalesce(t.delta, 0)) as closing_cents,
           t.total_debit_cents,
           t.total_credit_cents,
           t.total_line_count,
           p.line_id,
           p.entry_id,
           p.entry_no,
           p.entry_date::text as entry_date,
           p.source_type,
           p.entry_memo,
           p.line_memo,
           p.debit_cents,
           p.credit_cents,
           account_sign(s.type) * (coalesce(o.delta, 0) + p.running) as balance_cents,
           -- Named for the lines that are actually shown, not for every line in
           -- the window: on a wide range that is the difference between one
           -- lookup per printed row and one per row in the ledger. Read from the
           -- entry as posted, on either basis: they say what the entry was.
           (
             select array_agg(distinct ca.code || ' ' || ca.name)
               from journal_lines ol
               join accounts ca on ca.id = ol.account_id
              where ol.entry_id = p.entry_id
                and ol.account_id <> p.account_id
           ) as counter_accounts
      from scope s
      left join opening o on o.account_id = s.id
      left join totals t on t.account_id = s.id
      left join page p on p.account_id = s.id
     order by s.code, p.entry_date, p.entry_no, p.line_no
  `);

  const byAccount = new Map<string, GeneralLedgerAccount>();
  const order: string[] = [];

  for (const queryRow of rows) {
    const accountId = String(queryRow.account_id);
    let account = byAccount.get(accountId);
    if (account === undefined) {
      account = {
        accountId,
        code: String(queryRow.code),
        name: String(queryRow.name),
        openingCents: toCents(queryRow.opening_cents),
        // Computed from every line in the window rather than from the lines that
        // fit on the page, so a truncated register still reconciles.
        closingCents: toCents(queryRow.closing_cents),
        debitCents: toCents(queryRow.total_debit_cents ?? 0),
        creditCents: toCents(queryRow.total_credit_cents ?? 0),
        lineCount: Number(queryRow.total_line_count ?? 0),
        truncated: false,
        lines: [],
      };
      byAccount.set(accountId, account);
      order.push(accountId);
    }

    if (queryRow.line_id === null) continue;
    account.lines.push({
      lineId: String(queryRow.line_id),
      entryId: String(queryRow.entry_id),
      entryNo: Number(queryRow.entry_no),
      date: String(queryRow.entry_date),
      sourceType: String(queryRow.source_type),
      memo: queryRow.line_memo ?? queryRow.entry_memo,
      counterAccounts: queryRow.counter_accounts ?? [],
      debitCents: toCents(queryRow.debit_cents),
      creditCents: toCents(queryRow.credit_cents),
      balanceCents: toCents(queryRow.balance_cents),
    });
  }

  let debitTotalCents = 0;
  let creditTotalCents = 0;
  let truncated = false;

  const accounts: GeneralLedgerAccount[] = [];
  for (const accountId of order) {
    const account = byAccount.get(accountId);
    if (account === undefined) continue;
    account.truncated = account.lines.length < account.lineCount;
    if (account.truncated) truncated = true;
    debitTotalCents += account.debitCents;
    creditTotalCents += account.creditCents;
    accounts.push(account);
  }

  return { accounts, debitTotalCents, creditTotalCents, truncated };
}

/* ------------------------------------------------------------------ report */

const COLUMNS: readonly ColumnDef[] = Object.freeze([
  { key: 'date', label: 'Date', kind: 'date', group: 'detail' },
  { key: 'entry', label: 'Entry', kind: 'text', group: 'detail' },
  { key: 'source', label: 'Source', kind: 'text', group: 'detail' },
  { key: 'memo', label: 'Memo', kind: 'text', group: 'detail' },
  { key: 'counter', label: 'Other accounts', kind: 'text', group: 'detail' },
  { key: 'debit', label: 'Debit', kind: 'amount', group: 'current' },
  { key: 'credit', label: 'Credit', kind: 'amount', group: 'current' },
  { key: 'balance', label: 'Balance', kind: 'amount', emphasis: true, group: 'current' },
]);

const WIDTH = COLUMNS.length;
const DEBIT_COLUMN = 5;
const CREDIT_COLUMN = 6;
const BALANCE_COLUMN = 7;
const DEBIT_CREDIT_COLUMNS = [DEBIT_COLUMN, CREDIT_COLUMN];

function cells(values: Partial<Record<number, string | null>>): (string | null)[] {
  return Array.from({ length: WIDTH }, (_, i) => values[i] ?? null);
}

function summariseCounterAccounts(names: readonly string[]): string {
  if (names.length <= COUNTER_ACCOUNTS_SHOWN) return names.join(', ');
  const shown = names.slice(0, COUNTER_ACCOUNTS_SHOWN).join(', ');
  return `${shown} +${names.length - COUNTER_ACCOUNTS_SHOWN} more`;
}

export async function generalLedgerReport(
  request: GeneralLedgerRequest,
  exec: LedgerDb = db,
): Promise<Report> {
  const strategy = basisStrategy(request.basis);
  const data = await generalLedgerData(request, exec);

  const rows: ReportRow[] = [];

  for (const account of data.accounts) {
    const empty = account.lines.length === 0 && account.openingCents === 0 && account.closingCents === 0;
    if (empty && !request.includeZeroRows) continue;

    rows.push(
      row({
        id: `gl:${account.code}`,
        accountId: account.accountId,
        code: account.code,
        label: account.name,
        level: 0,
        values: new Array<number>(WIDTH).fill(0),
        cells: cells({}),
        style: 'section',
      }),
    );

    const opening = new Array<number>(WIDTH).fill(0);
    opening[BALANCE_COLUMN] = account.openingCents;
    rows.push(
      row({
        id: `gl:${account.code}:opening`,
        label: 'Opening balance',
        level: 1,
        values: opening,
        cells: cells({ 0: request.from }),
        style: 'detail',
        blankColumns: DEBIT_CREDIT_COLUMNS,
      }),
    );

    for (const line of account.lines) {
      const values = new Array<number>(WIDTH).fill(0);
      values[DEBIT_COLUMN] = line.debitCents;
      values[CREDIT_COLUMN] = line.creditCents;
      values[BALANCE_COLUMN] = line.balanceCents;
      rows.push(
        row({
          id: `gl:${account.code}:${line.lineId}`,
          accountId: account.accountId,
          code: account.code,
          // The memo has its own column; repeating it in the label column would
          // print every line twice.
          label: '',
          level: 1,
          values,
          cells: cells({
            0: line.date,
            1: String(line.entryNo),
            2: line.sourceType,
            3: line.memo ?? '',
            4: summariseCounterAccounts(line.counterAccounts),
          }),
          style: 'detail',
        }),
      );
    }

    if (account.truncated) {
      rows.push(
        row({
          id: `gl:${account.code}:truncated`,
          label: `${account.lineCount - account.lines.length} more lines not shown`,
          level: 1,
          values: new Array<number>(WIDTH).fill(0),
          cells: cells({ 3: 'Narrow the date range or export the register in full.' }),
          style: 'note',
          blankColumns: [DEBIT_COLUMN, CREDIT_COLUMN, BALANCE_COLUMN],
        }),
      );
    }

    const closing = new Array<number>(WIDTH).fill(0);
    closing[DEBIT_COLUMN] = account.debitCents;
    closing[CREDIT_COLUMN] = account.creditCents;
    closing[BALANCE_COLUMN] = account.closingCents;
    rows.push(
      row({
        id: `gl:${account.code}:closing`,
        label: 'Closing balance',
        level: 1,
        values: closing,
        cells: cells({ 0: request.to }),
        style: 'subtotal',
      }),
    );
  }

  const grand = new Array<number>(WIDTH).fill(0);
  grand[DEBIT_COLUMN] = data.debitTotalCents;
  grand[CREDIT_COLUMN] = data.creditTotalCents;
  rows.push(
    row({
      id: 'gl:total',
      label: 'Total movement',
      level: 0,
      values: grand,
      cells: cells({}),
      style: 'total',
      // Balances from different accounts do not add up to anything.
      blankColumns: [BALANCE_COLUMN],
    }),
  );

  const warnings = [...strategy.caveats];
  if (data.truncated) {
    warnings.push(
      `The register was cut at ${request.limit ?? DEFAULT_LINE_LIMIT} lines. Closing balances are still complete; the missing lines are in the middle of the range.`,
    );
  }

  return {
    columns: [...COLUMNS],
    rows,
    meta: {
      title: 'General Ledger',
      subtitle: formatWindow(request.from, request.to),
      from: request.from,
      to: request.to,
      basis: request.basis,
      columns: 'total',
      generatedAt: today(),
      warnings,
    },
  };
}

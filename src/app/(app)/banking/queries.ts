/**
 * The reads behind the banking screens that the engine's queue module does not already
 * answer: the account tabs with their balances, the lines of posted entries, the rule list,
 * recent imports, reconciliation history. One statement each, aggregated in Postgres.
 *
 * Nothing here writes. Mutations live in `./actions`.
 */

import { sql } from 'drizzle-orm';

import { db } from '@/db/client';
import { BOOKS_TIME_ZONE } from '@/lib/dates';
import { type RuleCondition, parseRuleConditions } from '@/lib/banking/rules';

import type {
  BankAccountTab,
  EntrySummary,
  RecentImport,
  ReconHistoryRow,
  RuleDirection,
  RuleRow,
  VendorOption,
} from '@/components/banking/types';

function cents(value: unknown): number {
  if (value === null || value === undefined) return 0;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(n)) throw new Error(`Expected whole cents from the database, got ${String(value)}`);
  return n;
}

function centsOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : cents(value);
}

const STAMP = new Intl.DateTimeFormat('en-US', {
  timeZone: BOOKS_TIME_ZONE,
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

function stamp(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : STAMP.format(date);
}

/** A bank account's short label: "••9726 Operating Expenses". */
export function bankLabel(name: string, mask: string | null): string {
  const bare = name.replace(/^Relay\s+—\s+/, '').replace(/^••\d{4}$/, '').trim();
  return [mask === null ? null : `••${mask}`, bare === '' ? null : bare].filter(Boolean).join(' ');
}

export async function bankAccountTabs(): Promise<BankAccountTab[]> {
  const rows = await db.execute<{
    id: string;
    name: string;
    mask: string | null;
    kind: string;
    account_id: string;
    gl_code: string;
    review: number;
    ready: number;
    posted: number;
    excluded: number;
    statement_balance: string | null;
    statement_date: string | null;
    ledger_balance: string | null;
    opening_balance_cents: string;
    opening_date: string | null;
  }>(sql`
    select ba.id, ba.name, ba.mask, ba.kind::text, ba.account_id, a.code as gl_code,
           ba.opening_balance_cents::text, ba.opening_date::text,
           count(bt.id) filter (where bt.journal_entry_id is null and bt.status not in ('excluded', 'categorized', 'matched'))::int as review,
           count(bt.id) filter (where bt.journal_entry_id is null and bt.status in ('categorized', 'matched'))::int as ready,
           count(bt.id) filter (where bt.journal_entry_id is not null)::int as posted,
           count(bt.id) filter (where bt.journal_entry_id is null and bt.status = 'excluded')::int as excluded,
           last.balance_cents::text as statement_balance, last.txn_date::text as statement_date,
           (select coalesce(sum(jl.debit_cents - jl.credit_cents), 0)
              from journal_lines jl
              join journal_entries je on je.id = jl.entry_id and je.status = 'posted'
             where jl.account_id = ba.account_id)::text as ledger_balance
      from bank_accounts ba
      join accounts a on a.id = ba.account_id
      left join bank_transactions bt on bt.bank_account_id = ba.id
      left join lateral (
        select t.balance_cents, t.txn_date, t.created_at
          from bank_transactions t
         where t.bank_account_id = ba.id and t.balance_cents is not null
         order by t.txn_date desc, t.created_at desc
         limit 1
      ) last on true
     where ba.active
     group by ba.id, a.code, last.balance_cents, last.txn_date, last.created_at
     order by count(bt.id) desc, ba.mask`);

  return rows.map((row) => ({
    id: row.id,
    name: bankLabel(row.name, row.mask),
    mask: row.mask,
    kind: row.kind,
    glAccountId: row.account_id,
    glCode: row.gl_code,
    counts: { review: row.review, ready: row.ready, posted: row.posted, excluded: row.excluded },
    statementBalanceCents: centsOrNull(row.statement_balance),
    statementBalanceDate: row.statement_date,
    ledgerBalanceCents: cents(row.ledger_balance),
    openingBalanceCents: cents(row.opening_balance_cents),
    openingDate: row.opening_date,
  }));
}

/** The posted entries behind a page of bank rows, with their lines, keyed by entry id. */
export async function entrySummaries(entryIds: readonly string[]): Promise<Record<string, EntrySummary>> {
  const ids = [...new Set(entryIds)];
  if (ids.length === 0) return {};
  const rows = await db.execute<{
    entry_id: string;
    entry_no: string;
    entry_date: string;
    memo: string | null;
    source_type: string;
    line_id: string;
    line_no: number;
    code: string;
    name: string;
    line_memo: string | null;
    debit_cents: string;
    credit_cents: string;
  }>(sql`
    select je.id as entry_id, je.entry_no::text, je.entry_date::text, je.memo, je.source_type,
           jl.id as line_id, jl.line_no, a.code, a.name, jl.memo as line_memo,
           jl.debit_cents::text, jl.credit_cents::text
      from journal_entries je
      join journal_lines jl on jl.entry_id = je.id
      join accounts a on a.id = jl.account_id
     where je.id in (${sql.join(
       ids.map((id) => sql`${id}::uuid`),
       sql`, `,
     )})
     order by je.id, jl.line_no`);

  const out: Record<string, EntrySummary> = {};
  for (const row of rows) {
    const entry = (out[row.entry_id] ??= {
      id: row.entry_id,
      entryNo: cents(row.entry_no),
      date: row.entry_date,
      memo: row.memo,
      sourceType: row.source_type,
      lines: [],
    });
    entry.lines.push({
      id: row.line_id,
      lineNo: row.line_no,
      accountCode: row.code,
      accountName: row.name,
      memo: row.line_memo,
      debitCents: cents(row.debit_cents),
      creditCents: cents(row.credit_cents),
    });
  }
  return out;
}

export async function vendorOptions(): Promise<VendorOption[]> {
  const rows = await db.execute<{ id: string; name: string }>(sql`
    select id, coalesce(display_name, name) as name from vendors where active order by lower(coalesce(display_name, name))`);
  return rows.map((row) => ({ id: row.id, name: row.name }));
}

export async function ruleRows(): Promise<RuleRow[]> {
  const rows = await db.execute<{
    id: string;
    name: string;
    priority: number;
    bank_account_id: string | null;
    bank_name: string | null;
    bank_mask: string | null;
    conditions: unknown;
    direction: string;
    amount_min_cents: string | null;
    amount_max_cents: string | null;
    account_id: string | null;
    account_code: string | null;
    account_name: string | null;
    vendor_id: string | null;
    vendor_name: string | null;
    memo_template: string | null;
    auto_post: boolean;
    active: boolean;
    hit_count: number;
    last_hit_at: string | null;
    current_matches: number;
  }>(sql`
    select r.id, r.name, r.priority, r.bank_account_id, ba.name as bank_name, ba.mask as bank_mask,
           r.conditions, r.direction, r.amount_min_cents::text, r.amount_max_cents::text,
           r.account_id, a.code as account_code, a.name as account_name,
           r.vendor_id, coalesce(v.display_name, v.name) as vendor_name, r.memo_template,
           r.auto_post, r.active, r.hit_count, r.last_hit_at::text,
           (select count(*) from bank_transactions bt where bt.rule_id = r.id)::int as current_matches
      from categorization_rules r
      left join bank_accounts ba on ba.id = r.bank_account_id
      left join accounts a on a.id = r.account_id
      left join vendors v on v.id = r.vendor_id
     order by r.active desc, r.priority, r.name, r.id`);

  return rows.map((row) => {
    const parsed = parseRuleConditions(row.conditions);
    const direction: RuleDirection = row.direction === 'in' || row.direction === 'out' ? row.direction : 'any';
    const conditions: RuleCondition[] = parsed.conditions.map((c) => ({ field: c.field, op: c.op, value: c.value }));
    return {
      id: row.id,
      name: row.name,
      priority: row.priority,
      bankAccountId: row.bank_account_id,
      bankAccountLabel: row.bank_name === null ? null : bankLabel(row.bank_name, row.bank_mask),
      conditions,
      direction,
      amountMinCents: centsOrNull(row.amount_min_cents),
      amountMaxCents: centsOrNull(row.amount_max_cents),
      accountId: row.account_id,
      accountCode: row.account_code,
      accountName: row.account_name,
      vendorId: row.vendor_id,
      vendorName: row.vendor_name,
      memoTemplate: row.memo_template,
      autoPost: row.auto_post,
      active: row.active,
      hitCount: row.hit_count,
      lastHit: stamp(row.last_hit_at),
      currentMatches: row.current_matches,
    };
  });
}

export async function recentImports(limit = 12): Promise<RecentImport[]> {
  const rows = await db.execute<{
    id: string;
    filename: string;
    name: string;
    mask: string | null;
    status: string;
    imported_count: number;
    duplicate_count: number;
    created_at: string;
  }>(sql`
    select ib.id, ib.filename, ba.name, ba.mask, ib.status::text, ib.imported_count, ib.duplicate_count,
           ib.created_at::text
      from import_batches ib
      join bank_accounts ba on ba.id = ib.bank_account_id
     where ib.status = 'imported'
     order by ib.created_at desc
     limit ${limit}`);
  return rows.map((row) => ({
    id: row.id,
    filename: row.filename,
    bankLabel: bankLabel(row.name, row.mask),
    status: row.status,
    importedCount: row.imported_count,
    duplicateCount: row.duplicate_count,
    createdAt: stamp(row.created_at) ?? '',
  }));
}

export async function reconciliationHistory(bankAccountId: string): Promise<ReconHistoryRow[]> {
  const rows = await db.execute<{
    id: string;
    status: 'in_progress' | 'completed' | 'abandoned';
    statement_start_date: string;
    statement_date: string;
    closing_balance_cents: string;
    completed_at: string | null;
    completed_by: string | null;
  }>(sql`
    select r.id, r.status::text as status, r.statement_start_date::text, r.statement_date::text,
           r.closing_balance_cents::text, r.completed_at::text,
           coalesce(u.full_name, u.email) as completed_by
      from reconciliations r
      left join app_users u on u.id = r.completed_by
     where r.bank_account_id = ${bankAccountId}::uuid
       and r.status <> 'abandoned'
     order by r.statement_date desc, r.created_at desc`);
  const latestCompleted = rows.find((row) => row.status === 'completed')?.id ?? null;
  const anyInProgress = rows.some((row) => row.status === 'in_progress');
  return rows.map((row) => ({
    id: row.id,
    status: row.status,
    statementStartDate: row.statement_start_date,
    statementDate: row.statement_date,
    closingBalanceCents: cents(row.closing_balance_cents),
    completedAt: stamp(row.completed_at),
    completedBy: row.completed_by,
    undoable: row.id === latestCompleted && !anyInProgress,
  }));
}

/** The months a bank account has rows in, newest first, as `YYYY-MM`. */
export async function statementMonths(bankAccountId: string): Promise<string[]> {
  const rows = await db.execute<{ month: string }>(sql`
    select distinct to_char(txn_date, 'YYYY-MM') as month
      from bank_transactions
     where bank_account_id = ${bankAccountId}::uuid
     order by 1 desc`);
  return rows.map((row) => row.month);
}

/** Posted lines on a bank's GL account dated inside a range: what a reconciliation can clear. */
export async function postedLineCount(glAccountId: string, from: string, to: string): Promise<number> {
  const [row] = await db.execute<{ n: number }>(sql`
    select count(*)::int as n
      from journal_lines jl
      join journal_entries je on je.id = jl.entry_id and je.status = 'posted'
     where jl.account_id = ${glAccountId}::uuid
       and je.entry_date between ${from}::date and ${to}::date`);
  return row?.n ?? 0;
}

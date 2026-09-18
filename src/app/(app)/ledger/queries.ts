/**
 * The reads behind the ledger screens.
 *
 * Kept together rather than spread across the pages because the journal, the
 * chart of accounts, the close screen and the dashboard ask overlapping
 * questions of the same three tables, and because every one of these is an
 * aggregation that belongs in Postgres: a page that walks accounts in
 * JavaScript becomes a thousand queries the first time the ledger gets real
 * volume.
 *
 * Nothing here writes. Mutations live in `./actions`.
 */

import { asc, eq, inArray, sql } from 'drizzle-orm';

import { db } from '@/db/client';
import {
  accounts,
  appUsers,
  channels,
  journalEntries,
  journalLines,
  products,
  type AccountType,
} from '@/db/schema';
import { BOOKS_TIME_ZONE, monthEnd, monthStart, periodOf, today, type CalendarDate } from '@/lib/dates';
import { balancesByAccount } from '@/lib/ledger/balances';
import { listPeriods } from '@/lib/ledger/periods';
import { SOURCE_TYPES } from '@/lib/ledger/post';
import { parseMoney } from '@/lib/money';
import type {
  AccountOption,
  AccountTreeRow,
  ActorOption,
  AuditEntryRow,
  AuditFilters,
  ChannelOption,
  EntryDetailRow,
  JournalFilters,
  JournalLineRow,
  JournalRow,
  PeriodRow,
  ProductOption,
} from '@/components/ledger/types';
import type { NetIncomePoint } from '@/components/ledger/net-income-chart';

export const JOURNAL_PAGE_SIZE = 50;
export const AUDIT_PAGE_SIZE = 40;

/** `sum(bigint)` widens to numeric, which postgres.js hands back as a string. */
function cents(value: unknown): number {
  if (value === null || value === undefined) return 0;
  const amount = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(amount)) {
    throw new Error(`Ledger returned an amount that is not a whole number of cents: ${String(value)}`);
  }
  return amount;
}

function count(value: unknown): number {
  return value === null || value === undefined ? 0 : Number(value);
}

const MAX_PERIOD_MONTHS = 36;

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function toDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value;
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

const STAMP_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: BOOKS_TIME_ZONE,
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  hourCycle: 'h23',
  calendar: 'gregory',
  numberingSystem: 'latn',
});

/**
 * A timestamp as the interface shows it. Formatted here, on the server, because
 * a client component renders on both sides of hydration and the two clocks sit
 * in different zones — and read on the books' calendar rather than the server's
 * own clock, which runs in UTC.
 */
function stamp(input: unknown): string | null {
  const value = toDate(input);
  if (value === null) return null;
  const parts = new Map(STAMP_FORMAT.formatToParts(value).map((part) => [part.type, part.value]));
  const month = MONTH_ABBR[Number(parts.get('month')) - 1];
  const day = (parts.get('day') ?? '').padStart(2, '0');
  const hours = (parts.get('hour') ?? '').padStart(2, '0');
  const minutes = (parts.get('minute') ?? '').padStart(2, '0');
  return `${day} ${month} ${parts.get('year') ?? ''}, ${hours}:${minutes}`;
}

function personLabel(fullName: string | null, email: string | null): string | null {
  if (fullName !== null && fullName !== '') return fullName;
  return email;
}

// ---------------------------------------------------------------------------
// Reference data
// ---------------------------------------------------------------------------

export async function accountOptions(): Promise<AccountOption[]> {
  const rows = await db
    .select({
      id: accounts.id,
      code: accounts.code,
      name: accounts.name,
      type: accounts.type,
      subtype: accounts.subtype,
      active: accounts.active,
      isControl: accounts.isControl,
      isBank: accounts.isBank,
      parentId: accounts.parentId,
    })
    .from(accounts)
    .orderBy(asc(accounts.code));

  // A rollup is a report header — it carries children and nothing posts to it.
  const parents = new Set(rows.map((row) => row.parentId).filter((id): id is string => id !== null));
  return rows.map((row) => ({ ...row, postable: !parents.has(row.id) }));
}

export async function channelOptions(): Promise<ChannelOption[]> {
  return db
    .select({ id: channels.id, code: channels.code, name: channels.name })
    .from(channels)
    .where(eq(channels.active, true))
    .orderBy(asc(channels.sortOrder), asc(channels.code));
}

export async function productOptions(): Promise<ProductOption[]> {
  return db
    .select({ id: products.id, sku: products.sku, name: products.name })
    .from(products)
    .where(eq(products.active, true))
    .orderBy(asc(products.sku));
}

/** Months already closed, as `YYYY-MM`. The entry form refuses to post into one. */
export async function closedPeriodKeys(): Promise<string[]> {
  const rows = await db.execute<{ period: string }>(sql`
    select to_char(make_date(year, month, 1), 'YYYY-MM') as period
      from periods
     where status = 'closed'
     order by 1
  `);
  return [...rows].map((row) => String(row.period));
}

// ---------------------------------------------------------------------------
// Journal register
// ---------------------------------------------------------------------------

export function readJournalFilters(params: URLSearchParams): JournalFilters {
  const value = (key: string): string => params.get(key) ?? '';
  const status = value('status');
  const sourceType = value('sourceType');
  return {
    from: value('from'),
    to: value('to'),
    status: status === 'draft' || status === 'posted' ? status : '',
    sourceType: (SOURCE_TYPES as readonly string[]).includes(sourceType) ? sourceType : '',
    accountId: value('accountId'),
    minAmount: value('minAmount'),
    maxAmount: value('maxAmount'),
    q: value('q'),
  };
}

/** A typed amount, or null when it is blank or unreadable. Never throws at a page. */
function amountFilter(text: string): number | null {
  if (text.trim() === '') return null;
  try {
    return Math.abs(parseMoney(text));
  } catch {
    return null;
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface JournalPage {
  rows: JournalRow[];
  lines: Record<string, JournalLineRow[]>;
  total: number;
  totalDebitCents: number;
}

interface JournalQueryRow extends Record<string, unknown> {
  id: string;
  entry_no: string | number;
  entry_date: string;
  memo: string | null;
  source_type: string;
  source_id: string | null;
  status: string;
  debit_cents: string | number;
  line_count: string | number;
  reverses_entry_no: string | number | null;
  reversed_by_entry_no: string | number | null;
}

export async function journalPage(
  filters: JournalFilters,
  page: number,
  pageSize = JOURNAL_PAGE_SIZE,
): Promise<JournalPage> {
  const from = ISO_DATE.test(filters.from) ? filters.from : null;
  const to = ISO_DATE.test(filters.to) ? filters.to : null;
  const accountId = UUID.test(filters.accountId) ? filters.accountId : null;
  const min = amountFilter(filters.minAmount);
  const max = amountFilter(filters.maxAmount);
  const q = filters.q.trim();

  const where = sql`
    where true
      ${from === null ? sql`` : sql`and e.entry_date >= ${from}`}
      ${to === null ? sql`` : sql`and e.entry_date <= ${to}`}
      ${filters.status === '' ? sql`` : sql`and e.status = ${filters.status}::je_status`}
      ${filters.sourceType === '' ? sql`` : sql`and e.source_type = ${filters.sourceType}`}
      ${q === '' ? sql`` : sql`and e.memo ilike ${`%${q}%`}`}
      ${
        accountId === null
          ? sql``
          : sql`and exists (
              select 1 from journal_lines la
               where la.entry_id = e.id and la.account_id = ${accountId}
            )`
      }
  `;

  const having = sql`
    ${min === null ? sql`` : sql`having coalesce(sum(l.debit_cents), 0) >= ${min}`}
    ${
      max === null
        ? sql``
        : min === null
          ? sql`having coalesce(sum(l.debit_cents), 0) <= ${max}`
          : sql`and coalesce(sum(l.debit_cents), 0) <= ${max}`
    }
  `;

  const matched = sql`
    select e.id,
           e.entry_no,
           e.entry_date::text as entry_date,
           e.memo,
           e.source_type,
           e.source_id,
           e.status::text as status,
           rev.entry_no   as reverses_entry_no,
           revby.entry_no as reversed_by_entry_no,
           coalesce(sum(l.debit_cents), 0) as debit_cents,
           count(l.id) as line_count
      from journal_entries e
      left join journal_lines l on l.entry_id = e.id
      left join journal_entries rev   on rev.id = e.reverses_id
      left join journal_entries revby on revby.id = e.reversed_by_id
      ${where}
     group by e.id, rev.entry_no, revby.entry_no
     ${having}
  `;

  const offset = Math.max(0, (page - 1) * pageSize);

  const [rowsResult, totalsResult] = await Promise.all([
    db.execute<JournalQueryRow>(sql`
      with matched as (${matched})
      select * from matched
       order by entry_date desc, entry_no desc
       limit ${pageSize} offset ${offset}
    `),
    db.execute<{ n: number; total: string | number }>(sql`
      with matched as (${matched})
      select count(*)::int as n, coalesce(sum(debit_cents), 0) as total from matched
    `),
  ]);

  const rows: JournalRow[] = [...rowsResult].map((row) => ({
    id: String(row.id),
    entryNo: Number(row.entry_no),
    date: String(row.entry_date),
    memo: row.memo,
    sourceType: String(row.source_type),
    sourceId: row.source_id,
    status: row.status === 'draft' ? 'draft' : 'posted',
    debitCents: cents(row.debit_cents),
    lineCount: count(row.line_count),
    reversesEntryNo: row.reverses_entry_no === null ? null : Number(row.reverses_entry_no),
    reversedByEntryNo: row.reversed_by_entry_no === null ? null : Number(row.reversed_by_entry_no),
  }));

  const totals = [...totalsResult][0];

  return {
    rows,
    lines: await linesForEntries(rows.map((row) => row.id)),
    total: count(totals?.n),
    totalDebitCents: cents(totals?.total),
  };
}

/** Every line of the entries on one page, so expanding a row costs no round trip. */
export async function linesForEntries(entryIds: readonly string[]): Promise<Record<string, JournalLineRow[]>> {
  if (entryIds.length === 0) return {};

  const rows = await db
    .select({
      id: journalLines.id,
      entryId: journalLines.entryId,
      lineNo: journalLines.lineNo,
      accountId: journalLines.accountId,
      accountCode: accounts.code,
      accountName: accounts.name,
      debitCents: journalLines.debitCents,
      creditCents: journalLines.creditCents,
      memo: journalLines.memo,
      channelId: journalLines.channelId,
      channelCode: channels.code,
      productId: journalLines.productId,
      productSku: products.sku,
    })
    .from(journalLines)
    .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
    .leftJoin(channels, eq(channels.id, journalLines.channelId))
    .leftJoin(products, eq(products.id, journalLines.productId))
    .where(inArray(journalLines.entryId, [...entryIds]))
    .orderBy(asc(journalLines.entryId), asc(journalLines.lineNo));

  const grouped: Record<string, JournalLineRow[]> = {};
  for (const row of rows) {
    (grouped[row.entryId] ??= []).push(row);
  }
  return grouped;
}

// ---------------------------------------------------------------------------
// One entry
// ---------------------------------------------------------------------------

export interface EntryDetailData {
  entry: EntryDetailRow;
  lines: JournalLineRow[];
  audit: AuditEntryRow[];
}

export async function entryDetail(entryId: string): Promise<EntryDetailData | null> {
  if (!UUID.test(entryId)) return null;

  const rows = await db.execute<Record<string, unknown>>(sql`
    select e.id,
           e.entry_no,
           e.entry_date::text as entry_date,
           e.memo,
           e.status::text as status,
           e.source_type,
           e.source_id,
           e.created_at,
           e.posted_at,
           e.reverses_id,
           e.reversed_by_id,
           rev.entry_no   as reverses_entry_no,
           revby.entry_no as reversed_by_entry_no,
           creator.full_name as created_by_name,
           creator.email     as created_by_email,
           poster.full_name  as posted_by_name,
           poster.email      as posted_by_email
      from journal_entries e
      left join journal_entries rev   on rev.id = e.reverses_id
      left join journal_entries revby on revby.id = e.reversed_by_id
      left join app_users creator on creator.id = e.created_by
      left join app_users poster  on poster.id = e.posted_by
     where e.id = ${entryId}
  `);

  const row = [...rows][0];
  if (row === undefined) return null;

  const entry: EntryDetailRow = {
    id: String(row.id),
    entryNo: Number(row.entry_no),
    date: String(row.entry_date),
    memo: (row.memo as string | null) ?? null,
    status: row.status === 'draft' ? 'draft' : 'posted',
    sourceType: String(row.source_type),
    sourceId: (row.source_id as string | null) ?? null,
    createdAtLabel: stamp(row.created_at) ?? '',
    createdByLabel: personLabel(
      (row.created_by_name as string | null) ?? null,
      (row.created_by_email as string | null) ?? null,
    ),
    postedAtLabel: stamp(row.posted_at),
    postedByLabel: personLabel(
      (row.posted_by_name as string | null) ?? null,
      (row.posted_by_email as string | null) ?? null,
    ),
    reversesId: (row.reverses_id as string | null) ?? null,
    reversesEntryNo: row.reverses_entry_no === null ? null : Number(row.reverses_entry_no),
    reversedById: (row.reversed_by_id as string | null) ?? null,
    reversedByEntryNo: row.reversed_by_entry_no === null ? null : Number(row.reversed_by_entry_no),
  };

  const [lines, audit] = await Promise.all([
    linesForEntries([entryId]),
    auditForEntry(entryId),
  ]);

  return { entry, lines: lines[entryId] ?? [], audit };
}

interface AuditQueryRow extends Record<string, unknown> {
  id: string | number;
  table_name: string;
  row_id: string;
  op: string;
  at: string | Date;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  actor_name: string | null;
  actor_email: string | null;
}

function toAuditRow(row: AuditQueryRow): AuditEntryRow {
  const op = row.op === 'INSERT' || row.op === 'DELETE' ? row.op : 'UPDATE';
  return {
    id: Number(row.id),
    op,
    tableName: String(row.table_name),
    rowId: String(row.row_id),
    atLabel: stamp(row.at) ?? '',
    actorLabel: personLabel(row.actor_name, row.actor_email),
    before: row.before,
    after: row.after,
  };
}

/**
 * Everything the trail holds about one entry, including its lines. Lines are
 * matched through the snapshot rather than through `journal_lines`, because a
 * line that was deleted from a draft is no longer in that table and its
 * deletion is exactly what the history is being read for.
 */
export async function auditForEntry(entryId: string): Promise<AuditEntryRow[]> {
  const rows = await db.execute<AuditQueryRow>(sql`
    select a.id, a.table_name, a.row_id, a.op, a.at, a.before, a.after,
           u.full_name as actor_name, u.email as actor_email
      from audit_log a
      left join app_users u on u.id = a.actor_id
     where (a.table_name = 'journal_entries' and a.row_id = ${entryId})
        or (a.table_name = 'journal_lines'
            and (a.before ->> 'entry_id' = ${entryId} or a.after ->> 'entry_id' = ${entryId}))
     order by a.id desc
     limit 200
  `);
  return [...rows].map(toAuditRow);
}

// ---------------------------------------------------------------------------
// Chart of accounts
// ---------------------------------------------------------------------------

export async function accountTreeRows(): Promise<AccountTreeRow[]> {
  const [rows, balances, postedCounts] = await Promise.all([
    db
      .select({
        id: accounts.id,
        code: accounts.code,
        name: accounts.name,
        type: accounts.type,
        subtype: accounts.subtype,
        active: accounts.active,
        isControl: accounts.isControl,
        isBank: accounts.isBank,
        parentId: accounts.parentId,
        description: accounts.description,
      })
      .from(accounts)
      .orderBy(asc(accounts.code)),
    balancesByAccount(),
    postedLineCounts(),
  ]);

  const parentIds = new Set(rows.map((row) => row.parentId).filter((id): id is string => id !== null));
  const byId = new Map(rows.map((row) => [row.id, row]));
  const codeById = new Map(rows.map((row) => [row.id, row.code]));

  type Row = (typeof rows)[number];
  const children = new Map<string | null, Row[]>();
  for (const row of rows) {
    // An account whose parent is missing becomes a root rather than vanishing.
    const parentId = row.parentId !== null && byId.has(row.parentId) ? row.parentId : null;
    const siblings = children.get(parentId);
    if (siblings === undefined) children.set(parentId, [row]);
    else siblings.push(row);
  }
  for (const siblings of children.values()) {
    siblings.sort((a, b) => a.code.localeCompare(b.code, 'en', { numeric: true }));
  }

  // A rollup reads as the total of what sits under it, which is how a statement
  // reads it; a parent and its children always share a type, so the signed
  // balances add up without re-signing anything.
  const rolled = new Map<string, number>();
  const rollup = (row: Row): number => {
    const total =
      (balances.get(row.id) ?? 0) +
      (children.get(row.id) ?? []).reduce((sum, child) => sum + rollup(child), 0);
    rolled.set(row.id, total);
    return total;
  };
  for (const root of children.get(null) ?? []) rollup(root);

  const out: AccountTreeRow[] = [];
  const walk = (row: Row, depth: number): void => {
    const kids = children.get(row.id) ?? [];
    out.push({
      id: row.id,
      code: row.code,
      name: row.name,
      type: row.type,
      subtype: row.subtype,
      active: row.active,
      isControl: row.isControl,
      isBank: row.isBank,
      parentId: row.parentId,
      postable: !parentIds.has(row.id),
      depth,
      parentCode: row.parentId === null ? null : (codeById.get(row.parentId) ?? null),
      description: row.description,
      balanceCents: rolled.get(row.id) ?? 0,
      postedLineCount: postedCounts.get(row.id) ?? 0,
      childCount: kids.length,
    });
    for (const child of kids) walk(child, depth + 1);
  };
  for (const root of children.get(null) ?? []) walk(root, 0);

  return out;
}

async function postedLineCounts(): Promise<Map<string, number>> {
  const rows = await db.execute<{ account_id: string; n: number }>(sql`
    select l.account_id, count(*)::int as n
      from journal_lines l
      join journal_entries e on e.id = l.entry_id
     where e.status = 'posted'
     group by l.account_id
  `);
  return new Map([...rows].map((row) => [String(row.account_id), Number(row.n)]));
}

// ---------------------------------------------------------------------------
// Audit trail
// ---------------------------------------------------------------------------

export function readAuditFilters(params: URLSearchParams): AuditFilters {
  const value = (key: string): string => params.get(key) ?? '';
  const op = value('op');
  return {
    table: value('table'),
    op: op === 'INSERT' || op === 'UPDATE' || op === 'DELETE' ? op : '',
    actorId: UUID.test(value('actorId')) ? value('actorId') : '',
    from: value('from'),
    to: value('to'),
    q: value('q'),
  };
}

export interface AuditPage {
  rows: AuditEntryRow[];
  total: number;
  tables: string[];
  actors: ActorOption[];
}

export async function auditPage(
  filters: AuditFilters,
  page: number,
  pageSize = AUDIT_PAGE_SIZE,
): Promise<AuditPage> {
  const from = ISO_DATE.test(filters.from) ? filters.from : null;
  const to = ISO_DATE.test(filters.to) ? filters.to : null;
  const q = filters.q.trim();

  const where = sql`
    where true
      ${filters.table === '' ? sql`` : sql`and a.table_name = ${filters.table}`}
      ${filters.op === '' ? sql`` : sql`and a.op = ${filters.op}`}
      ${filters.actorId === '' ? sql`` : sql`and a.actor_id = ${filters.actorId}`}
      ${from === null ? sql`` : sql`and a.at >= ${from}::date`}
      ${to === null ? sql`` : sql`and a.at < (${to}::date + 1)`}
      ${
        q === ''
          ? sql``
          : sql`and (a.row_id = ${q}
                 or coalesce(a.before::text, '') ilike ${`%${q}%`}
                 or coalesce(a.after::text, '') ilike ${`%${q}%`})`
      }
  `;

  const offset = Math.max(0, (page - 1) * pageSize);

  const [rowsResult, totalResult, tablesResult, actorsResult] = await Promise.all([
    db.execute<AuditQueryRow>(sql`
      select a.id, a.table_name, a.row_id, a.op, a.at, a.before, a.after,
             u.full_name as actor_name, u.email as actor_email
        from audit_log a
        left join app_users u on u.id = a.actor_id
        ${where}
       order by a.id desc
       limit ${pageSize} offset ${offset}
    `),
    db.execute<{ n: number }>(sql`select count(*)::int as n from audit_log a ${where}`),
    db.execute<{ table_name: string }>(
      sql`select distinct table_name from audit_log order by table_name`,
    ),
    db
      .select({ id: appUsers.id, fullName: appUsers.fullName, email: appUsers.email })
      .from(appUsers)
      .orderBy(asc(appUsers.email)),
  ]);

  return {
    rows: [...rowsResult].map(toAuditRow),
    total: count([...totalResult][0]?.n),
    tables: [...tablesResult].map((row) => String(row.table_name)),
    actors: actorsResult.map((actor) => ({
      id: actor.id,
      label: personLabel(actor.fullName, actor.email) ?? actor.id,
    })),
  };
}

// ---------------------------------------------------------------------------
// Periods
// ---------------------------------------------------------------------------

interface MonthStatsRow extends Record<string, unknown> {
  year: number;
  month: number;
  entries: number;
  drafts: number;
  debit_cents: string | number;
}

/**
 * Every month the books have anything to say about: from the earliest entry or
 * recorded period through the current one, so a month that was skipped still
 * gets a row and can still be closed.
 */
export async function periodRows(): Promise<PeriodRow[]> {
  const now = periodOf(today());

  const [boundsResult, statsResult, closersResult] = await Promise.all([
    db.execute<{ first_date: string | Date | null }>(sql`
      select least(
               (select min(entry_date) from journal_entries),
               (select min(make_date(year, month, 1)) from periods)
             ) as first_date
    `),
    db.execute<MonthStatsRow>(sql`
      select extract(year from e.entry_date)::int  as year,
             extract(month from e.entry_date)::int as month,
             count(distinct e.id)::int as entries,
             count(distinct e.id) filter (where e.status = 'draft')::int as drafts,
             coalesce(sum(l.debit_cents) filter (where e.status = 'posted'), 0) as debit_cents
        from journal_entries e
        left join journal_lines l on l.entry_id = e.id
       group by 1, 2
    `),
    db.execute<{ year: number; month: number; full_name: string | null; email: string | null }>(sql`
      select p.year, p.month, u.full_name, u.email
        from periods p
        join app_users u on u.id = p.closed_by
    `),
  ]);

  const firstDate = [...boundsResult][0]?.first_date ?? null;
  const earliest = firstDate === null ? now : periodOf(String(firstDate).slice(0, 10));
  // The books may reach back further than anyone wants to scroll; three years of
  // months is already more than a close screen has any use for.
  const oldest = Math.max(now.year * 12 + now.month - MAX_PERIOD_MONTHS, earliest.year * 12 + earliest.month);
  const first = { year: Math.floor((oldest - 1) / 12), month: ((oldest - 1) % 12) + 1 };

  const summaries = await listPeriods({ from: first, to: { year: now.year, month: now.month } });

  const key = (year: number, month: number): string => `${year}-${month}`;
  const stats = new Map(
    [...statsResult].map((row) => [
      key(Number(row.year), Number(row.month)),
      {
        entries: count(row.entries),
        drafts: count(row.drafts),
        debitCents: cents(row.debit_cents),
      },
    ]),
  );
  const closers = new Map(
    [...closersResult].map((row) => [
      key(Number(row.year), Number(row.month)),
      personLabel(row.full_name, row.email),
    ]),
  );

  return summaries
    .map((summary): PeriodRow => {
      const month = stats.get(key(summary.year, summary.month));
      return {
        year: summary.year,
        month: summary.month,
        status: summary.status,
        closedAtLabel: stamp(summary.closedAt),
        closedByLabel: closers.get(key(summary.year, summary.month)) ?? null,
        entryCount: month?.entries ?? 0,
        draftCount: month?.drafts ?? 0,
        debitCents: month?.debitCents ?? 0,
        start: summary.start,
        end: summary.end,
        current: summary.year === now.year && summary.month === now.month,
      };
    })
    .reverse();
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export interface DashboardAccountAmount {
  accountId: string;
  code: string;
  name: string;
  cents: number;
}

export interface DashboardData {
  asOf: CalendarDate;
  bankAccounts: DashboardAccountAmount[];
  cashCents: number;
  cardBalanceCents: number;
  netIncomeCents: number;
  previousNetIncomeCents: number;
  topExpenses: DashboardAccountAmount[];
  expenseTotalCents: number;
  recentEntries: JournalRow[];
  draftCount: number;
  period: { year: number; month: number; status: 'open' | 'closed' };
  monthly: NetIncomePoint[];
}

function netIncome(
  balances: ReadonlyMap<string, number>,
  byId: ReadonlyMap<string, { type: AccountType }>,
): number {
  let revenue = 0;
  let expense = 0;
  for (const [accountId, balance] of balances) {
    const type = byId.get(accountId)?.type;
    if (type === 'revenue') revenue += balance;
    else if (type === 'expense') expense += balance;
  }
  return revenue - expense;
}

export async function dashboardData(): Promise<DashboardData> {
  const asOf = today();
  const now = periodOf(asOf);
  const thisMonth = { from: monthStart(asOf), to: monthEnd(asOf) };
  const previousStart = monthStart(
    now.month === 1 ? `${now.year - 1}-12-01` : `${now.year}-${String(now.month - 1).padStart(2, '0')}-01`,
  );

  const options = await accountOptions();
  const byId = new Map(options.map((account) => [account.id, account]));

  const [allBalances, monthBalances, previousBalances, recent, drafts, periodRow, monthly] =
    await Promise.all([
      balancesByAccount({ to: asOf }),
      balancesByAccount(thisMonth),
      balancesByAccount({ from: previousStart, to: monthEnd(previousStart) }),
      recentEntries(8),
      draftCount(),
      currentPeriodStatus(now.year, now.month),
      monthlyNetIncome(asOf, 6),
    ]);

  const bankAccounts = options
    .filter((account) => account.isBank && account.type === 'asset')
    .map((account) => ({
      accountId: account.id,
      code: account.code,
      name: account.name,
      cents: allBalances.get(account.id) ?? 0,
    }))
    .sort((a, b) => b.cents - a.cents);

  const cardBalanceCents = options
    .filter((account) => account.isBank && account.type === 'liability')
    .reduce((sum, account) => sum + (allBalances.get(account.id) ?? 0), 0);

  const expenses = options
    .filter((account) => account.type === 'expense' && account.postable)
    .map((account) => ({
      accountId: account.id,
      code: account.code,
      name: account.name,
      cents: monthBalances.get(account.id) ?? 0,
    }))
    .filter((row) => row.cents > 0)
    .sort((a, b) => b.cents - a.cents);

  return {
    asOf,
    bankAccounts,
    cashCents: bankAccounts.reduce((sum, account) => sum + account.cents, 0),
    cardBalanceCents,
    netIncomeCents: netIncome(monthBalances, byId),
    previousNetIncomeCents: netIncome(previousBalances, byId),
    topExpenses: expenses.slice(0, 5),
    expenseTotalCents: expenses.reduce((sum, row) => sum + row.cents, 0),
    recentEntries: recent,
    draftCount: drafts,
    period: periodRow,
    monthly,
  };
}

async function recentEntries(limit: number): Promise<JournalRow[]> {
  const rows = await db.execute<JournalQueryRow>(sql`
    select e.id, e.entry_no, e.entry_date::text as entry_date, e.memo,
           e.source_type, e.source_id, e.status::text as status,
           null::bigint as reverses_entry_no, null::bigint as reversed_by_entry_no,
           coalesce(sum(l.debit_cents), 0) as debit_cents,
           count(l.id) as line_count
      from journal_entries e
      left join journal_lines l on l.entry_id = e.id
     group by e.id
     order by e.entry_date desc, e.entry_no desc
     limit ${limit}
  `);

  return [...rows].map((row) => ({
    id: String(row.id),
    entryNo: Number(row.entry_no),
    date: String(row.entry_date),
    memo: row.memo,
    sourceType: String(row.source_type),
    sourceId: row.source_id,
    status: row.status === 'draft' ? 'draft' : 'posted',
    debitCents: cents(row.debit_cents),
    lineCount: count(row.line_count),
    reversesEntryNo: null,
    reversedByEntryNo: null,
  }));
}

async function draftCount(): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(journalEntries)
    .where(eq(journalEntries.status, 'draft'));
  return count(row?.n);
}

async function currentPeriodStatus(
  year: number,
  month: number,
): Promise<{ year: number; month: number; status: 'open' | 'closed' }> {
  const [summary] = await listPeriods({ from: { year, month }, to: { year, month } });
  return { year, month, status: summary?.status ?? 'open' };
}

/**
 * Net income by month for the `months` months ending with the one `asOf` falls
 * in, oldest first. The anchor is passed in rather than read from Postgres'
 * `current_date`, which is on the database's UTC clock and turns the month over
 * hours before the books do.
 */
async function monthlyNetIncome(asOf: CalendarDate, months: number): Promise<NetIncomePoint[]> {
  const rows = await db.execute<{ period: string; net_cents: string | number }>(sql`
    with months as (
      select generate_series(
               date_trunc('month', ${asOf}::date) - (${months - 1}::int * interval '1 month'),
               date_trunc('month', ${asOf}::date),
               interval '1 month'
             )::date as start
    )
    select to_char(m.start, 'YYYY-MM') as period,
           coalesce(sum(
             case a.type
               when 'revenue' then account_sign(a.type) * (l.debit_cents - l.credit_cents)
               when 'expense' then -account_sign(a.type) * (l.debit_cents - l.credit_cents)
               else 0
             end
           ), 0) as net_cents
      from months m
      left join journal_entries e
             on e.status = 'posted'
            and e.entry_date >= m.start
            and e.entry_date < (m.start + interval '1 month')
      left join journal_lines l on l.entry_id = e.id
      left join accounts a on a.id = l.account_id
     group by m.start
     order by m.start
  `);

  return [...rows].map((row) => {
    const [, month] = String(row.period).split('-');
    return {
      label: MONTH_ABBR[Number(month) - 1] ?? String(row.period),
      netCents: cents(row.net_cents),
    };
  });
}

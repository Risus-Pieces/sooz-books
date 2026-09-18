/**
 * The reads behind the dashboard. Every figure is a query: posted balances from
 * the ledger, the bank's own running balances, and the review queue. Where the
 * ledger does not carry something yet because it is still waiting in review,
 * the figure says how much is waiting rather than pretending it has posted.
 */

import { sql } from 'drizzle-orm';

import { db } from '@/db/client';
import { type CalendarDate, addDays, monthEnd, monthStart, periodOf, today } from '@/lib/dates';
import { ACCOUNTS } from '@/lib/ledger/coa';
import { listPeriods } from '@/lib/ledger/periods';
import { actualCashFlows, cashPosition } from '@/lib/planning/cash-position';
import { type CashForecast, buildCashForecast } from '@/lib/planning/forecast';

function cents(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value ?? 0);
  if (!Number.isSafeInteger(n)) throw new Error(`Expected whole cents, received ${String(value)}.`);
  return n;
}

/** A bank line that has not reached the ledger yet (same test the forecast uses). */
const UNPOSTED = sql`(
  t.status <> 'excluded'
  and (t.journal_entry_id is null
       or not exists (select 1 from journal_entries je where je.id = t.journal_entry_id and je.status = 'posted'))
)`;

export interface BankRow {
  bankAccountId: string;
  name: string;
  mask: string | null;
  kind: string;
  glCode: string;
  /** The bank's own running balance on its latest imported line; null with nothing imported. */
  bankCents: number | null;
  bankDate: CalendarDate | null;
  /** Posted ledger balance of the bank's GL account. */
  bookCents: number;
  lineCount: number;
}

interface BankQueryRow extends Record<string, unknown> {
  id: string;
  name: string;
  mask: string | null;
  kind: string;
  code: string;
  book: string | number;
  bank: string | number | null;
  bank_date: string | null;
  lines: string | number;
}

export async function bankRows(): Promise<BankRow[]> {
  const rows = await db.execute<BankQueryRow>(sql`
    select b.id, b.name, b.mask, b.kind::text as kind, a.code,
           coalesce((select sum(l.debit_cents - l.credit_cents)
                       from journal_lines l join journal_entries e on e.id = l.entry_id
                      where l.account_id = a.id and e.status = 'posted'), 0) as book,
           s.balance_cents as bank, s.txn_date::text as bank_date,
           (select count(*) from bank_transactions t where t.bank_account_id = b.id) as lines
      from bank_accounts b
      join accounts a on a.id = b.account_id
      left join lateral (
        select t.balance_cents, t.txn_date from bank_transactions t
         where t.bank_account_id = b.id and t.balance_cents is not null
         order by t.txn_date desc, t.created_at desc, t.id desc limit 1
      ) s on true
     where b.active
     order by (select count(*) from bank_transactions t where t.bank_account_id = b.id) desc, a.code
  `);
  return [...rows].map((r) => ({
    bankAccountId: r.id,
    name: r.name,
    mask: r.mask,
    kind: r.kind,
    glCode: r.code,
    bankCents: r.bank === null ? null : cents(r.bank),
    bankDate: r.bank_date,
    bookCents: cents(r.book),
    lineCount: Number(r.lines),
  }));
}

export interface ReviewQueue {
  unreviewedCount: number;
  unreviewedInCents: number;
  unreviewedOutCents: number;
  /** Categorized by a rule but not yet posted. */
  categorizedCount: number;
  categorizedNetCents: number;
  oldestUnreviewed: CalendarDate | null;
  /** Unreviewed lines grouped by the account they are suggested to, largest first. */
  bySuggestion: Array<{ code: string | null; name: string; count: number; netCents: number }>;
}

export async function reviewQueue(): Promise<ReviewQueue> {
  const [row] = await db.execute<Record<string, string | number | null>>(sql`
    select count(*) filter (where t.status = 'unreviewed') as n,
           coalesce(sum(t.amount_cents) filter (where t.status = 'unreviewed' and t.amount_cents > 0), 0) as inflow,
           coalesce(-sum(t.amount_cents) filter (where t.status = 'unreviewed' and t.amount_cents < 0), 0) as outflow,
           count(*) filter (where t.status = 'categorized' and ${UNPOSTED}) as cat_n,
           coalesce(sum(t.amount_cents) filter (where t.status = 'categorized' and ${UNPOSTED}), 0) as cat_net,
           min(t.txn_date) filter (where t.status = 'unreviewed')::text as oldest
      from bank_transactions t
  `);
  const groups = await db.execute<{ code: string | null; name: string | null; n: string | number; net: string | number }>(sql`
    select a.code, a.name, count(*) as n, sum(t.amount_cents) as net
      from bank_transactions t
      left join accounts a on a.id = t.suggested_account_id
     where t.status = 'unreviewed'
     group by a.code, a.name
     order by abs(sum(t.amount_cents)) desc, count(*) desc
  `);
  return {
    bySuggestion: [...groups].map((g) => ({
      code: g.code,
      name: g.name ?? 'No suggestion',
      count: Number(g.n),
      netCents: cents(g.net),
    })),
    unreviewedCount: Number(row?.n ?? 0),
    unreviewedInCents: cents(row?.inflow),
    unreviewedOutCents: cents(row?.outflow),
    categorizedCount: Number(row?.cat_n ?? 0),
    categorizedNetCents: cents(row?.cat_net),
    oldestUnreviewed: row?.oldest === null || row?.oldest === undefined ? null : String(row.oldest),
  };
}

export interface BalanceWithPending {
  /** Posted balance in the account's normal direction (debit for assets, credit for equity). */
  postedCents: number;
  /** Unposted bank lines whose suggestion points into the account (or under it). */
  pendingCount: number;
  /** Their movement in the account's normal direction. */
  pendingCents: number;
}

/** Posted balance of an account and every account under it, plus what is waiting in review for it. */
async function balanceWithPending(code: string, normal: 'debit' | 'credit'): Promise<BalanceWithPending> {
  const sign = normal === 'debit' ? 1 : -1;
  const [row] = await db.execute<Record<string, string | number | null>>(sql`
    with recursive tree as (
      select id from accounts where code = ${code}
      union all
      select a.id from accounts a join tree on a.parent_id = tree.id
    )
    select coalesce((select sum(l.debit_cents - l.credit_cents)
                       from journal_lines l join journal_entries e on e.id = l.entry_id
                      where e.status = 'posted' and l.account_id in (select id from tree)), 0) as posted,
           (select count(*) from bank_transactions t
             where t.suggested_account_id in (select id from tree) and ${UNPOSTED}) as pending_n,
           -- A bank line's amount is the cash side; the account on the other side moves the opposite way.
           coalesce((select -sum(t.amount_cents) from bank_transactions t
                      where t.suggested_account_id in (select id from tree) and ${UNPOSTED}), 0) as pending
  `);
  return {
    postedCents: sign * cents(row?.posted),
    pendingCount: Number(row?.pending_n ?? 0),
    pendingCents: sign * cents(row?.pending),
  };
}

export interface FounderMoney extends BalanceWithPending {
  /** Opening bank balances (the founder's first deposit) whose opening entry is not posted yet. */
  unbookedOpeningCents: number;
}

export async function founderContributions(): Promise<FounderMoney> {
  const base = await balanceWithPending(ACCOUNTS.MEMBER_CONTRIBUTIONS, 'credit');
  const [row] = await db.execute<{ cents: string | number }>(sql`
    select coalesce(sum(b.opening_balance_cents), 0) as cents
      from bank_accounts b
     where b.opening_balance_cents <> 0
       and not exists (select 1 from journal_entries e
                        where e.source_type = 'opening_balance' and e.source_id = b.id and e.status = 'posted')
  `);
  return { ...base, unbookedOpeningCents: cents(row?.cents) };
}

export async function inventoryCapitalized(): Promise<BalanceWithPending & { ingredients: BalanceWithPending; packaging: BalanceWithPending }> {
  const [all, ingredients, packaging] = [
    await balanceWithPending(ACCOUNTS.INVENTORY, 'debit'),
    await balanceWithPending(ACCOUNTS.INVENTORY_INGREDIENTS, 'debit'),
    await balanceWithPending(ACCOUNTS.INVENTORY_PACKAGING, 'debit'),
  ];
  return { ...all, ingredients, packaging };
}

export async function squareClearing(): Promise<BalanceWithPending & { depositsCount: number; depositsCents: number }> {
  const base = await balanceWithPending(ACCOUNTS.CLEARING_SQUARE, 'debit');
  const [row] = await db.execute<{ n: string | number; total: string | number }>(sql`
    select count(*) as n, coalesce(sum(t.amount_cents), 0) as total
      from bank_transactions t
     where t.reference ~ '^SQ[0-9]{6}$' and t.amount_cents > 0
  `);
  return { ...base, depositsCount: Number(row?.n ?? 0), depositsCents: cents(row?.total) };
}

export interface CloseStatus {
  current: { year: number; month: number; status: 'open' | 'closed' };
  closedCount: number;
  lastClosed: { year: number; month: number } | null;
  /** The first month the books reach that is still open, which is the next to close. */
  nextToClose: { year: number; month: number } | null;
  checklist: { done: number; total: number; status: string } | null;
}

export async function closeStatus(): Promise<CloseStatus> {
  const now = periodOf(today());
  const [bounds] = await db.execute<{ first: string | null }>(sql`
    select least((select min(txn_date) from bank_transactions),
                 (select min(opening_date) from bank_accounts where opening_balance_cents <> 0),
                 (select min(entry_date) from journal_entries))::text as first
  `);
  const first = bounds?.first ? periodOf(bounds.first) : now;
  const periods = await listPeriods({ from: first, to: now });
  const closed = periods.filter((p) => p.status === 'closed');
  const next = periods.find((p) => p.status === 'open') ?? null;
  let checklist: CloseStatus['checklist'] = null;
  if (next !== null) {
    const [row] = await db.execute<{ done: string | number; total: string | number; status: string }>(sql`
      select count(*) filter (where t.status in ('done', 'skipped') and t.blocking) as done,
             count(*) filter (where t.blocking) as total, c.status
        from close_checklists c join close_tasks t on t.checklist_id = c.id
       where c.year = ${next.year} and c.month = ${next.month}
       group by c.status
    `);
    if (row !== undefined) checklist = { done: Number(row.done), total: Number(row.total), status: row.status };
  }
  const current = periods[periods.length - 1];
  return {
    current: { year: now.year, month: now.month, status: current?.status ?? 'open' },
    closedCount: closed.length,
    lastClosed: closed.length === 0 ? null : { year: closed[closed.length - 1].year, month: closed[closed.length - 1].month },
    nextToClose: next === null ? null : { year: next.year, month: next.month },
    checklist,
  };
}

export async function runwayForecast(): Promise<CashForecast> {
  return buildCashForecast();
}

/* ------------------------------------------------------------ the charts */

/** The first day the books have money in them: the earliest opening date or bank line. */
async function booksStart(): Promise<CalendarDate | null> {
  const [row] = await db.execute<{ first: string | null }>(sql`
    select least((select min(txn_date) from bank_transactions),
                 (select min(opening_date) from bank_accounts where opening_balance_cents <> 0))::text as first
  `);
  return row?.first ?? null;
}

export interface CashSeriesPoint {
  date: CalendarDate;
  cents: number;
}

/**
 * Cash at each month end since the books began, then today — measured by `cashPosition`, the same
 * figure the runway uses, so the line ends exactly on the cash total above it.
 */
export async function cashSeries(asOf: CalendarDate = today()): Promise<CashSeriesPoint[]> {
  const first = await booksStart();
  if (first === null) return [{ date: asOf, cents: (await cashPosition(asOf)).cashCents }];
  const points: CashSeriesPoint[] = [];
  let end = monthEnd(first);
  while (end < asOf) {
    points.push({ date: end, cents: (await cashPosition(end)).cashCents });
    end = monthEnd(addDays(end, 1));
  }
  points.push({ date: asOf, cents: (await cashPosition(asOf)).cashCents });
  return points;
}

export interface MonthFlow {
  year: number;
  month: number;
  /** Money in from the owners or lenders (member contributions, loans). */
  founderCents: number;
  /** Operating money in: sales deposits, refunds. */
  salesCents: number;
  /** Money out, operating and financing, as a positive number. */
  spendCents: number;
}

/**
 * Money in and out by month since the books began, on the same terms as the burn rate: transfers
 * between Sooz's own accounts are dropped, a flow's class comes from its posted entry or, while it
 * waits in review, from its suggested account.
 */
export async function monthlyFlows(asOf: CalendarDate = today()): Promise<MonthFlow[]> {
  const first = await booksStart();
  const start = monthStart(first ?? asOf);
  const flows = await actualCashFlows(addDays(start, -1), asOf);
  const months: MonthFlow[] = [];
  let cursor = start;
  while (cursor <= asOf) {
    const { year, month } = periodOf(cursor);
    months.push({ year, month, founderCents: 0, salesCents: 0, spendCents: 0 });
    cursor = addDays(monthEnd(cursor), 1);
  }
  const index = new Map(months.map((m, i) => [`${m.year}-${m.month}`, i]));
  for (const flow of flows) {
    if (flow.cls === 'transfer') continue;
    const { year, month } = periodOf(flow.date);
    const i = index.get(`${year}-${month}`);
    if (i === undefined) continue;
    const m = months[i];
    if (flow.amountCents < 0) m.spendCents += -flow.amountCents;
    else if (flow.cls === 'financing') m.founderCents += flow.amountCents;
    else m.salesCents += flow.amountCents;
  }
  return months;
}

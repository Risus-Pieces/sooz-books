/**
 * Accounting periods: one row per calendar month, open until someone closes it.
 *
 * A month with no row is open — the table records decisions, not the calendar —
 * so `ensurePeriod` exists for the close workflow rather than as a prerequisite
 * for posting. Closing is enforced in the database (nothing posts into a closed
 * period); everything here is the workflow around that trigger.
 */

import { and, asc, eq, gte, lte, sql } from 'drizzle-orm';

import { db, withActor } from '@/db/client';
import { appUsers, journalEntries, periods, type Period } from '@/db/schema';
import { type CalendarDate, monthEnd, monthStart, periodOf, today } from '@/lib/dates';

import {
  type DraftEntryRef,
  InvalidDateError,
  NotPermittedError,
  PeriodHasDraftsError,
} from './errors';
import type { LedgerDb } from './post';

export interface YearMonth {
  year: number;
  month: number;
}

export interface PeriodCtx {
  tx?: LedgerDb;
}

/**
 * A month as the close screen shows it. `exists` is false for a month that has
 * never been touched: open, but with no row and nothing recorded about it.
 */
export interface PeriodSummary extends YearMonth {
  status: 'open' | 'closed';
  closedAt: Date | null;
  closedBy: string | null;
  exists: boolean;
  start: CalendarDate;
  end: CalendarDate;
}

const MIN_YEAR = 1900;
const MAX_YEAR = 9999;

function assertYearMonth(year: number, month: number): void {
  if (!Number.isInteger(year) || year < MIN_YEAR || year > MAX_YEAR) {
    throw new InvalidDateError(String(year), `${year} is not a usable accounting year.`);
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new InvalidDateError(String(month), `${month} is not a month between 1 and 12.`);
  }
}

/** Months since year 0, so a period can be compared and stepped as one number. */
function monthIndex(year: number, month: number): number {
  return year * 12 + (month - 1);
}

function fromMonthIndex(index: number): YearMonth {
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

export function periodStart(year: number, month: number): CalendarDate {
  assertYearMonth(year, month);
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-01`;
}

export function periodEnd(year: number, month: number): CalendarDate {
  return monthEnd(periodStart(year, month));
}

function summarise(year: number, month: number, row: Period | undefined): PeriodSummary {
  return {
    year,
    month,
    status: row?.status ?? 'open',
    closedAt: row?.closedAt ?? null,
    closedBy: row?.closedBy ?? null,
    exists: row !== undefined,
    start: periodStart(year, month),
    end: periodEnd(year, month),
  };
}

/**
 * Creates the row for a month if it does not have one yet, and returns it. Two
 * concurrent callers are fine: the unique key settles it and both read the row
 * that won.
 */
export async function ensurePeriod(
  year: number,
  month: number,
  ctx: { userId: string | null; tx?: LedgerDb } = { userId: null },
): Promise<Period> {
  assertYearMonth(year, month);

  const work = async (tx: LedgerDb): Promise<Period> => {
    const inserted = await tx
      .insert(periods)
      .values({ year, month, status: 'open' })
      .onConflictDoNothing({ target: [periods.year, periods.month] })
      .returning();
    if (inserted.length > 0) return inserted[0];

    const [existing] = await tx
      .select()
      .from(periods)
      .where(and(eq(periods.year, year), eq(periods.month, month)));
    return existing;
  };

  return ctx.tx ? work(ctx.tx) : withActor(ctx.userId, work);
}

/** Every draft entry dated inside the month, which is what blocks a close. */
async function draftsIn(exec: LedgerDb, year: number, month: number): Promise<DraftEntryRef[]> {
  const rows = await exec
    .select({
      id: journalEntries.id,
      entryNo: journalEntries.entryNo,
      date: journalEntries.entryDate,
      memo: journalEntries.memo,
    })
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.status, 'draft'),
        gte(journalEntries.entryDate, periodStart(year, month)),
        lte(journalEntries.entryDate, periodEnd(year, month)),
      ),
    )
    .orderBy(asc(journalEntries.entryNo));
  return rows;
}

/**
 * Closes a month. Refuses while any entry dated in it is still a draft: a draft
 * can never be posted afterwards, so closing over one silently strands it.
 *
 * @throws {PeriodHasDraftsError} carrying the offending entries
 */
export async function closePeriod(
  year: number,
  month: number,
  userId: string | null,
  ctx: PeriodCtx = {},
): Promise<Period> {
  assertYearMonth(year, month);

  const work = async (tx: LedgerDb): Promise<Period> => {
    const drafts = await draftsIn(tx, year, month);
    if (drafts.length > 0) throw new PeriodHasDraftsError(year, month, drafts);

    const [row] = await tx
      .insert(periods)
      .values({ year, month, status: 'closed', closedAt: new Date(), closedBy: userId })
      .onConflictDoUpdate({
        target: [periods.year, periods.month],
        set: { status: 'closed', closedAt: new Date(), closedBy: userId },
      })
      .returning();
    return row;
  };

  return ctx.tx ? work(ctx.tx) : withActor(userId, work);
}

/**
 * Reopens a closed month. Owner only: reopening lets figures already reported to
 * the bank or the accountant move, so it is not a bookkeeping operation.
 *
 * @throws {NotPermittedError} when the acting user is not an active owner
 */
export async function reopenPeriod(
  year: number,
  month: number,
  userId: string | null,
  ctx: PeriodCtx = {},
): Promise<PeriodSummary> {
  assertYearMonth(year, month);

  const work = async (tx: LedgerDb): Promise<PeriodSummary> => {
    const role = userId === null ? null : await ownerRole(tx, userId);
    if (role !== 'owner') throw new NotPermittedError('reopen a closed period', userId, role);

    const updated = await tx
      .update(periods)
      .set({ status: 'open', closedAt: null, closedBy: null })
      .where(and(eq(periods.year, year), eq(periods.month, month)))
      .returning();

    // A month with no row was never closed; the reopen is already true.
    return summarise(year, month, updated[0]);
  };

  return ctx.tx ? work(ctx.tx) : withActor(userId, work);
}

async function ownerRole(exec: LedgerDb, userId: string): Promise<string | null> {
  const [user] = await exec
    .select({ role: appUsers.role, active: appUsers.active })
    .from(appUsers)
    .where(eq(appUsers.id, userId));
  if (user === undefined || !user.active) return null;
  return user.role;
}

/** True when a date may be posted to. A month with no row has never been closed. */
export async function isPeriodOpen(date: CalendarDate, exec: LedgerDb = db): Promise<boolean> {
  const { year, month } = periodOf(date);
  const [row] = await exec
    .select({ status: periods.status })
    .from(periods)
    .where(and(eq(periods.year, year), eq(periods.month, month)));
  return row === undefined || row.status === 'open';
}

/**
 * The first month on or after `onOrAfter` that is not closed — where a posting
 * whose own period has been closed has to land instead.
 */
export async function earliestOpenPeriod(
  onOrAfter: CalendarDate = today(),
  exec: LedgerDb = db,
): Promise<YearMonth> {
  const from = periodOf(onOrAfter);
  const start = monthIndex(from.year, from.month);

  const rows = await exec
    .select({ year: periods.year, month: periods.month })
    .from(periods)
    .where(
      and(
        eq(periods.status, 'closed'),
        gte(sql<number>`${periods.year} * 12 + ${periods.month} - 1`, start),
      ),
    );

  const closed = new Set(rows.map((r) => monthIndex(r.year, r.month)));
  let index = start;
  // Closed months are finite, so this walks at most one month past the last one.
  while (closed.has(index)) index += 1;
  return fromMonthIndex(index);
}

/**
 * Every month in the range, whether or not it has a row. Ordered oldest first.
 */
export async function listPeriods(
  range: { from: YearMonth; to: YearMonth },
  exec: LedgerDb = db,
): Promise<PeriodSummary[]> {
  assertYearMonth(range.from.year, range.from.month);
  assertYearMonth(range.to.year, range.to.month);

  const first = monthIndex(range.from.year, range.from.month);
  const last = monthIndex(range.to.year, range.to.month);
  if (last < first) return [];

  const rows = await exec
    .select()
    .from(periods)
    .where(
      and(
        gte(sql<number>`${periods.year} * 12 + ${periods.month} - 1`, first),
        lte(sql<number>`${periods.year} * 12 + ${periods.month} - 1`, last),
      ),
    );

  const byIndex = new Map(rows.map((row) => [monthIndex(row.year, row.month), row]));
  const out: PeriodSummary[] = [];
  for (let index = first; index <= last; index += 1) {
    const { year, month } = fromMonthIndex(index);
    out.push(summarise(year, month, byIndex.get(index)));
  }
  return out;
}

/** The period a date belongs to, as the close screen shows it. */
export async function periodFor(
  date: CalendarDate,
  exec: LedgerDb = db,
): Promise<PeriodSummary> {
  const { year, month } = periodOf(monthStart(date));
  const [row] = await exec
    .select()
    .from(periods)
    .where(and(eq(periods.year, year), eq(periods.month, month)));
  return summarise(year, month, row);
}

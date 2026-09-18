/**
 * The thirteen-week cash forecast.
 *
 *     opening   cash at close of business on the as-of date (`./cash-position`)
 *   + inflows   open receivables on their due dates, and inflow forecast items
 *   − outflows  open payables on their due dates, and outflow forecast items
 *   = the closing balance of each Monday-to-Sunday week
 *
 * Receivables and payables are the aging as of the same date, so a forecast
 * built for a past date sees the invoices that were open then. Forecast items
 * are expanded through their recurrence and weighted by their confidence. The
 * arithmetic itself lives in `./forecast-math`.
 *
 * Runway is given two ways, because for a pre-launch business they disagree and
 * both matter. The forecast runway is the first week the projected balance goes
 * below zero — only as good as the items someone has entered. The burn runway
 * divides cash by the trailing operating burn the bank actually shows, excluding
 * the founder's contributions, so it answers "how long until the founder has to
 * put more in" without anyone's expectations in it.
 */

import { asc, eq } from 'drizzle-orm';

import { type ForecastItem, type ForecastWeek, forecastItems, forecastSnapshots } from '@/db/schema';
import { apAging, arAging } from '@/lib/arap/aging';
import { type CalendarDate, addDays, isCalendarDate, today } from '@/lib/dates';
import type { LedgerDb } from '@/lib/ledger/post';
import { formatMoney } from '@/lib/money';

import { type CashPosition, type TrailingBurn, actualCashFlows, cashPosition, trailingBurn } from './cash-position';
import { PlanningError, type PlanningCtx, inTx, reader } from './context';
import {
  type ActualWeek,
  type BurnRunway,
  FORECAST_WEEKS,
  type ForecastFlow,
  type ForecastRunway,
  type ForecastScore,
  type ForecastWeekDetail,
  RECURRENCES,
  type Recurrence,
  burnRunway,
  confidenceThousandths,
  forecastRunway,
  forecastWeeks,
  horizonEnd,
  occurrences,
  rollForward,
  scoreWeeks,
  weightByConfidence,
} from './forecast-math';

/** Trailing window the burn rate is measured over. */
export const DEFAULT_BURN_WINDOW_DAYS = 90;

export interface CashForecast {
  asOf: CalendarDate;
  horizonEnd: CalendarDate;
  opening: CashPosition;
  weeks: ForecastWeekDetail[];
  runway: ForecastRunway;
  burn: TrailingBurn & BurnRunway;
  /** Receivables and one-off items already past their date, carried into week one. */
  overdueInflowCents: number;
  /** Payables and one-off items already past their date, carried into week one. */
  overdueOutflowCents: number;
  /** What the reader must know to trust the figures. Never silently dropped. */
  warnings: string[];
}

export interface ForecastOptions {
  asOf?: CalendarDate;
  burnWindowDays?: number;
}

/* ------------------------------------------------------------ forecast items */

export interface ForecastItemInput {
  label: string;
  category: string;
  direction: 'inflow' | 'outflow';
  amountCents: number;
  expectedDate: CalendarDate;
  recurrence?: Recurrence;
  endDate?: CalendarDate | null;
  bankAccountId?: string | null;
  /** Exact decimal between 0 and 1, e.g. "0.750". Defaults to "1.000". */
  confidence?: string;
  notes?: string | null;
}

function validateItem(input: ForecastItemInput): void {
  if (input.label.trim() === '') throw new PlanningError('invalid_input', 'A forecast item needs a label.');
  if (input.category.trim() === '') throw new PlanningError('invalid_input', 'A forecast item needs a category.');
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) {
    throw new PlanningError('invalid_input', 'A forecast item amount must be a positive number of cents.');
  }
  if (!isCalendarDate(input.expectedDate)) {
    throw new PlanningError('invalid_input', `${String(input.expectedDate)} is not a YYYY-MM-DD date.`);
  }
  const recurrence = input.recurrence ?? 'none';
  if (!RECURRENCES.includes(recurrence)) {
    throw new PlanningError('invalid_input', `"${String(recurrence)}" is not a recurrence.`);
  }
  const end = input.endDate ?? null;
  if (end !== null && (!isCalendarDate(end) || end < input.expectedDate)) {
    throw new PlanningError('invalid_input', 'An end date must be a date on or after the expected date.');
  }
  if (input.confidence !== undefined) confidenceThousandths(input.confidence);
}

export async function createForecastItem(input: ForecastItemInput, ctx: PlanningCtx): Promise<ForecastItem> {
  validateItem(input);
  return inTx(ctx, async (tx) => {
    const [created] = await tx
      .insert(forecastItems)
      .values({
        label: input.label.trim(),
        category: input.category.trim(),
        direction: input.direction,
        amountCents: input.amountCents,
        expectedDate: input.expectedDate,
        recurrence: input.recurrence ?? 'none',
        endDate: input.endDate ?? null,
        bankAccountId: input.bankAccountId ?? null,
        confidence: input.confidence ?? '1.000',
        notes: input.notes ?? null,
        createdBy: ctx.userId,
      })
      .returning();
    return created;
  });
}

/** Stops an item counting in future forecasts. Kept, not deleted, so old snapshots stay explicable. */
export async function deactivateForecastItem(itemId: string, ctx: PlanningCtx): Promise<ForecastItem> {
  return inTx(ctx, async (tx) => {
    const [updated] = await tx
      .update(forecastItems)
      .set({ active: false })
      .where(eq(forecastItems.id, itemId))
      .returning();
    if (updated === undefined) throw new PlanningError('not_found', 'That forecast item does not exist.');
    return updated;
  });
}

export async function listForecastItems(exec?: LedgerDb): Promise<ForecastItem[]> {
  return reader(exec)
    .select()
    .from(forecastItems)
    .where(eq(forecastItems.active, true))
    .orderBy(asc(forecastItems.expectedDate), asc(forecastItems.label));
}

/** Expands active items into dated, weighted flows inside `(asOf, horizon]`, plus overdue one-offs. */
export function itemFlows(
  items: readonly ForecastItem[],
  asOf: CalendarDate,
  horizon: CalendarDate,
): ForecastFlow[] {
  const flows: ForecastFlow[] = [];
  for (const item of items) {
    if (!item.active) continue;
    const amountCents = weightByConfidence(item.amountCents, item.confidence);
    if (amountCents === 0) continue;
    const base = {
      direction: item.direction,
      amountCents,
      source: 'item' as const,
      label: item.label,
      refId: item.id,
    };
    if (item.recurrence === 'none' && item.expectedDate <= asOf) {
      flows.push({ ...base, date: item.expectedDate, overdue: true });
      continue;
    }
    for (const date of occurrences(item.expectedDate, item.recurrence, item.endDate, asOf, horizon)) {
      flows.push({ ...base, date, overdue: false });
    }
  }
  return flows;
}

/* ------------------------------------------------------------------ forecast */

async function arapFlows(asOf: CalendarDate, horizon: CalendarDate, exec: LedgerDb): Promise<ForecastFlow[]> {
  const [ar, ap] = [await arAging(asOf, exec), await apAging(asOf, exec)];
  const flows: ForecastFlow[] = [];
  for (const [aging, direction, source, kind] of [
    [ar, 'inflow', 'ar', 'invoice'],
    [ap, 'outflow', 'ap', 'bill'],
  ] as const) {
    for (const party of aging.parties) {
      for (const item of party.items) {
        if (item.kind !== kind || item.balanceCents <= 0 || item.dueDate === null) continue;
        if (item.dueDate > horizon) continue;
        flows.push({
          date: item.dueDate,
          direction,
          amountCents: item.balanceCents,
          source,
          label: `${party.partyName} ${item.docNo}`,
          refId: item.id,
          overdue: item.dueDate <= asOf,
        });
      }
    }
  }
  return flows;
}

/** Builds the forecast as of a date (default: today on the books' calendar). */
export async function buildCashForecast(options: ForecastOptions = {}, exec?: LedgerDb): Promise<CashForecast> {
  const x = reader(exec);
  const asOf = options.asOf ?? today();
  if (!isCalendarDate(asOf)) throw new PlanningError('invalid_input', `${String(asOf)} is not a YYYY-MM-DD date.`);
  const windowDays = options.burnWindowDays ?? DEFAULT_BURN_WINDOW_DAYS;
  const horizon = horizonEnd(asOf);

  const opening = await cashPosition(asOf, x);
  const items = await listForecastItems(x);
  const flows = [...(await arapFlows(asOf, horizon, x)), ...itemFlows(items, asOf, horizon)];
  const weeks = rollForward(asOf, opening.cashCents, flows);
  const burn = await trailingBurn(asOf, windowDays, x);
  const runwayFromBurn = burnRunway(asOf, opening.cashCents, burn.netBurnCents, windowDays);

  const overdue = flows.filter((f) => f.overdue);
  const overdueInflowCents = overdue.filter((f) => f.direction === 'inflow').reduce((s, f) => s + f.amountCents, 0);
  const overdueOutflowCents = overdue.filter((f) => f.direction === 'outflow').reduce((s, f) => s + f.amountCents, 0);

  const warnings: string[] = [];
  if (opening.unpostedCount > 0) {
    warnings.push(
      `${opening.unpostedCount} imported bank ${opening.unpostedCount === 1 ? 'line is' : 'lines are'} not in the ledger yet ` +
        `(${formatMoney(opening.unpostedActivityCents)} net). Opening cash includes them, because the money has moved.`,
    );
  }
  if (opening.unpostedOpeningCents !== 0) {
    warnings.push(
      `${formatMoney(opening.unpostedOpeningCents)} of opening bank balances has no posted opening entry yet. Opening cash includes it.`,
    );
  }
  if (opening.bankDataThrough === null) {
    warnings.push('No bank statement lines are imported, so opening cash is the ledger alone.');
  } else if (opening.bankDataThrough < asOf) {
    warnings.push(
      `Bank data runs through ${opening.bankDataThrough}. Anything that cleared after that is not in opening cash.`,
    );
  }
  for (const account of opening.accounts) {
    if (account.statementBalanceCents === null || account.statementBalanceCents === account.cashCents) continue;
    warnings.push(
      `${account.name}: the books put cash at ${formatMoney(account.cashCents)} but the bank's running balance on ` +
        `${account.statementDate} is ${formatMoney(account.statementBalanceCents)}.`,
    );
  }
  if (overdueInflowCents > 0) {
    warnings.push(
      `${formatMoney(overdueInflowCents)} of expected inflows is past due and assumed to arrive in the first week.`,
    );
  }
  if (overdueOutflowCents > 0) {
    warnings.push(`${formatMoney(overdueOutflowCents)} of payables and expected outflows is past due and assumed paid in the first week.`);
  }
  if (flows.length === 0) {
    warnings.push(
      'No open receivables, payables or forecast items fall in the next thirteen weeks, so the weekly balances only carry ' +
        'opening cash forward. Read the burn runway: it is what the bank shows the business actually spending.',
    );
  }
  if (burn.suggestedCents > 0) {
    warnings.push(
      `${formatMoney(burn.suggestedCents)} of the trailing burn rests on bank lines not yet posted, classified by their suggested account rather than a reviewed entry.`,
    );
  }

  return {
    asOf,
    horizonEnd: horizon,
    opening,
    weeks,
    runway: forecastRunway(weeks),
    burn: { ...burn, ...runwayFromBurn },
    overdueInflowCents,
    overdueOutflowCents,
    warnings,
  };
}

/* ----------------------------------------------------------------- snapshots */

/** The snapshot shape: the weeks exactly as projected, without the flow detail. */
export function snapshotWeeks(weeks: readonly ForecastWeekDetail[]): ForecastWeek[] {
  return weeks.map((w) => ({
    weekStart: w.weekStart,
    openingCents: w.openingCents,
    inflowCents: w.inflowCents,
    outflowCents: w.outflowCents,
    closingCents: w.closingCents,
  }));
}

export interface SnapshotResult {
  id: string;
  asOfDate: CalendarDate;
  weeks: ForecastWeek[];
}

/**
 * Freezes the forecast as of `asOf`. One snapshot per date: a second attempt is
 * refused unless `replace` is set, because overwriting a projection after the
 * fact is how a forecast comes to look better than it was.
 */
export async function snapshotForecast(
  asOf: CalendarDate,
  ctx: PlanningCtx,
  options: { replace?: boolean } = {},
): Promise<SnapshotResult> {
  return inTx(ctx, async (tx) => {
    const forecast = await buildCashForecast({ asOf }, tx);
    const weeks = snapshotWeeks(forecast.weeks);
    const [existing] = await tx
      .select({ id: forecastSnapshots.id })
      .from(forecastSnapshots)
      .where(eq(forecastSnapshots.asOfDate, asOf))
      .for('update');
    if (existing !== undefined) {
      if (options.replace !== true) {
        throw new PlanningError('duplicate', `A forecast for ${asOf} is already snapshotted.`);
      }
      await tx.update(forecastSnapshots).set({ weeks, createdBy: ctx.userId }).where(eq(forecastSnapshots.id, existing.id));
      return { id: existing.id, asOfDate: asOf, weeks };
    }
    const [created] = await tx
      .insert(forecastSnapshots)
      .values({ asOfDate: asOf, weeks, createdBy: ctx.userId })
      .returning({ id: forecastSnapshots.id });
    return { id: created.id, asOfDate: asOf, weeks };
  });
}

/**
 * What actually happened in each forecast week, on the same terms as the
 * forecast: week one runs from the as-of date (its opening is the cash the
 * forecast started from), later weeks run Monday to Sunday. Only weeks that
 * have ended on or before `through` are returned.
 */
export async function actualWeeks(
  asOf: CalendarDate,
  through: CalendarDate,
  exec?: LedgerDb,
): Promise<ActualWeek[]> {
  const x = reader(exec);
  const windows = forecastWeeks(asOf, FORECAST_WEEKS).filter((w) => w.weekEnd <= through);
  if (windows.length === 0) return [];

  const opening = await cashPosition(asOf, x);
  const flows = await actualCashFlows(asOf, windows[windows.length - 1].weekEnd, x);

  const out: ActualWeek[] = [];
  let running = opening.cashCents;
  let cursor = 0;
  for (const window of windows) {
    let inflowCents = 0;
    let outflowCents = 0;
    while (cursor < flows.length && flows[cursor].date <= window.weekEnd) {
      const amount = flows[cursor].amountCents;
      if (amount > 0) inflowCents += amount;
      else outflowCents -= amount;
      cursor += 1;
    }
    const closingCents = running + inflowCents - outflowCents;
    out.push({ weekStart: window.weekStart, openingCents: running, inflowCents, outflowCents, closingCents });
    running = closingCents;
  }
  return out;
}

export interface SnapshotScore extends ForecastScore {
  snapshotId: string;
  asOfDate: CalendarDate;
  scoredThrough: CalendarDate;
}

/** Scores a frozen forecast against what the bank and the ledger show happened. */
export async function scoreSnapshot(
  snapshotId: string,
  options: { through?: CalendarDate } = {},
  exec?: LedgerDb,
): Promise<SnapshotScore> {
  const x = reader(exec);
  const [snapshot] = await x.select().from(forecastSnapshots).where(eq(forecastSnapshots.id, snapshotId));
  if (snapshot === undefined) throw new PlanningError('not_found', 'That forecast snapshot does not exist.');
  const through = options.through ?? addDays(today(), -1);
  const actual = await actualWeeks(snapshot.asOfDate, through, x);
  return {
    snapshotId,
    asOfDate: snapshot.asOfDate,
    scoredThrough: through,
    ...scoreWeeks(snapshot.weeks, actual),
  };
}

export async function listForecastSnapshots(
  exec?: LedgerDb,
): Promise<Array<{ id: string; asOfDate: CalendarDate; createdAt: Date }>> {
  return reader(exec)
    .select({ id: forecastSnapshots.id, asOfDate: forecastSnapshots.asOfDate, createdAt: forecastSnapshots.createdAt })
    .from(forecastSnapshots)
    .orderBy(asc(forecastSnapshots.asOfDate));
}

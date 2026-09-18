/**
 * The arithmetic of the thirteen-week cash forecast, with no database in sight.
 *
 * Everything the forecast says is decided here — which dates a recurring item
 * lands on, how a confidence weight rounds, which week a flow belongs to, what
 * the closing balance of each week is, and how long the cash lasts — so the
 * figures can be asserted exactly against hand-computed fixtures. The loaders in
 * `./forecast` only gather the inputs.
 *
 * Conventions: cents are whole numbers; dates are `YYYY-MM-DD`; a week runs
 * Monday to Sunday and is named by its Monday. The opening balance is cash at
 * close of business on the as-of date, so only flows dated after it move the
 * forecast. A one-off expectation already past its date (an overdue invoice, a
 * promised deposit that has not arrived) has not happened, so it is carried into
 * the first week and marked overdue rather than silently dropped.
 */

import type { ForecastDirection, ForecastWeek } from '@/db/schema';
import { type CalendarDate, addDays, dateParts, daysBetween, daysInMonth } from '@/lib/dates';
import { addMonths } from '@/lib/reports/types';

import { PlanningError } from './errors';

export const FORECAST_WEEKS = 13;

export type Recurrence = 'none' | 'weekly' | 'biweekly' | 'semimonthly' | 'monthly' | 'quarterly';

export const RECURRENCES: readonly Recurrence[] = [
  'none',
  'weekly',
  'biweekly',
  'semimonthly',
  'monthly',
  'quarterly',
];

export type FlowSource = 'ar' | 'ap' | 'item';

/** One expected movement of cash, already weighted and dated. */
export interface ForecastFlow {
  date: CalendarDate;
  direction: ForecastDirection;
  /** Always positive; `direction` carries the sign. */
  amountCents: number;
  source: FlowSource;
  label: string;
  /** The invoice, bill or forecast item behind the flow. */
  refId: string;
  /** Dated on or before the as-of date and still outstanding; carried into week one. */
  overdue: boolean;
}

/** A week as the forecast screen shows it: the snapshot shape plus where the money comes from. */
export interface ForecastWeekDetail extends ForecastWeek {
  weekEnd: CalendarDate;
  arInflowCents: number;
  itemInflowCents: number;
  apOutflowCents: number;
  itemOutflowCents: number;
  flows: ForecastFlow[];
}

/* ------------------------------------------------------------------ integers */

/** `numerator / denominator` rounded half away from zero, exactly, for any safe inputs. */
export function roundDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator === BigInt(0)) throw new Error('roundDiv: division by zero.');
  const negative = numerator < BigInt(0) !== denominator < BigInt(0);
  const n = numerator < BigInt(0) ? -numerator : numerator;
  const d = denominator < BigInt(0) ? -denominator : denominator;
  const q = (n + d / BigInt(2)) / d;
  return negative ? -q : q;
}

function toSafe(value: bigint, what: string): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new Error(`${what} is outside the safe-integer range.`);
  return n;
}

/** Parses an exact decimal confidence such as `"0.750"` into thousandths (750). */
export function confidenceThousandths(confidence: string): number {
  const match = /^\s*(\d)(?:\.(\d{1,3}))?\s*$/.exec(confidence);
  if (match === null) {
    throw new PlanningError('invalid_input', `Confidence "${confidence}" must be a decimal between 0 and 1.`);
  }
  const value = Number(match[1]) * 1000 + Number((match[2] ?? '').padEnd(3, '0'));
  if (value > 1000) {
    throw new PlanningError('invalid_input', `Confidence "${confidence}" is above 1.`);
  }
  return value;
}

/** An amount scaled by its confidence, half away from zero: 1,001¢ at 0.500 is 501¢. */
export function weightByConfidence(amountCents: number, confidence: string): number {
  const thousandths = confidenceThousandths(confidence);
  if (thousandths === 1000) return amountCents;
  return toSafe(roundDiv(BigInt(amountCents) * BigInt(thousandths), BigInt(1000)), 'Weighted amount');
}

/* --------------------------------------------------------------------- dates */

/** 1970-01-05 was a Monday. */
const A_MONDAY = '1970-01-05';

/** The Monday on or before `date`. */
export function mondayOf(date: CalendarDate): CalendarDate {
  const offset = ((daysBetween(A_MONDAY, date) % 7) + 7) % 7;
  return addDays(date, -offset);
}

function iso(year: number, month: number, day: number): CalendarDate {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Every date a forecast item falls on inside `(after, through]`.
 *
 * `monthly` and `quarterly` keep the anchor's day of month, clamped to shorter
 * months (the 31st lands on 30 April and on 28 February) without drifting: the
 * next month is computed from the anchor, not from the clamped date. A
 * `semimonthly` item falls twice a month, on the anchor day and fifteen days
 * away from it — the 1st and 16th for an anchor on the 1st, the 15th and 30th
 * (the last day in a short month) for an anchor on the 15th.
 */
export function occurrences(
  anchor: CalendarDate,
  recurrence: Recurrence,
  endDate: CalendarDate | null,
  after: CalendarDate,
  through: CalendarDate,
): CalendarDate[] {
  const last = endDate !== null && endDate < through ? endDate : through;
  const out: CalendarDate[] = [];
  const keep = (date: CalendarDate): void => {
    if (date > after && date <= last && date >= anchor) out.push(date);
  };

  switch (recurrence) {
    case 'none':
      keep(anchor);
      return out;
    case 'weekly':
    case 'biweekly': {
      const step = recurrence === 'weekly' ? 7 : 14;
      let cursor = anchor;
      if (cursor <= after) {
        const behind = daysBetween(cursor, after);
        cursor = addDays(cursor, (Math.floor(behind / step) + 1) * step);
      }
      for (; cursor <= last; cursor = addDays(cursor, step)) keep(cursor);
      return out;
    }
    case 'monthly':
    case 'quarterly':
    case 'semimonthly': {
      const stepMonths = recurrence === 'quarterly' ? 3 : 1;
      const { year: ay, month: am, day: ad } = dateParts(anchor);
      const firstDay = recurrence === 'semimonthly' && ad > 15 ? ad - 15 : ad;
      const days = recurrence === 'semimonthly' ? [firstDay, firstDay + 15] : [ad];
      const start = dateParts(after);
      // Months are counted from the anchor so a clamped February never drags March.
      const skip = Math.max(0, Math.floor(((start.year - ay) * 12 + (start.month - am)) / stepMonths) - 1);
      for (let k = skip; ; k += 1) {
        const monthDate = addMonths(iso(ay, am, 1), k * stepMonths);
        if (monthDate > last) break;
        const { year, month } = dateParts(monthDate);
        for (const day of days) keep(iso(year, month, Math.min(day, daysInMonth(year, month))));
      }
      return [...new Set(out)].sort();
    }
  }
}

/* --------------------------------------------------------------------- weeks */

export interface WeekWindow {
  weekStart: CalendarDate;
  weekEnd: CalendarDate;
}

/** The thirteen Monday-to-Sunday weeks starting with the one that holds `asOf`. */
export function forecastWeeks(asOf: CalendarDate, count: number = FORECAST_WEEKS): WeekWindow[] {
  const first = mondayOf(asOf);
  return Array.from({ length: count }, (_, i) => {
    const weekStart = addDays(first, i * 7);
    return { weekStart, weekEnd: addDays(weekStart, 6) };
  });
}

/** The last date the forecast covers. */
export function horizonEnd(asOf: CalendarDate, count: number = FORECAST_WEEKS): CalendarDate {
  return addDays(mondayOf(asOf), count * 7 - 1);
}

/**
 * Buckets flows into weeks and rolls the balance forward. A flow dated on or
 * before `asOf` lands in week one (it is overdue); a flow past the horizon is
 * ignored — the caller should not have produced it.
 */
export function rollForward(
  asOf: CalendarDate,
  openingCents: number,
  flows: readonly ForecastFlow[],
  count: number = FORECAST_WEEKS,
): ForecastWeekDetail[] {
  const windows = forecastWeeks(asOf, count);
  const weeks: ForecastWeekDetail[] = windows.map((w) => ({
    weekStart: w.weekStart,
    weekEnd: w.weekEnd,
    openingCents: 0,
    inflowCents: 0,
    outflowCents: 0,
    closingCents: 0,
    arInflowCents: 0,
    itemInflowCents: 0,
    apOutflowCents: 0,
    itemOutflowCents: 0,
    flows: [],
  }));

  for (const flow of flows) {
    if (!Number.isSafeInteger(flow.amountCents) || flow.amountCents < 0) {
      throw new PlanningError('invalid_input', `Forecast flow "${flow.label}" has an invalid amount.`);
    }
    const index =
      flow.date <= asOf ? 0 : Math.floor(daysBetween(windows[0].weekStart, flow.date) / 7);
    if (index < 0 || index >= weeks.length) continue;
    const week = weeks[index];
    week.flows.push(flow);
    if (flow.direction === 'inflow') {
      week.inflowCents += flow.amountCents;
      if (flow.source === 'ar') week.arInflowCents += flow.amountCents;
      else week.itemInflowCents += flow.amountCents;
    } else {
      week.outflowCents += flow.amountCents;
      if (flow.source === 'ap') week.apOutflowCents += flow.amountCents;
      else week.itemOutflowCents += flow.amountCents;
    }
  }

  let running = openingCents;
  for (const week of weeks) {
    week.openingCents = running;
    week.closingCents = running + week.inflowCents - week.outflowCents;
    running = week.closingCents;
    week.flows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.label.localeCompare(b.label)));
  }
  return weeks;
}

/* -------------------------------------------------------------------- runway */

export interface ForecastRunway {
  /** The first week whose closing balance is below zero, or null if none in the horizon. */
  firstNegativeWeekStart: CalendarDate | null;
  lowestClosingCents: number;
  lowestWeekStart: CalendarDate;
}

export function forecastRunway(weeks: readonly ForecastWeek[]): ForecastRunway {
  if (weeks.length === 0) throw new Error('forecastRunway: no weeks.');
  let lowest = weeks[0];
  let firstNegative: ForecastWeek | null = null;
  for (const week of weeks) {
    if (week.closingCents < lowest.closingCents) lowest = week;
    if (firstNegative === null && week.closingCents < 0) firstNegative = week;
  }
  return {
    firstNegativeWeekStart: firstNegative?.weekStart ?? null,
    lowestClosingCents: lowest.closingCents,
    lowestWeekStart: lowest.weekStart,
  };
}

export interface BurnRunway {
  /** Net operating cash out over the trailing window: outflows minus operating inflows. */
  netBurnCents: number;
  windowDays: number;
  /** netBurn scaled to 7 days, half away from zero. */
  weeklyBurnCents: number;
  /** netBurn scaled to an average month (365/12 days), half away from zero. */
  monthlyBurnCents: number;
  /**
   * Whole days the cash lasts at that burn: floor(cash × windowDays ÷ netBurn).
   * Zero when there is no cash; null when the business is not burning cash.
   */
  runwayDays: number | null;
  /** asOf + runwayDays: the last day the cash covers. Null when not burning. */
  cashOutDate: CalendarDate | null;
}

/**
 * How long the cash lasts if the trailing burn continues. The honest figure for
 * a business whose forecast items are still thin: it asks nothing of anyone's
 * expectations, only of what the bank shows already happened.
 */
export function burnRunway(
  asOf: CalendarDate,
  cashCents: number,
  netBurnCents: number,
  windowDays: number,
): BurnRunway {
  if (!Number.isInteger(windowDays) || windowDays <= 0) {
    throw new PlanningError('invalid_input', 'The burn window must be a positive number of days.');
  }
  const burn = BigInt(netBurnCents);
  const days = BigInt(windowDays);
  const weeklyBurnCents = toSafe(roundDiv(burn * BigInt(7), days), 'Weekly burn');
  const monthlyBurnCents = toSafe(roundDiv(burn * BigInt(365), days * BigInt(12)), 'Monthly burn');

  let runwayDays: number | null;
  if (netBurnCents <= 0) runwayDays = null;
  else if (cashCents <= 0) runwayDays = 0;
  else runwayDays = toSafe((BigInt(cashCents) * days) / burn, 'Runway');

  return {
    netBurnCents,
    windowDays,
    weeklyBurnCents,
    monthlyBurnCents,
    runwayDays,
    cashOutDate: runwayDays === null ? null : addDays(asOf, runwayDays),
  };
}

/* ------------------------------------------------------------------- scoring */

export interface ActualWeek {
  weekStart: CalendarDate;
  openingCents: number;
  inflowCents: number;
  outflowCents: number;
  closingCents: number;
}

export interface ScoredWeek {
  weekStart: CalendarDate;
  projected: ForecastWeek;
  actual: ActualWeek;
  /** actual − projected. */
  inflowVarianceCents: number;
  outflowVarianceCents: number;
  closingVarianceCents: number;
}

export interface ForecastScore {
  weeks: ScoredWeek[];
  /** Weeks of the snapshot not yet over on the scoring date, and so not scored. */
  unscoredWeeks: number;
  projectedInflowCents: number;
  actualInflowCents: number;
  projectedOutflowCents: number;
  actualOutflowCents: number;
  /** Mean of |closing variance| across scored weeks, half away from zero. 0 with no weeks. */
  meanAbsClosingErrorCents: number;
  /** The last scored week's closing variance: where the forecast ended up versus reality. */
  finalClosingVarianceCents: number;
}

/** Compares a frozen forecast with what happened, week by week. Pure. */
export function scoreWeeks(
  projected: readonly ForecastWeek[],
  actual: readonly ActualWeek[],
): ForecastScore {
  const actualByWeek = new Map(actual.map((week) => [week.weekStart, week]));
  const weeks: ScoredWeek[] = [];
  for (const p of projected) {
    const a = actualByWeek.get(p.weekStart);
    if (a === undefined) continue;
    weeks.push({
      weekStart: p.weekStart,
      projected: p,
      actual: a,
      inflowVarianceCents: a.inflowCents - p.inflowCents,
      outflowVarianceCents: a.outflowCents - p.outflowCents,
      closingVarianceCents: a.closingCents - p.closingCents,
    });
  }

  const sum = (values: number[]): number => values.reduce((total, v) => total + v, 0);
  const absErrors = sum(weeks.map((w) => Math.abs(w.closingVarianceCents)));
  return {
    weeks,
    unscoredWeeks: projected.length - weeks.length,
    projectedInflowCents: sum(weeks.map((w) => w.projected.inflowCents)),
    actualInflowCents: sum(weeks.map((w) => w.actual.inflowCents)),
    projectedOutflowCents: sum(weeks.map((w) => w.projected.outflowCents)),
    actualOutflowCents: sum(weeks.map((w) => w.actual.outflowCents)),
    meanAbsClosingErrorCents:
      weeks.length === 0 ? 0 : toSafe(roundDiv(BigInt(absErrors), BigInt(weeks.length)), 'Mean error'),
    finalClosingVarianceCents: weeks.length === 0 ? 0 : weeks[weeks.length - 1].closingVarianceCents,
  };
}

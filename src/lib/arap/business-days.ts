/**
 * Banking days: Monday to Friday, less the Federal Reserve holidays, when ACH
 * and wires do not settle. Used to judge whether a bank line is close enough to
 * a document's due date to be its payment.
 *
 * Fed rules: a holiday on a Sunday is observed the Monday after; one on a
 * Saturday is not moved (the Fed stays open that Friday).
 */

import { type CalendarDate, addDays, dateParts, daysBetween, daysInMonth } from '@/lib/dates';

/** 0 = Sunday … 6 = Saturday. 1970-01-01 was a Thursday. */
export function dayOfWeek(date: CalendarDate): number {
  const days = daysBetween('1970-01-01', date);
  return (((days + 4) % 7) + 7) % 7;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function ymd(year: number, month: number, day: number): CalendarDate {
  return `${String(year)}-${pad(month)}-${pad(day)}`;
}

/** The nth given weekday of a month (n = 1..4), or the last one when n = -1. */
function nthWeekday(year: number, month: number, weekday: number, n: number): CalendarDate {
  if (n === -1) {
    let date = ymd(year, month, daysInMonth(year, month));
    while (dayOfWeek(date) !== weekday) date = addDays(date, -1);
    return date;
  }
  let date = ymd(year, month, 1);
  while (dayOfWeek(date) !== weekday) date = addDays(date, 1);
  return addDays(date, 7 * (n - 1));
}

function observed(date: CalendarDate): CalendarDate {
  return dayOfWeek(date) === 0 ? addDays(date, 1) : date;
}

const holidayCache = new Map<number, ReadonlySet<CalendarDate>>();

/** Federal Reserve bank holidays observed in `year`. */
export function fedHolidays(year: number): ReadonlySet<CalendarDate> {
  const cached = holidayCache.get(year);
  if (cached) return cached;
  const days = [
    observed(ymd(year, 1, 1)),
    nthWeekday(year, 1, 1, 3), // Martin Luther King Jr. Day
    nthWeekday(year, 2, 1, 3), // Washington's Birthday
    nthWeekday(year, 5, 1, -1), // Memorial Day
    ...(year >= 2022 ? [observed(ymd(year, 6, 19))] : []), // Juneteenth
    observed(ymd(year, 7, 4)),
    nthWeekday(year, 9, 1, 1), // Labor Day
    nthWeekday(year, 10, 1, 2), // Columbus Day
    observed(ymd(year, 11, 11)), // Veterans Day
    nthWeekday(year, 11, 4, 4), // Thanksgiving
    observed(ymd(year, 12, 25)),
  ];
  const set = new Set(days);
  holidayCache.set(year, set);
  return set;
}

export function isBusinessDay(date: CalendarDate): boolean {
  const dow = dayOfWeek(date);
  if (dow === 0 || dow === 6) return false;
  return !fedHolidays(dateParts(date).year).has(date);
}

/**
 * Banking days from `from` to `to`: the number of business days after `from`
 * up to and including `to`, negative when `to` is earlier. Friday to the next
 * Monday is 1.
 */
export function businessDaysBetween(from: CalendarDate, to: CalendarDate): number {
  if (from === to) return 0;
  const forward = to > from;
  const [start, end] = forward ? [from, to] : [to, from];
  let count = 0;
  for (let d = addDays(start, 1); d <= end; d = addDays(d, 1)) {
    if (isBusinessDay(d)) count += 1;
  }
  return forward ? count : -count;
}

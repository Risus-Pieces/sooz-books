/**
 * Accounting dates are calendar dates: no clock, no zone, no offset. They are
 * carried end to end as `YYYY-MM-DD` strings and every helper here works on
 * integer day counts, so nothing can shift a posting into the wrong month
 * because the server happens to run in UTC and the bookkeeper does not.
 */

/** A calendar date in `YYYY-MM-DD` form. */
export type CalendarDate = string;

export interface DateParts {
  year: number;
  month: number;
  day: number;
}

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAMED = /^(\d{1,2})[-/. ]([A-Za-z]{3,9})[-/. ](\d{2}|\d{4})$/;
const US = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/;
const SERIAL = /^\d+(?:\.\d+)?$/;

const MONTH_NAMES = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];

/** Excel serial 61 is 1900-03-01, and every serial above it is 1899-12-30 + n days. */
const EXCEL_EPOCH_DAY = -25569;
const MIN_EXCEL_SERIAL = 61;
/** 9999-12-31, the last date Excel will represent. */
const MAX_EXCEL_SERIAL = 2958465;

function unparseable(input: string | number, reason: string): never {
  throw new Error(`Cannot read ${JSON.stringify(input)} as a date: ${reason}.`);
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

function isRealDate(year: number, month: number, day: number): boolean {
  return (
    Number.isInteger(year) &&
    Number.isInteger(month) &&
    Number.isInteger(day) &&
    year >= 1 &&
    year <= 9999 &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth(year, month)
  );
}

/** Days since 1970-01-01 in the proleptic Gregorian calendar (Hinnant's algorithm). */
function daysFromCivil(year: number, month: number, day: number): number {
  const y = year - (month <= 2 ? 1 : 0);
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function civilFromDays(epochDay: number): DateParts {
  const z = epochDay + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365,
  );
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp + (mp < 10 ? 3 : -9);
  return { year: yoe + era * 400 + (month <= 2 ? 1 : 0), month, day };
}

function toCalendarDate(year: number, month: number, day: number): CalendarDate {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function isCalendarDate(value: unknown): value is CalendarDate {
  if (typeof value !== 'string') return false;
  const match = ISO.exec(value);
  return match !== null && isRealDate(Number(match[1]), Number(match[2]), Number(match[3]));
}

/** Splits a calendar date into its numeric parts, rejecting anything malformed. */
export function dateParts(date: CalendarDate): DateParts {
  const match = ISO.exec(date);
  if (!match) {
    throw new Error(`Expected a YYYY-MM-DD calendar date, received ${JSON.stringify(date)}.`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!isRealDate(year, month, day)) {
    throw new Error(`${date} is not a real calendar date.`);
  }
  return { year, month, day };
}

function epochDayOf(date: CalendarDate): number {
  const { year, month, day } = dateParts(date);
  return daysFromCivil(year, month, day);
}

/**
 * The time zone the books are kept in. "Today", the current period and every
 * default date window are read on this calendar — never on the clock of whatever
 * machine happens to run the code. Server components and Vercel functions run in
 * UTC, where a US evening is already tomorrow: read from the process's own zone,
 * a 7pm entry on the last day of a month would default into the next month.
 */
export const BOOKS_TIME_ZONE = 'America/Chicago';

const dayFormatters = new Map<string, Intl.DateTimeFormat>();

/** The calendar date `instant` falls on in `timeZone` (an IANA zone name). */
export function calendarDateAt(instant: Date, timeZone: string = BOOKS_TIME_ZONE): CalendarDate {
  let formatter = dayFormatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      calendar: 'gregory',
      numberingSystem: 'latn',
    });
    dayFormatters.set(timeZone, formatter);
  }

  let year = 0;
  let month = 0;
  let day = 0;
  for (const part of formatter.formatToParts(instant)) {
    if (part.type === 'year') year = Number(part.value);
    else if (part.type === 'month') month = Number(part.value);
    else if (part.type === 'day') day = Number(part.value);
  }
  if (!isRealDate(year, month, day)) {
    throw new Error(`Could not read a calendar date for ${instant.toISOString()} in ${timeZone}.`);
  }
  return toCalendarDate(year, month, day);
}

/** Today on the books' calendar (`BOOKS_TIME_ZONE`), wherever this code runs. */
export function today(): CalendarDate {
  return calendarDateAt(new Date());
}

function fromExcelSerial(serial: number, original: string | number): CalendarDate {
  if (!Number.isFinite(serial)) unparseable(original, 'not a finite serial number');
  // Excel stores the clock in the fraction; a calendar date keeps only the day.
  const days = Math.floor(serial);
  if (days < MIN_EXCEL_SERIAL || days > MAX_EXCEL_SERIAL) {
    // Serials below 61 land in Jan–Feb 1900, where Excel's phantom 29 February
    // makes the mapping ambiguous. A number that low is far more often a
    // quantity read out of the wrong column than a real date.
    unparseable(
      original,
      `outside the usable Excel serial range ${MIN_EXCEL_SERIAL}–${MAX_EXCEL_SERIAL}`,
    );
  }
  const { year, month, day } = civilFromDays(EXCEL_EPOCH_DAY + days);
  return toCalendarDate(year, month, day);
}

function expandYear(text: string): number {
  const value = Number(text);
  if (text.length === 4) return value;
  return value < 70 ? 2000 + value : 1900 + value;
}

function monthFromName(name: string, original: string): number {
  const lower = name.toLowerCase();
  const index = MONTH_NAMES.findIndex((month) => month.startsWith(lower) && lower.length >= 3);
  if (index === -1) unparseable(original, `"${name}" is not a month name`);
  return index + 1;
}

function build(year: number, month: number, day: number, original: string | number): CalendarDate {
  if (!isRealDate(year, month, day)) {
    unparseable(original, `${year}-${month}-${day} is not a real calendar date`);
  }
  return toCalendarDate(year, month, day);
}

/**
 * Reads a date out of a CSV cell, a form field or a spreadsheet. Accepts
 * `YYYY-MM-DD`, `MM/DD/YYYY`, `M/D/YY`, `DD-MMM-YYYY` (`15-Mar-2026`) and raw
 * Excel serial numbers, as a number or as the string a CSV parser hands back.
 */
export function parseDateInput(input: string | number): CalendarDate {
  if (typeof input === 'number') return fromExcelSerial(input, input);

  const text = input.trim();
  if (text === '') unparseable(input, 'empty');

  const iso = ISO.exec(text);
  if (iso) return build(Number(iso[1]), Number(iso[2]), Number(iso[3]), input);

  const named = NAMED.exec(text);
  if (named) {
    return build(expandYear(named[3]), monthFromName(named[2], text), Number(named[1]), input);
  }

  const us = US.exec(text);
  if (us) return build(expandYear(us[3]), Number(us[1]), Number(us[2]), input);

  if (SERIAL.test(text)) return fromExcelSerial(Number(text), input);

  unparseable(input, 'unrecognised date format');
}

/** The accounting period a date falls in. */
export function periodOf(date: CalendarDate): { year: number; month: number } {
  const { year, month } = dateParts(date);
  return { year, month };
}

export function monthStart(date: CalendarDate): CalendarDate {
  const { year, month } = dateParts(date);
  return toCalendarDate(year, month, 1);
}

export function monthEnd(date: CalendarDate): CalendarDate {
  const { year, month } = dateParts(date);
  return toCalendarDate(year, month, daysInMonth(year, month));
}

export function addDays(date: CalendarDate, days: number): CalendarDate {
  const { year, month, day } = civilFromDays(epochDayOf(date) + Math.trunc(days));
  return toCalendarDate(year, month, day);
}

/** Whole days from `from` to `to`; negative when `to` is the earlier date. */
export function daysBetween(from: CalendarDate, to: CalendarDate): number {
  return epochDayOf(to) - epochDayOf(from);
}

/** `2026-03-15` as `03/15/2026`. */
export function formatDateUS(date: CalendarDate): string {
  const { year, month, day } = dateParts(date);
  return `${String(month).padStart(2, '0')}/${String(day).padStart(2, '0')}/${year}`;
}

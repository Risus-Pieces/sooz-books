import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  addDays,
  BOOKS_TIME_ZONE,
  calendarDateAt,
  daysBetween,
  daysInMonth,
  dateParts,
  formatDateUS,
  isCalendarDate,
  monthEnd,
  monthStart,
  parseDateInput,
  periodOf,
  today,
} from '@/lib/dates';

describe('today', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads the books\' calendar, not the clock of the machine running it', () => {
    // 7pm in Chicago on the last day of September is already 1 October in UTC,
    // which is the zone server components and Vercel functions run in.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-01T00:30:00Z'));
    expect(today()).toBe('2026-09-30');
    expect(periodOf(today())).toEqual({ year: 2026, month: 9 });

    // The same instant an hour after Chicago's midnight is the 1st there too.
    vi.setSystemTime(new Date('2026-10-01T06:00:00Z'));
    expect(today()).toBe('2026-10-01');
  });

  it('is always a calendar date', () => {
    expect(isCalendarDate(today())).toBe(true);
    expect(today()).toBe(calendarDateAt(new Date(), BOOKS_TIME_ZONE));
  });
});

describe('calendarDateAt', () => {
  it('turns the day over at midnight in the zone asked for', () => {
    // CDT is UTC-5.
    expect(calendarDateAt(new Date('2026-07-01T04:59:59Z'), 'America/Chicago')).toBe('2026-06-30');
    expect(calendarDateAt(new Date('2026-07-01T05:00:00Z'), 'America/Chicago')).toBe('2026-07-01');
    // CST is UTC-6.
    expect(calendarDateAt(new Date('2027-01-01T05:59:59Z'), 'America/Chicago')).toBe('2026-12-31');
    expect(calendarDateAt(new Date('2027-01-01T06:00:00Z'), 'America/Chicago')).toBe('2027-01-01');
    expect(calendarDateAt(new Date('2026-03-01T07:59:59Z'), 'America/Los_Angeles')).toBe('2026-02-28');
    expect(calendarDateAt(new Date('2026-03-01T00:00:00Z'), 'UTC')).toBe('2026-03-01');
  });

  it('keeps leap days and four-digit years', () => {
    expect(calendarDateAt(new Date('2028-02-29T18:00:00Z'), 'America/Chicago')).toBe('2028-02-29');
  });
});

describe('parseDateInput', () => {
  it('reads ISO dates', () => {
    expect(parseDateInput('2026-03-15')).toBe('2026-03-15');
    expect(parseDateInput('  2026-03-15  ')).toBe('2026-03-15');
    expect(parseDateInput('2024-02-29')).toBe('2024-02-29');
  });

  it('reads US numeric dates', () => {
    expect(parseDateInput('03/15/2026')).toBe('2026-03-15');
    expect(parseDateInput('3/15/2026')).toBe('2026-03-15');
    expect(parseDateInput('3/5/26')).toBe('2026-03-05');
    expect(parseDateInput('12/31/99')).toBe('1999-12-31');
    expect(parseDateInput('1/1/00')).toBe('2000-01-01');
    expect(parseDateInput('3-15-2026')).toBe('2026-03-15');
    expect(parseDateInput('3.15.2026')).toBe('2026-03-15');
  });

  it('reads DD-MMM-YYYY dates', () => {
    expect(parseDateInput('15-Mar-2026')).toBe('2026-03-15');
    expect(parseDateInput('15-mar-2026')).toBe('2026-03-15');
    expect(parseDateInput('1-Jan-2026')).toBe('2026-01-01');
    expect(parseDateInput('15 March 2026')).toBe('2026-03-15');
    expect(parseDateInput('30-Sept-2026')).toBe('2026-09-30');
    expect(parseDateInput('15-Mar-26')).toBe('2026-03-15');
  });

  it('reads Excel serial numbers as numbers or strings', () => {
    expect(parseDateInput(45000)).toBe('2023-03-15');
    expect(parseDateInput('45000')).toBe('2023-03-15');
    // Excel keeps the clock in the fraction; a calendar date keeps only the day.
    expect(parseDateInput(45000.75)).toBe('2023-03-15');
    expect(parseDateInput(61)).toBe('1900-03-01');
    expect(parseDateInput(2958465)).toBe('9999-12-31');
    expect(parseDateInput(44927)).toBe('2023-01-01');
  });

  it('rejects impossible and unrecognised input', () => {
    for (const bad of [
      '',
      '   ',
      'hello',
      '2026-13-01',
      '2026-02-30',
      '02/30/2026',
      '13/01/2026',
      '15-Smarch-2026',
      '2026/03/15',
      '2026-3-15',
    ]) {
      expect(() => parseDateInput(bad), bad).toThrow(/Cannot read/);
    }
    // Excel's phantom 1900 leap day makes every serial below 61 ambiguous.
    expect(() => parseDateInput(60)).toThrow(/Excel serial range/);
    expect(() => parseDateInput(0)).toThrow(/Excel serial range/);
    expect(() => parseDateInput(2958466)).toThrow(/Excel serial range/);
    expect(() => parseDateInput(Number.NaN)).toThrow(/Cannot read/);
  });
});

describe('dateParts and isCalendarDate', () => {
  it('splits a valid date', () => {
    expect(dateParts('2026-03-15')).toEqual({ year: 2026, month: 3, day: 15 });
  });

  it('rejects malformed or impossible dates', () => {
    expect(() => dateParts('3/15/2026')).toThrow(/YYYY-MM-DD/);
    expect(() => dateParts('2026-02-30')).toThrow(/not a real calendar date/);
    expect(isCalendarDate('2026-02-30')).toBe(false);
    expect(isCalendarDate('2026-2-3')).toBe(false);
    expect(isCalendarDate(20260315)).toBe(false);
    expect(isCalendarDate('2026-02-28')).toBe(true);
  });
});

describe('periodOf', () => {
  it('returns the accounting year and month', () => {
    expect(periodOf('2026-03-15')).toEqual({ year: 2026, month: 3 });
    expect(periodOf('2026-01-01')).toEqual({ year: 2026, month: 1 });
    expect(periodOf('2025-12-31')).toEqual({ year: 2025, month: 12 });
  });
});

describe('monthStart and monthEnd', () => {
  it('bounds ordinary months', () => {
    expect(monthStart('2026-03-15')).toBe('2026-03-01');
    expect(monthEnd('2026-03-15')).toBe('2026-03-31');
    expect(monthEnd('2026-04-01')).toBe('2026-04-30');
    expect(monthEnd('2026-12-25')).toBe('2026-12-31');
  });

  it('gets February right in every leap-year case', () => {
    expect(monthEnd('2026-02-10')).toBe('2026-02-28');
    expect(monthEnd('2024-02-10')).toBe('2024-02-29');
    expect(monthEnd('2000-02-10')).toBe('2000-02-29');
    expect(monthEnd('1900-02-10')).toBe('1900-02-28');
    expect(daysInMonth(2100, 2)).toBe(28);
  });
});

describe('addDays', () => {
  it('moves across month and year boundaries', () => {
    expect(addDays('2026-03-15', 1)).toBe('2026-03-16');
    expect(addDays('2026-03-31', 1)).toBe('2026-04-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
    expect(addDays('2026-03-15', 0)).toBe('2026-03-15');
    expect(addDays('2026-03-15', 365)).toBe('2027-03-15');
  });

  it('does not drift across a daylight-saving boundary', () => {
    // US DST starts 2026-03-08 and ends 2026-11-01; a local-time Date would land
    // on the wrong day for at least one of these.
    expect(addDays('2026-03-07', 1)).toBe('2026-03-08');
    expect(addDays('2026-03-08', 1)).toBe('2026-03-09');
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-11-01', 1)).toBe('2026-11-02');
  });

  it('walks a whole year one day at a time without losing a date', () => {
    let cursor = '2024-01-01';
    let steps = 0;
    while (cursor !== '2025-01-01') {
      cursor = addDays(cursor, 1);
      steps += 1;
      expect(isCalendarDate(cursor)).toBe(true);
    }
    expect(steps).toBe(366);
  });
});

describe('daysBetween', () => {
  it('counts whole days, signed', () => {
    expect(daysBetween('2026-03-15', '2026-03-16')).toBe(1);
    expect(daysBetween('2026-03-16', '2026-03-15')).toBe(-1);
    expect(daysBetween('2026-03-15', '2026-03-15')).toBe(0);
    expect(daysBetween('2026-01-01', '2027-01-01')).toBe(365);
    expect(daysBetween('2024-01-01', '2025-01-01')).toBe(366);
    expect(daysBetween('2026-01-31', '2026-03-01')).toBe(29);
  });

  it('is the inverse of addDays', () => {
    for (const offset of [0, 1, -1, 45, -45, 1000, -1000]) {
      expect(daysBetween('2026-03-15', addDays('2026-03-15', offset))).toBe(offset);
    }
  });
});

describe('formatDateUS', () => {
  it('renders MM/DD/YYYY', () => {
    expect(formatDateUS('2026-03-15')).toBe('03/15/2026');
    expect(formatDateUS('2026-12-01')).toBe('12/01/2026');
    expect(parseDateInput(formatDateUS('2026-03-05'))).toBe('2026-03-05');
  });
});

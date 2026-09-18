import { describe, expect, it } from 'vitest';

import {
  allocateCents,
  formatMoney,
  formatMoneyPlain,
  parseMoney,
  sumCents,
} from '@/lib/money';

describe('parseMoney', () => {
  it('reads the plain and grouped forms', () => {
    expect(parseMoney('1234.56')).toBe(123456);
    expect(parseMoney('1,234.56')).toBe(123456);
    expect(parseMoney('$1,234.56')).toBe(123456);
    expect(parseMoney('$ 1,234.56')).toBe(123456);
    expect(parseMoney('1,234,567.89')).toBe(123456789);
  });

  it('reads every negative form', () => {
    expect(parseMoney('(1,234.56)')).toBe(-123456);
    expect(parseMoney('($1,234.56)')).toBe(-123456);
    expect(parseMoney('$(1,234.56)')).toBe(-123456);
    expect(parseMoney('( 1,234.56 )')).toBe(-123456);
    expect(parseMoney('1234.56-')).toBe(-123456);
    expect(parseMoney('$1,234.56-')).toBe(-123456);
    expect(parseMoney('-1234.56')).toBe(-123456);
    expect(parseMoney('-$1,234.56')).toBe(-123456);
    expect(parseMoney('$-1,234.56')).toBe(-123456);
  });

  it('reads numbers', () => {
    expect(parseMoney(1234.56)).toBe(123456);
    expect(parseMoney(-1234.56)).toBe(-123456);
    expect(parseMoney(0)).toBe(0);
    expect(parseMoney(7)).toBe(700);
    // Below half a cent, so it rounds away rather than erroring.
    expect(parseMoney(1e-9)).toBe(0);
  });

  it('is exact, with no float drift', () => {
    // 1.005 * 100 is 100.49999999999999 in binary floating point.
    expect(parseMoney('1.005')).toBe(101);
    // 2.675 * 100 is 267.49999999999994.
    expect(parseMoney('2.675')).toBe(268);
    expect(parseMoney('0.145')).toBe(15);
    expect(parseMoney('1.004')).toBe(100);
    expect(parseMoney('1.0049999')).toBe(100);
    expect(parseMoney('0.999')).toBe(100);
    expect(parseMoney('0.005')).toBe(1);
    expect(parseMoney('0.004')).toBe(0);
    expect(parseMoney('-1.005')).toBe(-101);
    expect(parseMoney('(1.005)')).toBe(-101);
  });

  it('accepts partial decimal forms', () => {
    expect(parseMoney('.5')).toBe(50);
    expect(parseMoney('1.')).toBe(100);
    expect(parseMoney('1.5')).toBe(150);
    expect(parseMoney('+12.34')).toBe(1234);
    expect(parseMoney('0')).toBe(0);
    expect(parseMoney('-0.00')).toBe(0);
  });

  it('rejects garbage with a descriptive error', () => {
    for (const bad of ['', '   ', 'abc', '$', '-', '()', '1.2.3', '(1', '1)', '12a', '1 2 3.4.5']) {
      expect(() => parseMoney(bad), bad).toThrow(/Cannot read/);
    }
    expect(() => parseMoney('--1.00')).toThrow(/Cannot read/);
    expect(() => parseMoney('-1.00-')).toThrow(/negative sign/);
    expect(() => parseMoney(Number.NaN)).toThrow(/finite/);
    expect(() => parseMoney(Number.POSITIVE_INFINITY)).toThrow(/finite/);
    expect(() => parseMoney('99999999999999999999')).toThrow(/too large/);
    expect(() => parseMoney(1e21)).toThrow(/too large/);
  });
});

describe('formatMoney', () => {
  it('formats positive amounts', () => {
    expect(formatMoney(123456)).toBe('$1,234.56');
    expect(formatMoney(5)).toBe('$0.05');
    expect(formatMoney(50)).toBe('$0.50');
    expect(formatMoney(100)).toBe('$1.00');
    expect(formatMoney(100000000)).toBe('$1,000,000.00');
    expect(formatMoney(0)).toBe('$0.00');
  });

  it('formats negative amounts both ways', () => {
    expect(formatMoney(-123456)).toBe('-$1,234.56');
    expect(formatMoney(-123456, { parens: true })).toBe('($1,234.56)');
    expect(formatMoney(-5, { parens: true })).toBe('($0.05)');
  });

  it('can blank out zero', () => {
    expect(formatMoney(0, { showZero: false })).toBe('');
    expect(formatMoney(0, { showZero: true })).toBe('$0.00');
    expect(formatMoney(1, { showZero: false })).toBe('$0.01');
  });

  it('refuses non-integer cents', () => {
    expect(() => formatMoney(1.5)).toThrow(/whole number of cents/);
    expect(() => formatMoney(Number.NaN)).toThrow(/whole number of cents/);
  });

  it('round-trips through parseMoney', () => {
    for (const cents of [0, 1, -1, 99, 100, -123456, 987654321]) {
      expect(parseMoney(formatMoney(cents))).toBe(cents);
    }
  });
});

describe('formatMoneyPlain', () => {
  it('drops the symbol and the grouping for CSV', () => {
    expect(formatMoneyPlain(123456)).toBe('1234.56');
    expect(formatMoneyPlain(-123456)).toBe('-1234.56');
    expect(formatMoneyPlain(0)).toBe('0.00');
    expect(formatMoneyPlain(-5)).toBe('-0.05');
    expect(formatMoneyPlain(100000000)).toBe('1000000.00');
  });
});

describe('sumCents', () => {
  it('sums an iterable or an argument list', () => {
    expect(sumCents([100, 250, -50])).toBe(300);
    expect(sumCents(100, 250, -50)).toBe(300);
    expect(sumCents([])).toBe(0);
    expect(sumCents()).toBe(0);
    expect(sumCents(new Set([100, 200]))).toBe(300);
  });

  it('refuses non-integer cents', () => {
    expect(() => sumCents([100, 0.5])).toThrow(/whole number of cents/);
  });
});

describe('allocateCents', () => {
  it('splits evenly and gives the remainder to the earliest parts', () => {
    expect(allocateCents(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(allocateCents(1, [1, 1, 1])).toEqual([1, 0, 0]);
    expect(allocateCents(10, [1, 1])).toEqual([5, 5]);
  });

  it('splits in proportion', () => {
    expect(allocateCents(1000, [1, 2, 3])).toEqual([167, 333, 500]);
    expect(allocateCents(700, [0.5, 0.25, 0.25])).toEqual([350, 175, 175]);
    expect(allocateCents(7, [0.5, 0.25, 0.25])).toEqual([3, 2, 2]);
  });

  it('gives a zero weight nothing', () => {
    expect(allocateCents(10, [0, 1])).toEqual([0, 10]);
    expect(allocateCents(101, [0, 1, 1])).toEqual([0, 51, 50]);
  });

  it('handles negative totals without producing -0', () => {
    expect(allocateCents(-100, [1, 1, 1])).toEqual([-34, -33, -33]);
    expect(allocateCents(-1, [1, 1])).toEqual([-1, 0]);
    expect(Object.is(allocateCents(-1, [1, 1])[1], -0)).toBe(false);
  });

  it('handles the degenerate cases', () => {
    expect(allocateCents(0, [1, 2, 3])).toEqual([0, 0, 0]);
    expect(allocateCents(0, [0, 0])).toEqual([0, 0]);
    expect(allocateCents(0, [])).toEqual([]);
    expect(allocateCents(500, [3])).toEqual([500]);
  });

  it('always sums to exactly the total', () => {
    const totals = [0, 1, 7, 99, 100, 101, 999, 1000, 123457, -1, -7, -99, -123457, 1000000007];
    const weightSets = [
      [1, 1, 1],
      [1, 2, 3],
      [1, 1, 1, 1, 1, 1, 1],
      [0.1, 0.2, 0.7],
      [1, 0, 2, 0, 3],
      [1e-6, 1, 1e6],
      [3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3],
      [17, 23, 41, 59, 61],
      [1],
    ];
    for (const total of totals) {
      for (const weights of weightSets) {
        const parts = allocateCents(total, weights);
        expect(parts, `${total} over [${weights.join(', ')}]`).toHaveLength(weights.length);
        expect(sumCents(parts), `${total} over [${weights.join(', ')}]`).toBe(total);
      }
    }
  });

  it('keeps every part a whole number of cents', () => {
    for (const part of allocateCents(100000, [7.3, 11.9, 0.4, 88.2])) {
      expect(Number.isSafeInteger(part)).toBe(true);
    }
  });

  it('refuses inputs it cannot allocate', () => {
    expect(() => allocateCents(100, [])).toThrow(/zero parts/);
    expect(() => allocateCents(100, [0, 0])).toThrow(/every weight is zero/i);
    expect(() => allocateCents(100, [1, -1])).toThrow(/non-negative/);
    expect(() => allocateCents(100, [1, Number.NaN])).toThrow(/non-negative/);
    expect(() => allocateCents(1.5, [1, 1])).toThrow(/whole number of cents/);
  });
});

import { describe, expect, it } from 'vitest';

import { axisMoney, daysBetween, dollars, initials, shortDate, wholeDollars } from './format';
import { divergingTicks, evenTicks, niceStep } from './scale';

describe('chart labels', () => {
  it('formats cents without floating point', () => {
    expect(dollars(53014)).toBe('$530.14');
    expect(dollars(-649025)).toBe('−$6,490.25');
    expect(dollars(0)).toBe('$0.00');
    expect(wholeDollars(138172)).toBe('$1,382');
    expect(wholeDollars(-49)).toBe('$0');
  });

  it('labels an axis in dollars, or thousands once the step is $1,000', () => {
    expect(axisMoney(0, 40_000)).toBe('$0');
    expect(axisMoney(40_000, 40_000)).toBe('$400');
    expect(axisMoney(120_000, 40_000)).toBe('$1,200');
    expect(axisMoney(300_000, 100_000)).toBe('$3K');
    expect(axisMoney(-100_000, 100_000)).toBe('−$1K');
    expect(axisMoney(150_000, 250_000)).toBe('$1.5K');
  });

  it('reads calendar dates as text', () => {
    expect(shortDate('2026-09-29')).toBe('Sep 29');
    expect(daysBetween('2026-09-18', '2026-09-29')).toBe(11);
    expect(daysBetween('2026-02-28', '2026-03-01')).toBe(1);
    expect(daysBetween('2024-02-28', '2024-03-01')).toBe(2);
  });

  it('makes monograms', () => {
    expect(initials("Dave's Hot Chicken")).toBe('DH');
    expect(initials('FedEx')).toBe('F');
    expect(initials('AMCO Proteins')).toBe('AP');
  });
});

describe('axis scales', () => {
  it('picks nice steps', () => {
    expect(niceStep(90_000)).toBe(100_000);
    expect(niceStep(33_000)).toBe(50_000);
    expect(niceStep(21_000)).toBe(25_000);
  });

  it('always includes $0 and uses even steps', () => {
    const t = evenTicks(0, 115_000, 3);
    expect(t.values).toContain(0);
    expect(t.values[t.values.length - 1]).toBeGreaterThanOrEqual(115_000);
    const gaps = t.values.slice(1).map((v, i) => v - t.values[i]);
    expect(new Set(gaps).size).toBe(1);
  });

  it('diverges symmetrically from zero without padding past one step', () => {
    const t = divergingTicks(302_000, 310_000, 6);
    expect(t.values).toContain(0);
    const gaps = t.values.slice(1).map((v, i) => v - t.values[i]);
    expect(new Set(gaps).size).toBe(1);
    expect(t.max - 302_000).toBeLessThan(t.step);
    expect(-t.min - 310_000).toBeLessThan(t.step);
  });
});

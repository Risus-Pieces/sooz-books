import { describe, expect, it } from 'vitest';

import {
  type ForecastFlow,
  burnRunway,
  confidenceThousandths,
  forecastRunway,
  forecastWeeks,
  horizonEnd,
  mondayOf,
  occurrences,
  rollForward,
  roundDiv,
  scoreWeeks,
  weightByConfidence,
} from './forecast-math';

function flow(
  date: string,
  direction: 'inflow' | 'outflow',
  amountCents: number,
  source: ForecastFlow['source'] = 'item',
  overdue = false,
): ForecastFlow {
  return { date, direction, amountCents, source, label: `${direction} ${date}`, refId: date, overdue };
}

describe('integer helpers', () => {
  it('rounds half away from zero exactly', () => {
    expect(roundDiv(BigInt(5), BigInt(2))).toBe(BigInt(3));
    expect(roundDiv(BigInt(-5), BigInt(2))).toBe(BigInt(-3));
    expect(roundDiv(BigInt(4), BigInt(3))).toBe(BigInt(1));
    expect(roundDiv(BigInt(9_007_199_254_740_991) * BigInt(999), BigInt(1000))).toBe(
      BigInt('8998192055486250'),
    );
  });

  it('reads confidence as exact thousandths', () => {
    expect(confidenceThousandths('1.000')).toBe(1000);
    expect(confidenceThousandths('0.75')).toBe(750);
    expect(confidenceThousandths('0.5')).toBe(500);
    expect(confidenceThousandths('0')).toBe(0);
    expect(() => confidenceThousandths('1.5')).toThrow(/above 1/);
    expect(() => confidenceThousandths('abc')).toThrow(/decimal/);
  });

  it('weights an amount by confidence, half away from zero', () => {
    expect(weightByConfidence(150_001, '0.500')).toBe(75_001);
    expect(weightByConfidence(10_000, '0.333')).toBe(3_330);
    expect(weightByConfidence(10_000, '1.000')).toBe(10_000);
    expect(weightByConfidence(10_000, '0.000')).toBe(0);
  });
});

describe('weeks', () => {
  it('names weeks by their Monday', () => {
    expect(mondayOf('2031-03-05')).toBe('2031-03-03'); // a Wednesday
    expect(mondayOf('2031-03-03')).toBe('2031-03-03');
    expect(mondayOf('2031-03-09')).toBe('2031-03-03'); // a Sunday
    expect(mondayOf('2026-09-18')).toBe('2026-09-14');
    const weeks = forecastWeeks('2031-03-05');
    expect(weeks).toHaveLength(13);
    expect(weeks[0]).toEqual({ weekStart: '2031-03-03', weekEnd: '2031-03-09' });
    expect(weeks[12]).toEqual({ weekStart: '2031-05-26', weekEnd: '2031-06-01' });
    expect(horizonEnd('2031-03-05')).toBe('2031-06-01');
  });
});

describe('recurrence expansion', () => {
  it('keeps a monthly anchor day without drifting after a short month', () => {
    expect(occurrences('2031-01-31', 'monthly', null, '2031-01-01', '2031-05-31')).toEqual([
      '2031-01-31',
      '2031-02-28',
      '2031-03-31',
      '2031-04-30',
      '2031-05-31',
    ]);
  });

  it('only returns dates after the as-of date and within the end date', () => {
    expect(occurrences('2031-02-26', 'weekly', '2031-03-26', '2031-03-05', '2031-06-01')).toEqual([
      '2031-03-12',
      '2031-03-19',
      '2031-03-26',
    ]);
    expect(occurrences('2031-02-26', 'biweekly', null, '2031-03-05', '2031-04-10')).toEqual([
      '2031-03-12',
      '2031-03-26',
      '2031-04-09',
    ]);
  });

  it('falls twice a month when semimonthly', () => {
    expect(occurrences('2031-01-15', 'semimonthly', null, '2031-01-31', '2031-03-31')).toEqual([
      '2031-02-15',
      '2031-02-28',
      '2031-03-15',
      '2031-03-30',
    ]);
    expect(occurrences('2031-01-01', 'semimonthly', null, '2030-12-31', '2031-02-10')).toEqual([
      '2031-01-01',
      '2031-01-16',
      '2031-02-01',
    ]);
  });

  it('steps quarterly from the anchor', () => {
    expect(occurrences('2030-11-15', 'quarterly', null, '2031-01-01', '2031-12-31')).toEqual([
      '2031-02-15',
      '2031-05-15',
      '2031-08-15',
      '2031-11-15',
    ]);
  });

  it('returns a one-off once, and never before its own date', () => {
    expect(occurrences('2031-03-10', 'none', null, '2031-03-05', '2031-06-01')).toEqual(['2031-03-10']);
    expect(occurrences('2031-03-01', 'none', null, '2031-03-05', '2031-06-01')).toEqual([]);
    expect(occurrences('2031-09-01', 'monthly', null, '2031-03-05', '2031-06-01')).toEqual([]);
  });
});

describe('rolling the balance forward', () => {
  /**
   * The fixture the database test reproduces: opening $1,000.00 on Wednesday
   * 5 March 2031, an overdue receivable, a half-confidence deposit, a weekly
   * cost that ends, monthly rent anchored on the 31st and one payable.
   */
  const flows: ForecastFlow[] = [
    flow('2031-02-20', 'inflow', 20_000, 'ar', true),
    flow('2031-03-01', 'outflow', 1_000, 'item', true),
    flow('2031-03-10', 'inflow', weightByConfidence(150_001, '0.500')),
    ...occurrences('2031-02-26', 'weekly', '2031-03-26', '2031-03-05', '2031-06-01').map((d) =>
      flow(d, 'outflow', 5_000),
    ),
    ...occurrences('2031-01-31', 'monthly', null, '2031-03-05', '2031-06-01').map((d) =>
      flow(d, 'outflow', 30_000),
    ),
    flow('2031-04-15', 'outflow', 40_000, 'ap'),
  ];

  it('computes every week exactly', () => {
    const weeks = rollForward('2031-03-05', 100_000, flows);
    expect(weeks.map((w) => [w.weekStart, w.openingCents, w.inflowCents, w.outflowCents, w.closingCents])).toEqual([
      ['2031-03-03', 100_000, 20_000, 1_000, 119_000],
      ['2031-03-10', 119_000, 75_001, 5_000, 189_001],
      ['2031-03-17', 189_001, 0, 5_000, 184_001],
      ['2031-03-24', 184_001, 0, 5_000, 179_001],
      ['2031-03-31', 179_001, 0, 30_000, 149_001],
      ['2031-04-07', 149_001, 0, 0, 149_001],
      ['2031-04-14', 149_001, 0, 40_000, 109_001],
      ['2031-04-21', 109_001, 0, 0, 109_001],
      ['2031-04-28', 109_001, 0, 30_000, 79_001],
      ['2031-05-05', 79_001, 0, 0, 79_001],
      ['2031-05-12', 79_001, 0, 0, 79_001],
      ['2031-05-19', 79_001, 0, 0, 79_001],
      ['2031-05-26', 79_001, 0, 30_000, 49_001],
    ]);
    expect(weeks[0].arInflowCents).toBe(20_000);
    expect(weeks[0].itemOutflowCents).toBe(1_000);
    expect(weeks[6].apOutflowCents).toBe(40_000);
    // Every week's closing is its opening plus inflows minus outflows, and the
    // horizon's closing is opening plus every flow.
    const net = flows.reduce((s, f) => s + (f.direction === 'inflow' ? f.amountCents : -f.amountCents), 0);
    expect(weeks[12].closingCents).toBe(100_000 + net);
  });

  it('reports the first week the balance goes negative', () => {
    const weeks = rollForward('2031-03-05', 10_000, flows);
    const runway = forecastRunway(weeks);
    // 10,000 + 20,000 − 1,000 = 29,000; +75,001 − 5,000 = 99,001; … − 30,000 (w4) = 59,001;
    // − 40,000 (w6) = 19,001; − 30,000 (w8) = −10,999.
    expect(weeks[8].closingCents).toBe(-10_999);
    expect(runway.firstNegativeWeekStart).toBe('2031-04-28');
    expect(runway.lowestClosingCents).toBe(-40_999);
    expect(runway.lowestWeekStart).toBe('2031-05-26');
  });

  it('drops a flow past the horizon', () => {
    const weeks = rollForward('2031-03-05', 0, [flow('2031-06-02', 'outflow', 1)]);
    expect(weeks.every((w) => w.closingCents === 0)).toBe(true);
  });
});

describe('burn runway', () => {
  it('divides cash by the trailing burn, in whole days', () => {
    // $530.14 of cash; $4,000.00 of net operating burn over 90 days.
    const runway = burnRunway('2026-09-18', 53_014, 400_000, 90);
    expect(runway.weeklyBurnCents).toBe(31_111); // 400,000 × 7 / 90 = 31,111.1
    expect(runway.monthlyBurnCents).toBe(135_185); // 400,000 × 365 / 1,080 = 135,185.19
    expect(runway.runwayDays).toBe(11); // floor(53,014 × 90 / 400,000) = floor(11.93)
    expect(runway.cashOutDate).toBe('2026-09-29');
  });

  it('is zero with no cash and null when not burning', () => {
    expect(burnRunway('2026-09-18', -5, 1_000, 30).runwayDays).toBe(0);
    const notBurning = burnRunway('2026-09-18', 50_000, -1_000, 30);
    expect(notBurning.runwayDays).toBeNull();
    expect(notBurning.cashOutDate).toBeNull();
  });
});

describe('scoring', () => {
  it('compares a snapshot with what happened, week by week', () => {
    const projected = rollForward('2031-03-05', 100_000, [flow('2031-03-12', 'inflow', 10_000)]).map((w) => ({
      weekStart: w.weekStart,
      openingCents: w.openingCents,
      inflowCents: w.inflowCents,
      outflowCents: w.outflowCents,
      closingCents: w.closingCents,
    }));
    const score = scoreWeeks(projected, [
      { weekStart: '2031-03-03', openingCents: 100_000, inflowCents: 0, outflowCents: 500, closingCents: 99_500 },
      { weekStart: '2031-03-10', openingCents: 99_500, inflowCents: 7_000, outflowCents: 0, closingCents: 106_500 },
    ]);
    expect(score.weeks).toHaveLength(2);
    expect(score.unscoredWeeks).toBe(11);
    expect(score.weeks[0].closingVarianceCents).toBe(-500);
    expect(score.weeks[1].inflowVarianceCents).toBe(-3_000);
    expect(score.weeks[1].closingVarianceCents).toBe(-3_500);
    expect(score.meanAbsClosingErrorCents).toBe(2_000);
    expect(score.finalClosingVarianceCents).toBe(-3_500);
    expect(score.projectedInflowCents).toBe(10_000);
    expect(score.actualInflowCents).toBe(7_000);
  });
});

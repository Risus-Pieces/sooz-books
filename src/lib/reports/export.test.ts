import { describe, expect, it } from 'vitest';

import { reportFilename, toCsv, toMatrix, toTsv } from './export';
import {
  type Report,
  type ReportRequest,
  addMonths,
  basisPoints,
  dayBefore,
  formatBasisPoints,
  formatBasisPointsPlain,
  monthsBetween,
  parseReportRequest,
  quartersBetween,
  reportRequestToParams,
  resolveCompareWindow,
  row,
  shiftYears,
} from './types';

function sample(): Report {
  return {
    columns: [
      { key: 'total', label: 'Total', kind: 'amount', emphasis: true },
      { key: 'pct', label: '% of net sales', kind: 'percent' },
    ],
    rows: [
      row({ id: 'r1', label: 'Gross Sales', level: 0, values: [0, 0], style: 'section' }),
      row({
        id: 'r2',
        code: '4010',
        label: 'DTC Sales, "Shopify"',
        level: 1,
        values: [100_000, 10_000],
      }),
      row({ id: 'r3', code: '4575', label: 'Coupons', level: 1, values: [-2_550, -255] }),
      row({ id: 'r4', label: 'NET SALES', level: 0, values: [97_450, 10_000], style: 'total' }),
      row({
        id: 'r5',
        label: 'Gross margin',
        level: 0,
        values: [4_231, 0],
        style: 'ratio',
        format: 'percent',
        blankColumns: [1],
      }),
    ],
    meta: {
      title: 'Profit & Loss',
      subtitle: 'March 1, 2026 – March 31, 2026',
      from: '2026-03-01',
      to: '2026-03-31',
      basis: 'accrual',
      columns: 'total',
      generatedAt: '2026-04-02',
      warnings: ['Ask My Accountant carries a balance.'],
    },
  };
}

describe('report matrix export', () => {
  it('writes money plainly: no symbol, no grouping, a leading minus', () => {
    const matrix = toMatrix(sample());
    const dtc = matrix.find((line) => line[0] === '4010');
    const coupons = matrix.find((line) => line[0] === '4575');

    expect(dtc?.[4]).toBe('1000.00');
    expect(coupons?.[4]).toBe('-25.50');
  });

  it('writes a percentage as a plain number, and a percentage row with no percentage column', () => {
    const matrix = toMatrix(sample());
    const dtc = matrix.find((line) => line[0] === '4010');
    const margin = matrix.find((line) => line[1] === 'Gross margin');

    expect(dtc?.[5]).toBe('100.00');
    expect(margin?.[4]).toBe('42.31');
    // The percent column is blank on a row that is already a percentage.
    expect(margin?.[5]).toBe('');
  });

  it('leaves section headers without figures', () => {
    const matrix = toMatrix(sample());
    const section = matrix.find((line) => line[1] === 'Gross Sales');
    expect(section?.slice(4)).toEqual(['', '']);
  });

  it('quotes a field containing a comma or a quote', () => {
    const csv = toCsv(sample(), { includeHeader: false, includeWarnings: false });
    expect(csv).toContain('"DTC Sales, ""Shopify"""');
  });

  it('defuses a field that a spreadsheet would read as a formula', () => {
    const report = sample();
    report.rows[1] = { ...report.rows[1], label: '=SUM(A1:A9)' };
    const csv = toCsv(report, { includeHeader: false, includeWarnings: false });
    expect(csv).toContain("'=SUM(A1:A9)");
  });

  it('carries the title block and the warnings into the file', () => {
    const csv = toCsv(sample());
    expect(csv).toContain('Profit & Loss');
    expect(csv).toContain('Basis,Accrual');
    expect(csv).toContain('Note,Ask My Accountant carries a balance.');
  });

  it('separates clipboard output with tabs and indents by depth', () => {
    const tsv = toTsv(sample());
    const lines = tsv.split('\n');
    const dtc = lines.find((line) => line.startsWith('4010'));
    expect(dtc?.split('\t')[1]).toBe('  DTC Sales, "Shopify"');
    expect(tsv).not.toContain('\r');
  });

  it('names the file after the report and its window', () => {
    expect(reportFilename(sample(), 'csv')).toBe('sooz-profit-and-loss-2026-03-01-2026-03-31.csv');
  });
});

describe('report figures', () => {
  it('computes a ratio in basis points, rounded half away from zero', () => {
    expect(basisPoints(112_500, 197_500)).toBe(5_696);
    expect(basisPoints(1, 3)).toBe(3_333);
    expect(basisPoints(-1, 3)).toBe(-3_333);
    // A margin on no sales is not a number, and a statement is not the place to argue.
    expect(basisPoints(500, 0)).toBe(0);
  });

  it('formats basis points for the screen and for a spreadsheet', () => {
    expect(formatBasisPoints(5_696)).toBe('56.96%');
    expect(formatBasisPoints(-810)).toBe('−8.10%');
    expect(formatBasisPoints(1_200, { sign: true })).toBe('+12.00%');
    expect(formatBasisPointsPlain(-810)).toBe('-8.10');
  });
});

describe('report windows', () => {
  it('cuts a range into months, clipped to the range edges', () => {
    expect(monthsBetween('2026-01-15', '2026-03-10')).toEqual([
      { from: '2026-01-15', to: '2026-01-31' },
      { from: '2026-02-01', to: '2026-02-28' },
      { from: '2026-03-01', to: '2026-03-10' },
    ]);
  });

  it('cuts a range into quarters', () => {
    expect(quartersBetween('2026-01-01', '2026-07-31')).toEqual([
      { from: '2026-01-01', to: '2026-03-31' },
      { from: '2026-04-01', to: '2026-06-30' },
      { from: '2026-07-01', to: '2026-07-31' },
    ]);
  });

  it('clamps 29 February when shifting into a common year', () => {
    expect(shiftYears('2028-02-29', -1)).toBe('2027-02-28');
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(dayBefore('2026-01-01')).toBe('2025-12-31');
  });

  it('resolves a prior-year comparison against the same range', () => {
    const request: ReportRequest = {
      from: '2026-03-01',
      to: '2026-03-31',
      columns: 'total',
      basis: 'accrual',
      compareTo: 'prior_year',
      includeZeroRows: false,
    };
    expect(resolveCompareWindow(request)).toEqual({ from: '2025-03-01', to: '2025-03-31' });
    expect(resolveCompareWindow({ ...request, compareTo: 'prior_period' })).toEqual({
      from: '2026-02-01',
      to: '2026-02-28',
    });
  });
});

describe('report request parsing', () => {
  it('round-trips through the query string', () => {
    const request: ReportRequest = {
      from: '2026-01-01',
      to: '2026-03-31',
      columns: 'months',
      basis: 'cash',
      compareTo: 'prior_year',
      channelIds: ['3f7d2a1e-0000-4000-8000-000000000001'],
      includeZeroRows: true,
      percentOfNetSales: true,
    };
    const params = reportRequestToParams(request);
    const parsed = parseReportRequest(Object.fromEntries(params));
    expect(parsed).toEqual(request);
  });

  it('sorts a reversed range rather than reporting nothing', () => {
    const parsed = parseReportRequest({ from: '2026-03-31', to: '2026-01-01' });
    expect(parsed.from).toBe('2026-01-01');
    expect(parsed.to).toBe('2026-03-31');
  });

  it('falls back to the default window when the URL carries rubbish', () => {
    const parsed = parseReportRequest(
      { from: 'yesterday', columns: 'sideways', basis: 'hopeful' },
      { defaultWindow: { from: '2026-05-01', to: '2026-05-31' }, anchor: '2026-05-31' },
    );
    expect(parsed).toMatchObject({
      from: '2026-05-01',
      to: '2026-05-31',
      columns: 'total',
      basis: 'accrual',
    });
  });
});

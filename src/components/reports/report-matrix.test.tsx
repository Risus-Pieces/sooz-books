import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import { ReportMatrix } from './report-matrix';
import { type Report, row } from '@/lib/reports/types';

function sample(): Report {
  return {
    columns: [
      { key: 'total', label: 'Total', kind: 'amount', emphasis: true, from: '2026-03-01', to: '2026-03-31' },
      { key: 'pct', label: '% of net sales', kind: 'percent' },
    ],
    rows: [
      row({ id: 's', label: 'Gross Sales', level: 0, values: [0, 0], style: 'section' }),
      row({
        id: 'd',
        code: '4010',
        label: 'DTC Sales',
        level: 1,
        values: [100_000, 10_000],
        drilldown: { accountId: '11111111-2222-4333-8444-555555555555', from: '2026-03-01', to: '2026-03-31' },
      }),
      row({ id: 't', label: 'NET SALES', level: 0, values: [100_000, 10_000], style: 'total' }),
      row({
        id: 'm',
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
      subtitle: 'March 2026',
      from: '2026-03-01',
      to: '2026-03-31',
      basis: 'accrual',
      columns: 'total',
      generatedAt: '2026-04-01',
      warnings: ['A warning the reader must see.'],
    },
  };
}

describe('ReportMatrix', () => {
  it('renders', () => {
    const html = renderToStaticMarkup(<ReportMatrix report={sample()} />);
    expect(html).toContain('1,000.00');
    expect(html).toContain('42.31%');
    expect(html).toContain('A warning the reader must see.');
    expect(html).toContain('/reports/general-ledger?account=11111111');
  });
});

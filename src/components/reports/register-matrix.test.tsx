import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import { agingSplit } from '@/components/arap/overview';
import { type Report, row } from '@/lib/reports/types';

import { RegisterMatrix } from './register-matrix';

function register(): Report {
  const width = 8;
  const cells = (values: Partial<Record<number, string>>) => Array.from({ length: width }, (_, i) => values[i] ?? null);
  const values = (debit: number, credit: number, balance: number) => [0, 0, 0, 0, 0, debit, credit, balance];
  return {
    columns: [
      { key: 'date', label: 'Date', kind: 'date', group: 'detail' },
      { key: 'entry', label: 'Entry', kind: 'text', group: 'detail' },
      { key: 'source', label: 'Source', kind: 'text', group: 'detail' },
      { key: 'memo', label: 'Memo', kind: 'text', group: 'detail' },
      { key: 'counter', label: 'Other accounts', kind: 'text', group: 'detail' },
      { key: 'debit', label: 'Debit', kind: 'amount', group: 'current' },
      { key: 'credit', label: 'Credit', kind: 'amount', group: 'current' },
      { key: 'balance', label: 'Balance', kind: 'amount', emphasis: true, group: 'current' },
    ],
    rows: [
      row({ id: 's', code: '1011', label: 'Relay — Operating', level: 0, values: values(0, 0, 0), cells: cells({}), style: 'section' }),
      row({ id: 'o', label: 'Opening balance', level: 1, values: values(0, 0, 379_499), cells: cells({ 0: '2026-09-01' }), style: 'detail' }),
      row({
        id: 'l',
        code: '1011',
        label: '',
        level: 1,
        values: values(200_000, 0, 579_499),
        cells: cells({ 0: '2026-09-01', 1: '15', 2: 'bank', 3: 'CHASE COLLEGE', 4: '3015 Member Contributions' }),
        style: 'detail',
      }),
      row({ id: 'c', label: 'Closing balance', level: 1, values: values(200_000, 0, 579_499), cells: cells({ 0: '2026-09-18' }), style: 'subtotal' }),
      row({ id: 't', label: 'Total movement', level: 0, values: values(200_000, 0, 0), cells: cells({}), style: 'total' }),
    ],
    meta: {
      title: 'General Ledger',
      subtitle: 'September 2026',
      from: '2026-09-01',
      to: '2026-09-18',
      basis: 'accrual',
      columns: 'total',
      generatedAt: '2026-09-18',
      warnings: [],
    },
  };
}

describe('RegisterMatrix', () => {
  it('keeps every amount column and moves entry and source under the memo', () => {
    const html = renderToStaticMarkup(<RegisterMatrix report={register()} />);
    for (const head of ['Debit', 'Credit', 'Balance', 'Memo', 'Other accounts']) expect(html).toContain(`>${head}</th>`);
    expect(html).not.toContain('>Entry</th>');
    expect(html).toContain('#15 · Bank');
    expect(html).toContain('5,794.99');
    expect(html).toContain('Total movement');
  });
});

describe('agingSplit', () => {
  it('separates open documents from unapplied money netted against them', () => {
    const split = agingSplit([
      { items: [{ kind: 'invoice', balanceCents: 39_216 }, { kind: 'deduction', balanceCents: -39_216 }] },
      { items: [{ kind: 'invoice', balanceCents: 102_762 }, { kind: 'deduction', balanceCents: -102_762 }] },
    ]);
    expect(split).toEqual({ docsCents: 141_978, docsLabel: 'Invoices', creditsCents: -141_978, creditsLabel: 'Deductions' });
  });
});

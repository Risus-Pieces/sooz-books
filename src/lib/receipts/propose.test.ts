import { describe, expect, it } from 'vitest';

import { sumCents } from '@/lib/money';

import { buildProposalLines, recomputeWarnings } from './propose';
import type { ExtractedReceipt, ProposalLine, ReceiptWarning } from './types';

const IDS = new Map([
  ['1320', 'acct-ingredients'],
  ['1330', 'acct-packaging'],
  ['6740', 'acct-office'],
]);

function receipt(overrides: Partial<ExtractedReceipt> = {}): ExtractedReceipt {
  return {
    legible: true,
    vendorName: 'Pack Supply Co',
    date: '2026-09-15',
    subtotalCents: 3800,
    taxCents: 310,
    tipCents: 0,
    totalCents: 4110,
    cardLast4: null,
    items: [{ description: 'Shipper cartons', cents: 3800, accountCode: '1330' }],
    ...overrides,
  };
}

const build = (extracted: ExtractedReceipt, vendorAccountId: string | null = null) =>
  buildProposalLines({ extracted, idByCode: IDS, vendorAccountId });

describe('buildProposalLines', () => {
  it('folds tax into the cost, so the lines add up to the total paid', () => {
    const { lines, notes } = build(receipt());

    expect(lines).toEqual([{ description: 'Shipper cartons', cents: 4110, accountId: 'acct-packaging' }]);
    expect(notes).toEqual([]);
  });

  it('shares tax and tip across items in proportion, to the cent', () => {
    const { lines } = build(
      receipt({
        taxCents: 400,
        totalCents: 4400,
        items: [
          { description: 'Sugar', cents: 3000, accountCode: '1320' },
          { description: 'Boxes', cents: 1000, accountCode: '1330' },
        ],
      }),
    );

    expect(lines.map((l) => l.cents)).toEqual([3300, 1100]);
    expect(lines.map((l) => l.accountId)).toEqual(['acct-ingredients', 'acct-packaging']);
  });

  it('never loses or invents a cent when the shares do not divide evenly', () => {
    const { lines } = build(
      receipt({
        taxCents: 100,
        totalCents: 3100,
        items: [
          { description: 'a', cents: 1000, accountCode: '6740' },
          { description: 'b', cents: 1000, accountCode: '6740' },
          { description: 'c', cents: 1000, accountCode: '6740' },
        ],
      }),
    );

    expect(sumCents(lines.map((l) => l.cents))).toBe(3100);
    for (const line of lines) expect(Math.abs(line.cents - 1033)).toBeLessThanOrEqual(1);
  });

  it('keeps a discount as its own negative line and puts the tax on the purchases', () => {
    const { lines } = build(
      receipt({
        taxCents: 360,
        totalCents: 4860,
        items: [
          { description: 'Cartons', cents: 5000, accountCode: '1330' },
          { description: 'Coupon', cents: -500, accountCode: null },
        ],
      }),
    );

    expect(lines.map((l) => l.cents)).toEqual([5360, -500]);
    expect(sumCents(lines.map((l) => l.cents))).toBe(4860);
  });

  it("uses the vendor's own account for every line when it knows one, over the model's pick", () => {
    const { lines } = build(receipt(), 'acct-office');

    expect(lines.map((l) => l.accountId)).toEqual(['acct-office']);
  });

  it('leaves a line without an account rather than guessing, when the model named none or an unknown one', () => {
    const named = build(receipt({ items: [{ description: 'x', cents: 3800, accountCode: '9999' }] }));
    const none = build(receipt({ items: [{ description: 'x', cents: 3800, accountCode: null }] }));

    expect(named.lines[0].accountId).toBeNull();
    expect(none.lines[0].accountId).toBeNull();
  });

  it('posts one line for the full total when the items do not explain it, and says so', () => {
    const { lines, notes } = build(
      receipt({
        totalCents: 5000,
        items: [
          { description: 'small', cents: 1000, accountCode: '6740' },
          { description: 'big', cents: 3000, accountCode: '1330' },
        ],
      }),
    );

    expect(lines).toEqual([{ description: 'Pack Supply Co', cents: 5000, accountId: 'acct-packaging' }]);
    expect(notes).toEqual([expect.objectContaining({ code: 'total_mismatch', blocking: false })]);
  });

  it('makes one line for the total when the receipt shows no items', () => {
    const { lines, notes } = build(receipt({ items: [] }), 'acct-office');

    expect(lines).toEqual([{ description: 'Pack Supply Co', cents: 4110, accountId: 'acct-office' }]);
    expect(notes).toEqual([]);
  });

  it('refuses to propose from an unreadable receipt or a missing total', () => {
    for (const extracted of [receipt({ legible: false }), receipt({ totalCents: null })]) {
      const { lines, notes } = build(extracted);
      expect(lines).toEqual([]);
      expect(notes).toEqual([expect.objectContaining({ code: 'unreadable', blocking: true })]);
    }
  });

  it('blocks a refund or a zero receipt', () => {
    for (const totalCents of [0, -1200]) {
      const { lines, notes } = build(receipt({ totalCents }));
      expect(lines).toEqual([]);
      expect(notes).toEqual([expect.objectContaining({ code: 'refund', blocking: true })]);
    }
  });
});

describe('recomputeWarnings', () => {
  const line = (cents: number, accountId: string | null): ProposalLine => ({ description: 'x', cents, accountId });
  const TODAY = '2026-09-20';
  const ok = { payerId: 'u1', date: '2026-09-15', totalCents: 1000, lines: [line(1000, 'a1')] };
  const codes = (warnings: ReceiptWarning[]) => warnings.map((w) => w.code);

  it('has nothing to say about a complete proposal', () => {
    expect(recomputeWarnings([], ok, TODAY)).toEqual([]);
  });

  it('blocks on a line with no account, and clears when one is chosen', () => {
    const blocked = recomputeWarnings([], { ...ok, lines: [line(1000, null)] }, TODAY);
    expect(blocked).toEqual([expect.objectContaining({ code: 'no_account', blocking: true })]);
    expect(recomputeWarnings(blocked, ok, TODAY)).toEqual([]);
  });

  it('blocks until a payer is chosen', () => {
    const blocked = recomputeWarnings([], { ...ok, payerId: null }, TODAY);
    expect(blocked).toEqual([expect.objectContaining({ code: 'no_payer', blocking: true })]);
  });

  it('blocks on a missing date, and only notes a future or very old one', () => {
    expect(recomputeWarnings([], { ...ok, date: null }, TODAY)).toEqual([
      expect.objectContaining({ code: 'odd_date', blocking: true }),
    ]);
    expect(recomputeWarnings([], { ...ok, date: '2026-10-01' }, TODAY)).toEqual([
      expect.objectContaining({ code: 'odd_date', blocking: false }),
    ]);
    expect(recomputeWarnings([], { ...ok, date: '2025-01-01' }, TODAY)).toEqual([
      expect.objectContaining({ code: 'odd_date', blocking: false }),
    ]);
    expect(recomputeWarnings([], { ...ok, date: TODAY }, TODAY)).toEqual([]);
  });

  it('blocks when the lines do not add up to the total', () => {
    const blocked = recomputeWarnings([], { ...ok, lines: [line(900, 'a1')] }, TODAY);
    expect(blocked).toEqual([expect.objectContaining({ code: 'lines_off', blocking: true })]);
  });

  it('carries over what only ingest can know, and drops stale derived warnings', () => {
    const existing: ReceiptWarning[] = [
      { code: 'possible_duplicate', message: 'dup', blocking: false },
      { code: 'total_mismatch', message: 'mismatch', blocking: false },
      { code: 'no_payer', message: 'stale', blocking: true },
      { code: 'lines_off', message: 'stale', blocking: true },
    ];

    expect(codes(recomputeWarnings(existing, ok, TODAY))).toEqual(['possible_duplicate', 'total_mismatch']);
  });

  it('does not double-report a proposal that has no lines because it could not be read', () => {
    const existing: ReceiptWarning[] = [{ code: 'unreadable', message: 'cannot read', blocking: true }];
    const state = { payerId: 'u1', date: null, totalCents: null, lines: [] };

    expect(codes(recomputeWarnings(existing, state, TODAY))).toEqual(['unreadable']);
  });
});

import { describe, expect, it } from 'vitest';

import {
  allowedDiscount,
  applyOldestFirst,
  extendCents,
  invoiceTotals,
  percentOfCents,
  readMoney,
  termsLabel,
} from './math';

describe('arap form math', () => {
  it('extends quantity × unit price exactly, rounding half away from zero', () => {
    expect(extendCents('3', 3_000)).toBe(9_000);
    expect(extendCents('0.3333', 100)).toBe(33);
    expect(extendCents('1.005', 100)).toBe(101);
    expect(extendCents('2.5', 1)).toBe(3);
    expect(extendCents('abc', 100)).toBeNull();
    expect(extendCents('1.23456', 100)).toBeNull();
  });

  it('reads typed money without floats and flags nonsense', () => {
    expect(readMoney('1,234.56')).toEqual({ cents: 123_456, error: null });
    expect(readMoney('')).toEqual({ cents: null, error: null });
    expect(readMoney('-5').error).not.toBeNull();
    expect(readMoney('twelve').error).toBe('Not an amount.');
  });

  it('takes 2% within ten days and nothing after', () => {
    const terms = { termsDiscountPct: '2.00', termsDiscountDays: 10 };
    const invoice = { date: '2026-09-01', totalCents: 54_321 };
    expect(allowedDiscount(terms, invoice, '2026-09-11')).toBe(1_086);
    expect(allowedDiscount(terms, invoice, '2026-09-12')).toBe(0);
    expect(allowedDiscount({ termsDiscountPct: '0', termsDiscountDays: 0 }, invoice, '2026-09-02')).toBe(0);
    expect(percentOfCents(10_000, '1.5')).toBe(150);
  });

  it('names terms the way a buyer reads them', () => {
    expect(termsLabel(30, '2.00', 10)).toBe('2/10 net 30');
    expect(termsLabel(30, '1.50', 15)).toBe('1.5/15 net 30');
    expect(termsLabel(30)).toBe('Net 30');
    expect(termsLabel(0)).toBe('Due on receipt');
  });

  it('applies a lump payment to the oldest due first', () => {
    const applied = applyOldestFirst(15_000, [
      { id: 'b', dueDate: '2026-10-01', balanceCents: 10_000 },
      { id: 'a', dueDate: '2026-09-01', balanceCents: 10_000 },
    ]);
    expect([...applied.entries()]).toEqual([
      ['a', 10_000],
      ['b', 5_000],
    ]);
  });

  it('totals an invoice the way the engine writes it', () => {
    expect(
      invoiceTotals({
        lines: [
          { quantity: '3', unitPriceCents: 3_000, discountCents: 500, taxCents: 0 },
          { quantity: '1', unitPriceCents: 1_250, discountCents: 0, taxCents: 103 },
        ],
        discountCents: 250,
        shippingCents: 1_500,
      }),
    ).toEqual({ subtotalCents: 10_250, discountCents: 750, taxCents: 103, shippingCents: 1_500, totalCents: 11_103 });
  });
});

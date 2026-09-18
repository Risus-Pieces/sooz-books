import { afterAll, describe, expect, it } from 'vitest';

// First: loads .env.local, which the database client these modules import needs.
import { closeTestDb } from '@/lib/ledger/test-support';

import { bucketFor } from './aging';
import { extendCents, parseQuantity, percentOfCents, statusFor } from './common';
import { ArapError } from './errors';
import { allowedDiscountCents } from './receipts';

afterAll(closeTestDb);

describe('quantities and line amounts', () => {
  it('reads exact decimals without floats', () => {
    expect(parseQuantity('2.5').scaled).toBe(BigInt(25_000));
    expect(parseQuantity(3).scaled).toBe(BigInt(30_000));
    expect(parseQuantity('0.0001').scaled).toBe(BigInt(1));
    expect(() => parseQuantity('1.23456')).toThrow(ArapError);
    expect(() => parseQuantity('-1')).toThrow(ArapError);
    expect(() => parseQuantity('abc')).toThrow(ArapError);
  });

  it('extends quantity × unit price, rounding half away from zero', () => {
    expect(extendCents(parseQuantity('2.5').scaled, 1_999)).toBe(4_998); // 4997.5
    expect(extendCents(parseQuantity('0.3333').scaled, 300)).toBe(100); // 99.99
    expect(extendCents(parseQuantity('12').scaled, 2_450)).toBe(29_400);
    expect(extendCents(parseQuantity('0.1').scaled, 5)).toBe(1); // 0.5
  });

  it('takes a two-place percentage of an amount', () => {
    expect(percentOfCents(50_000, '2.00')).toBe(1_000);
    expect(percentOfCents(12_345, '2')).toBe(247); // 246.9
    expect(percentOfCents(10_050, '1.5')).toBe(151); // 150.75
  });
});

describe('document status', () => {
  it('follows what is still open', () => {
    expect(statusFor(10_000, 0)).toBe('open');
    expect(statusFor(10_000, 1)).toBe('partial');
    expect(statusFor(10_000, 10_000)).toBe('paid');
  });
});

describe('aging buckets', () => {
  it('buckets by days past due', () => {
    expect(bucketFor(null)).toBe('current');
    expect(bucketFor(-5)).toBe('current');
    expect(bucketFor(0)).toBe('current');
    expect(bucketFor(1)).toBe('days1to30');
    expect(bucketFor(30)).toBe('days1to30');
    expect(bucketFor(31)).toBe('days31to60');
    expect(bucketFor(60)).toBe('days31to60');
    expect(bucketFor(61)).toBe('days61to90');
    expect(bucketFor(90)).toBe('days61to90');
    expect(bucketFor(91)).toBe('over90');
  });
});

describe('early-payment discount terms', () => {
  const terms = { termsDiscountPct: '2.00', termsDiscountDays: 10 };
  const invoice = { invoiceDate: '2026-03-01', totalCents: 50_000 };

  it('allows the discount through the last day of the window only', () => {
    expect(allowedDiscountCents(terms, invoice, '2026-03-11')).toBe(1_000);
    expect(allowedDiscountCents(terms, invoice, '2026-03-12')).toBe(0);
    expect(allowedDiscountCents({ termsDiscountPct: '0', termsDiscountDays: 0 }, invoice, '2026-03-02')).toBe(0);
  });
});

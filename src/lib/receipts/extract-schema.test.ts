import { describe, expect, it } from 'vitest';

import {
  UnparseableReceiptError,
  itemsExplainTotal,
  parseExtraction,
  type RawExtraction,
} from './extract-schema';

function raw(overrides: Partial<RawExtraction> = {}): RawExtraction {
  return {
    legible: true,
    vendorName: 'Pack Supply Co',
    date: '2026-09-15',
    subtotal: '38.00',
    tax: '3.10',
    tip: null,
    total: '41.10',
    cardLast4: '4242',
    items: [{ description: 'Shipper cartons', amount: '38.00', accountCode: '1330' }],
    ...overrides,
  };
}

describe('parseExtraction', () => {
  it('turns every amount into integer cents', () => {
    const parsed = parseExtraction(raw());

    expect(parsed).toEqual({
      legible: true,
      vendorName: 'Pack Supply Co',
      date: '2026-09-15',
      subtotalCents: 3800,
      taxCents: 310,
      tipCents: 0,
      totalCents: 4110,
      cardLast4: '4242',
      items: [{ description: 'Shipper cartons', cents: 3800, accountCode: '1330' }],
    });
  });

  it('reads currency symbols and thousands separators the way parseMoney does', () => {
    const parsed = parseExtraction(
      raw({ total: '$1,234.56', items: [{ description: 'Pallet', amount: '1,234.56', accountCode: null }] }),
    );

    expect(parsed.totalCents).toBe(123456);
    expect(parsed.items[0].cents).toBe(123456);
  });

  it('keeps a discount negative', () => {
    const parsed = parseExtraction(
      raw({ items: [{ description: 'Coupon', amount: '-5.00', accountCode: null }] }),
    );

    expect(parsed.items[0].cents).toBe(-500);
  });

  it('treats a missing tax and tip as zero, and a missing total as null', () => {
    const parsed = parseExtraction(raw({ tax: null, tip: null, total: null }));

    expect(parsed.taxCents).toBe(0);
    expect(parsed.tipCents).toBe(0);
    expect(parsed.totalCents).toBeNull();
  });

  it('drops a date that is not a real calendar date, rather than guessing', () => {
    expect(parseExtraction(raw({ date: '2026-02-31' })).date).toBeNull();
    expect(parseExtraction(raw({ date: '9/15/26' })).date).toBeNull();
    expect(parseExtraction(raw({ date: null })).date).toBeNull();
  });

  it('keeps only exactly four digits of a card', () => {
    expect(parseExtraction(raw({ cardLast4: '4242' })).cardLast4).toBe('4242');
    expect(parseExtraction(raw({ cardLast4: '4242424242424242' })).cardLast4).toBeNull();
    expect(parseExtraction(raw({ cardLast4: 'xx42' })).cardLast4).toBeNull();
    expect(parseExtraction(raw({ cardLast4: null })).cardLast4).toBeNull();
  });

  it('trims the vendor and the account code, and names an unnamed item', () => {
    const parsed = parseExtraction(
      raw({
        vendorName: '  Pack Supply Co  ',
        items: [{ description: '  ', amount: '1.00', accountCode: ' 1330 ' }],
      }),
    );

    expect(parsed.vendorName).toBe('Pack Supply Co');
    expect(parsed.items[0]).toEqual({ description: 'Item', cents: 100, accountCode: '1330' });
  });

  it('refuses an amount it cannot read, naming which one', () => {
    expect(() => parseExtraction(raw({ total: 'forty' }))).toThrow(UnparseableReceiptError);
    expect(() => parseExtraction(raw({ total: 'forty' }))).toThrow(/total/);
    expect(() =>
      parseExtraction(raw({ items: [{ description: 'x', amount: 'n/a', accountCode: null }] })),
    ).toThrow(/line item/);
  });

  it('refuses a line item with no amount rather than booking it as nothing', () => {
    for (const blank of ['', '   ']) {
      const attempt = () => parseExtraction(raw({ items: [{ description: 'Sugar', amount: blank, accountCode: null }] }));
      expect(attempt).toThrow(UnparseableReceiptError);
      expect(attempt).toThrow('A line item on the receipt has no amount.');
    }
  });

  it('does not echo a long model-supplied value back in full', () => {
    const long = 'x'.repeat(200);

    let message = '';
    try {
      parseExtraction(raw({ total: long }));
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain('x'.repeat(40) + '…');
    expect(message).not.toContain('x'.repeat(41));
  });
});

describe('itemsExplainTotal', () => {
  it('is true when the items are the total', () => {
    const parsed = parseExtraction(
      raw({ total: '38.00', tax: null, items: [{ description: 'a', amount: '38.00', accountCode: null }] }),
    );
    expect(itemsExplainTotal(parsed)).toBe(true);
  });

  it('is true when the items plus tax and tip are the total', () => {
    expect(itemsExplainTotal(parseExtraction(raw()))).toBe(true);
    const withTip = parseExtraction(
      raw({ tip: '5.00', total: '46.10', items: [{ description: 'a', amount: '38.00', accountCode: null }] }),
    );
    expect(itemsExplainTotal(withTip)).toBe(true);
  });

  it('is false when the items do not add up', () => {
    const parsed = parseExtraction(
      raw({ total: '50.00', items: [{ description: 'a', amount: '38.00', accountCode: null }] }),
    );
    expect(itemsExplainTotal(parsed)).toBe(false);
  });

  it('is false with no items or no total', () => {
    expect(itemsExplainTotal(parseExtraction(raw({ items: [] })))).toBe(false);
    expect(itemsExplainTotal(parseExtraction(raw({ total: null })))).toBe(false);
  });
});

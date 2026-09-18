import { describe, expect, it } from 'vitest';

import { COA_SEED } from '@/lib/ledger/coa';

import { CATEGORIES, categoryFor, categoryForCode, categoryKeyFor } from './categories';
import { GLYPHS } from './glyphs';
import { TINTS } from './tints';

const seeded = COA_SEED.map((a) => ({
  code: a.code,
  name: a.name,
  subtype: a.subtype,
  parentCode: a.parentCode,
  type: a.type,
}));

describe('category system', () => {
  it.each(seeded)('resolves $code $name to a category with a real tint and glyph', (account) => {
    const category = categoryFor(account);
    expect(CATEGORIES[category.key]).toBe(category);
    expect(TINTS).toContain(category.tint);
    expect(Object.keys(GLYPHS)).toContain(category.glyph);
    expect(category.label.split(' ').length).toBeLessThanOrEqual(2);
  });

  it('gives the same account the same category every time', () => {
    for (const account of seeded) {
      const first = categoryFor(account);
      for (let i = 0; i < 3; i += 1) expect(categoryFor({ ...account })).toEqual(first);
    }
  });

  it('agrees with itself when only the code is known', () => {
    for (const account of seeded) {
      expect(categoryForCode(account.code).key, account.code).toBe(categoryKeyFor(account));
    }
  });

  it('follows the owner-approved palette', () => {
    const tint = (code: string) => categoryForCode(code).tint;
    expect(tint('1320')).toBe('teal'); // Raw Ingredients
    expect(tint('1330')).toBe('brown'); // Packaging
    expect(tint('6310')).toBe('purple'); // Formulation
    expect(tint('6740')).toBe('blue'); // Office supplies
    expect(tint('6730')).toBe('orange'); // Meals
    expect(tint('6170')).toBe('pink'); // Creative
    expect(tint('6120')).toBe('indigo'); // Advertising
    expect(tint('5510')).toBe('cyan'); // Freight
    expect(tint('6610')).toBe('gray'); // Software
    expect(tint('6710')).toBe('gray'); // Fees
    expect(tint('4010')).toBe('green'); // Revenue
    expect(tint('3015')).toBe('indigo'); // Founder
    expect(tint('1310')).toBe('teal'); // Inventory
    expect(tint('1011')).toBe('blue'); // Cash
    expect(tint('6720')).toBe('mint'); // Travel
  });

  it('lets a new account inherit from its parent, then its subtype', () => {
    expect(categoryKeyFor({ code: '6199', parentCode: '6100', subtype: 'marketing' })).toBe('advertising');
    expect(categoryKeyFor({ code: '6399', parentCode: '6300' })).toBe('formulation');
    expect(categoryKeyFor({ code: '1019', subtype: 'bank' })).toBe('cash');
    expect(categoryKeyFor({ code: '9999', type: 'expense' })).toBe('other');
    expect(categoryKeyFor({ code: '9999' })).toBe('other');
  });

  it('never throws on an unknown or missing code', () => {
    expect(categoryForCode(null).key).toBe('other');
    expect(categoryForCode('abc').key).toBe('other');
  });
});

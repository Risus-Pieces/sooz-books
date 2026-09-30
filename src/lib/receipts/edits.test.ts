import { describe, expect, it } from 'vitest';

import { buildVendorIndex } from '@/lib/banking/vendors';

import { type EditContext, type EditableProposal, applyEdit } from './edits';
import type { Payer } from './payers';

const RISUS: Payer = { userId: 'u-risus', name: 'Risus Zhao', email: 'risus@sooz.test', contributionsAccountId: 'c1' };
const MO: Payer = { userId: 'u-mo', name: 'Mo Chen', email: 'mo@sooz.test', contributionsAccountId: 'c2' };

const ctx: EditContext = {
  allowed: [
    { id: 'a-pack', code: '1330', name: 'Packaging Materials' },
    { id: 'a-ing', code: '1320', name: 'Raw Ingredients' },
  ],
  payers: [RISUS, MO],
  vendorIndex: buildVendorIndex(
    [
      { id: 'v-pack', name: 'Pack Supply Co', displayName: null, vendorType: 'other', defaultExpenseAccountId: null, active: true },
    ],
    [],
  ),
  today: '2026-09-20',
};

function state(overrides: Partial<EditableProposal> = {}): EditableProposal {
  return {
    vendorId: null,
    vendorName: 'Somewhere',
    date: '2026-09-15',
    totalCents: 4110,
    payerId: 'u-risus',
    lines: [
      { description: 'Cartons', cents: 3000, accountId: 'a-pack' },
      { description: 'Sugar', cents: 1110, accountId: null },
    ],
    warnings: [{ code: 'no_account', message: 'Choose an account for every line.', blocking: true }],
    ...overrides,
  };
}

function applied(result: ReturnType<typeof applyEdit>): EditableProposal {
  if (!result.ok || 'skip' in result) throw new Error(`expected an applied edit, got ${JSON.stringify(result)}`);
  return result.state;
}

describe('set_account', () => {
  it('moves one line, by its 1-based number, and clears the warning it fixed', () => {
    const result = applyEdit(state(), { kind: 'set_account', line: 2, accountCode: '1320' }, ctx);

    const next = applied(result);
    expect(next.lines.map((l) => l.accountId)).toEqual(['a-pack', 'a-ing']);
    expect(next.warnings).toEqual([]);
    expect(result.ok && result.note).toContain('Sugar');
    expect(result.ok && result.note).toContain('Raw Ingredients (1320)');
  });

  it('moves every line at once', () => {
    const next = applied(applyEdit(state(), { kind: 'set_account', line: 'all', accountCode: '1320' }, ctx));

    expect(next.lines.map((l) => l.accountId)).toEqual(['a-ing', 'a-ing']);
  });

  it('refuses an account a receipt cannot post to, and a line that is not there', () => {
    expect(applyEdit(state(), { kind: 'set_account', line: 1, accountCode: '3015' }, ctx)).toEqual({
      ok: false,
      message: '“3015” is not an account a receipt can post to.',
    });
    expect(applyEdit(state(), { kind: 'set_account', line: 3, accountCode: '1330' }, ctx)).toEqual({
      ok: false,
      message: 'There is no line 3; this receipt has 2.',
    });
    expect(applyEdit(state({ lines: [] }), { kind: 'set_account', line: 'all', accountCode: '1330' }, ctx).ok).toBe(false);
  });

  it('never changes the state it was given', () => {
    const before = state();
    const snapshot = JSON.stringify(before);

    applyEdit(before, { kind: 'set_account', line: 'all', accountCode: '1320' }, ctx);

    expect(JSON.stringify(before)).toBe(snapshot);
  });
});

describe('set_payer', () => {
  it('finds a member by first name, by email, or by id', () => {
    expect(applied(applyEdit(state(), { kind: 'set_payer', who: 'mo' }, ctx)).payerId).toBe('u-mo');
    expect(applied(applyEdit(state(), { kind: 'set_payer', who: 'RISUS@sooz.test' }, ctx)).payerId).toBe('u-risus');
    expect(applied(applyEdit(state({ payerId: null }), { kind: 'set_payer', who: 'u-mo' }, ctx)).payerId).toBe('u-mo');
  });

  it('clears the no-payer warning once someone is chosen', () => {
    const blocked = state({
      payerId: null,
      lines: [{ description: 'x', cents: 4110, accountId: 'a-pack' }],
      warnings: [{ code: 'no_payer', message: 'Choose which member paid.', blocking: true }],
    });

    expect(applied(applyEdit(blocked, { kind: 'set_payer', who: 'Mo' }, ctx)).warnings).toEqual([]);
  });

  it('refuses a name nobody has, and one that fits two members, saying who the members are', () => {
    const none = applyEdit(state(), { kind: 'set_payer', who: 'Pat' }, ctx);
    expect(none).toEqual({ ok: false, message: 'No member matches “Pat”. The members are Risus Zhao and Mo Chen.' });

    const both = applyEdit(state(), { kind: 'set_payer', who: 'sooz.test' }, ctx);
    expect(both.ok).toBe(false);
    expect(!both.ok && both.message).toMatch(/more than one/i);
  });

  it('will not treat a single letter as a match', () => {
    expect(applyEdit(state(), { kind: 'set_payer', who: 'm' }, ctx).ok).toBe(false);
  });
});

describe('set_date', () => {
  it('sets a real date', () => {
    expect(applied(applyEdit(state(), { kind: 'set_date', date: ' 2026-09-12 ' }, ctx)).date).toBe('2026-09-12');
  });

  it('refuses a date that is not a calendar date', () => {
    expect(applyEdit(state(), { kind: 'set_date', date: 'the 12th' }, ctx).ok).toBe(false);
    expect(applyEdit(state(), { kind: 'set_date', date: '2026-02-31' }, ctx).ok).toBe(false);
  });

  it('notes, without blocking, a date in the future', () => {
    const next = applied(applyEdit(state(), { kind: 'set_date', date: '2026-12-01' }, ctx));

    expect(next.warnings).toContainEqual(expect.objectContaining({ code: 'odd_date', blocking: false }));
  });
});

describe('set_vendor', () => {
  it('adopts a vendor it already knows', () => {
    const next = applied(applyEdit(state(), { kind: 'set_vendor', name: 'pack supply co' }, ctx));

    expect(next).toMatchObject({ vendorId: 'v-pack', vendorName: 'Pack Supply Co' });
  });

  it('keeps an unknown name as a new vendor, created when the entry posts', () => {
    const result = applyEdit(state(), { kind: 'set_vendor', name: '  Brand New Co ' }, ctx);

    expect(applied(result)).toMatchObject({ vendorId: null, vendorName: 'Brand New Co' });
    expect(result.ok && result.note).toMatch(/new/i);
  });

  it('refuses a blank name', () => {
    expect(applyEdit(state(), { kind: 'set_vendor', name: '   ' }, ctx).ok).toBe(false);
  });
});

describe('split', () => {
  const parts = [
    { description: 'Cartons', amount: '30.00', accountCode: '1330' },
    { description: 'Sugar', amount: '11.10', accountCode: '1320' },
  ];

  it('replaces the lines when the parts add up to the total exactly', () => {
    const next = applied(applyEdit(state(), { kind: 'split', parts }, ctx));

    expect(next.lines).toEqual([
      { description: 'Cartons', cents: 3000, accountId: 'a-pack' },
      { description: 'Sugar', cents: 1110, accountId: 'a-ing' },
    ]);
    expect(next.warnings).toEqual([]);
  });

  it('refuses parts that do not add up, and says by how much', () => {
    const result = applyEdit(state(), { kind: 'split', parts: [parts[0], { ...parts[1], amount: '10.00' }] }, ctx);

    expect(result).toEqual({ ok: false, message: 'The parts add up to $40.00, but the receipt total is $41.10.' });
  });

  it('refuses an amount it cannot read and an account a receipt cannot use', () => {
    expect(applyEdit(state(), { kind: 'split', parts: [{ ...parts[0], amount: 'lots' }, parts[1]] }, ctx).ok).toBe(false);
    expect(applyEdit(state(), { kind: 'split', parts: [{ ...parts[0], accountCode: '9999' }, parts[1]] }, ctx).ok).toBe(false);
  });

  it('refuses when the receipt has no total to split', () => {
    expect(applyEdit(state({ totalCents: null }), { kind: 'split', parts }, ctx).ok).toBe(false);
  });
});

describe('skip', () => {
  it('asks to skip, without changing anything', () => {
    expect(applyEdit(state(), { kind: 'skip' }, ctx)).toEqual({
      ok: true,
      skip: true,
      note: 'Skipped. It will not be posted.',
    });
  });
});

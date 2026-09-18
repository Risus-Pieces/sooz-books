import { describe, expect, it } from 'vitest';

import {
  autoBalanceFor,
  blankLine,
  draftReadiness,
  entryTotals,
  isLineEmpty,
  lineAmounts,
  parseAmount,
  postReadiness,
  setAmount,
  toEntryLines,
  type DraftLineState,
} from './entry-math';

const ACCOUNT_A = '11111111-1111-4111-8111-111111111111';
const ACCOUNT_B = '22222222-2222-4222-8222-222222222222';

function line(patch: Partial<DraftLineState> = {}): DraftLineState {
  return { ...blankLine(), ...patch };
}

/** A balanced two-line entry: $250.00 of software on the operating card. */
function balancedPair(): DraftLineState[] {
  return [
    line({ accountId: ACCOUNT_A, debit: '250.00' }),
    line({ accountId: ACCOUNT_B, credit: '250.00' }),
  ];
}

describe('parseAmount', () => {
  it('reads the forms a bookkeeper and a bank export both write', () => {
    expect(parseAmount('1,234.56').cents).toBe(123456);
    expect(parseAmount('1234.56').cents).toBe(123456);
    expect(parseAmount('$1,234.56').cents).toBe(123456);
    expect(parseAmount('(50)').cents).toBe(-5000);
    expect(parseAmount('50-').cents).toBe(-5000);
    expect(parseAmount('  12  ').cents).toBe(1200);
  });

  it('treats an empty field as no amount rather than as zero or an error', () => {
    expect(parseAmount('')).toEqual({ cents: null, error: null });
    expect(parseAmount('   ')).toEqual({ cents: null, error: null });
  });

  it('reports unreadable text on the line instead of throwing', () => {
    const parsed = parseAmount('twelve');
    expect(parsed.cents).toBeNull();
    expect(parsed.error).toContain('twelve');
  });

  it('never loses a cent to a float round-trip', () => {
    expect(parseAmount('1.005').cents).toBe(101);
    expect(parseAmount('0.07').cents).toBe(7);
    expect(parseAmount('1999999.99').cents).toBe(199999999);
  });
});

describe('lineAmounts', () => {
  it('puts a plain amount on the side it was typed', () => {
    expect(lineAmounts(line({ debit: '10' }))).toEqual({
      debitCents: 1000,
      creditCents: 0,
      error: null,
    });
    expect(lineAmounts(line({ credit: '10' }))).toEqual({
      debitCents: 0,
      creditCents: 1000,
      error: null,
    });
  });

  it('moves a negative to the other column, which is what the parentheses mean', () => {
    expect(lineAmounts(line({ debit: '(50)' }))).toEqual({
      debitCents: 0,
      creditCents: 5000,
      error: null,
    });
    expect(lineAmounts(line({ credit: '-50' }))).toEqual({
      debitCents: 5000,
      creditCents: 0,
      error: null,
    });
  });

  it('refuses a line carrying both sides rather than netting it', () => {
    const amounts = lineAmounts(line({ debit: '10', credit: '4' }));
    expect(amounts.error).toBe('A line takes a debit or a credit, not both.');
    expect(amounts.debitCents).toBe(0);
    expect(amounts.creditCents).toBe(0);
  });

  it('reports unreadable text once, from whichever column holds it', () => {
    expect(lineAmounts(line({ debit: 'abc' })).error).toContain('abc');
    expect(lineAmounts(line({ credit: 'abc' })).error).toContain('abc');
  });

  it('reads a zero as no amount', () => {
    expect(lineAmounts(line({ debit: '0' }))).toEqual({
      debitCents: 0,
      creditCents: 0,
      error: null,
    });
  });
});

describe('entryTotals', () => {
  it('runs debits, credits and the difference across the grid', () => {
    const totals = entryTotals(balancedPair());
    expect(totals.debitCents).toBe(25000);
    expect(totals.creditCents).toBe(25000);
    expect(totals.differenceCents).toBe(0);
    expect(totals.balanced).toBe(true);
    expect(totals.amountLineCount).toBe(2);
  });

  it('signs the difference as debits less credits', () => {
    const short = [line({ accountId: ACCOUNT_A, debit: '100' }), line({ accountId: ACCOUNT_B, credit: '40' })];
    expect(entryTotals(short).differenceCents).toBe(6000);

    const over = [line({ accountId: ACCOUNT_A, debit: '40' }), line({ accountId: ACCOUNT_B, credit: '100' })];
    expect(entryTotals(over).differenceCents).toBe(-6000);
  });

  it('ignores untouched lines, so a grid of spare rows still balances', () => {
    const totals = entryTotals([...balancedPair(), blankLine(), blankLine()]);
    expect(totals.balanced).toBe(true);
    expect(totals.filledLineCount).toBe(2);
    expect(totals.lineErrors).toEqual({});
  });

  it('keeps a line without an account out of the totals and names it', () => {
    const lines = [line({ accountId: ACCOUNT_A, debit: '250' }), line({ credit: '250' })];
    const totals = entryTotals(lines);
    expect(totals.creditCents).toBe(0);
    expect(totals.lineErrors[lines[1].key]).toBe('Choose an account for this line.');
  });

  it('names a line that has an account but no amount', () => {
    const lines = [line({ accountId: ACCOUNT_A, memo: 'to fill in' })];
    expect(entryTotals(lines).lineErrors[lines[0].key]).toBe('This line has no amount.');
  });

  it('adds cents exactly across many lines', () => {
    const lines = Array.from({ length: 300 }, () => line({ accountId: ACCOUNT_A, debit: '0.07' }));
    expect(entryTotals(lines).debitCents).toBe(2100);
  });
});

describe('autoBalanceFor', () => {
  it('fills the remaining difference on the side that closes it', () => {
    const lines = [line({ accountId: ACCOUNT_A, debit: '100' }), line({ accountId: ACCOUNT_B })];
    expect(autoBalanceFor(lines, lines[1].key)).toEqual({ side: 'credit', cents: 10000 });
  });

  it('fills a debit when the credits are ahead', () => {
    const lines = [line({ accountId: ACCOUNT_A, credit: '100' }), line({ accountId: ACCOUNT_B })];
    expect(autoBalanceFor(lines, lines[1].key)).toEqual({ side: 'debit', cents: 10000 });
  });

  it('offers nothing when the entry already balances', () => {
    const lines = [...balancedPair(), blankLine()];
    expect(autoBalanceFor(lines, lines[2].key)).toBeNull();
  });

  it('leaves a line that already carries an amount alone', () => {
    const lines = [line({ accountId: ACCOUNT_A, debit: '100' }), line({ accountId: ACCOUNT_B, credit: '40' })];
    expect(autoBalanceFor(lines, lines[1].key)).toBeNull();
  });

  it('ignores the target line when working out what is missing', () => {
    // The blank target must not count itself, or the difference would be zero.
    const lines = [
      line({ accountId: ACCOUNT_A, debit: '75.25' }),
      line({ accountId: ACCOUNT_B, credit: '25.25' }),
      blankLine(),
    ];
    expect(autoBalanceFor(lines, lines[2].key)).toEqual({ side: 'credit', cents: 5000 });
  });

  it('returns null for a line that is not in the grid', () => {
    expect(autoBalanceFor(balancedPair(), 'missing')).toBeNull();
  });
});

describe('postReadiness', () => {
  const DATE = '2026-03-14';

  it('accepts a balanced entry of two lines', () => {
    expect(postReadiness(balancedPair(), DATE)).toEqual({ ready: true, reason: null });
  });

  it('refuses an entry that is out of balance', () => {
    const lines = [line({ accountId: ACCOUNT_A, debit: '100' }), line({ accountId: ACCOUNT_B, credit: '40' })];
    expect(postReadiness(lines, DATE)).toEqual({
      ready: false,
      reason: 'The entry is out of balance.',
    });
  });

  it('refuses a single-line entry even when it nets to nothing', () => {
    const lines = [line({ accountId: ACCOUNT_A, debit: '100' })];
    expect(postReadiness(lines, DATE).ready).toBe(false);
    expect(postReadiness(lines, DATE).reason).toContain('at least two lines');
  });

  it('refuses an entry whose lines are all zero', () => {
    const lines = [line({ accountId: ACCOUNT_A, debit: '0' }), line({ accountId: ACCOUNT_B, credit: '0' })];
    expect(postReadiness(lines, DATE).ready).toBe(false);
  });

  it('refuses a date that is not a calendar date', () => {
    expect(postReadiness(balancedPair(), '').ready).toBe(false);
    expect(postReadiness(balancedPair(), '2026-02-30').ready).toBe(false);
  });

  it('surfaces a line problem ahead of the balance', () => {
    const lines = [line({ accountId: ACCOUNT_A, debit: 'abc' }), line({ accountId: ACCOUNT_B, credit: '40' })];
    expect(postReadiness(lines, DATE).reason).toContain('abc');
  });
});

describe('draftReadiness', () => {
  it('accepts an unbalanced work in progress', () => {
    const lines = [line({ accountId: ACCOUNT_A, debit: '100' })];
    expect(draftReadiness(lines, '2026-03-14')).toEqual({ ready: true, reason: null });
  });

  it('refuses a grid with nothing on it', () => {
    expect(draftReadiness([blankLine(), blankLine()], '2026-03-14').ready).toBe(false);
  });

  it('refuses text that is not an amount, which would be lost on save', () => {
    const lines = [line({ accountId: ACCOUNT_A, debit: 'abc' })];
    expect(draftReadiness(lines, '2026-03-14').ready).toBe(false);
  });
});

describe('toEntryLines', () => {
  it('projects the grid into the ledger payload, dropping blank rows', () => {
    const lines = [
      line({ accountId: ACCOUNT_A, debit: '250.00', memo: ' Annual plan ' }),
      blankLine(),
      line({ accountId: ACCOUNT_B, credit: '(250.00)' }),
    ];
    expect(toEntryLines(lines)).toEqual([
      {
        accountId: ACCOUNT_A,
        debitCents: 25000,
        creditCents: 0,
        memo: 'Annual plan',
        channelId: null,
        productId: null,
      },
      {
        accountId: ACCOUNT_B,
        debitCents: 25000,
        creditCents: 0,
        memo: null,
        channelId: null,
        productId: null,
      },
    ]);
  });

  it('carries the per-line dimensions through', () => {
    const channelId = '33333333-3333-4333-8333-333333333333';
    const productId = '44444444-4444-4444-8444-444444444444';
    const [only] = toEntryLines([line({ accountId: ACCOUNT_A, debit: '5', channelId, productId })]);
    expect(only.channelId).toBe(channelId);
    expect(only.productId).toBe(productId);
  });
});

describe('setAmount', () => {
  it('clears the credit when a debit is typed, the way a ledger column does', () => {
    const start = line({ credit: '40' });
    expect(setAmount(start, 'debit', '1')).toMatchObject({ debit: '1', credit: '' });
  });

  it('clears the debit when a credit is typed', () => {
    const start = line({ debit: '40' });
    expect(setAmount(start, 'credit', '1')).toMatchObject({ debit: '', credit: '1' });
  });

  it('leaves the other side alone while a field is being emptied', () => {
    const start = line({ debit: '40', credit: '' });
    expect(setAmount(start, 'credit', '')).toMatchObject({ debit: '40', credit: '' });
  });
});

describe('isLineEmpty', () => {
  it('is true only for a row nobody has touched', () => {
    expect(isLineEmpty(blankLine())).toBe(true);
    expect(isLineEmpty(line({ memo: 'note' }))).toBe(false);
    expect(isLineEmpty(line({ accountId: ACCOUNT_A }))).toBe(false);
    expect(isLineEmpty(line({ debit: '  ' }))).toBe(true);
  });
});

describe('line keys', () => {
  it('gives every row its own identity, so deleting one does not move focus', () => {
    const keys = new Set(Array.from({ length: 50 }, () => blankLine().key));
    expect(keys.size).toBe(50);
  });
});

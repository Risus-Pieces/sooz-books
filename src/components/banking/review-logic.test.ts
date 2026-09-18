import { describe, expect, it } from 'vitest';

import {
  EMPTY_FILTER,
  amountQuery,
  canAcceptAsSuggested,
  groupByPayee,
  isFilterActive,
  matchesFilter,
  monthLabel,
  nextFocus,
  payeeKey,
  rangeIds,
  shortDate,
  totalsOf,
} from './review-logic';
import type { QueueRow } from './types';

let seq = 0;

function row(overrides: Partial<QueueRow> = {}): QueueRow {
  seq += 1;
  return {
    id: `row-${seq}`,
    bankAccountId: 'bank-a',
    bankAccountName: 'Relay — Operating Expenses',
    bankAccountMask: '9726',
    txnDate: '2031-03-10',
    description: 'Unknown',
    payee: 'Amazon',
    reference: 'Corporate Card -1892',
    amountCents: -1234,
    balanceCents: null,
    status: 'unreviewed',
    stage: 'review',
    journalEntryId: null,
    entryNo: null,
    matchedType: null,
    matchedId: null,
    reconciled: false,
    notes: null,
    suggestion: {
      account: { id: 'acct-supplies', code: '6150', name: 'Supplies' },
      vendor: null,
      customerId: null,
      channelId: null,
      memo: null,
      source: 'ai',
      confidence: 0.8,
      reasoning: 'Amazon purchases are usually supplies.',
      rule: null,
    },
    postedAccount: null,
    postedLineCount: 0,
    transferPartner: null,
    refundOriginal: null,
    flags: [],
    ...overrides,
  };
}

describe('amountQuery', () => {
  it('reads dollars and cents as whole cents without floats', () => {
    expect(amountQuery('12.34')).toBe(1234);
    expect(amountQuery('$1,000')).toBe(100000);
    expect(amountQuery('0.1')).toBe(10);
    expect(amountQuery('-4.55')).toBe(455);
  });

  it('refuses text that is not an amount', () => {
    expect(amountQuery('amazon')).toBeNull();
    expect(amountQuery('1.234')).toBeNull();
    expect(amountQuery('')).toBeNull();
  });
});

describe('matchesFilter', () => {
  it('passes everything through an empty filter', () => {
    expect(isFilterActive(EMPTY_FILTER)).toBe(false);
    expect(matchesFilter(row(), EMPTY_FILTER)).toBe(true);
  });

  it('matches payee, reference and suggested account text, case-insensitively', () => {
    expect(matchesFilter(row(), { ...EMPTY_FILTER, search: 'AMAZ' })).toBe(true);
    expect(matchesFilter(row(), { ...EMPTY_FILTER, search: '1892' })).toBe(true);
    expect(matchesFilter(row(), { ...EMPTY_FILTER, search: 'supplies' })).toBe(true);
    expect(matchesFilter(row(), { ...EMPTY_FILTER, search: 'target' })).toBe(false);
  });

  it('matches an amount in either direction', () => {
    expect(matchesFilter(row({ amountCents: -1234 }), { ...EMPTY_FILTER, search: '12.34' })).toBe(true);
    expect(matchesFilter(row({ amountCents: 1234 }), { ...EMPTY_FILTER, search: '$12.34' })).toBe(true);
    expect(matchesFilter(row({ amountCents: 1235 }), { ...EMPTY_FILTER, search: '12.34' })).toBe(false);
  });

  it('narrows by month, source, bank account and flags', () => {
    const flagged = row({ flags: ['mixed_use'], txnDate: '2031-04-02' });
    expect(matchesFilter(flagged, { ...EMPTY_FILTER, month: '2031-04' })).toBe(true);
    expect(matchesFilter(flagged, { ...EMPTY_FILTER, month: '2031-03' })).toBe(false);
    expect(matchesFilter(flagged, { ...EMPTY_FILTER, flaggedOnly: true })).toBe(true);
    expect(matchesFilter(row(), { ...EMPTY_FILTER, flaggedOnly: true })).toBe(false);
    expect(matchesFilter(row(), { ...EMPTY_FILTER, source: 'ai' })).toBe(true);
    expect(matchesFilter(row(), { ...EMPTY_FILTER, source: 'rule' })).toBe(false);
    const bare = row({ suggestion: { ...row().suggestion, source: null, account: null } });
    expect(matchesFilter(bare, { ...EMPTY_FILTER, source: 'none' })).toBe(true);
    expect(matchesFilter(row(), { ...EMPTY_FILTER, bankAccountId: 'bank-b' })).toBe(false);
  });
});

describe('totalsOf', () => {
  it('keeps money in and money out apart, in cents', () => {
    const totals = totalsOf([row({ amountCents: -1000 }), row({ amountCents: 455 }), row({ amountCents: -1, flags: ['low_confidence'] })]);
    expect(totals).toEqual({ count: 3, inCents: 455, outCents: 1001, flagged: 1 });
  });
});

describe('groupByPayee', () => {
  it('groups identical payees and sorts the largest group first', () => {
    const rows = [
      row({ payee: 'Amazon' }),
      row({ payee: 'AMAZON ' }),
      row({ payee: 'Amazon', flags: ['mixed_use'] }),
      row({ payee: 'Target #1234' }),
      row({ payee: 'Target #998' }),
      row({ payee: 'FEDEX' }),
    ];
    const groups = groupByPayee(rows);
    expect(groups.map((g) => g.rows.length)).toEqual([3, 2, 1]);
    expect(groups[0].key).toBe('amazon');
    expect(groups[0].flagged).toBe(1);
    expect(groups[0].netCents).toBe(-3702);
    expect(groups[1].key).toBe(payeeKey(row({ payee: 'Target #55' })));
  });

  it('counts only the rows accept-as-suggested can post', () => {
    const rows = [
      row({ payee: 'Relay' }),
      row({ payee: 'Relay', suggestion: { ...row().suggestion, account: null } }),
      row({ payee: 'Relay', status: 'transfer' }),
    ];
    const [group] = groupByPayee(rows);
    expect(group.acceptable).toHaveLength(1);
    expect(group.acceptableNetCents).toBe(-1234);
    expect(group.accounts[0]).toEqual({ label: '6150 Supplies', count: 2 });
  });
});

describe('canAcceptAsSuggested', () => {
  it('needs an account and a row that is still undecided', () => {
    expect(canAcceptAsSuggested(row())).toBe(true);
    expect(canAcceptAsSuggested(row({ suggestion: { ...row().suggestion, account: null } }))).toBe(false);
    expect(canAcceptAsSuggested(row({ stage: 'posted' }))).toBe(false);
    expect(canAcceptAsSuggested(row({ stage: 'excluded', status: 'excluded' }))).toBe(false);
    expect(canAcceptAsSuggested(row({ status: 'transfer' }))).toBe(false);
  });

  it('accepts a refund linked to its charge even without a suggestion', () => {
    const refund = row({
      amountCents: 500,
      suggestion: { ...row().suggestion, account: null },
      refundOriginal: {
        id: 'charge',
        txnDate: '2031-03-01',
        amountCents: -500,
        payee: 'Amazon',
        account: { id: 'acct-supplies', code: '6150', name: 'Supplies' },
      },
    });
    expect(canAcceptAsSuggested(refund)).toBe(true);
  });
});

describe('selection helpers', () => {
  const ids = ['a', 'b', 'c', 'd', 'e'];

  it('selects a range in either direction', () => {
    expect(rangeIds(ids, 'b', 'd')).toEqual(['b', 'c', 'd']);
    expect(rangeIds(ids, 'd', 'b')).toEqual(['b', 'c', 'd']);
    expect(rangeIds(ids, 'gone', 'c')).toEqual(['c']);
  });

  it('moves focus to the next row that stays, else the previous', () => {
    expect(nextFocus(ids, new Set(['b']), 'b')).toBe('c');
    expect(nextFocus(ids, new Set(['b', 'c']), 'b')).toBe('d');
    expect(nextFocus(ids, new Set(['e']), 'e')).toBe('d');
    expect(nextFocus(ids, new Set(ids), 'c')).toBeNull();
    expect(nextFocus(ids, new Set(['a']), null)).toBe('b');
  });
});

describe('labels', () => {
  it('formats calendar dates without a Date object', () => {
    expect(shortDate('2026-01-05')).toBe('Jan 5');
    expect(monthLabel('2026-12')).toBe('Dec 2026');
  });
});

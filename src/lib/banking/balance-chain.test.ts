import { describe, expect, it } from 'vitest';

import { readFixture, readRelay, RELAY_PROFILE } from './__fixtures__/support';
import { applyProfile } from './apply-profile';
import { validateBalanceChain } from './balance-chain';
import { normalizeDescription } from './normalize';
import type { NormalizedTxn } from './types';

/** A minimal transaction, for the cases no real statement happens to contain. */
function txn(
  rowIndex: number,
  date: string,
  amountCents: number,
  balanceCents: number | null,
  overrides: Partial<NormalizedTxn> = {},
): NormalizedTxn {
  const description = overrides.description ?? `row ${rowIndex}`;
  return {
    date,
    description,
    descriptionNormalized: normalizeDescription(description),
    counterparty: null,
    amountCents,
    balanceCents,
    reference: null,
    externalId: null,
    rawType: null,
    status: null,
    rowIndex,
    raw: {},
    warnings: [],
    usable: true,
    ...overrides,
  };
}

describe('validateBalanceChain on the real Relay statements', () => {
  it('reads the direction off the balance column and derives the January opening balance', async () => {
    const parsed = applyProfile(await readRelay('Relay 2026-01-01 #9726.csv'), RELAY_PROFILE);
    const chain = validateBalanceChain(parsed.rows);

    expect(chain.ok).toBe(true);
    expect(chain.breaks).toEqual([]);
    expect(chain.direction).toBe('descending');
    expect(chain.checked).toBe(18);

    // $1,000.00 — the figure `bank_accounts.opening_balance_cents` was seeded
    // with for account #9726, derived from the file rather than typed in.
    expect(chain.openingBalanceCents).toBe(100000);
    expect(chain.closingBalanceCents).toBe(75833);

    // `ordered` is the same rows, oldest first.
    expect(chain.ordered).toHaveLength(parsed.rows.length);
    expect(chain.ordered[0].date).toBe('2026-01-15');
    expect(chain.ordered[chain.ordered.length - 1].date).toBe('2026-01-30');
    expect([...chain.ordered].sort((a, b) => a.rowIndex - b.rowIndex)).toEqual(
      [...parsed.rows].sort((a, b) => a.rowIndex - b.rowIndex),
    );
  });

  it('ties month to month across the nine real statements for account #9726', async () => {
    // Each file's closing balance is the next file's opening balance. Nothing in
    // the parser enforces this; it holds only if every row in every month was read
    // correctly, which makes it the strongest end-to-end check in the suite.
    const months = [
      'Relay 2026-01-01 #9726.csv',
      'Relay 2026-02-01 #9726.csv',
      'Relay 2026-03-01 #9726.csv',
      'Relay 2026-04-01 #9726.csv',
      'Relay 2026-05-01 #9726.csv',
      'Relay 2026-06-01 #9726.csv',
      'Relay 2026-07-01 #9726.csv',
      'Relay 2026-08-01 #9726.csv',
      'Relay (Partial) 2026-09-01 #9726.csv',
    ];

    let carried = 100000;
    const closings: number[] = [];
    for (const filename of months) {
      const parsed = applyProfile(await readRelay(filename), RELAY_PROFILE);
      const chain = validateBalanceChain(parsed.rows, { openingBalanceCents: carried });
      expect(chain.ok, filename).toBe(true);
      expect(chain.openingBalanceCents, filename).toBe(carried);
      carried = chain.closingBalanceCents!;
      closings.push(carried);
    }

    expect(closings).toEqual([75833, 36457, 22466, 5815, 10238, 51115, 115907, 55004, 52967]);
  });

  it('ties across the two statements account #9973 has any activity in', async () => {
    const january = validateBalanceChain(
      applyProfile(await readRelay('Relay 2026-01-01 #9973.csv'), RELAY_PROFILE).rows,
      { openingBalanceCents: 0 },
    );
    expect(january.ok).toBe(true);
    expect(january.closingBalanceCents).toBe(5047);

    // One row, so there is no step to measure a direction from — and the
    // validator says `unknown` rather than claiming one.
    const may = validateBalanceChain(
      applyProfile(await readRelay('Relay 2026-05-01 #9973.csv'), RELAY_PROFILE).rows,
      { openingBalanceCents: 5047 },
    );
    expect(may.ok).toBe(true);
    expect(may.direction).toBe('unknown');
    expect(may.openingBalanceCents).toBe(5047);
    expect(may.closingBalanceCents).toBe(47);
  });

  it('accepts an empty statement without claiming a balance it cannot know', async () => {
    const parsed = applyProfile(await readRelay('Relay 2026-06-01 #9973.csv'), RELAY_PROFILE);
    const chain = validateBalanceChain(parsed.rows);
    expect(chain).toMatchObject({
      ok: true,
      breaks: [],
      direction: 'unknown',
      openingBalanceCents: null,
      closingBalanceCents: null,
      checked: 0,
    });
  });

  it('carries a supplied opening balance through an empty statement', async () => {
    const parsed = applyProfile(await readRelay('Relay 2026-06-01 #9973.csv'), RELAY_PROFILE);
    expect(validateBalanceChain(parsed.rows, { openingBalanceCents: 5047 }).openingBalanceCents).toBe(5047);
  });
});

describe('validateBalanceChain — breaks', () => {
  it('names the exact row where a chain does not tie', async () => {
    // The synthetic sample in docs/formats/relay.md, verbatim. Its RETURNED row
    // carries the same balance as the settled row above it, which the real
    // statements do not do — a returned ACH moves the running balance.
    const parsed = applyProfile(await readFixture('relay-sample-broken-chain.csv'), RELAY_PROFILE);
    const chain = validateBalanceChain(parsed.rows);

    expect(chain.ok).toBe(false);
    expect(chain.direction).toBe('descending');
    expect(chain.breaks).toEqual([{ rowIndex: 3, expected: 205315, actual: 204315, delta: -1000 }]);
    expect(parsed.rows[3]).toMatchObject({ date: '2026-02-27', description: 'GOOGLE', status: 'RETURNED' });
  });

  it('validates the same transactions once the balance column is recomputed', async () => {
    // Identical rows, with the balance column rebuilt from the bottom upward the
    // way the real statements do it — including the RETURNED row, which moves the
    // balance and then has it moved back by the settled row it is paired with.
    const parsed = applyProfile(await readFixture('relay-sample.csv'), RELAY_PROFILE);
    const chain = validateBalanceChain(parsed.rows);

    expect(chain.ok).toBe(true);
    expect(chain.breaks).toEqual([]);
    expect(chain.openingBalanceCents).toBe(178688);
    expect(chain.closingBalanceCents).toBe(121455);
    // The closing balance is the opening plus every amount in the file.
    expect(chain.closingBalanceCents! - chain.openingBalanceCents!).toBe(parsed.meta.netCents);
  });

  it('produces one break for one missing transaction, not a cascade', () => {
    const rows = [
      txn(0, '2026-03-01', 100000, 100000),
      txn(1, '2026-03-02', -25000, 75000),
      // The -$15.00 bank fee that belongs here was never exported.
      txn(2, '2026-03-04', 12550, 73050),
      txn(3, '2026-03-05', -6050, 67000),
    ];
    const chain = validateBalanceChain(rows);

    expect(chain.ok).toBe(false);
    expect(chain.breaks).toEqual([{ rowIndex: 2, expected: 87550, actual: 73050, delta: -14500 }]);
    expect(chain.closingBalanceCents).toBe(67000);
  });

  it('reports a mismatch against a known opening balance as a break at the first row', () => {
    const rows = [txn(0, '2026-03-01', -25000, 75000), txn(1, '2026-03-02', 12550, 87550)];
    const chain = validateBalanceChain(rows, { openingBalanceCents: 90000 });

    expect(chain.openingBalanceCents).toBe(100000);
    expect(chain.ok).toBe(false);
    expect(chain.breaks[0]).toMatchObject({ rowIndex: 0, expected: 65000, actual: 75000, delta: 10000 });
  });

  it('is satisfied when the known opening balance agrees', () => {
    const rows = [txn(0, '2026-03-01', -25000, 75000), txn(1, '2026-03-02', 12550, 87550)];
    expect(validateBalanceChain(rows, { openingBalanceCents: 100000 }).ok).toBe(true);
  });
});

describe('validateBalanceChain — direction and sparse balances', () => {
  it('recognises an oldest-first file', async () => {
    const parsed = applyProfile(await readFixture('debit-credit.csv'), {
      date_column: 'Date',
      description_columns: ['Description'],
      mode: 'debit_credit',
      debit_column: 'Debit',
      credit_column: 'Credit',
      balance_column: 'Balance',
    });
    const chain = validateBalanceChain(parsed.rows);

    expect(chain.direction).toBe('ascending');
    expect(chain.ok).toBe(true);
    expect(chain.openingBalanceCents).toBe(0);
    expect(chain.closingBalanceCents).toBe(80000);
    expect(chain.ordered.map((row) => row.rowIndex)).toEqual([0, 1, 2, 3, 4]);
  });

  it('recognises a newest-first file and reverses it', async () => {
    const parsed = applyProfile(await readFixture('preamble.csv'), {
      date_column: 'Date',
      date_format: 'M/D/YYYY',
      description_columns: ['Description'],
      mode: 'signed',
      amount_column: 'Amount',
      balance_column: 'Running Bal.',
      skip_rows: 5,
    });
    const chain = validateBalanceChain(parsed.rows);

    expect(chain.direction).toBe('descending');
    expect(chain.ordered.map((row) => row.rowIndex)).toEqual([4, 3, 2, 1, 0]);
    expect(chain.openingBalanceCents).toBe(0);
    expect(chain.closingBalanceCents).toBe(80000);
  });

  it('carries the running total through rows that print no balance', () => {
    const rows = [
      txn(0, '2026-03-01', 100000, 100000),
      txn(1, '2026-03-02', -25000, null),
      txn(2, '2026-03-02', -1500, null),
      txn(3, '2026-03-03', 12550, 86050),
    ];
    const chain = validateBalanceChain(rows);

    expect(chain.ok).toBe(true);
    expect(chain.checked).toBe(2);
    expect(chain.openingBalanceCents).toBe(0);
    expect(chain.closingBalanceCents).toBe(86050);
  });

  it('walks the opening balance back past leading rows that print none', () => {
    const rows = [txn(0, '2026-03-01', 100000, null), txn(1, '2026-03-02', -25000, 75000)];
    expect(validateBalanceChain(rows).openingBalanceCents).toBe(0);
  });

  it('walks the closing balance forward past trailing rows that print none', () => {
    const rows = [txn(0, '2026-03-01', 100000, 100000), txn(1, '2026-03-02', -25000, null)];
    expect(validateBalanceChain(rows).closingBalanceCents).toBe(75000);
  });

  it('orders a file with no balance column at all by its dates', () => {
    const rows = [txn(0, '2026-03-05', -6050, null), txn(1, '2026-03-01', 100000, null)];
    const chain = validateBalanceChain(rows);

    expect(chain.ok).toBe(true);
    expect(chain.checked).toBe(0);
    expect(chain.direction).toBe('descending');
    expect(chain.ordered.map((row) => row.date)).toEqual(['2026-03-01', '2026-03-05']);
  });

  it('leaves unusable rows out of the arithmetic but keeps them in the output', () => {
    const rows = [
      txn(0, '2026-03-01', 100000, 100000),
      txn(1, '', 0, null, { usable: false, description: 'unparsable' }),
      txn(2, '2026-03-02', -25000, 75000),
    ];
    const chain = validateBalanceChain(rows);

    expect(chain.ok).toBe(true);
    expect(chain.ordered).toHaveLength(3);
    expect(chain.closingBalanceCents).toBe(75000);
  });

  it('handles no rows at all', () => {
    expect(validateBalanceChain([])).toMatchObject({
      ordered: [],
      ok: true,
      openingBalanceCents: null,
      closingBalanceCents: null,
      breaks: [],
      direction: 'unknown',
      checked: 0,
    });
  });

  it('derives an opening balance from a single row', () => {
    const chain = validateBalanceChain([txn(0, '2026-05-14', -5000, 47)]);
    expect(chain).toMatchObject({
      ok: true,
      direction: 'unknown',
      openingBalanceCents: 5047,
      closingBalanceCents: 47,
      checked: 1,
    });
  });
});

/**
 * The whole parsing layer against the whole real corpus.
 *
 * `data/statements/relay/` holds 36 genuine Relay exports covering four accounts
 * from January to September 2026. They are this company's actual bank records and
 * are gitignored; everything asserted here is a fact about those files, checked
 * against them rather than against a description of them.
 */

import { describe, expect, it } from 'vitest';

import { readRelay, relayAccountMask, RELAY_PROFILE, relayFilenames } from './__fixtures__/support';
import { applyProfile } from './apply-profile';
import { validateBalanceChain } from './balance-chain';
import { detectColumns } from './detect';
import { assignOccurrences, rowFingerprint } from './fingerprint';
import type { NormalizedTxn, ParseResult } from './types';

const FILENAMES = relayFilenames();

interface Statement {
  filename: string;
  mask: string;
  parsed: ParseResult;
  chain: ReturnType<typeof validateBalanceChain>;
}

async function parseAll(): Promise<Statement[]> {
  const out: Statement[] = [];
  for (const filename of FILENAMES) {
    const file = await readRelay(filename);
    const parsed = applyProfile(file, RELAY_PROFILE);
    out.push({
      filename,
      mask: relayAccountMask(filename),
      parsed,
      chain: validateBalanceChain(parsed.rows),
    });
  }
  return out;
}

describe('the 36 real Relay statements', () => {
  it('finds all 36 files', () => {
    expect(FILENAMES).toHaveLength(36);
  });

  it('parses every one of them without throwing', async () => {
    const statements = await parseAll();
    expect(statements).toHaveLength(36);
    // And every one of them found the ten-column Relay header.
    for (const { filename, parsed } of statements) {
      expect(parsed.meta.headers, filename).toHaveLength(10);
      expect(parsed.meta.headerRowIndex, filename).toBe(0);
    }
  });

  it('finds exactly 25 header-only files, which is the normal case, not an error', async () => {
    const statements = await parseAll();
    const empty = statements.filter(({ parsed }) => parsed.meta.dataRowCount === 0);

    expect(empty).toHaveLength(25);
    for (const { filename, parsed, chain } of empty) {
      expect(parsed.rows, filename).toEqual([]);
      expect(parsed.skipped, filename).toEqual([]);
      // An empty statement is information, not a failure: the account had no
      // activity that month.
      expect(parsed.warnings.every((warning) => warning.severity === 'info'), filename).toBe(true);
      expect(chain.ok, filename).toBe(true);
    }
  });

  it('reads 110 transactions across the four accounts', async () => {
    const statements = await parseAll();

    const total = statements.reduce((sum, { parsed }) => sum + parsed.meta.usableCount, 0);
    expect(total).toBe(110);

    const byAccount: Record<string, number> = {};
    for (const { mask, parsed } of statements) {
      byAccount[mask] = (byAccount[mask] ?? 0) + parsed.meta.usableCount;
    }
    // #9727 and #9972 have no activity at all across the full nine months.
    expect(byAccount).toEqual({ '9726': 106, '9727': 0, '9972': 0, '9973': 4 });
  });

  it('loses nothing: every physical row is either a transaction or a counted skip', async () => {
    const statements = await parseAll();
    for (const { filename, parsed } of statements) {
      expect(parsed.meta.dataRowCount, filename).toBe(parsed.meta.returnedCount + parsed.meta.skippedCount);
      expect(parsed.rows.every((row) => row.usable), filename).toBe(true);
      expect(parsed.skipped, filename).toEqual([]);
    }
  });

  it('validates the balance chain on every non-empty statement', async () => {
    const statements = await parseAll();
    const nonEmpty = statements.filter(({ parsed }) => parsed.meta.dataRowCount > 0);

    expect(nonEmpty).toHaveLength(11);
    for (const { filename, chain } of nonEmpty) {
      expect(chain.breaks, filename).toEqual([]);
      expect(chain.ok, filename).toBe(true);
    }
  });

  it("derives exactly $1,000.00 as the January opening balance for account #9726", async () => {
    const parsed = applyProfile(await readRelay('Relay 2026-01-01 #9726.csv'), RELAY_PROFILE);
    const chain = validateBalanceChain(parsed.rows);
    // The figure seeded into `bank_accounts.opening_balance_cents`, as of 2026-01-14.
    expect(chain.openingBalanceCents).toBe(100000);
  });

  it('reads every statement newest-first, which is how Relay exports them', async () => {
    const statements = await parseAll();
    for (const { filename, parsed, chain } of statements) {
      if (parsed.meta.usableCount < 2) continue;
      expect(chain.direction, filename).toBe('descending');
      // `ordered` is oldest-first whatever the file's own direction was.
      const dates = chain.ordered.map((row) => row.date);
      expect([...dates].sort(), filename).toEqual(dates);
    }
  });

  it('flags the one returned ACH and imports it, because it moved the balance', async () => {
    const statements = await parseAll();
    const returned = statements.flatMap(({ filename, parsed }) =>
      parsed.rows.filter((row) => row.status === 'RETURNED').map((row) => ({ filename, row })),
    );

    expect(returned).toHaveLength(1);
    expect(returned[0].filename).toBe('Relay 2026-05-01 #9726.csv');
    expect(returned[0].row).toMatchObject({ date: '2026-05-15', description: 'GOOGLE', amountCents: 1000 });
    expect(returned[0].row.warnings.map((warning) => warning.code)).toEqual(['row.flagged_by_rule']);
  });

  it('signs every amount from the company\'s point of view', async () => {
    const statements = await parseAll();
    const rows = statements.flatMap(({ parsed }) => parsed.rows);

    // No zero-amount rows: `bank_transactions` has a check constraint refusing them.
    expect(rows.every((row) => row.amountCents !== 0)).toBe(true);

    // `Spend` and `Spend-transfer` are money out; `Receive` and `Receive-transfer`
    // are money in. Relay labels direction on every row, so this is checkable.
    const wrong = rows.filter((row) => {
      const out = row.rawType === 'Spend' || row.rawType === 'Spend-transfer';
      return out ? row.amountCents > 0 : row.amountCents < 0;
    });
    expect(wrong).toEqual([]);

    const inflow = rows.filter((row) => row.amountCents > 0).reduce((sum, row) => sum + row.amountCents, 0);
    const outflow = rows.filter((row) => row.amountCents < 0).reduce((sum, row) => sum + row.amountCents, 0);
    expect(inflow).toBe(608939);
    expect(outflow).toBe(-655925);
    // $1,000.00 of opening balance, less $469.86 of net outflow, leaves the
    // $529.67 that #9726 held on 2026-09-15 plus #9973's $0.47.
    expect(inflow + outflow).toBe(52967 + 47 - 100000);
  });

  it("finds $5,673.46 of ACH Pulls from the founder's personal accounts", async () => {
    // Not revenue. Booking these as income would overstate it roughly tenfold,
    // which is why the parser has to surface them intact for the rule engine.
    //
    // Note the figure: docs/formats/relay.md states $4,673.46, but the twelve
    // `ACH Pull` rows in the files themselves add up to $5,673.46. The files are
    // the authority, so that is what is asserted here.
    const statements = await parseAll();
    const pulls = statements
      .flatMap(({ parsed }) => parsed.rows)
      .filter(
        (row) =>
          row.reference === 'ACH Pull' &&
          (row.description === 'CHASE COLLEGE' || row.description === 'Adv SafeBalance Banking'),
      );

    expect(pulls).toHaveLength(12);
    expect(pulls.reduce((sum, row) => sum + row.amountCents, 0)).toBe(567346);
    expect(pulls.every((row) => row.amountCents > 0)).toBe(true);
    // Every one of them dwarfs the Square deposits they must never be booked with.
    const square = statements
      .flatMap(({ parsed }) => parsed.rows)
      .filter((row) => row.reference?.startsWith('SQ26') === true);
    expect(square).toHaveLength(7);
    expect(square.reduce((sum, row) => sum + row.amountCents, 0)).toBe(27200);
  });

  it('gives every transaction in an account a distinct fingerprint', async () => {
    const statements = await parseAll();
    const perAccount = new Map<string, NormalizedTxn[]>();

    for (const { mask, chain } of statements) {
      const rows = perAccount.get(mask) ?? [];
      rows.push(...chain.ordered.filter((row) => row.usable));
      perAccount.set(mask, rows);
    }

    for (const [mask, rows] of perAccount) {
      if (rows.length === 0) continue;
      const occurrences = assignOccurrences(rows);
      const fingerprints = rows.map((row, index) =>
        rowFingerprint({
          bankAccountId: `00000000-0000-0000-0000-0000000${mask}`,
          date: row.date as string,
          amountCents: row.amountCents,
          description: row.description,
          externalId: row.externalId,
          occurrence: occurrences[index],
        }),
      );
      // The unique index on (bank_account_id, fingerprint) would reject anything less.
      expect(new Set(fingerprints).size, mask).toBe(fingerprints.length);
    }
  });

  it('re-importing a partial month as a full month produces the same fingerprints', async () => {
    // The normal case with Relay: a `(Partial)` file is downloaded again once the
    // month closes. If the keys moved, every transaction would import twice.
    const partial = validateBalanceChain(
      applyProfile(await readRelay('Relay (Partial) 2026-09-01 #9726.csv'), RELAY_PROFILE).rows,
    ).ordered;

    const key = (rows: readonly NormalizedTxn[]): string[] => {
      const occurrences = assignOccurrences(rows);
      return rows.map((row, index) =>
        rowFingerprint({
          bankAccountId: 'ae8e021b-2b45-48fb-a2bc-aae8a3350d8f',
          date: row.date as string,
          amountCents: row.amountCents,
          description: row.description,
          occurrence: occurrences[index],
        }),
      );
    };

    // The full month is the partial plus later rows, in oldest-first order.
    const laterRows = partial.slice(0, 3).map((row) => ({ ...row, date: '2026-09-30', rowIndex: row.rowIndex + 100 }));
    const full = [...partial, ...laterRows];

    expect(key(full).slice(0, partial.length)).toEqual(key(partial));
  });
});

describe('detection agrees with the seeded Relay profile', () => {
  it('independently proposes the profile that was seeded by hand', async () => {
    for (const filename of FILENAMES) {
      const file = await readRelay(filename);
      const parsed = applyProfile(file, RELAY_PROFILE);
      if (parsed.meta.dataRowCount === 0) continue;

      const detection = detectColumns(file);
      expect(detection.profile, filename).toMatchObject({
        date_column: 'Date',
        date_format: 'M/D/YYYY',
        description_columns: ['Payee'],
        counterparty_column: 'Payee',
        mode: 'signed',
        amount_column: 'Amount',
        balance_column: 'Balance',
        type_column: 'Transaction Type',
        reference_column: 'Reference',
        external_id_column: null,
        invert_sign: false,
        skip_rows: 0,
        header_row: 0,
      });
      expect(detection.guesses.amount?.map((guess) => guess.column), filename).toEqual(['Amount']);
    }
  });

  it('produces the same transactions from the detected profile as from the seeded one', async () => {
    for (const filename of FILENAMES) {
      const file = await readRelay(filename);
      const seeded = applyProfile(file, RELAY_PROFILE);
      if (seeded.meta.dataRowCount === 0) continue;

      const detected = applyProfile(file, detectColumns(file).profile);
      expect(
        detected.rows.map((row) => [row.date, row.description, row.amountCents, row.balanceCents]),
        filename,
      ).toEqual(seeded.rows.map((row) => [row.date, row.description, row.amountCents, row.balanceCents]));
    }
  });
});

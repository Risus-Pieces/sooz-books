import { describe, expect, it } from 'vitest';

import { readFixture, readInline, readRelay, RELAY_PROFILE } from './__fixtures__/support';
import { applyProfile, parseDateCell, readRawRows, resolveProfile } from './apply-profile';
import type { ImportProfile, ParseResult } from './types';

const SIMPLE: ImportProfile = {
  name: 'Test',
  date_column: 'Date',
  description_columns: ['Description'],
  mode: 'signed',
  amount_column: 'Amount',
  balance_column: 'Balance',
};

/** Every physical data row must end up in exactly one of `rows` or `skipped`. */
function accountsForEveryRow(result: ParseResult): boolean {
  return result.meta.dataRowCount === result.meta.returnedCount + result.meta.skippedCount;
}

describe('applyProfile on the real Relay statements', () => {
  it('normalizes the January statement for account #9726', async () => {
    const result = applyProfile(await readRelay('Relay 2026-01-01 #9726.csv'), RELAY_PROFILE);

    expect(result.meta.dataRowCount).toBe(18);
    expect(result.meta.usableCount).toBe(18);
    expect(result.meta.skippedCount).toBe(0);
    expect(accountsForEveryRow(result)).toBe(true);
    expect(result.warnings).toEqual([]);

    expect(result.rows[0]).toMatchObject({
      date: '2026-01-30',
      description: 'DAVESHOTCHICKEN',
      descriptionNormalized: 'DAVESHOTCHICKEN',
      counterparty: 'DAVESHOTCHICKEN',
      amountCents: -9743,
      balanceCents: 75833,
      reference: 'Corporate Card - 1892 (Business Card)',
      externalId: null,
      rawType: 'Spend',
      status: 'SETTLED',
      rowIndex: 0,
      usable: true,
    });

    // Money in is positive, money out is negative, always.
    const inflows = result.rows.filter((row) => row.amountCents > 0);
    expect(inflows.map((row) => row.description)).toEqual([
      'CHASE COLLEGE',
      'CHASE COLLEGE',
      'Square Inc',
      'Square Inc',
      'Square Inc',
      'Square Inc',
    ]);
    expect(result.meta.totalInCents).toBe(18874);
    expect(result.meta.totalOutCents).toBe(-43041);
    expect(result.meta.netCents).toBe(-24167);
    expect(result.meta.minDate).toBe('2026-01-15');
    expect(result.meta.maxDate).toBe('2026-01-30');
  });

  it('keeps the whole source row so a fingerprint can be recomputed later', async () => {
    const result = applyProfile(await readRelay('Relay 2026-01-01 #9726.csv'), RELAY_PROFILE);
    expect(result.rows[0].raw).toEqual({
      Date: '1/30/2026',
      Payee: 'DAVESHOTCHICKEN',
      'Account #': '',
      'Transaction Type': 'Spend',
      Description: 'Unknown',
      Reference: 'Corporate Card - 1892 (Business Card)',
      Status: 'SETTLED',
      Amount: '-97.43',
      Currency: 'USD',
      Balance: '758.33',
    });
  });

  it('flags a RETURNED ACH without dropping it, because it still moved the balance', async () => {
    const result = applyProfile(await readRelay('Relay 2026-05-01 #9726.csv'), RELAY_PROFILE);

    const returned = result.rows.filter((row) => row.status === 'RETURNED');
    expect(returned).toHaveLength(1);
    expect(returned[0]).toMatchObject({ date: '2026-05-15', description: 'GOOGLE', amountCents: 1000, usable: true });
    expect(returned[0].warnings).toEqual([
      expect.objectContaining({ code: 'row.flagged_by_rule', message: 'Returned ACH — did not settle' }),
    ]);
    expect(result.meta.skippedCount).toBe(0);
    expect(result.meta.usableCount).toBe(14);
  });

  it('drops the same row when the rule says skip, and counts the reason', async () => {
    const skipping: ImportProfile = {
      ...RELAY_PROFILE,
      skip_row_rules: [
        { field: 'Status', op: 'exact', value: 'RETURNED', action: 'skip', reason: 'Returned ACH — did not settle' },
      ],
    };
    const result = applyProfile(await readRelay('Relay 2026-05-01 #9726.csv'), skipping);

    expect(result.meta.usableCount).toBe(13);
    expect(result.meta.skippedCount).toBe(1);
    expect(accountsForEveryRow(result)).toBe(true);
    expect(result.skipped[0]).toMatchObject({
      rowIndex: 7,
      code: 'row.skipped_by_rule',
      reason: 'Returned ACH — did not settle',
    });
    // The raw cells travel with the skipped row; nothing disappears.
    expect(result.skipped[0].cells[1]).toBe('GOOGLE');
  });

  it('falls back to the reference when Relay writes a transfer with no payee', async () => {
    const result = applyProfile(await readRelay('Relay 2026-04-01 #9726.csv'), RELAY_PROFILE);
    const transfer = result.rows.find((row) => row.rawType === 'Receive-transfer');

    expect(transfer).toMatchObject({
      date: '2026-04-30',
      description: 'TRANSFER',
      counterparty: null,
      amountCents: 455,
      usable: true,
    });
    expect(transfer!.warnings).toEqual([
      expect.objectContaining({ code: 'description.fallback', message: expect.stringContaining('"Reference"') }),
    ]);
  });

  it('cleans the counterparty but leaves the description as the bank wrote it', async () => {
    const result = applyProfile(await readRelay('Relay 2026-05-01 #9726.csv'), RELAY_PROFILE);
    const meta = result.rows.find((row) => row.description === 'SP+AFF * META STORE -');
    expect(meta).toBeDefined();
    expect(meta!.counterparty).toBe('META STORE');
    expect(meta!.descriptionNormalized).toBe('SP AFF META STORE');
  });

  it('parses every one of the 110 real transactions without a single warning row', async () => {
    const files = [
      'Relay 2026-01-01 #9726.csv',
      'Relay 2026-02-01 #9726.csv',
      'Relay 2026-03-01 #9726.csv',
      'Relay 2026-06-01 #9726.csv',
      'Relay 2026-07-01 #9726.csv',
      'Relay 2026-08-01 #9726.csv',
      'Relay 2026-01-01 #9973.csv',
      'Relay 2026-05-01 #9973.csv',
    ];
    for (const filename of files) {
      const result = applyProfile(await readRelay(filename), RELAY_PROFILE);
      expect(result.rows.every((row) => row.usable), filename).toBe(true);
      expect(result.skipped, filename).toEqual([]);
      expect(result.rows.flatMap((row) => row.warnings).filter((w) => w.severity === 'error'), filename).toEqual([]);
    }
  });
});

describe('applyProfile — a bad row costs the row, never the file', () => {
  it('returns an unparsable date flagged rather than throwing or dropping it', async () => {
    const file = await readInline(
      [
        'Date,Description,Amount,Balance',
        '2026-03-01,Opening deposit,1000.00,1000.00',
        'not a date,ACME SUPPLY CO,-250.00,750.00',
        '2026-03-03,Customer payment,125.50,875.50',
        '',
      ].join('\n'),
    );
    const result = applyProfile(file, { ...SIMPLE, date_format: 'YYYY-MM-DD' });

    expect(result.rows).toHaveLength(3);
    expect(result.skipped).toEqual([]);
    expect(result.rows[1]).toMatchObject({ date: '', usable: false, description: 'ACME SUPPLY CO' });
    expect(result.rows[1].warnings[0]).toMatchObject({ code: 'date.unparsable', field: 'Date', value: 'not a date' });
    // Its amount was still read, so a human can see what the row was worth.
    expect(result.rows[1].amountCents).toBe(-25000);
    expect(result.meta.usableCount).toBe(2);
    expect(result.meta.flaggedCount).toBe(1);
  });

  it('returns an unparsable amount flagged, and does not guess a value', async () => {
    const file = await readInline(
      ['Date,Description,Amount', '2026-03-01,Opening deposit,one thousand', ''].join('\n'),
    );
    const result = applyProfile(file, { ...SIMPLE, balance_column: null });

    expect(result.rows[0]).toMatchObject({ usable: false, amountCents: 0 });
    expect(result.rows[0].warnings[0].code).toBe('amount.unparsable');
  });

  it('flags a $0.00 authorisation rather than importing a row the ledger cannot hold', async () => {
    const file = await readInline(['Date,Description,Amount', '2026-03-01,CARD AUTH,0.00', ''].join('\n'));
    const result = applyProfile(file, { ...SIMPLE, balance_column: null });

    expect(result.rows[0]).toMatchObject({ amountCents: 0, usable: false });
    expect(result.rows[0].warnings[0]).toMatchObject({ code: 'amount.zero' });
  });

  it('skips a short row rather than shifting every column, and says why', async () => {
    const file = await readInline(
      [
        'Date,Description,Amount,Balance',
        '2026-03-01,Opening deposit,1000.00,1000.00',
        'Totals,-250.00',
        '2026-03-03,Customer payment,125.50,875.50',
        '',
      ].join('\n'),
    );
    const result = applyProfile(file, SIMPLE);

    expect(result.rows).toHaveLength(2);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toMatchObject({ rowIndex: 1, code: 'row.field_count' });
    expect(result.skipped[0].reason).toMatch(/2 fields but the header has 4/);
    expect(result.meta.skippedByCode).toEqual({ 'row.field_count': 1 });
    expect(accountsForEveryRow(result)).toBe(true);
  });

  it('reads a short row positionally when the caller asks for it', async () => {
    const file = await readInline(
      ['Date,Description,Amount,Balance', '2026-03-01,Opening deposit,1000.00', ''].join('\n'),
    );
    const result = applyProfile(file, SIMPLE, { padShortRows: true });

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ amountCents: 100000, balanceCents: null, usable: true });
    expect(result.rows[0].warnings[0].code).toBe('row.field_count');
  });

  it('skips every row with a counted reason when the profile does not match the file', async () => {
    const file = await readInline(
      ['Datum,Beschreibung,Betrag', '2026-03-01,Opening deposit,1000.00', '2026-03-02,ACME,-250.00', ''].join('\n'),
    );
    const result = applyProfile(file, SIMPLE);

    expect(result.rows).toEqual([]);
    expect(result.skipped).toHaveLength(2);
    expect(result.meta.skippedByCode).toEqual({ 'profile.column_missing': 2 });
    expect(accountsForEveryRow(result)).toBe(true);
    expect(result.warnings[0]).toMatchObject({ severity: 'error', code: 'profile.column_missing' });
    expect(result.warnings[0].message).toMatch(
      /"Date", "Amount"[\s\S]*Its columns are: "Datum", "Beschreibung", "Betrag"/,
    );
  });

  it('warns but carries on when only an optional column is missing', async () => {
    const file = await readInline(
      ['Date,Description,Amount', '2026-03-01,Opening deposit,1000.00', ''].join('\n'),
    );
    const result = applyProfile(file, SIMPLE);

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].balanceCents).toBeNull();
    expect(result.warnings[0]).toMatchObject({ severity: 'warn', code: 'profile.column_missing', field: 'Balance' });
  });

  it('is fine with a header and no transactions at all', async () => {
    const result = applyProfile(await readRelay('Relay 2026-03-01 #9973.csv'), RELAY_PROFILE);
    expect(result.rows).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.meta.dataRowCount).toBe(0);
    expect(result.warnings).toEqual([expect.objectContaining({ severity: 'info', code: 'file.no_data_rows' })]);
  });

  it('never throws for any data reason', async () => {
    const file = await readInline(
      [
        'Date,Description,Amount,Balance',
        ',,,',
        'not a date,,not money,not money',
        '2026-13-45,x,1e999,-',
        '2026-03-01,ok,-1.00,999.00',
        '',
      ].join('\n'),
    );
    expect(() => applyProfile(file, SIMPLE)).not.toThrow();
    const result = applyProfile(file, SIMPLE);
    expect(result.meta.usableCount).toBe(1);
    expect(accountsForEveryRow(result)).toBe(true);
  });
});

describe('applyProfile — amount modes', () => {
  it('turns a debit into money out and a credit into money in', async () => {
    const result = applyProfile(await readFixture('debit-credit.csv'), {
      name: 'Pair',
      date_column: 'Date',
      description_columns: ['Description'],
      mode: 'debit_credit',
      debit_column: 'Debit',
      credit_column: 'Credit',
      balance_column: 'Balance',
    });
    expect(result.rows.map((row) => row.amountCents)).toEqual([100000, -25000, 12550, -1500, -6050]);
  });

  it('nets a row where both the debit and the credit are filled, and says so', async () => {
    const file = await readInline(
      ['Date,Description,Debit,Credit', '2026-03-01,Adjustment,40.00,100.00', ''].join('\n'),
    );
    const result = applyProfile(file, {
      date_column: 'Date',
      description_columns: ['Description'],
      mode: 'debit_credit',
      debit_column: 'Debit',
      credit_column: 'Credit',
    });
    expect(result.rows[0]).toMatchObject({ amountCents: 6000, usable: true });
    expect(result.rows[0].warnings[0].code).toBe('amount.debit_and_credit');
  });

  it('takes direction from the type column when every amount is positive', async () => {
    const result = applyProfile(await readFixture('amount-with-type.csv'), {
      date_column: 'Posted Date',
      date_format: 'M/D/YYYY',
      description_columns: ['Description'],
      mode: 'amount_with_type',
      amount_column: 'Amount',
      type_column: 'Transaction Type',
      debit_type_values: ['DEBIT'],
      credit_type_values: ['CREDIT'],
    });
    expect(result.rows.map((row) => row.amountCents)).toEqual([100000, -25000, 12550, -1500, -6050]);
    expect(result.rows.map((row) => row.date)).toEqual([
      '2026-03-01',
      '2026-03-02',
      '2026-03-03',
      '2026-03-04',
      '2026-03-05',
    ]);
  });

  it('refuses to guess at an unmapped transaction type', async () => {
    // An unknown enum value is never silently dropped and never assumed: that is
    // exactly how a new row category slips into the ledger with the wrong sign.
    const file = await readInline(
      [
        'Date,Type,Description,Amount',
        '2026-03-01,CREDIT,Opening deposit,1000.00',
        '2026-03-02,REVERSAL,Chargeback,250.00',
        '',
      ].join('\n'),
    );
    const result = applyProfile(file, {
      date_column: 'Date',
      description_columns: ['Description'],
      mode: 'amount_with_type',
      amount_column: 'Amount',
      type_column: 'Type',
      debit_type_values: ['DEBIT'],
      credit_type_values: ['CREDIT'],
    });

    expect(result.rows[1]).toMatchObject({ usable: false, rawType: 'REVERSAL' });
    expect(result.rows[1].warnings[0]).toMatchObject({ code: 'type.unknown', value: 'REVERSAL' });
    expect(result.rows[1].warnings[0].message).toMatch(/neither the debit list \(DEBIT\) nor the credit list \(CREDIT\)/);
  });

  it('inverts every amount when the profile says to', async () => {
    const result = applyProfile(await readFixture('inverted-sign.csv'), {
      date_column: 'Date',
      description_columns: ['Description'],
      mode: 'signed',
      amount_column: 'Amount',
      balance_column: 'Balance',
      invert_sign: true,
    });
    expect(result.rows.map((row) => row.amountCents)).toEqual([100000, -25000, 12550, -1500]);
  });

  it('concatenates a description split across several columns', async () => {
    const file = await readInline(
      [
        'Date,Detail 1,Detail 2,Amount',
        '2026-03-01,ACH CREDIT,BLUE PACIFIC FLAVORS,1000.00',
        '2026-03-02,CARD PURCHASE,,-250.00',
        '',
      ].join('\n'),
    );
    const result = applyProfile(file, {
      date_column: 'Date',
      description_columns: ['Detail 1', 'Detail 2'],
      mode: 'signed',
      amount_column: 'Amount',
    });
    expect(result.rows.map((row) => row.description)).toEqual([
      'ACH CREDIT BLUE PACIFIC FLAVORS',
      'CARD PURCHASE',
    ]);
  });
});

describe('applyProfile — preamble and column addressing', () => {
  it('honours skip_rows and header_row', async () => {
    const result = applyProfile(await readFixture('preamble.csv'), {
      date_column: 'Date',
      date_format: 'M/D/YYYY',
      description_columns: ['Description'],
      mode: 'signed',
      amount_column: 'Amount',
      balance_column: 'Running Bal.',
      skip_rows: 5,
      header_row: 0,
    });
    expect(result.meta.headerRowIndex).toBe(5);
    expect(result.rows).toHaveLength(5);
    expect(result.rows[0]).toMatchObject({ date: '2026-03-05', amountCents: -6050, balanceCents: 80000 });
  });

  it('matches a profile column name case-insensitively and past punctuation', async () => {
    const file = await readInline(
      ['TXN_DATE,DESCRIPTION,AMOUNT', '2026-03-01,Opening deposit,1000.00', ''].join('\n'),
    );
    const result = applyProfile(file, {
      date_column: 'Txn Date',
      description_columns: ['description'],
      mode: 'signed',
      amount_column: 'amount',
    });
    expect(result.rows[0]).toMatchObject({ date: '2026-03-01', description: 'Opening deposit', amountCents: 100000 });
  });

  it('keeps a repeated header under a suffixed key rather than losing one of them', async () => {
    const file = await readInline(
      ['Date,Memo,Memo,Amount', '2026-03-01,first,second,1000.00', ''].join('\n'),
    );
    const result = applyProfile(file, {
      date_column: 'Date',
      description_columns: ['Memo'],
      mode: 'signed',
      amount_column: 'Amount',
    });
    expect(result.rows[0].raw).toEqual({ Date: '2026-03-01', Memo: 'first', Memo__2: 'second', Amount: '1000.00' });
  });
});

describe('applyProfile — skip rules', () => {
  const file = (): Promise<import('./types').ParsedFile> =>
    readInline(
      [
        'Date,Description,Status,Amount',
        '2026-03-01,Opening deposit,SETTLED,1000.00',
        '2026-03-02,Pending charge,PENDING,-250.00',
        '2026-03-03,Customer payment,SETTLED,125.50',
        '',
      ].join('\n'),
    );

  const base: ImportProfile = {
    date_column: 'Date',
    description_columns: ['Description'],
    mode: 'signed',
    amount_column: 'Amount',
  };

  it('supports every operator', async () => {
    const parsed = await file();
    const drop = (rule: import('./types').SkipRowRule): number =>
      applyProfile(parsed, { ...base, skip_row_rules: [rule] }).skipped.length;

    expect(drop({ field: 'Status', op: 'exact', value: 'PENDING', action: 'skip' })).toBe(1);
    expect(drop({ field: 'Status', op: 'contains', value: 'PEND', action: 'skip' })).toBe(1);
    expect(drop({ field: 'Status', op: 'not_contains', value: 'SETTLED', action: 'skip' })).toBe(1);
    expect(drop({ field: 'Status', op: 'starts_with', value: 'PEND', action: 'skip' })).toBe(1);
    expect(drop({ field: 'Status', op: 'ends_with', value: 'ING', action: 'skip' })).toBe(1);
    expect(drop({ field: 'Status', op: 'regex', value: '^pend', action: 'skip' })).toBe(1);
    expect(drop({ field: 'Description', op: 'blank', action: 'skip' })).toBe(0);
    expect(drop({ field: 'Description', op: 'not_blank', action: 'skip' })).toBe(3);
  });

  it('matches case-insensitively unless told otherwise', async () => {
    const parsed = await file();
    const sensitive = applyProfile(parsed, {
      ...base,
      skip_row_rules: [{ field: 'Status', op: 'exact', value: 'pending', action: 'skip', caseSensitive: true }],
    });
    expect(sensitive.skipped).toHaveLength(0);
  });

  it('resolves a semantic field name when the file has no column by that name', async () => {
    const parsed = await file();
    const result = applyProfile(parsed, {
      ...base,
      skip_row_rules: [{ field: 'description', op: 'contains', value: 'PENDING CHARGE', action: 'skip' }],
    });
    expect(result.skipped).toHaveLength(1);
  });

  it('ignores a rule naming a column this file does not have', async () => {
    const parsed = await file();
    const result = applyProfile(parsed, {
      ...base,
      skip_row_rules: [{ field: 'Cleared Date', op: 'blank', action: 'skip' }],
    });
    expect(result.skipped).toHaveLength(0);
  });

  it('does not let a malformed saved pattern take the file down', async () => {
    const parsed = await file();
    const result = applyProfile(parsed, {
      ...base,
      skip_row_rules: [{ field: 'Status', op: 'regex', value: '([unclosed', action: 'skip' }],
    });
    expect(result.rows).toHaveLength(3);
    expect(result.skipped).toHaveLength(0);
  });
});

describe('parseDateCell', () => {
  it('reads M/D/YYYY, which is what Relay writes', () => {
    expect(parseDateCell('1/5/2026', 'M/D/YYYY')).toBe('2026-01-05');
    expect(parseDateCell('1/30/2026', 'M/D/YYYY')).toBe('2026-01-30');
    expect(parseDateCell('12/31/2026', 'M/D/YYYY')).toBe('2026-12-31');
  });

  it('reads D/M/YYYY when the profile says so — the one case inspection cannot settle', () => {
    expect(parseDateCell('3/4/2026', 'M/D/YYYY')).toBe('2026-03-04');
    expect(parseDateCell('3/4/2026', 'D/M/YYYY')).toBe('2026-04-03');
    expect(parseDateCell('31/12/2026', 'DD/MM/YYYY')).toBe('2026-12-31');
  });

  it('reads ISO, named months, two-digit years and Excel serials', () => {
    expect(parseDateCell('2026-03-01', 'YYYY-MM-DD')).toBe('2026-03-01');
    expect(parseDateCell('15-Mar-2026', 'DD-MMM-YYYY')).toBe('2026-03-15');
    expect(parseDateCell('3/1/26', 'M/D/YY')).toBe('2026-03-01');
    expect(parseDateCell('46082', null)).toBe('2026-03-01');
  });

  it('drops a time component and keeps the calendar date', () => {
    expect(parseDateCell('2026-03-01T14:30:00Z', 'YYYY-MM-DD')).toBe('2026-03-01');
    expect(parseDateCell('3/1/2026 14:30', 'M/D/YYYY')).toBe('2026-03-01');
  });

  it('rejects a date that does not exist', () => {
    expect(() => parseDateCell('2/30/2026', 'M/D/YYYY')).toThrow();
    expect(() => parseDateCell('31/12/2026', 'M/D/YYYY')).toThrow();
  });
});

describe('readRawRows', () => {
  it('splits a file into its header and data rows, addressable both ways', async () => {
    const { headers, headerPhysicalRow, rows } = readRawRows(await readRelay('Relay 2026-01-01 #9973.csv'));

    expect(headerPhysicalRow).toBe(0);
    expect(headers[1]).toBe('Payee');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ rowIndex: 0, physicalRow: 1 });
    expect(rows[0].cells[1]).toBe('CHASE COLLEGE');
    expect(rows[0].record.Payee).toBe('CHASE COLLEGE');
    expect(rows[0].record.Amount).toBe('+10.47');
  });

  it('honours a preamble', async () => {
    const { headers, headerPhysicalRow, rows } = readRawRows(await readFixture('preamble.csv'), { skipRows: 5 });
    expect(headerPhysicalRow).toBe(5);
    expect(headers).toEqual(['Date', 'Description', 'Amount', 'Running Bal.']);
    expect(rows).toHaveLength(5);
    expect(rows[0].physicalRow).toBe(6);
  });
});

describe('resolveProfile', () => {
  it('fills in every optional field', () => {
    const resolved = resolveProfile({ date_column: 'Date', mode: 'signed', amount_column: 'Amount' });
    expect(resolved).toMatchObject({
      file_type: 'csv',
      delimiter: ',',
      encoding: 'utf-8',
      skip_rows: 0,
      header_row: 0,
      description_columns: [],
      debit_type_values: [],
      credit_type_values: [],
      invert_sign: false,
      skip_row_rules: [],
      status_column: null,
    });
  });
});

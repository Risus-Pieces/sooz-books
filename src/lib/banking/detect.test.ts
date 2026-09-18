import { describe, expect, it } from 'vitest';

import { readFixture, readInline, readRelay } from './__fixtures__/support';
import { applyProfile } from './apply-profile';
import { detectColumns } from './detect';
import type { ColumnGuess, DetectionResult } from './types';

function best(detection: DetectionResult, role: keyof DetectionResult['guesses']): ColumnGuess | undefined {
  return detection.guesses[role]?.[0];
}

function columnsFor(detection: DetectionResult, role: keyof DetectionResult['guesses']): string[] {
  return (detection.guesses[role] ?? []).map((guess) => guess.column);
}

describe('detectColumns on a real Relay statement', () => {
  it('proposes Date, Amount, signed, Balance — and never Balance as the amount', async () => {
    const detection = detectColumns(await readRelay('Relay 2026-01-01 #9726.csv'));

    expect(detection.ok).toBe(true);
    expect(detection.headerRowIndex).toBe(0);
    expect(detection.dataRowCount).toBe(18);

    expect(detection.profile.date_column).toBe('Date');
    expect(detection.profile.amount_column).toBe('Amount');
    expect(detection.amountMode).toBe('signed');
    expect(detection.profile.mode).toBe('signed');
    expect(detection.profile.balance_column).toBe('Balance');

    // The rule this whole module is built around. A running balance proposed as
    // the amount produces a ledger where every transaction is worth whatever the
    // account held that day, and it reconciles to nothing.
    expect(columnsFor(detection, 'amount')).not.toContain('Balance');
    expect(columnsFor(detection, 'amount')).toEqual(['Amount']);
    expect(best(detection, 'balance')?.column).toBe('Balance');
  });

  it('explains how it told the balance from the amount', async () => {
    const detection = detectColumns(await readRelay('Relay 2026-01-01 #9726.csv'));
    expect(detection.reasons.join(' | ')).toMatch(
      /"Balance" is the running balance: it moves by "Amount" on 100% of 17 consecutive rows \(descending order\)/,
    );
    expect(best(detection, 'amount')?.reasons[0]).toMatch(/running balance "Balance" moves by this column/);
  });

  it('prefers Payee over the Description column, which is the word "Unknown" on three rows in four', async () => {
    const detection = detectColumns(await readRelay('Relay 2026-01-01 #9726.csv'));
    expect(detection.profile.description_columns).toEqual(['Payee']);
    expect(detection.profile.counterparty_column).toBe('Payee');

    const description = detection.guesses.description ?? [];
    const payee = description.find((guess) => guess.column === 'Payee');
    const unknown = description.find((guess) => guess.column === 'Description');
    expect(payee!.confidence).toBeGreaterThan(unknown!.confidence);
    expect(unknown!.reasons.join(' ')).toMatch(/every non-empty value is the same string/);
  });

  it('finds the type, status, reference and currency columns and leaves external id empty', async () => {
    const detection = detectColumns(await readRelay('Relay 2026-01-01 #9726.csv'));
    expect(detection.profile.type_column).toBe('Transaction Type');
    expect(detection.profile.reference_column).toBe('Reference');
    expect(best(detection, 'status')?.column).toBe('Status');
    expect(best(detection, 'currency')?.column).toBe('Currency');
    // Relay has no stable transaction id, and inventing one would be worse than none.
    expect(detection.profile.external_id_column).toBeNull();
  });

  it('reads the sign convention off the balance and proposes no inversion', async () => {
    const detection = detectColumns(await readRelay('Relay 2026-01-01 #9726.csv'));
    expect(detection.signConvention).toMatchObject({
      mode: 'signed',
      negativeIsOutflow: true,
      invertSign: false,
    });
    expect(detection.profile.invert_sign).toBe(false);
    expect(detection.confidence).toBeGreaterThan(0.9);
  });

  it('names the M/D/YYYY date format and a filename pattern', async () => {
    const detection = detectColumns(await readRelay('Relay 2026-05-01 #9726.csv'));
    expect(detection.profile.date_format).toBe('M/D/YYYY');
    expect(detection.profile.detected_from_filename).toBe('^Relay \\d{4}-\\d{2}-\\d{2} #\\d{4}\\.csv$');
    expect(new RegExp(detection.profile.detected_from_filename!).test('Relay 2026-08-01 #9973.csv')).toBe(true);
  });

  it('classifies a header-only statement from its names alone, and says the confidence is nil', async () => {
    const detection = detectColumns(await readFixture('header-only.csv'));
    expect(detection.profile.date_column).toBe('Date');
    expect(detection.profile.amount_column).toBe('Amount');
    expect(detection.profile.balance_column).toBe('Balance');
    expect(columnsFor(detection, 'amount')).not.toContain('Balance');
    // Nothing in the file corroborates any of it, and nothing says which way the
    // signs run, so the UI must ask rather than accept.
    expect(detection.confidence).toBe(0);
    expect(detection.warnings.map((warning) => warning.code)).toContain('file.no_data_rows');
  });
});

describe('detectColumns — the balance must never be the amount', () => {
  it('identifies a running balance with no balance-ish header, purely from the chain', async () => {
    // `Total` matches nothing in the header vocabulary. The only evidence that it
    // is a balance is that it moves by `Value` row over row — which is exactly the
    // evidence a bank with an unusual header gives you.
    const detection = detectColumns(await readFixture('disguised-balance.csv'));

    expect(detection.profile.amount_column).toBe('Value');
    expect(detection.profile.balance_column).toBe('Total');
    expect(columnsFor(detection, 'amount')).not.toContain('Total');
    expect(detection.reasons.join(' | ')).toMatch(/"Total" is the running balance: it moves by "Value"/);
  });

  it('never ranks a column called Balance as the amount, even with no rows to check', async () => {
    const detection = detectColumns(
      await readInline('Date,Description,Balance\n', 'weird.csv'),
    );
    expect(columnsFor(detection, 'amount')).not.toContain('Balance');
    expect(detection.profile.amount_column).toBeNull();
    expect(detection.ok).toBe(false);
    expect(detection.warnings.map((w) => w.code)).toContain('profile.mode_columns_missing');
  });

  it('does not mistake half of a debit/credit pair for the amount column', async () => {
    const detection = detectColumns(await readFixture('debit-credit.csv'));
    expect(detection.profile.mode).toBe('debit_credit');
    expect(detection.profile.amount_column).toBeNull();
    expect(detection.profile.balance_column).toBe('Balance');
    expect(columnsFor(detection, 'amount')).not.toContain('Balance');
  });
});

describe('detectColumns — amount modes', () => {
  it('detects a debit/credit pair from mutual exclusivity plus the headers', async () => {
    const detection = detectColumns(await readFixture('debit-credit.csv'));
    expect(detection.amountMode).toBe('debit_credit');
    expect(detection.profile.debit_column).toBe('Debit');
    expect(detection.profile.credit_column).toBe('Credit');
    expect(detection.signConvention.evidence).toMatch(/no sign convention is needed/);
    expect(detection.reasons.join(' | ')).toMatch(/exactly one of the two is filled on 100% of rows/);
  });

  it('detects an amount + type layout and learns both vocabularies', async () => {
    const detection = detectColumns(await readFixture('amount-with-type.csv'));
    expect(detection.amountMode).toBe('amount_with_type');
    expect(detection.profile.amount_column).toBe('Amount');
    expect(detection.profile.type_column).toBe('Transaction Type');
    expect(detection.profile.debit_type_values).toEqual(['DEBIT']);
    expect(detection.profile.credit_type_values).toEqual(['CREDIT']);
    expect(detection.profile.date_column).toBe('Posted Date');
  });

  it('reads Withdrawal/Deposit as a type vocabulary too', async () => {
    const detection = detectColumns(
      await readInline(
        [
          'Date,Type,Description,Amount',
          '2026-03-01,Deposit,Opening deposit,1000.00',
          '2026-03-02,Withdrawal,ACME SUPPLY CO,250.00',
          '2026-03-03,Deposit,Customer payment,125.50',
          '2026-03-04,Withdrawal,BANK FEE,15.00',
          '',
        ].join('\n'),
      ),
    );
    expect(detection.amountMode).toBe('amount_with_type');
    expect(detection.profile.debit_type_values).toEqual(['Withdrawal']);
    expect(detection.profile.credit_type_values).toEqual(['Deposit']);
  });

  it('reads DR/CR as a type vocabulary', async () => {
    const detection = detectColumns(
      await readInline(
        [
          'Date,Dr/Cr,Narrative,Amount',
          '2026-03-01,CR,Opening deposit,1000.00',
          '2026-03-02,DR,ACME SUPPLY CO,250.00',
          '2026-03-03,CR,Customer payment,125.50',
          '',
        ].join('\n'),
      ),
    );
    expect(detection.amountMode).toBe('amount_with_type');
    expect(detection.profile.type_column).toBe('Dr/Cr');
    expect(detection.profile.debit_type_values).toEqual(['DR']);
    expect(detection.profile.credit_type_values).toEqual(['CR']);
  });

  it('stays signed when the amounts already carry their own signs', async () => {
    // A type column is present and classifiable, but the amounts are signed, so
    // the type is captured as metadata and the signs are trusted.
    const detection = detectColumns(await readRelay('Relay 2026-05-01 #9726.csv'));
    expect(detection.amountMode).toBe('signed');
    expect(detection.profile.type_column).toBe('Transaction Type');
    expect(detection.profile.debit_type_values).toEqual([]);
    expect(detection.profile.credit_type_values).toEqual([]);
  });
});

describe('detectColumns — sign convention', () => {
  it('proposes inverting when the balance rises on a negative amount', async () => {
    // A bank writing the file from its own point of view: a withdrawal is a
    // positive number. Only the balance column can tell you.
    const detection = detectColumns(await readFixture('inverted-sign.csv'));
    expect(detection.amountMode).toBe('signed');
    expect(detection.signConvention.negativeIsOutflow).toBe(false);
    expect(detection.profile.invert_sign).toBe(true);
    expect(detection.signConvention.evidence).toMatch(/bank's point of view/);

    // And applying the proposed profile puts the signs the right way round.
    const parsed = applyProfile(await readFixture('inverted-sign.csv'), detection.profile);
    expect(parsed.rows.map((row) => row.amountCents)).toEqual([100000, -25000, 12550, -1500]);
  });

  it('admits when it cannot tell, rather than assuming', async () => {
    const detection = detectColumns(
      await readInline(
        ['Date,Description,Amount', '2026-03-01,Opening deposit,1000.00', '2026-03-02,ACME SUPPLY CO,250.00', ''].join(
          '\n',
        ),
      ),
    );
    expect(detection.signConvention.confidence).toBeLessThan(0.5);
    expect(detection.signConvention.evidence).toMatch(/needs confirming/);
    expect(detection.confidence).toBeLessThan(0.5);
  });
});

describe('detectColumns — finding the header row', () => {
  it('walks past a five-row preamble', async () => {
    const detection = detectColumns(await readFixture('preamble.csv'));
    expect(detection.headerRowIndex).toBe(5);
    expect(detection.skipRows).toBe(5);
    expect(detection.profile.skip_rows).toBe(5);
    expect(detection.profile.header_row).toBe(0);
    expect(detection.headers).toEqual(['Date', 'Description', 'Amount', 'Running Bal.']);
    expect(detection.profile.balance_column).toBe('Running Bal.');
    expect(detection.dataRowCount).toBe(5);
  });

  it('does not pick a summary line that happens to mention a balance', async () => {
    const detection = detectColumns(await readFixture('preamble.csv'));
    expect(detection.headers).not.toContain('Summary Amt.');
  });

  it('reports an empty file rather than inventing a header', async () => {
    const detection = detectColumns({
      filename: 'nothing.csv',
      format: 'csv',
      rows: [],
      encoding: 'utf-8',
      delimiter: ',',
      sha256: '',
      byteLength: 0,
    });
    expect(detection.ok).toBe(false);
    expect(detection.headerRowIndex).toBe(-1);
    expect(detection.warnings.map((warning) => warning.code)).toEqual(['file.empty']);
  });

  it('only scans as far as the caller allows', async () => {
    const detection = detectColumns(await readFixture('preamble.csv'), { headerScanRows: 3 });
    expect(detection.headerRowIndex).toBeLessThan(3);
  });
});

describe('detectColumns — profile naming', () => {
  it('names the profile after the bank, not the month', async () => {
    expect(detectColumns(await readRelay('Relay 2026-01-01 #9726.csv')).profile.name).toBe('Relay CSV');
    expect(detectColumns(await readRelay('Relay (Partial) 2026-09-01 #9726.csv')).profile.name).toBe('Relay CSV');
  });

  it('records the file type in the name and the profile', async () => {
    const detection = detectColumns(await readFixture('date-serials.xlsx'));
    expect(detection.profile.file_type).toBe('xlsx');
    expect(detection.profile.name).toBe('date-serials XLSX');
  });

  it('accepts an explicit profile name', async () => {
    const detection = detectColumns(await readRelay('Relay 2026-01-01 #9726.csv'), {
      profileName: 'Relay — Operating Expenses',
    });
    expect(detection.profile.name).toBe('Relay — Operating Expenses');
  });
});

import { describe, expect, it } from 'vitest';

import { fixtureBytes, readFixture, readInline, readRelay } from './__fixtures__/support';
import { fileHash } from './fingerprint';
import { readFile, UnreadableFileError } from './read-file';

describe('readFile — delimited text', () => {
  it('reads a real Relay statement into a 10-column grid of trimmed strings', async () => {
    const file = await readRelay('Relay 2026-01-01 #9726.csv');

    expect(file.format).toBe('csv');
    expect(file.delimiter).toBe(',');
    expect(file.encoding).toBe('utf-8');
    expect(file.rows[0]).toEqual([
      'Date',
      'Payee',
      'Account #',
      'Transaction Type',
      'Description',
      'Reference',
      'Status',
      'Amount',
      'Currency',
      'Balance',
    ]);
    // 18 data rows, and the trailing newline did not become a 20th row.
    expect(file.rows).toHaveLength(19);
    expect(file.rows.every((row) => row.length === 10)).toBe(true);
    expect(file.rows[1][7]).toBe('-97.43');
  });

  it('keeps an empty Relay statement as a header and nothing else', async () => {
    const file = await readRelay('Relay 2026-01-01 #9727.csv');
    expect(file.rows).toHaveLength(1);
    expect(file.rows[0][0]).toBe('Date');
  });

  it('reports the sha256 of the bytes as the file hash', async () => {
    const bytes = fixtureBytes('relay-sample.csv');
    const file = await readFile(bytes, 'relay-sample.csv');
    expect(file.sha256).toBe(fileHash(bytes));
    expect(file.byteLength).toBe(bytes.byteLength);
  });

  it('strips a UTF-8 BOM and records that it was there', async () => {
    const file = await readFixture('bom.csv');
    expect(file.encoding).toBe('utf-8-sig');
    // Without the strip this would be "﻿Date" and every header lookup would miss.
    expect(file.rows[0][0]).toBe('Date');
  });

  it('falls back to latin-1 when the bytes are not valid UTF-8', async () => {
    const file = await readFixture('latin1.csv');
    expect(file.encoding).toBe('latin-1');
    expect(file.rows[1][1]).toBe('Café Olé');
    expect(file.rows[2][1]).toBe("Kalustyan's naïve");
    expect(file.rows[3][1]).toBe('Jürgen Müller GmbH');
    // A replacement character here would mean the fallback did not happen.
    expect(file.rows.flat().join('')).not.toContain('�');
  });

  it('honours a forced encoding', async () => {
    const file = await readFile(fixtureBytes('latin1.csv'), 'latin1.csv', { encoding: 'latin-1' });
    expect(file.encoding).toBe('latin-1');
    expect(file.rows[1][1]).toBe('Café Olé');
  });

  it('sniffs a semicolon delimiter even when the descriptions contain commas', async () => {
    const file = await readFixture('semicolon.csv');
    expect(file.delimiter).toBe(';');
    expect(file.rows[1]).toEqual(['2026-03-01', 'Opening deposit, initial', '1000.00', '1000.00']);
  });

  it('sniffs tab and pipe delimiters', async () => {
    const tabbed = await readInline('Date\tDescription\tAmount\n2026-03-01\tACME, INC\t-250.00\n', 'tabbed.csv');
    expect(tabbed.delimiter).toBe('\t');
    expect(tabbed.rows[1]).toEqual(['2026-03-01', 'ACME, INC', '-250.00']);

    const piped = await readInline('Date|Description|Amount\n2026-03-01|ACME; INC|-250.00\n', 'piped.txt');
    expect(piped.delimiter).toBe('|');
    expect(piped.rows[1]).toEqual(['2026-03-01', 'ACME; INC', '-250.00']);
  });

  it('honours a forced delimiter', async () => {
    const file = await readFile(Buffer.from('a;b\n1;2\n'), 'x.csv', { delimiter: ',' });
    expect(file.delimiter).toBe(',');
    expect(file.rows[0]).toEqual(['a;b']);
  });

  it('keeps quoted fields whole, including embedded newlines and doubled quotes', async () => {
    const file = await readInline(
      'Date,Memo,Amount\n2026-03-01,"line one\nline two",-1.00\n2026-03-02,"a ""quoted"" word",-2.00\n',
    );
    expect(file.rows[1][1]).toBe('line one\nline two');
    expect(file.rows[2][1]).toBe('a "quoted" word');
  });

  it('drops wholly blank rows but keeps rows with a single value', async () => {
    const file = await readInline('Date,Amount\n\n2026-03-01,-1.00\n,,\n2026-03-02,\n');
    expect(file.rows).toEqual([
      ['Date', 'Amount'],
      ['2026-03-01', '-1.00'],
      ['2026-03-02', ''],
    ]);
  });

  it('stops at maxRows', async () => {
    const file = await readRelay('Relay 2026-02-01 #9726.csv');
    expect(file.rows.length).toBeGreaterThan(5);
    const limited = await readFile(fixtureBytes('relay-sample.csv'), 'relay-sample.csv', { maxRows: 4 });
    expect(limited.rows).toHaveLength(4);
  });
});

describe('readFile — workbooks', () => {
  it('detects an XLSX from its bytes, whatever the filename claims', async () => {
    const file = await readFile(fixtureBytes('date-serials.xlsx'), 'statement-export.csv');
    expect(file.format).toBe('xlsx');
    expect(file.delimiter).toBeNull();
    expect(file.sheetNames).toEqual(['Notes', 'Statement']);
  });

  it('reads the largest sheet, not the first one', async () => {
    // Bank workbooks routinely put a one-line "exported by …" tab in front.
    const file = await readFixture('date-serials.xlsx');
    expect(file.sheetName).toBe('Statement');
    expect(file.rows[0]).toEqual(['Date', 'Description', 'Amount', 'Balance']);
  });

  it('reads a named sheet on request, and says so when there is no such sheet', async () => {
    const file = await readFile(fixtureBytes('date-serials.xlsx'), 'wb.xlsx', { sheet: 'Notes' });
    expect(file.sheetName).toBe('Notes');
    expect(file.rows[0][0]).toBe('Exported by the bank portal. Do not edit.');

    await expect(readFile(fixtureBytes('date-serials.xlsx'), 'wb.xlsx', { sheet: 'Ledger' })).rejects.toThrow(
      /no sheet named "Ledger"/,
    );
  });

  it('renders Excel date serials and real date cells alike as YYYY-MM-DD', async () => {
    const file = await readFixture('date-serials.xlsx');
    // Rows 1–3 are raw serials under a date number format; rows 4–5 are real
    // date cells. Both must come out as calendar-date strings — never as 46082,
    // and never routed through a local-time Date that lands a day early.
    expect(file.rows.slice(1).map((row) => row[0])).toEqual([
      '2026-03-01',
      '2026-03-02',
      '2026-03-03',
      '2026-03-04',
      '2026-03-05',
    ]);
  });

  it('never turns a numeric cell into a float-formatted money string', async () => {
    const file = await readFixture('date-serials.xlsx');
    const amounts = file.rows.slice(1).map((row) => row[2]);
    // The last amount is stored as the double -60.500000000000014, which is what
    // a spreadsheet round-trip does to -60.50. Fifteen significant digits is what
    // Excel itself keeps, so that is what comes back.
    expect(amounts).toEqual(['1000', '-250', '125.5', '-15', '-60.5']);
    expect(amounts.some((value) => /\d{8,}$/.test(value))).toBe(false);
  });
});

describe('readFile — impostors', () => {
  it('rejects an HTML page served under a .csv name', async () => {
    const error = await readFixture('html-disguised.csv').catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(UnreadableFileError);
    expect((error as UnreadableFileError).code).toBe('file.html');
    expect((error as UnreadableFileError).message).toMatch(/HTML document/);
    expect((error as UnreadableFileError).remedy).toMatch(/download the statement again/i);
  });

  it('rejects a legacy binary .xls, whatever it is called', async () => {
    const error = await readFixture('legacy-xls-disguised.csv').catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(UnreadableFileError);
    expect((error as UnreadableFileError).code).toBe('file.legacy_xls');
    expect((error as UnreadableFileError).remedy).toMatch(/Save As/);
  });

  it('rejects a PDF', async () => {
    const error = await readFile(Buffer.from('%PDF-1.7\n%âãÏÓ\n', 'latin1'), 'statement.csv').catch(
      (cause: unknown) => cause,
    );
    expect((error as UnreadableFileError).code).toBe('file.pdf');
  });

  it('rejects an empty file', async () => {
    const error = await readFile(Buffer.alloc(0), 'statement.csv').catch((cause: unknown) => cause);
    expect((error as UnreadableFileError).code).toBe('file.empty');
  });

  it('rejects a zip that is not a readable workbook', async () => {
    // A valid empty zip: the end-of-central-directory record with a local header
    // prefix, which passes the magic-byte check and fails to open.
    const bytes = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(60, 0)]);
    const error = await readFile(bytes, 'statement.xlsx').catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(UnreadableFileError);
    expect((error as UnreadableFileError).code).toBe('xlsx.unreadable');
  });

  it('does not mistake a CSV whose first field starts with a < for HTML', async () => {
    const file = await readInline('Date,Memo,Amount\n2026-03-01,<unknown merchant>,-1.00\n');
    expect(file.rows[1][1]).toBe('<unknown merchant>');
  });
});

/**
 * Bytes in, a rectangle of trimmed strings out.
 *
 * The format is decided by looking at the bytes, never at the extension. Banks
 * ship XLS-disguised-as-CSV and HTML-disguised-as-XLS often enough that trusting
 * the name is how an importer silently produces a grid of `<td>` fragments. Each
 * impostor is detected and rejected by name, with the remedy the user needs.
 *
 * Every cell comes back as a string, so no float ever stands between the bank's
 * digits and `parseMoney`. The single exception is dates: a real date cell or an
 * Excel date serial is rendered `YYYY-MM-DD` before stringifying, because its
 * numeric form is meaningless to a date parser downstream.
 */

import Papa from 'papaparse';

import { parseDateInput } from '@/lib/dates';

import { fileHash } from './fingerprint';
import type { CsvDelimiter, FileEncoding, ParsedFile, SheetSummary } from './types';

/** Raised when the file cannot be read at all. A bad *row* never raises. */
export class UnreadableFileError extends Error {
  readonly code: string;
  readonly remedy: string;

  constructor(code: string, message: string, remedy: string) {
    super(message);
    this.name = 'UnreadableFileError';
    this.code = code;
    this.remedy = remedy;
  }
}

export interface ReadFileOptions {
  /** Force a delimiter instead of sniffing. */
  delimiter?: CsvDelimiter;
  /** Force an encoding instead of sniffing. */
  encoding?: FileEncoding;
  /** Which workbook sheet to read: a name, or a 0-based index. Default: the first with data. */
  sheet?: string | number;
  /** Stop after this many physical rows. Used by the preview pane on very large files. */
  maxRows?: number;
}

const DELIMITERS: readonly CsvDelimiter[] = [',', ';', '\t', '|'];

// ---------------------------------------------------------------------------
// Magic bytes
// ---------------------------------------------------------------------------

const MAGIC = {
  /** ZIP local file header — every .xlsx is a zip. */
  zip: [0x50, 0x4b, 0x03, 0x04],
  /** OLE2 compound document — the legacy binary .xls (and .doc, and .msg). */
  ole2: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1],
  pdf: [0x25, 0x50, 0x44, 0x46],
  utf8Bom: [0xef, 0xbb, 0xbf],
  utf16le: [0xff, 0xfe],
  utf16be: [0xfe, 0xff],
} as const;

function startsWith(bytes: Uint8Array, magic: readonly number[]): boolean {
  if (bytes.length < magic.length) return false;
  return magic.every((byte, i) => bytes[i] === byte);
}

/** The first bytes as ASCII, for the HTML sniff. Control bytes become spaces. */
function asciiHead(bytes: Uint8Array, length: number): string {
  let out = '';
  for (let i = 0; i < Math.min(length, bytes.length); i += 1) {
    const byte = bytes[i];
    out += byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : ' ';
  }
  return out;
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

interface Decoded {
  text: string;
  encoding: FileEncoding;
}

/**
 * Decodes delimited text. UTF-8 is tried strictly first; a single invalid
 * sequence — one `ñ` written by a bank that still emits Latin-1 — falls the whole
 * file back rather than scattering replacement characters through the payees.
 *
 * The fallback label is `latin-1`; the decoder is windows-1252, its real-world
 * superset, so the 0x80–0x9F range that Latin-1 leaves as control codes decodes
 * to the curly quotes and dashes banks actually put there.
 */
function decode(bytes: Uint8Array, forced?: FileEncoding): Decoded {
  if (startsWith(bytes, MAGIC.utf16le)) {
    return { text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), encoding: 'utf-16le' };
  }
  if (startsWith(bytes, MAGIC.utf16be)) {
    return { text: new TextDecoder('utf-16be').decode(bytes.subarray(2)), encoding: 'utf-16be' };
  }

  const hasBom = startsWith(bytes, MAGIC.utf8Bom);
  const body = hasBom ? bytes.subarray(3) : bytes;

  if (forced === 'latin-1') {
    return { text: new TextDecoder('windows-1252').decode(body), encoding: 'latin-1' };
  }

  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(body);
    return { text, encoding: hasBom ? 'utf-8-sig' : 'utf-8' };
  } catch {
    return { text: new TextDecoder('windows-1252').decode(body), encoding: 'latin-1' };
  }
}

// ---------------------------------------------------------------------------
// Delimiter sniffing
// ---------------------------------------------------------------------------

/** Counts delimiters outside double quotes, so a comma inside a payee does not vote. */
function countOutsideQuotes(line: string, delimiter: string): number {
  let count = 0;
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      // A doubled quote inside a quoted field is an escaped quote, not a toggle.
      if (inQuotes && line[i + 1] === '"') {
        i += 1;
        continue;
      }
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && char === delimiter) count += 1;
  }
  return count;
}

/**
 * Picks the delimiter that splits the sample lines into the same number of
 * fields most consistently, with more fields breaking a tie. Consistency beats
 * raw frequency: a description column full of semicolons loses to the comma that
 * actually separates the ten columns on every line.
 */
function sniffDelimiter(text: string): CsvDelimiter {
  const lines = text
    .split(/\r\n|\r|\n/)
    .filter((line) => line.trim() !== '')
    .slice(0, 25);

  if (lines.length === 0) return ',';

  let best: { delimiter: CsvDelimiter; score: number; fields: number } | null = null;

  for (const delimiter of DELIMITERS) {
    const counts = lines.map((line) => countOutsideQuotes(line, delimiter));
    const fields = counts[0] + 1;
    if (fields < 2) continue;

    const consistent = counts.filter((count) => count === counts[0]).length / counts.length;
    // Consistency dominates; field count is the tie-break, damped so that a
    // wildly inconsistent delimiter cannot buy its way past a clean one.
    const score = consistent * 100 + Math.min(fields, 40);

    if (best === null || score > best.score) best = { delimiter, score, fields };
  }

  return best?.delimiter ?? ',';
}

// ---------------------------------------------------------------------------
// Numbers out of a workbook
// ---------------------------------------------------------------------------

/** Expands `1.5e-7` / `1.2e+21` into plain decimal digits. */
function expandExponent(text: string): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(text);
  if (!match) return text;

  const [, sign, whole, fraction = '', exponentText] = match;
  const exponent = Number(exponentText);
  const digits = whole + fraction;
  const pointAt = whole.length + exponent;

  if (pointAt <= 0) return `${sign}0.${'0'.repeat(-pointAt)}${digits}`;
  if (pointAt >= digits.length) return `${sign}${digits}${'0'.repeat(pointAt - digits.length)}`;
  return `${sign}${digits.slice(0, pointAt)}.${digits.slice(pointAt)}`;
}

/**
 * Renders a workbook's numeric cell as the digits the spreadsheet holds.
 *
 * Excel itself stores fifteen significant decimal digits; anything beyond that in
 * the JavaScript rendering is IEEE noise from the double round-trip, which is how
 * `1043.00` arrives as `1043.0000000000001`. Re-rendering at fifteen significant
 * digits recovers the stored value without ever multiplying or rounding it as a
 * float — and `toFixed(2)` is never used, because that would invent a precision
 * the file did not state.
 */
function numberCellToString(value: number): string {
  if (!Number.isFinite(value)) return '';
  if (Number.isInteger(value) && Math.abs(value) < 1e21) return String(value);

  const direct = expandExponent(String(value));
  const rounded = expandExponent(String(Number(value.toPrecision(15))));
  return rounded.length <= direct.length ? rounded : direct;
}

/** `true` when a number format renders the cell as a date rather than a quantity. */
function isDateFormat(numFmt: string | undefined): boolean {
  if (!numFmt) return false;
  // Strip quoted literals and colour/condition blocks so a currency format whose
  // literal text happens to contain `d` or `y` does not read as a date.
  const bare = numFmt.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '');
  return /(?:y{2,}|d{1,2}|m{3,})/.test(bare) && !/[$€£¥]/.test(bare);
}

function dateToCalendarString(value: Date): string {
  // UTC getters, not local ones: ExcelJS materialises dates at UTC midnight, and
  // a local-time read renders 2026-03-01 as Feb 28 anywhere west of Greenwich.
  const year = String(value.getUTCFullYear()).padStart(4, '0');
  const month = String(value.getUTCMonth() + 1).padStart(2, '0');
  const day = String(value.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// ---------------------------------------------------------------------------
// XLSX
// ---------------------------------------------------------------------------

interface CellLike {
  value: unknown;
  numFmt?: string;
  text?: string;
}

/** One cell of a worksheet, as a trimmed string. */
function cellToString(cell: CellLike): string {
  const { value } = cell;

  if (value === null || value === undefined) return '';
  if (value instanceof Date) return dateToCalendarString(value);
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';

  if (typeof value === 'number') {
    if (isDateFormat(cell.numFmt)) {
      try {
        return parseDateInput(value);
      } catch {
        // A "date-formatted" cell holding a number outside the serial range is a
        // quantity in a mis-formatted column. Keep the digits.
        return numberCellToString(value);
      }
    }
    return numberCellToString(value);
  }

  if (typeof value === 'string') return value.trim();

  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;

    // Rich text: concatenate the runs.
    if (Array.isArray(record.richText)) {
      return (record.richText as Array<{ text?: string }>)
        .map((run) => run.text ?? '')
        .join('')
        .trim();
    }
    // Hyperlink: the label, not the href.
    if (typeof record.text === 'string') return record.text.trim();
    // Formula: the cached result. An error result becomes empty, not `#N/A`.
    if ('result' in record) {
      const result = record.result;
      if (result === null || result === undefined) return '';
      if (result instanceof Date) return dateToCalendarString(result);
      if (typeof result === 'number') {
        return isDateFormat(cell.numFmt) ? cellToString({ value: result, numFmt: cell.numFmt }) : numberCellToString(result);
      }
      if (typeof result === 'object') return '';
      return String(result).trim();
    }
    if ('error' in record) return '';
  }

  return String(value).trim();
}

interface WorksheetLike {
  name: string;
  rowCount: number;
  columnCount: number;
  eachRow(
    options: { includeEmpty: boolean },
    callback: (row: { eachCell(o: { includeEmpty: boolean }, cb: (cell: CellLike, col: number) => void): void }, rowNumber: number) => void,
  ): void;
}

function worksheetToRows(sheet: WorksheetLike, maxRows: number | undefined): string[][] {
  const rows: string[][] = [];
  let stopped = false;

  sheet.eachRow({ includeEmpty: true }, (row) => {
    if (stopped) return;
    const cells: string[] = [];
    row.eachCell({ includeEmpty: true }, (cell, columnNumber) => {
      // eachCell is 1-based and skips nothing when includeEmpty is set, but a
      // sparse sheet can still jump; pad so the column index stays true.
      while (cells.length < columnNumber - 1) cells.push('');
      cells[columnNumber - 1] = cellToString(cell);
    });
    rows.push(cells);
    if (maxRows !== undefined && rows.length >= maxRows) stopped = true;
  });

  return rows;
}

async function readWorkbook(
  bytes: Uint8Array,
  options: ReadFileOptions,
): Promise<{ rows: string[][]; sheets: SheetSummary[]; sheetName: string }> {
  // Loaded lazily: exceljs is large, and a CSV import must not pay for it.
  const { Workbook } = await import('exceljs');
  const workbook = new Workbook();

  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;

  try {
    await workbook.xlsx.load(buffer);
  } catch (cause) {
    throw new UnreadableFileError(
      'xlsx.unreadable',
      `The file starts with a zip signature but is not a readable .xlsx workbook: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      'Open it in Excel or Google Sheets and re-save as .xlsx, or export the statement as CSV.',
    );
  }

  const worksheets = workbook.worksheets as unknown as WorksheetLike[];
  if (worksheets.length === 0) {
    throw new UnreadableFileError(
      'xlsx.no_sheets',
      'The workbook contains no worksheets.',
      'Check that the download completed, then re-export the statement.',
    );
  }

  const summaries: SheetSummary[] = worksheets.map((sheet) => ({
    name: sheet.name,
    rowCount: sheet.rowCount,
    columnCount: sheet.columnCount,
  }));

  let chosen: WorksheetLike | undefined;
  if (typeof options.sheet === 'string') {
    chosen = worksheets.find((sheet) => sheet.name === options.sheet);
    if (!chosen) {
      throw new UnreadableFileError(
        'xlsx.sheet_not_found',
        `The workbook has no sheet named "${options.sheet}". It has: ${summaries
          .map((s) => s.name)
          .join(', ')}.`,
        'Pick one of the listed sheets.',
      );
    }
  } else if (typeof options.sheet === 'number') {
    chosen = worksheets[options.sheet];
    if (!chosen) {
      throw new UnreadableFileError(
        'xlsx.sheet_not_found',
        `The workbook has no sheet at index ${options.sheet}; it has ${worksheets.length}.`,
        'Pick a sheet index within range.',
      );
    }
  } else {
    // The biggest grid, not the first non-empty one. Bank workbooks routinely put
    // a one-line "exported by …" or "Notes" tab in front of the statement, and
    // reading that tab produces a file with one column and no transactions.
    chosen = worksheets.reduce((best, sheet) =>
      sheet.rowCount * Math.max(sheet.columnCount, 1) > best.rowCount * Math.max(best.columnCount, 1)
        ? sheet
        : best,
    );
  }

  return {
    rows: worksheetToRows(chosen, options.maxRows),
    sheets: summaries,
    sheetName: chosen.name,
  };
}

// ---------------------------------------------------------------------------
// Impostors
// ---------------------------------------------------------------------------

function rejectImpostors(bytes: Uint8Array, filename: string): void {
  if (bytes.length === 0) {
    throw new UnreadableFileError(
      'file.empty',
      `"${filename}" is empty — it contains no bytes at all.`,
      'Re-download the statement; the transfer was probably interrupted.',
    );
  }

  if (startsWith(bytes, MAGIC.ole2)) {
    throw new UnreadableFileError(
      'file.legacy_xls',
      `"${filename}" is a legacy binary .xls workbook, whatever its extension says.`,
      'Open it and use "Save As" to write an .xlsx workbook or a CSV, then upload that.',
    );
  }

  if (startsWith(bytes, MAGIC.pdf)) {
    throw new UnreadableFileError(
      'file.pdf',
      `"${filename}" is a PDF, not a statement data file.`,
      'Download the CSV or XLSX export from the bank rather than the printable statement.',
    );
  }

  if (startsWith(bytes, MAGIC.zip)) return; // a genuine workbook

  const head = asciiHead(bytes, 1024).replace(/^[\s﻿]+/, '');
  const lower = head.toLowerCase();
  if (
    lower.startsWith('<!doctype html') ||
    lower.startsWith('<html') ||
    lower.startsWith('<?xml') ||
    (head.startsWith('<') && /<table|<tr[\s>]|<meta|<body/i.test(lower))
  ) {
    throw new UnreadableFileError(
      'file.html',
      `"${filename}" is an HTML document, not a statement. Some banks and expired download links serve a login or error page under a .csv or .xls name.`,
      'Sign in to the bank and download the statement again; if it keeps arriving as HTML, use the bank\'s CSV export rather than "Save page as".',
    );
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Reads an uploaded statement into a grid of trimmed strings.
 *
 * Throws `UnreadableFileError` only when the file cannot be read at all — empty
 * bytes, a legacy .xls, a PDF, an HTML login page, an unopenable workbook. It
 * never throws because of the *contents* of a row; that is `applyProfile`'s job
 * and it reports rather than throws.
 */
export async function readFile(
  input: Uint8Array | ArrayBuffer,
  filename: string,
  options: ReadFileOptions = {},
): Promise<ParsedFile> {
  const bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : input;
  const sha256 = fileHash(bytes);

  rejectImpostors(bytes, filename);

  if (startsWith(bytes, MAGIC.zip)) {
    const { rows, sheets, sheetName } = await readWorkbook(bytes, options);
    return {
      filename,
      format: 'xlsx',
      rows: dropBlankRows(rows),
      sheetNames: sheets.map((sheet) => sheet.name),
      sheets,
      sheetName,
      encoding: 'utf-8',
      delimiter: null,
      sha256,
      byteLength: bytes.byteLength,
    };
  }

  const { text, encoding } = decode(bytes, options.encoding);
  const delimiter = options.delimiter ?? sniffDelimiter(text);

  const parsed = Papa.parse<string[]>(text, {
    delimiter,
    header: false,
    // Everything stays a string: no bank number is ever handed to the JS number
    // parser on the way in.
    dynamicTyping: false,
    skipEmptyLines: false,
    newline: undefined,
  });

  const rows = parsed.data.map((row) =>
    // Papa hands back `string[]`, but a ragged final line can leave a hole.
    row.map((cell) => (typeof cell === 'string' ? cell.trim() : '')),
  );

  const limited = options.maxRows === undefined ? rows : rows.slice(0, options.maxRows);

  return {
    filename,
    format: 'csv',
    rows: dropBlankRows(limited),
    encoding,
    delimiter,
    sha256,
    byteLength: bytes.byteLength,
  };
}

/**
 * Removes rows with nothing in them. A trailing newline produces one on every
 * CSV; blank separator rows appear in hand-edited exports. Neither carries data,
 * and keeping them would make the header-row scan and the arity check noisier
 * without ever adding a transaction.
 */
function dropBlankRows(rows: string[][]): string[][] {
  return rows.filter((row) => row.some((cell) => cell !== ''));
}

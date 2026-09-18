/**
 * Profile + file -> normalized transactions.
 *
 * This is where a bank's own conventions stop existing. Whatever the file said —
 * a debit/credit pair, a positive amount next to a `DR` token, a credit-card
 * export written from the bank's point of view — what comes out is
 * `amountCents` signed from the company's point of view: positive is money in,
 * negative is money out.
 *
 * The contract that matters as much as the arithmetic: **a bad row never costs
 * the file, and a bad row never vanishes.** Nothing here throws for a data
 * reason. A row that cannot be parsed comes back in `rows` with `usable: false`
 * and the warnings explaining why; a row a profile rule deliberately drops comes
 * back in `skipped` with its raw cells and a counted reason. The totals in
 * `meta` always reconcile: `dataRowCount = returnedCount + skippedCount`.
 */

import { type CalendarDate, parseDateInput } from '@/lib/dates';
import { parseMoney } from '@/lib/money';

import { findStatusColumn, normalizeHeader } from './detect';
import { cleanPayee, normalizeDescription } from './normalize';
import type {
  ImportProfile,
  NormalizedTxn,
  ParsedFile,
  ParseMeta,
  ParseResult,
  ParseWarning,
  ParseWarningCode,
  RawRow,
  ResolvedProfile,
  SkippedRow,
  SkipRowRule,
} from './types';

export interface ApplyProfileOptions {
  /**
   * Accept rows with fewer cells than the header by reading the missing trailing
   * columns as empty. Off by default: a short row is usually a footer or a
   * dropped field, and reading it positionally anyway silently shifts data into
   * the wrong columns. Amazon's Flat File V2, where 23-field rows are legal, is
   * the kind of format that needs this turned on.
   */
  padShortRows?: boolean;
  /** Warn when a row's date falls outside this window. Both bounds inclusive. */
  expectedPeriod?: { start: CalendarDate; end: CalendarDate };
}

// ---------------------------------------------------------------------------
// Profile resolution
// ---------------------------------------------------------------------------

/** Fills in every optional field so the rest of the file can stop checking. */
export function resolveProfile(profile: ImportProfile): ResolvedProfile {
  return {
    id: profile.id ?? null,
    name: profile.name ?? null,
    file_type: profile.file_type ?? 'csv',
    delimiter: profile.delimiter ?? ',',
    encoding: profile.encoding ?? 'utf-8',
    skip_rows: profile.skip_rows ?? 0,
    header_row: profile.header_row ?? 0,
    date_column: profile.date_column,
    date_format: profile.date_format ?? null,
    description_columns: profile.description_columns ?? [],
    counterparty_column: profile.counterparty_column ?? null,
    mode: profile.mode,
    amount_column: profile.amount_column ?? null,
    debit_column: profile.debit_column ?? null,
    credit_column: profile.credit_column ?? null,
    type_column: profile.type_column ?? null,
    status_column: profile.status_column ?? null,
    debit_type_values: profile.debit_type_values ?? [],
    credit_type_values: profile.credit_type_values ?? [],
    balance_column: profile.balance_column ?? null,
    reference_column: profile.reference_column ?? null,
    external_id_column: profile.external_id_column ?? null,
    invert_sign: profile.invert_sign ?? false,
    skip_row_rules: profile.skip_row_rules ?? [],
    detected_from_filename: profile.detected_from_filename ?? null,
  };
}

// ---------------------------------------------------------------------------
// Column addressing
// ---------------------------------------------------------------------------

/**
 * Resolves a profile's column names against the file's actual header.
 *
 * Three passes, loosening each time: verbatim, case-insensitive, then normalised
 * (`Account #` and `account_#` are the same column). Banks re-case and re-punctuate
 * their headers between exports far more often than they reorder them.
 */
class ColumnIndex {
  private readonly exact = new Map<string, number>();
  private readonly lower = new Map<string, number>();
  private readonly normalized = new Map<string, number>();

  constructor(readonly headers: readonly string[]) {
    headers.forEach((header, index) => {
      if (header === '') return;
      if (!this.exact.has(header)) this.exact.set(header, index);
      const lower = header.toLowerCase();
      if (!this.lower.has(lower)) this.lower.set(lower, index);
      const normal = normalizeHeader(header);
      if (normal !== '' && !this.normalized.has(normal)) this.normalized.set(normal, index);
    });
  }

  /** -1 when the file has no such column. */
  find(name: string | null | undefined): number {
    if (name === null || name === undefined || name === '') return -1;
    const trimmed = name.trim();
    return (
      this.exact.get(trimmed) ??
      this.lower.get(trimmed.toLowerCase()) ??
      this.normalized.get(normalizeHeader(trimmed)) ??
      -1
    );
  }
}

/**
 * Splits a file into its header and its data rows, each addressable both
 * positionally and by header name.
 *
 * Exported because every format importer needs exactly this and nothing more:
 * a Shopify balance-transactions export or an Amazon settlement is a header plus
 * rows too, and none of them should re-derive the header offset or the
 * duplicate-header handling for themselves.
 */
export function readRawRows(
  file: ParsedFile,
  options: { skipRows?: number; headerRow?: number } = {},
): { headers: string[]; headerPhysicalRow: number; rows: RawRow[] } {
  const headerPhysicalRow = (options.skipRows ?? 0) + (options.headerRow ?? 0);
  const headers = (file.rows[headerPhysicalRow] ?? []).map((cell) => cell.trim());

  const rows: RawRow[] = file.rows.slice(headerPhysicalRow + 1).map((cells, rowIndex) => ({
    rowIndex,
    physicalRow: headerPhysicalRow + 1 + rowIndex,
    cells,
    record: buildRecord(headers, cells),
  }));

  return { headers, headerPhysicalRow, rows };
}

/** Header-keyed view of a row. Repeated headers get `__2`, `__3`, … suffixes. */
function buildRecord(headers: readonly string[], cells: readonly string[]): Record<string, string> {
  const record: Record<string, string> = {};
  const seen = new Map<string, number>();

  headers.forEach((header, index) => {
    const name = header === '' ? `column_${index + 1}` : header;
    const count = (seen.get(name) ?? 0) + 1;
    seen.set(name, count);
    record[count === 1 ? name : `${name}__${count}`] = cells[index] ?? '';
  });

  // A row longer than the header keeps its overflow rather than losing it.
  for (let index = headers.length; index < cells.length; index += 1) {
    record[`column_${index + 1}`] = cells[index];
  }

  return record;
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const DMY_FORMAT = /^D{1,2}[-/. ]M{1,2}[-/. ]Y{2,4}$/i;
const MDY_FORMAT = /^M{1,2}[-/. ]D{1,2}[-/. ]Y{2,4}$/i;
const ISO_FORMAT = /^Y{4}[-/. ]M{1,2}[-/. ]D{1,2}$/i;
const NAMED_FORMAT = /^D{1,2}[-/. ]M{3,4}[-/. ]Y{2,4}$/i;

function expandTwoDigitYear(text: string): number {
  const value = Number(text);
  if (text.length === 4) return value;
  return value < 70 ? 2000 + value : 1900 + value;
}

/**
 * Parses a date cell, honouring the profile's declared format.
 *
 * The format matters for exactly one reason and it is a big one: `3/4/2026` is
 * March 4th to an American bank and the 3rd of April to a British one, and no
 * amount of inspection of a single cell can tell them apart. When the profile
 * declares `D/M/YYYY` the two parts are swapped before validation; otherwise the
 * shared `parseDateInput` handles ISO, US, named-month and Excel-serial forms.
 */
export function parseDateCell(value: string, format: string | null): CalendarDate {
  // A timestamp column is still a calendar date once the clock is dropped.
  const text = value.trim().replace(/[T ]\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/, '');
  if (text === '') throw new Error('Cannot read "" as a date: empty.');

  if (format !== null && DMY_FORMAT.test(format) && !NAMED_FORMAT.test(format)) {
    const parts = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/.exec(text);
    if (parts) {
      const year = expandTwoDigitYear(parts[3]);
      // Round-trip through the ISO branch of parseDateInput so the real-date
      // check (and the 31 February rejection) stays in one place.
      return parseDateInput(
        `${String(year).padStart(4, '0')}-${parts[2].padStart(2, '0')}-${parts[1].padStart(2, '0')}`,
      );
    }
  }

  if (format !== null && (MDY_FORMAT.test(format) || ISO_FORMAT.test(format) || NAMED_FORMAT.test(format))) {
    return parseDateInput(text);
  }

  return parseDateInput(text);
}

// ---------------------------------------------------------------------------
// Skip rules
// ---------------------------------------------------------------------------

type SemanticField =
  | 'date'
  | 'description'
  | 'counterparty'
  | 'amount'
  | 'balance'
  | 'reference'
  | 'type'
  | 'status'
  | 'external_id';

function semanticColumn(field: string, profile: ResolvedProfile): string | null {
  const key = normalizeHeader(field).replace(/ /g, '_') as SemanticField;
  switch (key) {
    case 'date':
      return profile.date_column;
    case 'description':
      return profile.description_columns[0] ?? null;
    case 'counterparty':
      return profile.counterparty_column;
    case 'amount':
      return profile.amount_column;
    case 'balance':
      return profile.balance_column;
    case 'reference':
      return profile.reference_column;
    case 'type':
    case 'status':
      return profile.type_column;
    case 'external_id':
      return profile.external_id_column;
    default:
      return null;
  }
}

function ruleMatches(rule: SkipRowRule, cell: string): boolean {
  const sensitive = rule.caseSensitive === true;
  const subject = sensitive ? cell : cell.toUpperCase();
  const target = sensitive ? (rule.value ?? '') : (rule.value ?? '').toUpperCase();

  switch (rule.op) {
    case 'blank':
      return cell.trim() === '';
    case 'not_blank':
      return cell.trim() !== '';
    case 'exact':
      return subject === target;
    case 'contains':
      return target !== '' && subject.includes(target);
    case 'not_contains':
      return target !== '' && !subject.includes(target);
    case 'starts_with':
      return target !== '' && subject.startsWith(target);
    case 'ends_with':
      return target !== '' && subject.endsWith(target);
    case 'regex':
      try {
        return new RegExp(rule.value ?? '', sensitive ? '' : 'i').test(cell);
      } catch {
        // A malformed saved pattern must not take the file down with it.
        return false;
      }
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Row parsing
// ---------------------------------------------------------------------------

function warn(
  severity: ParseWarning['severity'],
  code: ParseWarningCode,
  message: string,
  extra: Omit<ParseWarning, 'severity' | 'code' | 'message'> = {},
): ParseWarning {
  return { severity, code, message, ...extra };
}

interface AmountResult {
  cents: number | null;
  rawType: string | null;
  warnings: ParseWarning[];
}

function readAmount(
  cells: readonly string[],
  columns: ColumnIndex,
  profile: ResolvedProfile,
  rowIndex: number,
): AmountResult {
  const warnings: ParseWarning[] = [];
  const cell = (index: number): string => (index === -1 ? '' : (cells[index] ?? '').trim());

  const typeIndex = columns.find(profile.type_column);
  const rawType = typeIndex === -1 ? null : cell(typeIndex) || null;

  if (profile.mode === 'debit_credit') {
    const debitIndex = columns.find(profile.debit_column);
    const creditIndex = columns.find(profile.credit_column);
    const debitText = cell(debitIndex);
    const creditText = cell(creditIndex);

    let debit = 0;
    let credit = 0;

    if (debitText !== '') {
      try {
        debit = Math.abs(parseMoney(debitText));
      } catch {
        warnings.push(
          warn('error', 'amount.unparsable', `Debit "${debitText}" is not an amount.`, {
            rowIndex,
            field: profile.debit_column ?? undefined,
            value: debitText,
          }),
        );
        return { cents: null, rawType, warnings };
      }
    }

    if (creditText !== '') {
      try {
        credit = Math.abs(parseMoney(creditText));
      } catch {
        warnings.push(
          warn('error', 'amount.unparsable', `Credit "${creditText}" is not an amount.`, {
            rowIndex,
            field: profile.credit_column ?? undefined,
            value: creditText,
          }),
        );
        return { cents: null, rawType, warnings };
      }
    }

    if (debit === 0 && credit === 0) {
      warnings.push(
        warn('error', 'amount.missing', 'Neither the debit nor the credit column holds an amount.', {
          rowIndex,
        }),
      );
      return { cents: null, rawType, warnings };
    }

    if (debit !== 0 && credit !== 0) {
      warnings.push(
        warn(
          'warn',
          'amount.debit_and_credit',
          `Both the debit (${debitText}) and the credit (${creditText}) columns are filled; the row was netted to their difference.`,
          { rowIndex },
        ),
      );
    }

    // A debit on a bank statement is money leaving the company.
    return { cents: credit - debit, rawType, warnings };
  }

  const amountIndex = columns.find(profile.amount_column);
  const amountText = cell(amountIndex);

  if (amountText === '') {
    warnings.push(
      warn('error', 'amount.missing', 'The amount column is empty.', {
        rowIndex,
        field: profile.amount_column ?? undefined,
      }),
    );
    return { cents: null, rawType, warnings };
  }

  let cents: number;
  try {
    cents = parseMoney(amountText);
  } catch (cause) {
    warnings.push(
      warn(
        'error',
        'amount.unparsable',
        `"${amountText}" is not an amount: ${cause instanceof Error ? cause.message : String(cause)}`,
        { rowIndex, field: profile.amount_column ?? undefined, value: amountText },
      ),
    );
    return { cents: null, rawType, warnings };
  }

  if (profile.mode === 'amount_with_type') {
    if (rawType === null) {
      warnings.push(
        warn('error', 'type.unknown', 'The transaction-type column is empty, so the direction of this row is unknown.', {
          rowIndex,
          field: profile.type_column ?? undefined,
        }),
      );
      return { cents: null, rawType, warnings };
    }

    const isDebit = profile.debit_type_values.some((value) => value.toUpperCase() === rawType.toUpperCase());
    const isCredit = profile.credit_type_values.some((value) => value.toUpperCase() === rawType.toUpperCase());

    if (!isDebit && !isCredit) {
      // Never silently dropped and never guessed: an unmapped type is exactly
      // how a new row category slips into the ledger with the wrong sign.
      warnings.push(
        warn(
          'error',
          'type.unknown',
          `Transaction type "${rawType}" is in neither the debit list (${profile.debit_type_values.join(
            ', ',
          ) || 'empty'}) nor the credit list (${profile.credit_type_values.join(', ') || 'empty'}).`,
          { rowIndex, field: profile.type_column ?? undefined, value: rawType },
        ),
      );
      return { cents: null, rawType, warnings };
    }

    const magnitude = Math.abs(cents);
    if (cents < 0) {
      warnings.push(
        warn(
          'warn',
          'amount.sign_conflict',
          `The amount "${amountText}" is already negative but the type column also states the direction ("${rawType}"); the type won.`,
          { rowIndex, value: amountText },
        ),
      );
    }
    return { cents: isDebit ? -magnitude : magnitude, rawType, warnings };
  }

  return { cents, rawType, warnings };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Turns a parsed file into normalized transactions using a saved profile.
 *
 * Never throws for a data reason. Every physical data row ends up in exactly one
 * of `rows` (parsed, possibly flagged) or `skipped` (dropped with a counted
 * reason), so the import report can always account for the whole file.
 */
export function applyProfile(
  file: ParsedFile,
  profileInput: ImportProfile,
  options: ApplyProfileOptions = {},
): ParseResult {
  const profile = resolveProfile(profileInput);
  const warnings: ParseWarning[] = [];
  const skipped: SkippedRow[] = [];
  const rows: NormalizedTxn[] = [];

  const { headers, headerPhysicalRow, rows: dataRows } = readRawRows(file, {
    skipRows: profile.skip_rows,
    headerRow: profile.header_row,
  });

  const meta = (): ParseMeta => {
    const usable = rows.filter((row) => row.usable);
    const dates = usable.map((row) => row.date).filter((date): date is CalendarDate => date !== '');
    const skippedByCode: Record<string, number> = {};
    for (const row of skipped) skippedByCode[row.code] = (skippedByCode[row.code] ?? 0) + 1;

    let totalIn = 0;
    let totalOut = 0;
    for (const row of usable) {
      if (row.amountCents > 0) totalIn += row.amountCents;
      else totalOut += row.amountCents;
    }

    return {
      filename: file.filename,
      format: file.format,
      encoding: file.encoding,
      delimiter: file.delimiter,
      sha256: file.sha256,
      headerRowIndex: headerPhysicalRow,
      headers,
      dataRowCount: dataRows.length,
      returnedCount: rows.length,
      usableCount: usable.length,
      // Rows a human has to look at: unimportable, or carrying something stronger
      // than an `info` note. A description falling back to the reference is worth
      // recording and not worth anybody's attention.
      flaggedCount: rows.filter(
        (row) => !row.usable || row.warnings.some((warning) => warning.severity !== 'info'),
      ).length,
      skippedCount: skipped.length,
      skippedByCode,
      minDate: dates.length === 0 ? null : dates.reduce((a, b) => (a < b ? a : b)),
      maxDate: dates.length === 0 ? null : dates.reduce((a, b) => (a > b ? a : b)),
      totalInCents: totalIn,
      totalOutCents: totalOut,
      netCents: totalIn + totalOut,
      profileName: profile.name,
    };
  };

  if (headers.length === 0) {
    warnings.push(
      warn(
        'error',
        'header.not_found',
        `The profile expects a header on physical row ${headerPhysicalRow + 1}, but "${file.filename}" has only ${file.rows.length} rows.`,
      ),
    );
    return { rows, warnings, skipped, meta: meta() };
  }

  const columns = new ColumnIndex(headers);

  // --- the columns a profile cannot work without ------------------------------
  const missing: string[] = [];
  if (columns.find(profile.date_column) === -1) missing.push(profile.date_column || '(no date column set)');
  if (profile.mode === 'debit_credit') {
    if (columns.find(profile.debit_column) === -1) missing.push(profile.debit_column ?? '(no debit column set)');
    if (columns.find(profile.credit_column) === -1) missing.push(profile.credit_column ?? '(no credit column set)');
  } else {
    if (columns.find(profile.amount_column) === -1) missing.push(profile.amount_column ?? '(no amount column set)');
    if (profile.mode === 'amount_with_type' && columns.find(profile.type_column) === -1) {
      missing.push(profile.type_column ?? '(no type column set)');
    }
  }

  if (missing.length > 0) {
    warnings.push(
      warn(
        'error',
        'profile.column_missing',
        `The profile${profile.name ? ` "${profile.name}"` : ''} needs ${missing
          .map((name) => `"${name}"`)
          .join(', ')}, which "${file.filename}" does not have. Its columns are: ${headers
          .filter((header) => header !== '')
          .map((header) => `"${header}"`)
          .join(', ')}.`,
      ),
    );
    for (const { rowIndex, physicalRow, cells } of dataRows) {
      skipped.push({
        rowIndex,
        physicalRow,
        code: 'profile.column_missing',
        reason: `The profile does not match this file's columns (missing ${missing.join(', ')}).`,
        cells,
      });
    }
    return { rows, warnings, skipped, meta: meta() };
  }

  // Optional columns are worth a note but not a failure.
  for (const [label, name] of [
    ['balance', profile.balance_column],
    ['reference', profile.reference_column],
    ['counterparty', profile.counterparty_column],
    ['external id', profile.external_id_column],
  ] as const) {
    if (name !== null && name !== '' && columns.find(name) === -1) {
      warnings.push(
        warn(
          'warn',
          'profile.column_missing',
          `The profile's ${label} column "${name}" is not in this file; that field will be empty on every row.`,
          { field: name },
        ),
      );
    }
  }

  const descriptionColumns = profile.description_columns
    .map((name) => ({ name, index: columns.find(name) }))
    .filter((entry) => entry.index !== -1);

  if (profile.description_columns.length > 0 && descriptionColumns.length === 0) {
    warnings.push(
      warn(
        'warn',
        'profile.column_missing',
        `None of the profile's description columns (${profile.description_columns.join(
          ', ',
        )}) are in this file; the counterparty or reference will be used instead.`,
      ),
    );
  }

  const dateIndex = columns.find(profile.date_column);
  const balanceIndex = columns.find(profile.balance_column);
  const referenceIndex = columns.find(profile.reference_column);
  const counterpartyIndex = columns.find(profile.counterparty_column);
  const externalIdIndex = columns.find(profile.external_id_column);
  // `import_profiles` names no status column, so fall back to the file's own
  // header. Relay's `Status` column is what marks a returned ACH, and a returned
  // ACH must never reach the ledger as money received.
  const statusIndex =
    profile.status_column !== null ? columns.find(profile.status_column) : findStatusColumn(headers);

  // --- rows -------------------------------------------------------------------
  for (const { rowIndex, physicalRow, cells, record } of dataRows) {
    const rowWarnings: ParseWarning[] = [];

    if (cells.every((cell) => cell === '')) {
      skipped.push({ rowIndex, physicalRow, code: 'row.blank', reason: 'The row is empty.', cells });
      continue;
    }

    if (cells.length !== headers.length) {
      const short = cells.length < headers.length;
      if (short && !options.padShortRows) {
        skipped.push({
          rowIndex,
          physicalRow,
          code: 'row.field_count',
          reason: `The row has ${cells.length} fields but the header has ${headers.length}. Reading it positionally anyway would shift every column, so it was left out — check whether it is a footer or a totals line.`,
          cells,
        });
        continue;
      }
      rowWarnings.push(
        warn(
          short ? 'warn' : 'info',
          'row.field_count',
          `The row has ${cells.length} fields and the header has ${headers.length}.`,
          { rowIndex },
        ),
      );
    }

    const cell = (index: number): string => (index === -1 ? '' : (cells[index] ?? '').trim());

    // --- profile skip rules ---------------------------------------------------
    let dropped: SkipRowRule | null = null;
    for (const rule of profile.skip_row_rules) {
      const direct = columns.find(rule.field);
      const index = direct !== -1 ? direct : columns.find(semanticColumn(rule.field, profile));
      // A rule naming a column this file does not have simply does not fire.
      if (index === -1) continue;
      if (!ruleMatches(rule, cell(index))) continue;

      if (rule.action === 'skip') {
        dropped = rule;
        break;
      }
      rowWarnings.push(
        warn(
          'warn',
          'row.flagged_by_rule',
          rule.reason ?? `Flagged by the profile rule on "${rule.field}".`,
          { rowIndex, field: rule.field, value: cell(index) },
        ),
      );
    }

    if (dropped !== null) {
      skipped.push({
        rowIndex,
        physicalRow,
        code: 'row.skipped_by_rule',
        reason: dropped.reason ?? `Dropped by the profile rule on "${dropped.field}".`,
        cells,
      });
      continue;
    }

    let usable = true;

    // --- date -----------------------------------------------------------------
    const dateText = cell(dateIndex);
    let date: CalendarDate | '' = '';
    if (dateText === '') {
      usable = false;
      rowWarnings.push(
        warn('error', 'date.missing', 'The date column is empty.', {
          rowIndex,
          field: profile.date_column,
        }),
      );
    } else {
      try {
        date = parseDateCell(dateText, profile.date_format);
      } catch (cause) {
        usable = false;
        rowWarnings.push(
          warn(
            'error',
            'date.unparsable',
            `"${dateText}" is not a date${profile.date_format ? ` in the profile's ${profile.date_format} format` : ''}: ${
              cause instanceof Error ? cause.message : String(cause)
            }`,
            { rowIndex, field: profile.date_column, value: dateText },
          ),
        );
      }
    }

    if (date !== '' && options.expectedPeriod) {
      const { start, end } = options.expectedPeriod;
      if (date < start || date > end) {
        rowWarnings.push(
          warn(
            'warn',
            'date.out_of_range',
            `${date} falls outside the ${start}..${end} period this file was expected to cover.`,
            { rowIndex, field: profile.date_column, value: dateText },
          ),
        );
      }
    }

    // --- amount ---------------------------------------------------------------
    const amount = readAmount(cells, columns, profile, rowIndex);
    rowWarnings.push(...amount.warnings);

    let amountCents = 0;
    if (amount.cents === null) {
      usable = false;
    } else {
      amountCents = profile.invert_sign ? -amount.cents : amount.cents;
      if (amountCents === 0) {
        usable = false;
        rowWarnings.push(
          warn(
            'error',
            'amount.zero',
            'The row is worth $0.00 — usually a card authorisation or an account-verification ping. The ledger does not hold zero-amount transactions, so it was flagged rather than imported.',
            { rowIndex },
          ),
        );
      }
    }

    // --- balance --------------------------------------------------------------
    let balanceCents: number | null = null;
    const balanceText = cell(balanceIndex);
    if (balanceText !== '') {
      try {
        balanceCents = parseMoney(balanceText);
      } catch {
        rowWarnings.push(
          warn('info', 'balance.unparsable', `Running balance "${balanceText}" is not an amount; it was left empty.`, {
            rowIndex,
            field: profile.balance_column ?? undefined,
            value: balanceText,
          }),
        );
      }
    }

    // --- text fields ----------------------------------------------------------
    const counterpartyRaw = cell(counterpartyIndex);
    const reference = cell(referenceIndex) || null;
    const externalId = cell(externalIdIndex) || null;
    const status = cell(statusIndex) || null;

    const parts = descriptionColumns.map((entry) => cell(entry.index)).filter((value) => value !== '');
    let description = parts.join(' ').trim();

    if (description === '') {
      // Relay writes one internal transfer with no payee at all. Falling back to
      // the reference keeps "TRANSFER" on the row instead of a blank memo; what
      // was used is recorded so nobody mistakes it for the bank's own wording.
      const fallback =
        (counterpartyRaw !== '' && { value: counterpartyRaw, from: profile.counterparty_column }) ||
        (reference !== null && { value: reference, from: profile.reference_column }) ||
        (amount.rawType !== null && { value: amount.rawType, from: profile.type_column }) ||
        null;

      if (fallback !== null) {
        description = fallback.value;
        rowWarnings.push(
          warn('info', 'description.fallback', `No description on this row; the "${fallback.from}" column was used instead.`, {
            rowIndex,
          }),
        );
      } else {
        rowWarnings.push(
          warn('warn', 'description.empty', 'The row carries no description, counterparty or reference.', { rowIndex }),
        );
      }
    }

    const counterparty = counterpartyRaw === '' ? null : cleanPayee(counterpartyRaw).name;

    rows.push({
      date,
      description,
      descriptionNormalized: normalizeDescription(description),
      counterparty,
      amountCents,
      balanceCents,
      reference,
      externalId,
      rawType: amount.rawType,
      status,
      rowIndex,
      raw: record,
      warnings: rowWarnings,
      usable,
    });
  }

  if (dataRows.length === 0) {
    warnings.push(
      warn(
        'info',
        'file.no_data_rows',
        `"${file.filename}" has a header and no transactions. For Relay this is normal — an account with no activity still exports its header.`,
      ),
    );
  }

  return { rows, warnings, skipped, meta: meta() };
}

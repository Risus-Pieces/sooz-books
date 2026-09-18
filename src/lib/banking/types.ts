/**
 * The vocabulary of the statement-parsing layer.
 *
 * Nothing here knows about Relay, Chase or Mercury. A bank file becomes a
 * `ParsedFile` (bytes -> a grid of trimmed strings), an `ImportProfile` says what
 * the columns mean, and `applyProfile` turns the two into `NormalizedTxn[]`.
 * `detectColumns` proposes a profile for a file nobody has mapped yet.
 *
 * Two conventions run through the whole module and are not negotiable:
 *
 *   - Money is integer cents. Nothing in this path touches a float.
 *   - `amountCents` is signed from the company's point of view: positive is money
 *     into the company, negative is money out. Every format, always. The file's
 *     own convention (debit/credit pair, amount + type, inverted sign on a credit
 *     card export) is resolved here and never leaks downstream.
 */

import type { CalendarDate } from '@/lib/dates';

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/** Delimiters we sniff for. A bank that ships anything else needs an explicit profile. */
export type CsvDelimiter = ',' | ';' | '\t' | '|';

/**
 * How the bytes were decoded. `utf-8-sig` is UTF-8 that arrived with a byte-order
 * mark; the mark is stripped from the text but recorded, because it is a strong
 * fingerprint of an Excel re-save and worth showing in the import report.
 */
export type FileEncoding = 'utf-8' | 'utf-8-sig' | 'latin-1' | 'utf-16le' | 'utf-16be';

export type SourceFormat = 'csv' | 'xlsx';

/** One spreadsheet tab, for workbooks that carry more than one. */
export interface SheetSummary {
  name: string;
  rowCount: number;
  columnCount: number;
}

/**
 * A file decoded into a rectangle of trimmed strings. Every cell is a string:
 * numbers are never pre-parsed, so no float ever stands between the bank's digits
 * and `parseMoney`. Real date cells and Excel date serials are the one exception
 * — they are rendered as `YYYY-MM-DD` before stringifying, because their numeric
 * form is meaningless to a downstream date parser.
 */
export interface ParsedFile {
  /** Advisory only. Never trust the extension — the format is sniffed from bytes. */
  filename: string;
  format: SourceFormat;
  /** Physical rows, header included. Wholly blank rows are removed. */
  rows: string[][];
  /** Present for workbooks. The sheet actually read is `sheetName`. */
  sheetNames?: string[];
  sheets?: SheetSummary[];
  sheetName?: string;
  encoding: FileEncoding;
  /** `null` for a workbook, which has no delimiter. */
  delimiter: CsvDelimiter | null;
  /** sha256 of the raw bytes — the file-level deduplication key. */
  sha256: string;
  byteLength: number;
}

/** One physical data row, addressable both positionally and by header name. */
export interface RawRow {
  /** 0-based index among data rows (the header is not a data row). */
  rowIndex: number;
  /** 0-based index into `ParsedFile.rows`, for pointing a human at the line. */
  physicalRow: number;
  cells: string[];
  /** Header name -> cell. Duplicate headers are suffixed `__2`, `__3`, …. */
  record: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Warnings
// ---------------------------------------------------------------------------

/**
 * `info` is recorded and shown; `warn` keeps the row but marks it for review;
 * `error` means the row cannot be imported as it stands. A bad row never costs
 * the file — `applyProfile` does not throw for a data reason.
 */
export type WarningSeverity = 'info' | 'warn' | 'error';

/** Stable, machine-readable warning codes. The UI groups and counts on these. */
export type ParseWarningCode =
  | 'file.empty'
  | 'file.no_data_rows'
  | 'header.not_found'
  | 'profile.column_missing'
  | 'profile.mode_columns_missing'
  | 'row.blank'
  | 'row.field_count'
  | 'row.skipped_by_rule'
  | 'row.flagged_by_rule'
  | 'date.missing'
  | 'date.unparsable'
  | 'date.out_of_range'
  | 'amount.missing'
  | 'amount.unparsable'
  | 'amount.zero'
  | 'amount.debit_and_credit'
  | 'amount.sign_conflict'
  | 'type.unknown'
  | 'balance.unparsable'
  | 'description.empty'
  | 'description.fallback';

export interface ParseWarning {
  severity: WarningSeverity;
  code: ParseWarningCode;
  /** What a bookkeeper reads. */
  message: string;
  /** 0-based index among data rows, when the warning belongs to one. */
  rowIndex?: number;
  /** The column header the warning is about. */
  field?: string;
  /** The offending cell, verbatim. */
  value?: string;
}

/** A row that never became a transaction, kept with its reason so nothing vanishes. */
export interface SkippedRow {
  rowIndex: number;
  physicalRow: number;
  code: ParseWarningCode;
  reason: string;
  cells: string[];
}

// ---------------------------------------------------------------------------
// Normalized transactions
// ---------------------------------------------------------------------------

export interface NormalizedTxn {
  /** `YYYY-MM-DD`. Empty string only when `usable` is false. */
  date: CalendarDate | '';
  description: string;
  /** Byte-identical to the Postgres `normalize_description(text)` function. */
  descriptionNormalized: string;
  counterparty: string | null;
  /** Integer cents. Positive is money in, negative is money out. Always. */
  amountCents: number;
  /** The statement's running balance after this row, when the file carries one. */
  balanceCents: number | null;
  reference: string | null;
  /** A bank-provided stable id, when the format has one. Relay has none. */
  externalId: string | null;
  /** The file's own transaction-type token, unmapped (`Spend`, `DEBIT`, `CR`). */
  rawType: string | null;
  /** The file's own status token (`SETTLED`, `RETURNED`, `Pending`). */
  status: string | null;
  /** 0-based index among data rows, for pointing a human at the line. */
  rowIndex: number;
  /** The whole source row, header-keyed. Persisted so fingerprints can be recomputed. */
  raw: Record<string, string>;
  warnings: ParseWarning[];
  /**
   * False when a required field could not be read. The row is still returned —
   * flagged, with its warnings and its raw cells — so a human can see it and fix
   * the profile. It must never be written to `bank_transactions`.
   */
  usable: boolean;
}

export interface ParseMeta {
  filename: string;
  format: SourceFormat;
  encoding: FileEncoding;
  delimiter: CsvDelimiter | null;
  sha256: string;
  /** Physical index of the header row in `ParsedFile.rows`. */
  headerRowIndex: number;
  headers: string[];
  /** Physical data rows seen, before skipping. */
  dataRowCount: number;
  /** Rows returned in `rows` (usable and flagged alike). */
  returnedCount: number;
  usableCount: number;
  flaggedCount: number;
  skippedCount: number;
  /** Counted reasons for the skipped rows, keyed by code. */
  skippedByCode: Record<string, number>;
  minDate: CalendarDate | null;
  maxDate: CalendarDate | null;
  /** Sum of the positive amounts, in cents. */
  totalInCents: number;
  /** Sum of the negative amounts, in cents (negative). */
  totalOutCents: number;
  netCents: number;
  profileName: string | null;
}

export interface ParseResult {
  rows: NormalizedTxn[];
  /** File-level warnings. Row-level warnings live on their row. */
  warnings: ParseWarning[];
  skipped: SkippedRow[];
  meta: ParseMeta;
}

// ---------------------------------------------------------------------------
// Import profiles
// ---------------------------------------------------------------------------

/** Mirrors the `amount_mode` enum in the database. */
export type AmountMode = 'signed' | 'debit_credit' | 'amount_with_type';

export type SkipRowOp =
  | 'contains'
  | 'not_contains'
  | 'exact'
  | 'starts_with'
  | 'ends_with'
  | 'regex'
  | 'blank'
  | 'not_blank';

/**
 * One entry of `import_profiles.skip_row_rules`.
 *
 * `field` is resolved against the file's own headers first (case-insensitively),
 * then against the semantic names `date`, `description`, `counterparty`, `amount`,
 * `balance`, `reference`, `type`, `status` and `external_id`. That order matters:
 * the seeded Relay profile names the literal column `Status`, and a bank whose
 * status column is called something else can still be matched semantically.
 */
export interface SkipRowRule {
  field: string;
  op: SkipRowOp;
  value?: string;
  /** `skip` drops the row with a counted reason; `flag` keeps it and marks it. */
  action: 'skip' | 'flag';
  reason?: string;
  caseSensitive?: boolean;
}

/**
 * The saved answer to "what do this bank's columns mean?".
 *
 * Field names are the snake_case of the `import_profiles` table so a row read
 * straight out of Postgres is a valid `ImportProfile` with no translation layer
 * to drift out of sync.
 */
export interface ImportProfile {
  id?: string;
  name?: string;
  file_type?: SourceFormat;
  delimiter?: string;
  encoding?: string;
  /** Preamble rows discarded before the header is looked for. */
  skip_rows?: number;
  /** 0-based index of the header row, counted after `skip_rows`. */
  header_row?: number;
  date_column: string;
  /** `null` auto-detects. `M/D/YYYY`, `D/M/YYYY`, `YYYY-MM-DD`, `DD-MMM-YYYY`, … */
  date_format?: string | null;
  /** Concatenated in order when a bank splits the description across columns. */
  description_columns?: string[];
  counterparty_column?: string | null;
  mode: AmountMode;
  amount_column?: string | null;
  debit_column?: string | null;
  credit_column?: string | null;
  type_column?: string | null;
  /**
   * The column holding a settlement status (`SETTLED`/`RETURNED`, `Pending`).
   *
   * `import_profiles` has no such column: a bank's status is used through
   * `skip_row_rules`, not through the amount mode, so the table never needed one.
   * It is captured onto `NormalizedTxn.status` all the same, because a returned
   * ACH is not money received and the review queue has to be able to see that.
   * When this is absent, `applyProfile` looks for a column whose header reads as
   * a status and uses that.
   */
  status_column?: string | null;
  debit_type_values?: string[];
  credit_type_values?: string[];
  /** Captured for the balance chain, and NEVER treated as an amount. */
  balance_column?: string | null;
  reference_column?: string | null;
  external_id_column?: string | null;
  /** Flips every amount after the mode has been resolved. */
  invert_sign?: boolean;
  skip_row_rules?: SkipRowRule[];
  detected_from_filename?: string | null;
}

/** An `ImportProfile` with every optional field filled in, as `applyProfile` sees it. */
export type ResolvedProfile = Required<
  Omit<ImportProfile, 'id' | 'name' | 'date_format' | 'detected_from_filename'>
> & {
  id: string | null;
  name: string | null;
  date_format: string | null;
  detected_from_filename: string | null;
};

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * The roles a column can play. `debit`/`credit` are the two halves of a
 * mutually-exclusive pair; `amount` is a single column, signed or paired with a
 * type. `balance` is captured but is structurally barred from ever being ranked
 * as `amount`.
 */
export type ColumnRole =
  | 'date'
  | 'description'
  | 'counterparty'
  | 'amount'
  | 'debit'
  | 'credit'
  | 'type'
  | 'balance'
  | 'reference'
  | 'external_id'
  | 'status'
  | 'currency';

export interface ColumnGuess {
  role: ColumnRole;
  columnIndex: number;
  /** The header text, verbatim. */
  column: string;
  /** 0..1. >= 0.80 is safe to preselect; below 0.50 is offered, never chosen. */
  confidence: number;
  /** The strongest reason, for a one-line UI label. */
  reason: string;
  /** Every reason, strongest first, for the "why?" disclosure. */
  reasons: string[];
}

/** How the file expresses direction, and what that means for `amountCents`. */
export interface SignConvention {
  mode: AmountMode;
  /**
   * For `signed`: whether a negative number in the file means money leaving the
   * company. False means the file is written from the bank's point of view (or is
   * a credit-card export) and every amount must be inverted.
   */
  negativeIsOutflow: boolean;
  /** What `import_profiles.invert_sign` should be set to. */
  invertSign: boolean;
  /** How it was decided — balance correlation, the type column, or the default. */
  evidence: string;
  /** 0..1. Low confidence means the UI must ask rather than assume. */
  confidence: number;
}

/** A proposed `import_profiles` row, in the table's own field names. */
export interface ProposedProfile {
  name: string;
  file_type: SourceFormat;
  delimiter: string;
  encoding: string;
  skip_rows: number;
  header_row: number;
  date_column: string;
  date_format: string | null;
  description_columns: string[];
  counterparty_column: string | null;
  mode: AmountMode;
  amount_column: string | null;
  debit_column: string | null;
  credit_column: string | null;
  type_column: string | null;
  debit_type_values: string[];
  credit_type_values: string[];
  balance_column: string | null;
  reference_column: string | null;
  external_id_column: string | null;
  invert_sign: boolean;
  skip_row_rules: SkipRowRule[];
  detected_from_filename: string | null;
}

export interface DetectionResult {
  /** True when a header and the columns a profile requires were all found. */
  ok: boolean;
  /** Physical index of the header row in `ParsedFile.rows`. */
  headerRowIndex: number;
  /** Preamble rows before the header — what `import_profiles.skip_rows` gets. */
  skipRows: number;
  headers: string[];
  dataRowCount: number;
  /** Ranked candidates per role, best first. A role with no candidate is absent. */
  guesses: Partial<Record<ColumnRole, ColumnGuess[]>>;
  amountMode: AmountMode;
  signConvention: SignConvention;
  /** 0..1 over the whole detection, not any single column. */
  confidence: number;
  /** Human-readable, strongest first. Logged with every import. */
  reasons: string[];
  warnings: ParseWarning[];
  /** The row the UI presents for confirmation. */
  profile: ProposedProfile;
}

// ---------------------------------------------------------------------------
// Balance chain
// ---------------------------------------------------------------------------

export interface BalanceBreak {
  /** `NormalizedTxn.rowIndex` of the row whose balance did not tie. */
  rowIndex: number;
  /** What the running balance should have been, in cents. */
  expected: number;
  /** What the file said, in cents. */
  actual: number;
  /** `actual - expected`. */
  delta: number;
}

export interface BalanceChainResult {
  /** The same rows in chronological order, oldest first. */
  ordered: NormalizedTxn[];
  ok: boolean;
  openingBalanceCents: number | null;
  closingBalanceCents: number | null;
  breaks: BalanceBreak[];
  /** Which way the file was sorted, as read off the balance column. */
  direction: 'ascending' | 'descending' | 'unknown';
  /** How many rows carried a balance and took part in the chain. */
  checked: number;
}

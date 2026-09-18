/**
 * Column-mapping auto-detection: given a file nobody has mapped yet, work out
 * where the header is, what each column means, and how the file expresses
 * direction — then hand back a proposed `import_profiles` row for a human to
 * confirm.
 *
 * The rule that shapes the whole file is this: **a running-balance column must
 * never be proposed as the amount.** Getting it wrong does not produce an obvious
 * error; it produces a ledger where every transaction is worth whatever the
 * account happened to hold that day, and it reconciles to nothing. So balance is
 * identified first, on two independent signals — its header, and the fact that it
 * moves by the amount column row over row — and every column identified as a
 * balance is then structurally removed from the amount candidates rather than
 * merely out-ranked.
 */

import { parseMoney } from '@/lib/money';

import type {
  AmountMode,
  ColumnGuess,
  ColumnRole,
  DetectionResult,
  ParsedFile,
  ParseWarning,
  ProposedProfile,
  SignConvention,
} from './types';

export interface DetectOptions {
  /** Rows to sample for the value-shape tests. Default 2000. */
  sampleRows?: number;
  /** Rows to scan for the header. Default 25, as the spec requires. */
  headerScanRows?: number;
  /** Name for the proposed profile. Defaults to something derived from the filename. */
  profileName?: string;
}

const DEFAULT_SAMPLE_ROWS = 2000;
const DEFAULT_HEADER_SCAN_ROWS = 25;

// ---------------------------------------------------------------------------
// Value shapes
// ---------------------------------------------------------------------------

/**
 * Date shapes a bank actually writes, and nothing else. A bare integer is
 * deliberately excluded: `9726` is a valid Excel serial and would make every
 * account-number column look like a date column.
 */
const DATE_SHAPES: readonly RegExp[] = [
  /^\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:[T ]\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/,
  /^\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}(?:[T ]\d{1,2}:\d{2}(?::\d{2})?)?$/,
  /^\d{1,2}[-/. ][A-Za-z]{3,9}[-/. ]\d{2,4}$/,
  /^[A-Za-z]{3,9}[-/. ]\d{1,2},?[-/. ]\d{2,4}$/,
];

function looksLikeDate(value: string): boolean {
  return DATE_SHAPES.some((shape) => shape.test(value));
}

/** `-97.43`, `+13.99`, `$1,234.56`, `(50.00)`, `1234.56-`, `0`. */
const MONEY_SHAPE = /^[+-]?\$?\(?\s*(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,4})?\s*\)?-?$/;

function looksLikeMoney(value: string): boolean {
  if (value === '' || !/\d/.test(value)) return false;
  if (looksLikeDate(value)) return false;
  return MONEY_SHAPE.test(value);
}

function toCents(value: string): number | null {
  if (!looksLikeMoney(value)) return null;
  try {
    return parseMoney(value);
  } catch {
    return null;
  }
}

/** `USD`, `EUR` — three letters, and the column never holds more than a few. */
function looksLikeCurrencyCode(value: string): boolean {
  return /^[A-Za-z]{3}$/.test(value);
}

// ---------------------------------------------------------------------------
// Header names
// ---------------------------------------------------------------------------

/** `Account #` -> `account`; `Transaction  Type` -> `transaction type`. */
export function normalizeHeader(header: string): string {
  return header
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/ +/g, ' ')
    .trim();
}

interface HeaderPattern {
  pattern: RegExp;
  score: number;
  label: string;
}

const HEADER_PATTERNS: Readonly<Record<ColumnRole, readonly HeaderPattern[]>> = {
  date: [
    {
      pattern: /^(?:transaction |posting |posted |value |effective |book |trade |completion |settlement )?date$/,
      score: 1,
      label: 'is a date header',
    },
    { pattern: /^(?:date [a-z ]+|posted|posting|settled on)$/, score: 0.75, label: 'reads as a date header' },
    { pattern: /\bdate\b/, score: 0.7, label: 'contains "date"' },
  ],
  description: [
    {
      pattern: /^(?:description|memo|narrative|detail|details|particulars|transaction description|transaction details|reason)$/,
      score: 0.95,
      label: 'is a description header',
    },
    {
      pattern: /^(?:payee|merchant|counterparty|vendor|originator|beneficiary|name|payee name|merchant name|to from)$/,
      score: 0.9,
      label: 'is a payee header, the usual memo when no description column exists',
    },
    { pattern: /\b(?:description|memo|narrative|particulars|detail)\b/, score: 0.8, label: 'contains a description word' },
  ],
  counterparty: [
    {
      pattern: /^(?:payee|merchant|counterparty|vendor|originator|beneficiary|name|payee name|merchant name|customer|supplier)$/,
      score: 0.95,
      label: 'is a counterparty header',
    },
    { pattern: /\b(?:payee|merchant|counterparty|vendor|beneficiary)\b/, score: 0.85, label: 'contains a counterparty word' },
  ],
  amount: [
    { pattern: /^amount$/, score: 1, label: 'is exactly "Amount"' },
    {
      pattern: /^(?:transaction amount|amt|net amount|amount usd|amount in account currency|value|signed amount)$/,
      score: 0.9,
      label: 'is an amount header',
    },
    { pattern: /\bamount\b/, score: 0.7, label: 'contains "amount"' },
  ],
  debit: [
    {
      pattern: /^(?:debit|debits|debit amount|amount debit|withdrawal|withdrawals|withdrawal amount|money out|paid out|payments out|charge|charges)$/,
      score: 0.95,
      label: 'is a debit header',
    },
    { pattern: /\b(?:debit|withdrawal|money out|paid out)\b/, score: 0.8, label: 'contains a debit word' },
  ],
  credit: [
    {
      pattern: /^(?:credit|credits|credit amount|amount credit|deposit|deposits|deposit amount|money in|paid in|payments in|receipt|receipts)$/,
      score: 0.95,
      label: 'is a credit header',
    },
    { pattern: /\b(?:credit|deposit|money in|paid in)\b/, score: 0.8, label: 'contains a credit word' },
  ],
  type: [
    {
      pattern: /^(?:transaction type|type|txn type|trans type|entry type|dr cr|debit credit|debit credit indicator|direction|transaction kind)$/,
      score: 0.95,
      label: 'is a transaction-type header',
    },
    { pattern: /\btype\b/, score: 0.75, label: 'contains "type"' },
  ],
  balance: [
    {
      pattern: /^(?:balance|running balance|ledger balance|available balance|closing balance|balance usd|running bal|bal|account balance)$/,
      score: 1,
      label: 'is a balance header',
    },
    { pattern: /\b(?:balance|running|ledger)\b/, score: 0.85, label: 'contains a balance word' },
  ],
  reference: [
    {
      pattern: /^(?:reference|ref|memo|note|notes|check number|check no|cheque number|confirmation|confirmation number|reference number|remittance information)$/,
      score: 0.9,
      label: 'is a reference header',
    },
    { pattern: /\b(?:reference|ref|check|cheque|confirmation|invoice)\b/, score: 0.75, label: 'contains a reference word' },
  ],
  external_id: [
    {
      pattern: /^(?:transaction id|txn id|id|transaction reference|trace number|trace id|unique id|external id|bank reference|transaction number)$/,
      score: 0.95,
      label: 'is an identifier header',
    },
    { pattern: /\b(?:transaction id|txn id|trace)\b/, score: 0.85, label: 'contains an identifier word' },
  ],
  status: [
    { pattern: /^(?:status|transaction status|state|posted status)$/, score: 0.95, label: 'is a status header' },
    { pattern: /\bstatus\b/, score: 0.8, label: 'contains "status"' },
  ],
  currency: [
    { pattern: /^(?:currency|ccy|currency code|iso currency)$/, score: 0.95, label: 'is a currency header' },
  ],
};

const ALL_ROLES = Object.keys(HEADER_PATTERNS) as ColumnRole[];

/**
 * The index of the first column whose header reads as a settlement status, or -1.
 * `applyProfile` uses it when a profile does not name one, because
 * `import_profiles` has no status column of its own.
 */
export function findStatusColumn(headers: readonly string[]): number {
  return headers.findIndex((header) => headerScore('status', header).score >= 0.9);
}

function headerScore(role: ColumnRole, header: string): { score: number; reason: string | null } {
  const normalized = normalizeHeader(header);
  if (normalized === '') return { score: 0, reason: null };

  for (const { pattern, score, label } of HEADER_PATTERNS[role]) {
    if (pattern.test(normalized)) return { score, reason: `header "${header}" ${label}` };
  }
  return { score: 0, reason: null };
}

/** How strongly a cell reads as *any* column header. Used to find the header row. */
function headerWordStrength(cell: string): number {
  let best = 0;
  for (const role of ALL_ROLES) {
    best = Math.max(best, headerScore(role, cell).score);
  }
  return best;
}

// ---------------------------------------------------------------------------
// Transaction-type vocabulary
// ---------------------------------------------------------------------------

const DEBIT_WORDS = new Set([
  'DEBIT',
  'DR',
  'D',
  'WITHDRAWAL',
  'WITHDRAWALS',
  'WITHDRAW',
  'PAYMENT',
  'PAYMENTS',
  'CHARGE',
  'CHARGES',
  'PURCHASE',
  'SPEND',
  'OUT',
  'MONEY OUT',
  'PAID OUT',
  'SENT',
  'ACH DEBIT',
  'CHECK',
  'FEE',
]);

const CREDIT_WORDS = new Set([
  'CREDIT',
  'CR',
  'C',
  'DEPOSIT',
  'DEPOSITS',
  'RECEIVE',
  'RECEIVED',
  'IN',
  'MONEY IN',
  'PAID IN',
  'REFUND',
  'ACH CREDIT',
  'INTEREST',
]);

/**
 * Classifies one transaction-type token. A hyphenated compound is decided by its
 * first part, which is how `Spend-transfer` and `Receive-transfer` resolve: the
 * suffix says the transfer is internal, not which way the money went.
 */
function classifyTypeValue(value: string): 'debit' | 'credit' | null {
  const upper = value.trim().toUpperCase();
  if (upper === '') return null;
  if (DEBIT_WORDS.has(upper)) return 'debit';
  if (CREDIT_WORDS.has(upper)) return 'credit';

  const head = upper.split(/[-/ ]/)[0];
  if (DEBIT_WORDS.has(head)) return 'debit';
  if (CREDIT_WORDS.has(head)) return 'credit';
  return null;
}

// ---------------------------------------------------------------------------
// Header row
// ---------------------------------------------------------------------------

interface HeaderRow {
  index: number;
  score: number;
  reasons: string[];
}

/**
 * Finds the header row by scanning the first 25 rows.
 *
 * The header is the row that maximises non-empty, non-numeric, distinct cells and
 * is followed by rows of consistent arity. Preamble lines lose on all three
 * counts: `"Account: 9726"` has two cells, a totals block repeats itself, and a
 * date line is numeric. A row that reads as a set of known column headers wins
 * outright, which is what settles the common case in one step.
 */
function findHeaderRow(rows: readonly string[][], scanRows: number): HeaderRow | null {
  let best: HeaderRow | null = null;
  const limit = Math.min(scanRows, rows.length);

  for (let index = 0; index < limit; index += 1) {
    const cells = rows[index];
    const nonEmpty = cells.filter((cell) => cell !== '');
    if (nonEmpty.length < 2) continue;

    const distinct = new Set(nonEmpty.map((cell) => cell.toLowerCase())).size;
    const valueish = nonEmpty.filter((cell) => looksLikeMoney(cell) || looksLikeDate(cell)).length;
    const keyword = nonEmpty.reduce((sum, cell) => sum + headerWordStrength(cell), 0);

    const below = rows.slice(index + 1, index + 21);
    const sameArity =
      below.length === 0 ? 0 : below.filter((row) => row.length === cells.length).length / below.length;

    const reasons: string[] = [];
    // Weights: a row that reads as known headers dominates; a row full of values
    // is punished hard, because a data row can otherwise look "distinct" too.
    const score =
      keyword * 6 + distinct * 2 + nonEmpty.length - valueish * 5 + sameArity * 12 - index * 0.5;

    if (keyword > 0) reasons.push(`${nonEmpty.filter((c) => headerWordStrength(c) > 0).length} of ${nonEmpty.length} cells are recognised column names`);
    if (below.length > 0) reasons.push(`${Math.round(sameArity * 100)}% of the rows below have the same field count`);
    if (below.length === 0) reasons.push('no data rows follow — the file is header-only');
    if (valueish > 0) reasons.push(`${valueish} cells look like values rather than labels`);

    if (best === null || score > best.score) best = { index, score, reasons };
  }

  return best;
}

// ---------------------------------------------------------------------------
// Column statistics
// ---------------------------------------------------------------------------

interface ColumnStats {
  index: number;
  header: string;
  values: string[];
  nonEmpty: number;
  distinct: number;
  dateCount: number;
  moneyCount: number;
  currencyCount: number;
  negativeCount: number;
  explicitPlusCount: number;
  zeroCount: number;
  /** Cents per sampled row, `null` where the cell is empty or not money. */
  cents: Array<number | null>;
  maxAbsCents: number;
}

/** The share of a column's non-empty values that read as a debit or credit token. */
function typeVocabularyFit(column: ColumnStats): number {
  if (column.nonEmpty === 0) return 0;
  const classified = column.values.filter((value) => value !== '' && classifyTypeValue(value) !== null).length;
  return classified / column.nonEmpty;
}

function columnStats(header: string, index: number, dataRows: readonly string[][]): ColumnStats {
  const values: string[] = [];
  const cents: Array<number | null> = [];
  let nonEmpty = 0;
  let dateCount = 0;
  let moneyCount = 0;
  let currencyCount = 0;
  let negativeCount = 0;
  let explicitPlusCount = 0;
  let zeroCount = 0;
  let maxAbsCents = 0;
  const distinct = new Set<string>();

  for (const row of dataRows) {
    const value = row[index] ?? '';
    values.push(value);

    if (value === '') {
      cents.push(null);
      continue;
    }

    nonEmpty += 1;
    distinct.add(value);
    if (looksLikeDate(value)) dateCount += 1;
    if (looksLikeCurrencyCode(value)) currencyCount += 1;

    const parsed = toCents(value);
    cents.push(parsed);
    if (parsed !== null) {
      moneyCount += 1;
      if (parsed < 0) negativeCount += 1;
      if (parsed === 0) zeroCount += 1;
      if (value.trimStart().startsWith('+')) explicitPlusCount += 1;
      maxAbsCents = Math.max(maxAbsCents, Math.abs(parsed));
    }
  }

  return {
    index,
    header,
    values,
    nonEmpty,
    distinct: distinct.size,
    dateCount,
    moneyCount,
    currencyCount,
    negativeCount,
    explicitPlusCount,
    zeroCount,
    cents,
    maxAbsCents,
  };
}

// ---------------------------------------------------------------------------
// The balance chain test
// ---------------------------------------------------------------------------

interface ChainEvidence {
  amountIndex: number;
  balanceIndex: number;
  /** Fraction of testable consecutive pairs that tie. */
  fit: number;
  pairs: number;
  /** Which way the file is sorted. */
  direction: 'ascending' | 'descending';
  /** `+1` when a negative amount reduces the balance; `-1` when it increases it. */
  sign: 1 | -1;
}

/**
 * Tests whether `balance` is the running total of `amount`.
 *
 * All four combinations are tried, because the two things we do not yet know are
 * independent: whether the file is sorted oldest-first or newest-first, and
 * whether the file writes money out as a negative (a checking export) or as a
 * positive (many credit-card exports). Relay ties at `descending, +1`: reading the
 * file upward, each balance is the one below it plus that row's signed amount.
 */
function chainEvidence(amount: ColumnStats, balance: ColumnStats): ChainEvidence | null {
  const n = Math.min(amount.cents.length, balance.cents.length);
  if (n < 3) return null;

  let best: ChainEvidence | null = null;

  const directions: Array<'ascending' | 'descending'> = ['ascending', 'descending'];
  const signs: Array<1 | -1> = [1, -1];

  for (const direction of directions) {
    for (const sign of signs) {
      let pairs = 0;
      let hits = 0;

      for (let i = 0; i < n; i += 1) {
        // The neighbour that holds the *previous* balance.
        const previous = direction === 'ascending' ? i - 1 : i + 1;
        if (previous < 0 || previous >= n) continue;

        const priorBalance = balance.cents[previous];
        const thisBalance = balance.cents[i];
        const thisAmount = amount.cents[i];
        if (priorBalance === null || thisBalance === null || thisAmount === null) continue;

        pairs += 1;
        if (thisBalance === priorBalance + sign * thisAmount) hits += 1;
      }

      if (pairs < 2) continue;
      const fit = hits / pairs;
      if (best === null || fit > best.fit) {
        best = { amountIndex: amount.index, balanceIndex: balance.index, fit, pairs, direction, sign };
      }
    }
  }

  return best !== null && best.fit >= 0.9 ? best : null;
}

// ---------------------------------------------------------------------------
// Role scoring
// ---------------------------------------------------------------------------

interface RoleScore {
  value: number | null;
  reasons: string[];
}

function fraction(part: number, whole: number): number {
  return whole === 0 ? 0 : part / whole;
}

function scoreRole(role: ColumnRole, column: ColumnStats): RoleScore {
  const { nonEmpty } = column;
  if (nonEmpty === 0) return { value: null, reasons: [] };

  const reasons: string[] = [];
  const pct = (n: number): string => `${Math.round(fraction(n, nonEmpty) * 100)}%`;

  switch (role) {
    case 'date': {
      const fit = fraction(column.dateCount, nonEmpty);
      if (fit > 0) reasons.push(`${pct(column.dateCount)} of values parse as a calendar date`);
      return { value: fit, reasons };
    }

    case 'description':
    case 'counterparty': {
      const textual = column.values.filter(
        (value) => value !== '' && !looksLikeMoney(value) && !looksLikeDate(value),
      ).length;
      const textFit = fraction(textual, nonEmpty);
      const variety = fraction(column.distinct, nonEmpty);
      let value = textFit * (0.4 + 0.6 * variety);

      reasons.push(`${pct(textual)} of values are free text, ${column.distinct} distinct in ${nonEmpty}`);
      // A column with one repeated value is a label, not a description. Relay's
      // `Description` column is literally the word "Unknown" on three rows in four.
      if (nonEmpty >= 4 && column.distinct === 1) {
        value *= 0.15;
        reasons.push(`every non-empty value is the same string ("${column.values.find((v) => v !== '')}") — it carries no information`);
      }
      return { value, reasons };
    }

    case 'amount':
    case 'debit':
    case 'credit':
    case 'balance': {
      const fit = fraction(column.moneyCount, nonEmpty);
      if (fit > 0) reasons.push(`${pct(column.moneyCount)} of values parse as an amount`);
      if (role === 'balance' && column.moneyCount > 0) {
        const negatives = fraction(column.negativeCount, column.moneyCount);
        if (negatives < 0.1) reasons.push(`only ${Math.round(negatives * 100)}% of values are negative, as a running balance usually is`);
      }
      if (role === 'amount' && column.negativeCount > 0) {
        reasons.push(`${column.negativeCount} values are negative — the column carries direction`);
      }
      return { value: fit, reasons };
    }

    case 'type':
    case 'status': {
      if (column.moneyCount > nonEmpty / 2) return { value: 0, reasons: [] };
      const variety = fraction(column.distinct, nonEmpty);
      // A type column is a small closed vocabulary repeated many times.
      const closed = column.distinct <= 8 && nonEmpty >= 2 ? 1 - Math.min(variety, 1) : 0;
      if (closed > 0) {
        reasons.push(`only ${column.distinct} distinct values in ${nonEmpty} rows — a closed vocabulary`);
      }
      if (role === 'type') {
        const known = typeVocabularyFit(column);
        if (known > 0) {
          reasons.push(`${Math.round(known * 100)}% of values read as a debit or credit token`);
        }
        // A closed vocabulary alone is weak evidence — "ACME SUPPLY CO" repeated
        // twice in five rows is closed too. It only counts once the values
        // themselves read as directions, or the header says so.
        return { value: known > 0 ? Math.max(closed * 0.6, known) : closed * 0.25, reasons };
      }
      return { value: closed, reasons };
    }

    case 'reference': {
      const textual = column.values.filter((v) => v !== '' && !looksLikeMoney(v) && !looksLikeDate(v)).length;
      const fit = fraction(textual, nonEmpty) * Math.min(1, fraction(nonEmpty, column.values.length) + 0.2);
      if (textual > 0) reasons.push(`${pct(textual)} of values are free text`);
      return { value: fit, reasons };
    }

    case 'external_id': {
      // Uniqueness decides, not the header. Mercury's `Reference` holds
      // "Profit distribution" and would be a disastrous dedup key; Amex's holds
      // a 19-digit number and is a perfect one. The headers are identical.
      const populated = fraction(nonEmpty, column.values.length);
      const unique = column.distinct === nonEmpty && nonEmpty >= 3;
      const longEnough = column.values.every((v) => v === '' || v.length >= 8);
      const value = populated >= 0.95 && unique && longEnough ? 1 : 0;
      if (value === 1) {
        reasons.push(`populated on ${Math.round(populated * 100)}% of rows and unique on every one — usable as a stable id`);
      } else if (!unique) {
        reasons.push('values repeat, so this cannot be a transaction id');
      } else if (!longEnough) {
        reasons.push('values are too short to be a bank-issued id');
      }
      return { value, reasons };
    }

    case 'currency': {
      const fit = fraction(column.currencyCount, nonEmpty);
      if (fit > 0.9 && column.distinct <= 3) {
        reasons.push(`every value is a three-letter currency code (${column.distinct} distinct)`);
        return { value: 1, reasons };
      }
      return { value: 0, reasons };
    }

    default:
      return { value: null, reasons: [] };
  }
}

/**
 * Combines the header evidence with the value evidence.
 *
 * When a file has data, the values dominate: a column called `Amount` that holds
 * dates is not an amount column. When the file is header-only — 25 of Sooz's 36
 * Relay statements are — there is nothing to corroborate the name, so the header
 * score carries alone at a discount, and the caller sees that in the confidence.
 */
function combine(header: number, value: number | null): number {
  if (value === null) return header * 0.75;
  if (header === 0 && value === 0) return 0;
  const blended = 0.45 * header + 0.55 * value;
  // Both signals agreeing is worth more than the average of the two.
  const agreement = header >= 0.7 && value >= 0.7 ? 0.12 : 0;
  return Math.min(1, blended + agreement);
}

// ---------------------------------------------------------------------------
// Filename pattern
// ---------------------------------------------------------------------------

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Proposes a `detected_from_filename` pattern by generalising the digit runs in
 * the filename: `Relay 2026-01-01 #9726.csv` becomes
 * `^Relay \d{4}-\d{2}-\d{2} #\d{4}\.csv$`. A starting point for the user to edit,
 * not a claim about the bank's naming scheme.
 */
function proposeFilenamePattern(filename: string): string | null {
  if (filename.trim() === '') return null;
  const pattern = filename
    .split(/(\d+)/)
    .map((part) => (/^\d+$/.test(part) ? `\\d{${part.length}}` : escapeRegExp(part)))
    .join('');
  return `^${pattern}$`;
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

function emptyProfile(file: ParsedFile, name: string): ProposedProfile {
  return {
    name,
    file_type: file.format,
    delimiter: file.delimiter ?? ',',
    encoding: file.encoding === 'utf-8-sig' ? 'utf-8' : file.encoding,
    skip_rows: 0,
    header_row: 0,
    date_column: '',
    date_format: null,
    description_columns: [],
    counterparty_column: null,
    mode: 'signed',
    amount_column: null,
    debit_column: null,
    credit_column: null,
    type_column: null,
    debit_type_values: [],
    credit_type_values: [],
    balance_column: null,
    reference_column: null,
    external_id_column: null,
    invert_sign: false,
    skip_row_rules: [],
    detected_from_filename: proposeFilenamePattern(file.filename),
  };
}

/**
 * Works out what a file's columns mean.
 *
 * Returns ranked candidates per role — the UI shows the best and lets a human
 * pick another — plus the amount mode, the sign convention and a proposed
 * `import_profiles` row. Nothing here writes anything; the human confirms.
 */
export function detectColumns(file: ParsedFile, options: DetectOptions = {}): DetectionResult {
  const scanRows = options.headerScanRows ?? DEFAULT_HEADER_SCAN_ROWS;
  const sampleRows = options.sampleRows ?? DEFAULT_SAMPLE_ROWS;
  const profileName = options.profileName ?? defaultProfileName(file.filename, file.format);

  const warnings: ParseWarning[] = [];
  const reasons: string[] = [];

  if (file.rows.length === 0) {
    warnings.push({
      severity: 'error',
      code: 'file.empty',
      message: `"${file.filename}" has no rows at all — not even a header.`,
    });
    return {
      ok: false,
      headerRowIndex: -1,
      skipRows: 0,
      headers: [],
      dataRowCount: 0,
      guesses: {},
      amountMode: 'signed',
      signConvention: {
        mode: 'signed',
        negativeIsOutflow: true,
        invertSign: false,
        evidence: 'no rows to read',
        confidence: 0,
      },
      confidence: 0,
      reasons: [],
      warnings,
      profile: emptyProfile(file, profileName),
    };
  }

  const header = findHeaderRow(file.rows, scanRows);
  if (header === null) {
    warnings.push({
      severity: 'error',
      code: 'header.not_found',
      message: `No row in the first ${scanRows} of "${file.filename}" reads as a header.`,
    });
    return {
      ok: false,
      headerRowIndex: -1,
      skipRows: 0,
      headers: [],
      dataRowCount: 0,
      guesses: {},
      amountMode: 'signed',
      signConvention: {
        mode: 'signed',
        negativeIsOutflow: true,
        invertSign: false,
        evidence: 'no header found',
        confidence: 0,
      },
      confidence: 0,
      reasons: [],
      warnings,
      profile: emptyProfile(file, profileName),
    };
  }

  const headers = file.rows[header.index].map((cell) => cell.trim());
  const allDataRows = file.rows.slice(header.index + 1);
  const dataRows = allDataRows.slice(0, sampleRows);
  reasons.push(`header found on physical row ${header.index + 1}: ${header.reasons[0] ?? 'best-scoring row'}`);

  if (allDataRows.length === 0) {
    warnings.push({
      severity: 'info',
      code: 'file.no_data_rows',
      message: `"${file.filename}" is header-only. For Relay this is normal — an account with no activity still exports its header.`,
    });
    reasons.push('no data rows, so every column was classified from its name alone');
  }

  const columns = headers.map((name, index) => columnStats(name, index, dataRows));

  // --- balance first, and hard ------------------------------------------------
  const moneyColumns = columns.filter(
    (column) => column.nonEmpty > 0 && fraction(column.moneyCount, column.nonEmpty) >= 0.8,
  );

  // The amount side of a chain has to be filled on essentially every row. Half of
  // a debit/credit pair is not: it is blank whenever the money went the other way,
  // and it would otherwise "prove" itself the amount column on the rows it does
  // occupy. The balance side may be sparse — some banks print it once a day.
  const chainAmountCandidates = moneyColumns.filter(
    (column) => dataRows.length > 0 && column.moneyCount >= 0.9 * dataRows.length,
  );

  let chain: ChainEvidence | null = null;
  for (const candidateAmount of chainAmountCandidates) {
    for (const candidateBalance of moneyColumns) {
      if (candidateAmount.index === candidateBalance.index) continue;
      const evidence = chainEvidence(candidateAmount, candidateBalance);
      if (evidence === null) continue;
      if (chain === null || evidence.fit > chain.fit || (evidence.fit === chain.fit && evidence.pairs > chain.pairs)) {
        chain = evidence;
      }
    }
  }

  /** Column indices barred from ever being ranked as the amount. */
  const barredFromAmount = new Set<number>();
  for (const column of columns) {
    if (headerScore('balance', column.header).score >= 0.85) barredFromAmount.add(column.index);
  }
  if (chain !== null) {
    barredFromAmount.add(chain.balanceIndex);
    // The chain also proves the other column *is* the amount, so it must not be
    // barred by an unlucky header match.
    barredFromAmount.delete(chain.amountIndex);
    reasons.push(
      `"${headers[chain.balanceIndex]}" is the running balance: it moves by "${headers[chain.amountIndex]}" on ${Math.round(
        chain.fit * 100,
      )}% of ${chain.pairs} consecutive rows (${chain.direction} order)`,
    );
  }

  // --- rank every role --------------------------------------------------------
  const guesses: Partial<Record<ColumnRole, ColumnGuess[]>> = {};

  for (const role of ALL_ROLES) {
    const ranked: ColumnGuess[] = [];

    for (const column of columns) {
      if (column.header === '') continue;
      if (role === 'amount' && barredFromAmount.has(column.index)) continue;
      // An amount column is filled on essentially every row of a statement. A
      // sparse one is something else wearing numbers — Relay's `Account #` holds
      // a counterparty's last four on six rows in a hundred and ten, and reads as
      // perfectly good money on every one of them.
      if (
        role === 'amount' &&
        dataRows.length > 0 &&
        column.moneyCount < 0.9 * dataRows.length
      ) {
        continue;
      }
      // …and money is written as money. An unnamed column of bare integers with
      // no sign and no cents is an account number, a cheque number or a quantity.
      // A column actually called `Amount`, or one the balance chain has already
      // proved, is exempt: a bank that reports whole dollars is unusual, not
      // impossible.
      if (
        role === 'amount' &&
        headerScore('amount', column.header).score === 0 &&
        !(chain !== null && column.index === chain.amountIndex) &&
        !column.values.some((value) => value !== '' && /\.\d{1,4}$|^[+-]/.test(value.trim()))
      ) {
        continue;
      }
      // A status column is a closed vocabulary too; keep the two apart by name.
      if (role === 'type' && headerScore('status', column.header).score >= 0.9) continue;
      if (role === 'type' && headerScore('currency', column.header).score >= 0.9) continue;

      const { score: hdr, reason: headerReason } = headerScore(role, column.header);

      // Roles that a profile can live without are only ever proposed on a named
      // header — or, for the balance, on chain evidence. Guessing them from value
      // shape alone fills a profile with plausible nonsense: every text column
      // becomes the counterparty, every money column becomes the balance, and the
      // balance a later phase reconciles against is then the amount column.
      if (hdr === 0) {
        if (role === 'counterparty' || role === 'reference' || role === 'external_id') continue;
        if (role === 'status' || role === 'currency') continue;
        if (role === 'type' && typeVocabularyFit(column) < 0.9) continue;
        if (role === 'balance' && !(chain !== null && column.index === chain.balanceIndex)) continue;
      }

      const { value, reasons: valueReasons } = scoreRole(role, column);

      let confidence = combine(hdr, value);
      const why = [...(headerReason ? [headerReason] : []), ...valueReasons];

      if (chain !== null && role === 'amount' && column.index === chain.amountIndex) {
        confidence = Math.min(1, confidence + 0.25);
        why.unshift(`the running balance "${headers[chain.balanceIndex]}" moves by this column row over row`);
      }
      if (chain !== null && role === 'balance' && column.index === chain.balanceIndex) {
        confidence = Math.min(1, confidence + 0.25);
        why.unshift(`this column is the running total of "${headers[chain.amountIndex]}"`);
      }

      if (confidence <= 0.05 || why.length === 0) continue;

      ranked.push({
        role,
        columnIndex: column.index,
        column: column.header,
        confidence: Math.round(confidence * 1000) / 1000,
        reason: why[0],
        reasons: why,
      });
    }

    ranked.sort((a, b) => b.confidence - a.confidence || a.columnIndex - b.columnIndex);
    if (ranked.length > 0) guesses[role] = ranked;
  }

  // --- debit/credit pair ------------------------------------------------------
  const pair = findDebitCreditPair(columns, barredFromAmount, dataRows.length);
  if (pair !== null) {
    reasons.push(
      `"${pair.debit.header}" and "${pair.credit.header}" are a debit/credit pair: exactly one of the two is filled on ${Math.round(
        pair.exclusivity * 100,
      )}% of rows`,
    );
  } else {
    delete guesses.debit;
    delete guesses.credit;
  }

  // --- mode and sign ----------------------------------------------------------
  const amountGuess = guesses.amount?.[0] ?? null;
  const typeGuess = guesses.type?.[0] ?? null;
  const amountColumn = amountGuess ? columns[amountGuess.columnIndex] : null;

  const typeValues = typeGuess ? classifyTypeColumn(columns[typeGuess.columnIndex]) : null;

  const { mode, sign } = resolveMode({
    pair,
    amountColumn,
    typeValues,
    chain,
    hasDataRows: dataRows.length > 0,
  });
  reasons.push(sign.evidence);

  // --- assemble the proposed profile -----------------------------------------
  const descriptionGuess = guesses.description?.[0] ?? null;
  const counterpartyGuess = guesses.counterparty?.[0] ?? null;
  const balanceGuess = guesses.balance?.[0] ?? null;
  const referenceGuess = pickReference(guesses, descriptionGuess, counterpartyGuess);
  const externalIdGuess = guesses.external_id?.[0] ?? null;
  const dateGuess = guesses.date?.[0] ?? null;

  if (dateGuess === null) {
    warnings.push({
      severity: 'error',
      code: 'profile.column_missing',
      message: 'No column reads as a transaction date. A profile cannot be built without one.',
    });
  }
  if (mode === 'signed' && amountGuess === null) {
    warnings.push({
      severity: 'error',
      code: 'profile.mode_columns_missing',
      message:
        'No column reads as a signed amount, and no debit/credit pair was found. Pick the amount column by hand.',
    });
  }

  const profile: ProposedProfile = {
    ...emptyProfile(file, profileName),
    skip_rows: header.index,
    header_row: 0,
    date_column: dateGuess?.column ?? '',
    date_format: dateGuess ? inferDateFormat(columns[dateGuess.columnIndex]) : null,
    description_columns: descriptionGuess ? [descriptionGuess.column] : [],
    counterparty_column: counterpartyGuess?.column ?? null,
    mode,
    amount_column: mode === 'debit_credit' ? null : (amountGuess?.column ?? null),
    debit_column: pair?.debit.header ?? null,
    credit_column: pair?.credit.header ?? null,
    type_column: typeGuess?.column ?? null,
    debit_type_values: mode === 'amount_with_type' ? (typeValues?.debit ?? []) : [],
    credit_type_values: mode === 'amount_with_type' ? (typeValues?.credit ?? []) : [],
    balance_column: balanceGuess?.column ?? null,
    reference_column: referenceGuess?.column ?? null,
    external_id_column: externalIdGuess?.column ?? null,
    invert_sign: sign.invertSign,
  };

  // Overall confidence is only as good as the two columns a profile cannot do
  // without, tempered by how sure we are which way the signs run. A file whose
  // date and amount are obvious but whose direction is a guess is not a file the
  // UI should auto-accept.
  const required: number[] = [dateGuess?.confidence ?? 0];
  required.push(
    mode === 'debit_credit' ? (pair === null ? 0 : Math.min(1, pair.exclusivity)) : (amountGuess?.confidence ?? 0),
  );
  const weakest = Math.min(...required);
  const average = required.reduce((sum, value) => sum + value, 0) / required.length;
  const confidence = Math.round(((weakest + average) / 2) * sign.confidence * 1000) / 1000;

  const ok =
    dateGuess !== null && (mode === 'debit_credit' ? pair !== null : amountGuess !== null);

  return {
    ok,
    headerRowIndex: header.index,
    skipRows: header.index,
    headers,
    dataRowCount: allDataRows.length,
    guesses,
    amountMode: mode,
    signConvention: sign,
    confidence,
    reasons,
    warnings,
    profile,
  };
}

// ---------------------------------------------------------------------------
// Helpers used by detectColumns
// ---------------------------------------------------------------------------

function defaultProfileName(filename: string, format: string): string {
  const base = filename.replace(/\.[A-Za-z0-9]+$/, '').trim();
  // Strip the volatile part of a per-period filename so the profile's name is
  // about the bank, not about January.
  const stable = base
    .replace(/\d{4}[-/]\d{1,2}([-/]\d{1,2})?/g, '')
    .replace(/#\d+/g, '')
    .replace(/\(partial\)/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  return `${stable === '' ? 'Imported' : stable} ${format.toUpperCase()}`.replace(/\s+/g, ' ');
}

interface DebitCreditPair {
  debit: ColumnStats;
  credit: ColumnStats;
  exclusivity: number;
}

/**
 * Finds a debit/credit pair: two money columns where, row by row, exactly one of
 * the two carries a value. Which is which is decided by the headers — the values
 * themselves are usually both positive and say nothing about direction.
 */
function findDebitCreditPair(
  columns: readonly ColumnStats[],
  barredFromAmount: ReadonlySet<number>,
  rowCount: number,
): DebitCreditPair | null {
  const candidates = columns.filter(
    (column) =>
      !barredFromAmount.has(column.index) &&
      column.header !== '' &&
      (column.nonEmpty === 0
        ? headerScore('debit', column.header).score > 0 || headerScore('credit', column.header).score > 0
        : fraction(column.moneyCount, column.nonEmpty) >= 0.8),
  );

  let best: DebitCreditPair | null = null;

  for (const a of candidates) {
    for (const b of candidates) {
      if (a.index >= b.index) continue;

      const aDebit = headerScore('debit', a.header).score;
      const bCredit = headerScore('credit', b.header).score;
      const aCredit = headerScore('credit', a.header).score;
      const bDebit = headerScore('debit', b.header).score;

      const forward = Math.min(aDebit, bCredit);
      const backward = Math.min(aCredit, bDebit);
      if (forward === 0 && backward === 0) continue;

      const debit = forward >= backward ? a : b;
      const credit = forward >= backward ? b : a;

      let exclusivity = 1;
      if (rowCount > 0) {
        let exclusive = 0;
        for (let i = 0; i < rowCount; i += 1) {
          const left = a.cents[i];
          const right = b.cents[i];
          const leftFilled = left !== null && left !== 0;
          const rightFilled = right !== null && right !== 0;
          if (leftFilled !== rightFilled) exclusive += 1;
        }
        exclusivity = exclusive / rowCount;
        if (exclusivity < 0.9) continue;
      }

      if (best === null || exclusivity > best.exclusivity) best = { debit, credit, exclusivity };
    }
  }

  return best;
}

interface TypeVocabulary {
  debit: string[];
  credit: string[];
  unknown: string[];
}

function classifyTypeColumn(column: ColumnStats): TypeVocabulary {
  const debit = new Set<string>();
  const credit = new Set<string>();
  const unknown = new Set<string>();

  for (const value of column.values) {
    if (value === '') continue;
    const kind = classifyTypeValue(value);
    if (kind === 'debit') debit.add(value);
    else if (kind === 'credit') credit.add(value);
    else unknown.add(value);
  }

  return {
    debit: [...debit].sort(),
    credit: [...credit].sort(),
    unknown: [...unknown].sort(),
  };
}

interface ResolveModeInput {
  pair: DebitCreditPair | null;
  amountColumn: ColumnStats | null;
  typeValues: TypeVocabulary | null;
  chain: ChainEvidence | null;
  hasDataRows: boolean;
}

/**
 * Decides the amount mode and, for a signed file, which way the signs run.
 *
 * The balance column is what settles the sign question when it exists: if the
 * running balance falls by the amount on a row whose amount is negative, then
 * negative means money left the company and the file needs no inversion. A
 * credit-card export that writes purchases as positives ties at `sign: -1`
 * instead, and `invert_sign` is proposed true.
 */
function resolveMode(input: ResolveModeInput): { mode: AmountMode; sign: SignConvention } {
  const { pair, amountColumn, typeValues, chain, hasDataRows } = input;

  if (pair !== null) {
    return {
      mode: 'debit_credit',
      sign: {
        mode: 'debit_credit',
        negativeIsOutflow: true,
        invertSign: false,
        evidence: `direction comes from the "${pair.debit.header}" / "${pair.credit.header}" pair, so no sign convention is needed`,
        confidence: 1,
      },
    };
  }

  const hasNegatives = (amountColumn?.negativeCount ?? 0) > 0;
  const usableType =
    typeValues !== null && typeValues.debit.length > 0 && typeValues.credit.length > 0;

  if (hasDataRows && amountColumn !== null && !hasNegatives && usableType) {
    return {
      mode: 'amount_with_type',
      sign: {
        mode: 'amount_with_type',
        negativeIsOutflow: true,
        invertSign: false,
        evidence: `every amount is positive, so direction comes from the type column (${typeValues.debit.join(
          '/',
        )} out, ${typeValues.credit.join('/')} in)`,
        confidence: 0.9,
      },
    };
  }

  if (chain !== null) {
    const negativeIsOutflow = chain.sign === 1;
    return {
      mode: 'signed',
      sign: {
        mode: 'signed',
        negativeIsOutflow,
        invertSign: !negativeIsOutflow,
        evidence: negativeIsOutflow
          ? 'the running balance falls when the amount is negative, so a negative amount is money out and no inversion is needed'
          : 'the running balance rises when the amount is negative, so the file is written from the bank\'s point of view and every amount must be inverted',
        confidence: 0.95,
      },
    };
  }

  if (hasNegatives) {
    return {
      mode: 'signed',
      sign: {
        mode: 'signed',
        negativeIsOutflow: true,
        invertSign: false,
        evidence:
          'the amount column carries both signs but there is no balance column to corroborate the direction; assuming negative means money out',
        confidence: 0.6,
      },
    };
  }

  return {
    mode: 'signed',
    sign: {
      mode: 'signed',
      negativeIsOutflow: true,
      invertSign: false,
      evidence: hasDataRows
        ? 'no negative amounts, no usable type column and no balance column — the direction of every row needs confirming'
        : 'no data rows to read a sign convention from',
      confidence: hasDataRows ? 0.2 : 0,
    },
  };
}

/** The best reference candidate that is not already carrying another role. */
function pickReference(
  guesses: Partial<Record<ColumnRole, ColumnGuess[]>>,
  description: ColumnGuess | null,
  counterparty: ColumnGuess | null,
): ColumnGuess | null {
  const taken = new Set<number>();
  if (description) taken.add(description.columnIndex);
  if (counterparty) taken.add(counterparty.columnIndex);
  return guesses.reference?.find((guess) => !taken.has(guess.columnIndex)) ?? null;
}

/**
 * Names the date layout the column actually uses, so `applyProfile` never has to
 * guess between `3/4/2026` as March 4th and as the 3rd of April. A column whose
 * day-part exceeds 12 somewhere proves the order; one that never does is reported
 * as `null`, which leaves the decision to the human confirming the profile.
 */
function inferDateFormat(column: ColumnStats): string | null {
  let iso = 0;
  let slash = 0;
  let named = 0;
  let firstOverTwelve = 0;
  let secondOverTwelve = 0;
  let total = 0;

  for (const value of column.values) {
    if (value === '' || !looksLikeDate(value)) continue;
    total += 1;

    if (/^\d{4}[-/]/.test(value)) {
      iso += 1;
      continue;
    }
    if (/^\d{1,2}[-/. ][A-Za-z]{3,9}/.test(value) || /^[A-Za-z]{3,9}/.test(value)) {
      named += 1;
      continue;
    }
    const parts = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/.exec(value);
    if (parts) {
      slash += 1;
      if (Number(parts[1]) > 12) firstOverTwelve += 1;
      if (Number(parts[2]) > 12) secondOverTwelve += 1;
    }
  }

  if (total === 0) return null;
  if (iso > slash && iso > named) return 'YYYY-MM-DD';
  if (named > slash) return 'D-MMM-YYYY';
  if (slash === 0) return null;
  if (firstOverTwelve > 0 && secondOverTwelve === 0) return 'D/M/YYYY';
  if (secondOverTwelve > 0 && firstOverTwelve === 0) return 'M/D/YYYY';
  // Ambiguous in this sample. US month-first is the overwhelming default for the
  // banks in scope, but the caller is told nothing was proved.
  return firstOverTwelve === 0 && secondOverTwelve === 0 ? 'M/D/YYYY' : null;
}

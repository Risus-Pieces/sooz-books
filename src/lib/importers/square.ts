/**
 * Square — the settlement importer.
 *
 * Square is Sooz's only revenue channel today. Nine months of Relay statements
 * carry exactly seven Square deposits, worth $272.00, and they are the entire
 * top line of the company. Every one of them arrived **net of Square's
 * processing fee**, so the bank number is not revenue and must never be booked
 * as revenue. This module turns a Square settlement export into the gross
 * decomposition — sales, refunds, discounts, tax, tips, fees — that posts
 * against **Square Clearing**, which the matching Relay deposit then clears to
 * exactly zero. That zero is the proof nothing was dropped.
 *
 * Three things are load-bearing and none of them is negotiable:
 *
 *   1. **Nothing posts until the settlement ties.** `assertSettlementBalances`
 *      checks the file's own arithmetic to the cent, with no tolerance, and a
 *      settlement that does not tie is rejected with the difference and a
 *      diagnosis of *why*. Never plug a difference.
 *   2. **One payout can arrive as several deposits.** On 2026-01-26 three
 *      separate Relay rows all carry the reference `SQ260126` (+161.67, +3.25,
 *      +0.82). A matcher that stops at the first row strands $4.07 in clearing
 *      forever. `matchSquarePayoutToBankTransaction` matches sets, not rows.
 *   3. **Money is integer cents.** No float touches this path.
 *
 * ## Accounts
 *
 * This module deliberately emits **semantic account roles**, not account codes.
 * It stops short of posting: the later phase resolves a role to an account
 * through the posting context, and the authoritative role → account table lives
 * in `docs/formats/square.md` §7b alongside the rest of the format contract.
 * Square Clearing and Direct & Market Sales (Square) are Sooz-specific accounts
 * that the seeded chart carries but the semantic `ACCOUNTS` map in
 * `@/lib/ledger/coa` does not yet name, and inventing a second, divergent copy
 * of the chart here would be worse than naming the roles honestly.
 *
 * ## Provenance
 *
 * **No real Square export has been seen yet.** `docs/formats/square.md` marks
 * every claim as verified against Square's documentation, corroborated by
 * third-party sources, or inferred. The column contract in §4a of that document
 * is *inferred*, which is why this parser selects columns by name through an
 * alias table rather than by position, keeps unrecognised money columns instead
 * of dropping them, and can diagnose an inverted sign convention rather than
 * silently posting a mirror-image entry. Validate against a real export
 * (`square.md` §11) before trusting it with the books.
 */

import { createHash } from 'node:crypto';

import { readRawRows } from '@/lib/banking/apply-profile';
import type { ParsedFile, RawRow } from '@/lib/banking/types';
import { addDays, isCalendarDate, parseDateInput, type CalendarDate } from '@/lib/dates';
import { formatMoney, parseMoney, sumCents } from '@/lib/money';

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/** The importer id recorded on every batch, warning and draft entry. */
export const SQUARE_IMPORTER_ID = 'square.settlements.v1';

/** Unit separator. A value containing it cannot forge a fingerprint collision. */
const SEP = '';

// ---------------------------------------------------------------------------
// Warnings
// ---------------------------------------------------------------------------

/**
 * `info` is recorded; `warn` keeps the data and flags it; `error` drops one row
 * and, because this importer asserts a control total, is treated as proof the
 * parse is incomplete; `fatal` means nothing from the file may post.
 */
export type SquareWarningSeverity = 'info' | 'warn' | 'error' | 'fatal';

export type SquareWarningCode =
  | 'file.empty'
  | 'file.no_data_rows'
  | 'file.wrong_report'
  | 'header.missing_required'
  | 'header.duplicate_role'
  | 'header.column_absent'
  | 'header.unknown_money_column'
  | 'row.no_amounts'
  | 'date.missing'
  | 'date.unparsable'
  | 'amount.unparsable'
  | 'settlement.identity_failed'
  | 'settlement.outflow_sign'
  | 'settlement.unmapped_component';

export interface SquareWarning {
  severity: SquareWarningSeverity;
  code: SquareWarningCode;
  /** What a bookkeeper reads. */
  message: string;
  /** 0-based index among data rows, when the warning belongs to one. */
  rowIndex?: number;
  /** The column header the warning is about. */
  field?: string;
  /** The offending cell, verbatim. */
  value?: string;
}

/** A row that never became part of a settlement, kept with its reason. */
export interface SquareSkippedRow {
  rowIndex: number;
  physicalRow: number;
  code: SquareWarningCode;
  reason: string;
  cells: string[];
}

/**
 * Skips that prove the parse is incomplete rather than that the row held nothing.
 *
 * This importer asserts a control total, so a row lost to an unreadable date or
 * an unreadable amount is not a tolerable loss — the payout total it fed can no
 * longer be checked, and the file must not post (`docs/formats/README.md` §1.3
 * rule 2). A row carrying only zeroes is different: nothing was lost, and it is
 * reported without blocking.
 */
export const SQUARE_BLOCKING_SKIP_CODES: readonly SquareWarningCode[] = Object.freeze([
  'date.missing',
  'date.unparsable',
  'amount.unparsable',
]);

// ---------------------------------------------------------------------------
// The column contract
// ---------------------------------------------------------------------------

/** A money bucket that posts. Derived columns are not components. */
export type SquareComponent =
  | 'gross_sales'
  | 'returns'
  | 'partial_refunds'
  | 'discounts'
  | 'service_charges'
  | 'gift_card_sales'
  | 'tax'
  | 'tip'
  | 'fees'
  | 'other';

export const SQUARE_COMPONENTS: readonly SquareComponent[] = Object.freeze([
  'gross_sales',
  'returns',
  'partial_refunds',
  'discounts',
  'service_charges',
  'gift_card_sales',
  'tax',
  'tip',
  'fees',
  'other',
]);

/**
 * Components the file states as negative numbers (`docs/formats/square.md` §6).
 * Nothing is ever subtracted; every identity in this module is a plain sum.
 */
export const SQUARE_OUTFLOW_COMPONENTS: readonly SquareComponent[] = Object.freeze([
  'returns',
  'partial_refunds',
  'discounts',
  'fees',
]);

/** Every column role the parser understands, component and non-component alike. */
export type SquareField =
  | SquareComponent
  | 'settlement_date'
  | 'settlement_id'
  | 'settlement_type'
  | 'description'
  | 'currency'
  | 'net_sales'
  | 'total_collected'
  | 'net_total';

/**
 * Columns computed by Square from the components. They are read so the identity
 * in §6 can be checked and are **never posted** — posting a derived column
 * alongside its components double-counts the entire settlement.
 */
export const SQUARE_DERIVED_FIELDS: readonly SquareField[] = Object.freeze([
  'net_sales',
  'total_collected',
]);

/** Semantic account roles. Resolved to accounts by the posting phase, not here. */
export type SquareAccountRole =
  | 'square_clearing'
  | 'square_sales'
  | 'other_sales_income'
  | 'gift_card_liability'
  | 'sales_tax_payable'
  | 'returns_and_allowances'
  | 'coupons_and_promotions'
  | 'payment_processing_fees'
  | 'ask_my_accountant';

/** `docs/formats/square.md` §7b holds the role → account-code table. */
export const SQUARE_COMPONENT_ACCOUNT_ROLE: Readonly<Record<SquareComponent, SquareAccountRole>> =
  Object.freeze({
    gross_sales: 'square_sales',
    returns: 'returns_and_allowances',
    partial_refunds: 'returns_and_allowances',
    discounts: 'coupons_and_promotions',
    service_charges: 'other_sales_income',
    gift_card_sales: 'gift_card_liability',
    tax: 'sales_tax_payable',
    tip: 'other_sales_income',
    fees: 'payment_processing_fees',
    // An unrecognised money column is never guessed and never dropped.
    other: 'ask_my_accountant',
  } satisfies Record<SquareComponent, SquareAccountRole>);

interface ColumnAlias {
  readonly field: SquareField;
  readonly headers: readonly string[];
}

/**
 * Header aliases, canonical spelling first. Matching is case- and
 * punctuation-insensitive (`normalizeHeaderKey`), so `Discounts & Comps`,
 * `discounts and comps` and `DISCOUNTS_&_COMPS` are one column.
 */
const COLUMN_ALIASES: readonly ColumnAlias[] = Object.freeze([
  {
    field: 'settlement_date',
    headers: ['Settlement Date', 'Payout Date', 'Transfer Date', 'Deposit Date', 'Date'],
  },
  {
    field: 'settlement_id',
    headers: ['Settlement ID', 'Payout ID', 'Transfer ID', 'Deposit ID'],
  },
  {
    field: 'settlement_type',
    headers: ['Settlement Type', 'Activity Type', 'Transfer Type', 'Type'],
  },
  { field: 'description', headers: ['Settlement Description', 'Description', 'Details'] },
  { field: 'currency', headers: ['Currency', 'Currency Code'] },
  { field: 'gross_sales', headers: ['Gross Sales', 'Gross Amount', 'Gross'] },
  { field: 'returns', headers: ['Returns', 'Refunds', 'Refunds Issued'] },
  { field: 'partial_refunds', headers: ['Partial Refunds', 'Partial Refund'] },
  {
    field: 'discounts',
    headers: ['Discounts & Comps', 'Discounts and Comps', 'Discounts', 'Comps'],
  },
  {
    field: 'service_charges',
    headers: ['Service Charges', 'Service Charge', 'Surcharges', 'Auto Gratuity'],
  },
  { field: 'gift_card_sales', headers: ['Gift Card Sales', 'Gift Card Sale', 'Gift Cards Sold'] },
  { field: 'net_sales', headers: ['Net Sales', 'Net Sale'] },
  { field: 'tax', headers: ['Tax', 'Taxes', 'Sales Tax', 'Tax Collected'] },
  { field: 'tip', headers: ['Tip', 'Tips', 'Tips Collected'] },
  { field: 'total_collected', headers: ['Total Collected', 'Total Money Collected', 'Total'] },
  { field: 'fees', headers: ['Fees', 'Fee', 'Square Fees', 'Processing Fees'] },
  {
    field: 'net_total',
    headers: [
      'Net Total',
      'Net Amount',
      'Total Transferred',
      'Transfer Total',
      'Payout Amount',
      'Net',
    ],
  },
]);

/** Headers that identify the per-payment Transactions CSV, which is the wrong file. */
const TRANSACTIONS_CSV_MARKERS = Object.freeze(['Transaction ID', 'Payment ID']);

const HEADER_TO_FIELD: ReadonlyMap<string, SquareField> = (() => {
  const map = new Map<string, SquareField>();
  for (const alias of COLUMN_ALIASES) {
    for (const header of alias.headers) {
      const key = normalizeHeaderKey(header);
      if (!map.has(key)) map.set(key, alias.field);
    }
  }
  return map;
})();

const CANONICAL_HEADER: Readonly<Record<SquareField, string>> = (() => {
  const record: Partial<Record<SquareField, string>> = { other: 'Unrecognised money column' };
  for (const alias of COLUMN_ALIASES) record[alias.field] = alias.headers[0];
  return Object.freeze(record as Record<SquareField, string>);
})();

function normalizeHeaderKey(header: string): string {
  return header
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

// ---------------------------------------------------------------------------
// Parsed shapes
// ---------------------------------------------------------------------------

/** One money bucket of one settlement, aggregated over the settlement's rows. */
export interface SquareSettlementLine {
  component: SquareComponent;
  /** The file header the amount came from, verbatim. `other` keeps its own. */
  label: string;
  accountRole: SquareAccountRole;
  /** Integer cents, as the file states it (money-out components are negative). */
  amountCents: number;
  /** 0-based indexes of the data rows that contributed. */
  rowIndexes: number[];
  /** `sha256(settlementKey ␟ component ␟ label ␟ amountCents ␟ ordinal)`. */
  fingerprint: string;
}

export interface SquareSettlement {
  /** The idempotency container key. `x:<id>` when the file carries one. */
  key: string;
  settlementId: string | null;
  /** The settlement's own date, `YYYY-MM-DD`. */
  date: CalendarDate;
  currency: string;
  /** The file's `Settlement Type` token, unmapped. */
  type: string | null;
  description: string | null;
  /** `SQ` + `YYMMDD` of `date` — how Relay stamps the deposit. */
  bankReference: string;
  lines: SquareSettlementLine[];
  /** Every component, zero when the file did not carry the column. */
  componentCents: Readonly<Record<SquareComponent, number>>;
  /** `Net Sales` as the file states it; `null` when the column is absent. */
  netSalesCents: number | null;
  /** `Total Collected` as stated; `null` when absent. */
  totalCollectedCents: number | null;
  /** Σ `Net Total` over the settlement's rows — what should reach the bank. */
  reportedNetCents: number;
  rowIndexes: number[];
  warnings: SquareWarning[];
}

export interface SquareParseOptions {
  /**
   * The file states money-out components (`Returns`, `Partial Refunds`,
   * `Discounts & Comps`, `Fees`) as positive magnitudes rather than negatives.
   * Set only after `assertSettlementBalances` has reported
   * `ties_if_outflows_negated` against a real export — never as a guess.
   */
  outflowsArePositive?: boolean;
  /** Preamble rows discarded before the header. */
  skipRows?: number;
  /** 0-based index of the header row, counted after `skipRows`. */
  headerRow?: number;
  /** Used when the file carries no currency column. */
  defaultCurrency?: string;
}

export interface SquareUnmappedColumn {
  header: string;
  /** Rows with a non-empty value in this column. */
  count: number;
  amountCents: number;
}

export interface SquareParseResult {
  importerId: string;
  filename: string;
  fileHash: string;
  headers: string[];
  /** Resolved role → the header that filled it. */
  fields: Partial<Record<SquareField, string>>;
  /** Canonical columns the file did not carry. */
  absentColumns: SquareField[];
  unmappedColumns: SquareUnmappedColumn[];
  settlements: SquareSettlement[];
  /** Physical data rows seen. */
  rowCount: number;
  skipped: SquareSkippedRow[];
  warnings: SquareWarning[];
}

/** Raised when the file cannot be read as a Square settlement export at all. */
export class SquareFormatError extends Error {
  readonly code: string;
  readonly remedy: string;

  constructor(code: string, message: string, remedy: string) {
    super(message);
    this.name = 'SquareFormatError';
    this.code = code;
    this.remedy = remedy;
  }
}

/** Raised when a draft entry is requested for a settlement that does not tie. */
export class SquareSettlementNotBalancedError extends Error {
  readonly report: SettlementBalanceReport;

  constructor(report: SettlementBalanceReport) {
    super(report.message);
    this.name = 'SquareSettlementNotBalancedError';
    this.report = report;
  }
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

export interface SquareRejection {
  code: string;
  message: string;
  remedy: string;
}

export interface SquareDetectionResult {
  importerId: string;
  /** True when the file can be parsed as a settlement export. */
  ok: boolean;
  /** 0..1 over the whole detection. >= 0.90 auto-selects. */
  confidence: number;
  /** Human-readable, strongest first. Logged with every import. */
  reasons: string[];
  headers: string[];
  fields: Partial<Record<SquareField, string>>;
  /** Set when the file is recognised but must not be imported. */
  rejection?: SquareRejection;
  warnings: SquareWarning[];
}

/**
 * Decides whether a file is a Square settlement export.
 *
 * Detection is the right place to reject a recognisable-but-wrong file. The
 * per-payment Transactions CSV parses perfectly well and produces a confidently
 * wrong answer — it is organised by sale, not by settlement, so it carries no
 * payout total to assert against. It is rejected here, by name, with the path to
 * the right export.
 */
export function detectSquareSettlements(
  file: ParsedFile,
  options: Pick<SquareParseOptions, 'skipRows' | 'headerRow'> = {},
): SquareDetectionResult {
  const warnings: SquareWarning[] = [];
  const { headers, rows } = readRawRows(file, {
    skipRows: options.skipRows,
    headerRow: options.headerRow,
  });

  const base: Omit<SquareDetectionResult, 'ok' | 'confidence' | 'reasons'> = {
    importerId: SQUARE_IMPORTER_ID,
    headers,
    fields: {},
    warnings,
  };

  if (headers.length === 0) {
    warnings.push({
      severity: 'fatal',
      code: 'file.empty',
      message: 'The file has no header row.',
    });
    return { ...base, ok: false, confidence: 0, reasons: ['no header row'] };
  }

  const resolution = resolveColumns(headers, rows);
  const fields = resolution.fields;
  const reasons: string[] = [];

  const headerKeys = new Set(headers.map(normalizeHeaderKey));
  const transactionsMarkers = TRANSACTIONS_CSV_MARKERS.filter((marker) =>
    headerKeys.has(normalizeHeaderKey(marker)),
  );
  const perPayment = transactionsMarkers.length === TRANSACTIONS_CSV_MARKERS.length;

  // Per-payment rows are fine *if* the file says which payout each belongs to —
  // this parser groups and sums, so a transactions export carrying `Deposit ID`
  // is usable. Per-payment rows with no grouping column are not: there is no
  // payout total to assert against, and a file that cannot be asserted is a file
  // that cannot be trusted.
  if (perPayment && fields.settlement_id === undefined) {
    const rejection: SquareRejection = {
      code: 'square.wrong_report.transactions_csv',
      message:
        'This is the Square Transactions CSV — one row per payment, with no column saying which ' +
        'payout each payment belongs to, so no payout total can be checked against the bank.',
      remedy:
        'Export the Transfers report (Dashboard → Banking → View all transfers → Export) or the ' +
        'Reconciliation report, which group payments into the payout that reaches the bank. A ' +
        'transactions export that does carry Deposit ID is accepted and grouped on it.',
    };
    warnings.push({
      severity: 'fatal',
      code: 'file.wrong_report',
      message: `${rejection.message} ${rejection.remedy}`,
    });
    return {
      ...base,
      fields,
      ok: false,
      confidence: 0.95,
      reasons: [`headers ${transactionsMarkers.join(' + ')} with no settlement grouping column`],
      rejection,
    };
  }

  const componentsFound = SQUARE_COMPONENTS.filter(
    (component) => component !== 'other' && fields[component] !== undefined,
  );

  if (fields.settlement_date === undefined || fields.net_total === undefined) {
    const missing = [
      fields.settlement_date === undefined ? CANONICAL_HEADER.settlement_date : null,
      fields.net_total === undefined ? CANONICAL_HEADER.net_total : null,
    ].filter((name): name is string => name !== null);

    const rejection: SquareRejection = {
      code: 'square.missing_required_columns',
      message: `A Square settlement export needs ${missing.join(' and ')}; this file has neither spelling of ${missing.length === 1 ? 'it' : 'them'}.`,
      remedy:
        'Re-export with the gear icon set to "Export all columns in your view" — a column-subset ' +
        'export drops the columns the payout identity is checked against.',
    };
    warnings.push({
      severity: 'fatal',
      code: 'header.missing_required',
      message: `${rejection.message} ${rejection.remedy}`,
    });
    return {
      ...base,
      fields,
      ok: false,
      confidence: componentsFound.length >= 3 ? 0.55 : 0.1,
      reasons: [`missing required column(s): ${missing.join(', ')}`],
      rejection,
    };
  }

  reasons.push(
    `date column "${fields.settlement_date}" and payout total column "${fields.net_total}" both present`,
  );
  if (componentsFound.length > 0) {
    reasons.push(
      `${componentsFound.length} Square money column(s) recognised: ${componentsFound
        .map((component) => fields[component])
        .join(', ')}`,
    );
  }
  if (fields.settlement_id !== undefined) {
    reasons.push(`settlement id column "${fields.settlement_id}" gives an exact container key`);
  }
  if (perPayment) {
    reasons.push(
      `per-payment rows (${transactionsMarkers.join(' + ')}) grouped on "${fields.settlement_id}"`,
    );
  }
  if (rows.length === 0) {
    warnings.push({
      severity: 'warn',
      code: 'file.no_data_rows',
      message: 'The file has a header but no data rows.',
    });
    reasons.push('header only, no data rows');
  }

  // Two required columns alone is a weak signal; the money columns are what make
  // it recognisably Square rather than any spreadsheet with a date and a total.
  const confidence = Math.min(
    0.99,
    0.5 + 0.06 * componentsFound.length + (fields.settlement_id !== undefined ? 0.1 : 0),
  );

  return { ...base, fields, ok: true, confidence, reasons };
}

// ---------------------------------------------------------------------------
// Column resolution
// ---------------------------------------------------------------------------

interface ResolvedColumn {
  field: SquareField;
  header: string;
  index: number;
}

interface ColumnResolution {
  fields: Partial<Record<SquareField, string>>;
  columns: ResolvedColumn[];
  unmapped: SquareUnmappedColumn[];
  warnings: SquareWarning[];
}

/** A column whose cells are amounts: a component, or one of the derived totals. */
type MoneyField = SquareComponent | 'net_sales' | 'total_collected' | 'net_total';

interface MoneyColumn {
  field: MoneyField;
  header: string;
  index: number;
}

const MONEY_FIELDS: ReadonlySet<string> = new Set<string>([
  ...SQUARE_COMPONENTS,
  'net_sales',
  'total_collected',
  'net_total',
]);

function isMoneyField(field: SquareField): field is MoneyField {
  return MONEY_FIELDS.has(field);
}

/** `true` when every non-empty cell parses as money and at least one looks it. */
function looksLikeMoneyColumn(rows: readonly RawRow[], index: number): boolean {
  let seen = 0;
  let monetary = 0;

  for (const row of rows) {
    const cell = (row.cells[index] ?? '').trim();
    if (cell === '') continue;
    seen += 1;
    try {
      parseMoney(cell);
    } catch {
      return false;
    }
    // A bare integer run is a count, not an amount. Require a decimal point, a
    // currency mark, or an explicit sign somewhere in the column.
    if (/[.$()]/.test(cell) || /^[+-]/.test(cell) || /-$/.test(cell)) monetary += 1;
  }

  return seen > 0 && monetary > 0;
}

function resolveColumns(headers: readonly string[], rows: readonly RawRow[]): ColumnResolution {
  const fields: Partial<Record<SquareField, string>> = {};
  const columns: ResolvedColumn[] = [];
  const unmapped: SquareUnmappedColumn[] = [];
  const warnings: SquareWarning[] = [];

  headers.forEach((header, index) => {
    if (header === '') return;
    const field = HEADER_TO_FIELD.get(normalizeHeaderKey(header));

    if (field === undefined) {
      if (!looksLikeMoneyColumn(rows, index)) return;

      let count = 0;
      let amountCents = 0;
      for (const row of rows) {
        const cell = (row.cells[index] ?? '').trim();
        if (cell === '') continue;
        count += 1;
        amountCents += parseMoney(cell);
      }

      unmapped.push({ header, count, amountCents });
      columns.push({ field: 'other', header, index });
      warnings.push({
        severity: 'warn',
        code: 'header.unknown_money_column',
        field: header,
        message:
          `Column "${header}" holds money but is not part of the documented Square column set. ` +
          `Its ${formatMoney(amountCents)} is kept as an unmapped component and routed to review ` +
          'rather than dropped — dropping it would break the payout identity.',
      });
      return;
    }

    if (fields[field] !== undefined) {
      warnings.push({
        severity: 'warn',
        code: 'header.duplicate_role',
        field: header,
        message:
          `Columns "${fields[field]}" and "${header}" both read as ${CANONICAL_HEADER[field]}. ` +
          `"${fields[field]}" is used; "${header}" is ignored.`,
      });
      return;
    }

    fields[field] = header;
    columns.push({ field, header, index });
  });

  return { fields, columns, unmapped, warnings };
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function emptyComponents(): Record<SquareComponent, number> {
  return {
    gross_sales: 0,
    returns: 0,
    partial_refunds: 0,
    discounts: 0,
    service_charges: 0,
    gift_card_sales: 0,
    tax: 0,
    tip: 0,
    fees: 0,
    other: 0,
  };
}

interface SettlementAccumulator {
  settlementId: string | null;
  date: CalendarDate;
  currency: string;
  type: string | null;
  description: string | null;
  componentCents: Record<SquareComponent, number>;
  /** Component → the headers that fed it, and the rows they came from. */
  lineRows: Map<string, { component: SquareComponent; rowIndexes: number[]; amountCents: number }>;
  netSalesCents: number | null;
  totalCollectedCents: number | null;
  reportedNetCents: number;
  rowIndexes: number[];
  warnings: SquareWarning[];
}

/**
 * Parses a Square settlement export into settlements.
 *
 * Never throws for a data reason — a bad row is skipped with a counted reason
 * and the rest of the file still parses. It throws `SquareFormatError` only
 * when the file is not a settlement export at all, because parsing on would
 * produce a confidently wrong answer rather than a reported one.
 *
 * Because this importer asserts a control total, a skipped row is not a
 * tolerable loss: it is proof the parse is incomplete. `previewSquareSettlements`
 * refuses the file when `skipped` is non-empty.
 */
export function parseSquareSettlements(
  file: ParsedFile,
  options: SquareParseOptions = {},
): SquareParseResult {
  const detection = detectSquareSettlements(file, options);
  if (!detection.ok) {
    const rejection = detection.rejection ?? {
      code: 'square.unreadable',
      message: 'The file is not a Square settlement export.',
      remedy: 'Export the Transfers or Reconciliation report from the Square Dashboard.',
    };
    throw new SquareFormatError(rejection.code, rejection.message, rejection.remedy);
  }

  const defaultCurrency = options.defaultCurrency ?? 'USD';
  const outflowsArePositive = options.outflowsArePositive ?? false;

  const { headers, rows } = readRawRows(file, {
    skipRows: options.skipRows,
    headerRow: options.headerRow,
  });
  const resolution = resolveColumns(headers, rows);
  const warnings: SquareWarning[] = [...detection.warnings, ...resolution.warnings];
  const skipped: SquareSkippedRow[] = [];

  const absentColumns = (Object.keys(CANONICAL_HEADER) as SquareField[]).filter(
    (field) => field !== 'other' && resolution.fields[field] === undefined,
  );
  for (const field of absentColumns) {
    warnings.push({
      severity: 'info',
      code: 'header.column_absent',
      field: CANONICAL_HEADER[field],
      message:
        `The file carries no ${CANONICAL_HEADER[field]} column. It contributes nothing rather ` +
        'than zero-by-accident, and the identities that need it are not checked.',
    });
  }

  const moneyColumns: MoneyColumn[] = [];
  for (const column of resolution.columns) {
    if (!isMoneyField(column.field)) continue;
    moneyColumns.push({ field: column.field, header: column.header, index: column.index });
  }

  const dateHeader = resolution.fields.settlement_date;
  const accumulators = new Map<string, SettlementAccumulator>();
  const order: string[] = [];

  for (const row of rows) {
    const rawDate = dateHeader === undefined ? '' : (row.record[dateHeader] ?? '').trim();
    if (rawDate === '') {
      skipped.push({
        rowIndex: row.rowIndex,
        physicalRow: row.physicalRow,
        code: 'date.missing',
        reason: `Row ${row.physicalRow + 1} has no ${CANONICAL_HEADER.settlement_date}.`,
        cells: row.cells,
      });
      continue;
    }

    let date: CalendarDate;
    try {
      date = parseDateInput(stripTime(rawDate));
    } catch {
      skipped.push({
        rowIndex: row.rowIndex,
        physicalRow: row.physicalRow,
        code: 'date.unparsable',
        reason: `Row ${row.physicalRow + 1}: cannot read "${rawDate}" as a date.`,
        cells: row.cells,
      });
      continue;
    }

    const rowWarnings: SquareWarning[] = [];
    const amounts = new Map<MoneyColumn, number>();
    let sawAmount = false;
    let unparsable = false;

    for (const column of moneyColumns) {
      const cell = (row.cells[column.index] ?? '').trim();
      if (cell === '') continue;
      let cents: number;
      try {
        cents = parseMoney(cell);
      } catch {
        unparsable = true;
        rowWarnings.push({
          severity: 'error',
          code: 'amount.unparsable',
          rowIndex: row.rowIndex,
          field: column.header,
          value: cell,
          message: `Row ${row.physicalRow + 1}: cannot read "${cell}" in ${column.header} as money.`,
        });
        break;
      }
      amounts.set(column, cents);
      if (cents !== 0) sawAmount = true;
    }

    if (unparsable) {
      const reason = rowWarnings[rowWarnings.length - 1]?.message ?? 'unparsable amount';
      skipped.push({
        rowIndex: row.rowIndex,
        physicalRow: row.physicalRow,
        code: 'amount.unparsable',
        reason,
        cells: row.cells,
      });
      continue;
    }

    if (!sawAmount) {
      skipped.push({
        rowIndex: row.rowIndex,
        physicalRow: row.physicalRow,
        code: 'row.no_amounts',
        reason: `Row ${row.physicalRow + 1} carries no money in any recognised column.`,
        cells: row.cells,
      });
      continue;
    }

    const currency = readCell(row, resolution.fields.currency)?.toUpperCase() ?? defaultCurrency;
    const settlementId = readCell(row, resolution.fields.settlement_id);
    const groupKey =
      settlementId !== null ? `id:${settlementId}` : `date:${date}|${currency}`;

    let acc = accumulators.get(groupKey);
    if (acc === undefined) {
      acc = {
        settlementId,
        date,
        currency,
        type: readCell(row, resolution.fields.settlement_type),
        description: readCell(row, resolution.fields.description),
        componentCents: emptyComponents(),
        lineRows: new Map(),
        netSalesCents: null,
        totalCollectedCents: null,
        reportedNetCents: 0,
        rowIndexes: [],
        warnings: [],
      };
      accumulators.set(groupKey, acc);
      order.push(groupKey);
    } else if (date < acc.date) {
      // A settlement id spanning dates keeps its earliest; the bank code comes
      // from the deposit side and the match window covers the difference.
      acc.date = date;
    }

    acc.rowIndexes.push(row.rowIndex);
    acc.warnings.push(...rowWarnings);

    for (const [column, rawCents] of amounts) {
      if (column.field === 'net_sales') {
        acc.netSalesCents = (acc.netSalesCents ?? 0) + rawCents;
        continue;
      }
      if (column.field === 'total_collected') {
        acc.totalCollectedCents = (acc.totalCollectedCents ?? 0) + rawCents;
        continue;
      }
      if (column.field === 'net_total') {
        acc.reportedNetCents += rawCents;
        continue;
      }

      const component = column.field;
      const cents = normalizeOutflow(component, rawCents, outflowsArePositive);
      acc.componentCents[component] += cents;

      const lineKey = `${component}${SEP}${column.header}`;
      const line = acc.lineRows.get(lineKey);
      if (line === undefined) {
        acc.lineRows.set(lineKey, {
          component,
          rowIndexes: [row.rowIndex],
          amountCents: cents,
        });
      } else {
        line.rowIndexes.push(row.rowIndex);
        line.amountCents += cents;
      }
    }
  }

  const settlements: SquareSettlement[] = order.map((groupKey) => {
    const acc = accumulators.get(groupKey);
    /* c8 ignore next */
    if (acc === undefined) throw new Error(`square: lost accumulator for ${groupKey}`);

    const key = settlementKey(acc.settlementId, acc.currency, acc.date, acc.reportedNetCents);
    const lines: SquareSettlementLine[] = [];
    let ordinal = 0;
    for (const [lineKey, line] of acc.lineRows) {
      const label = lineKey.slice(lineKey.indexOf(SEP) + 1);
      lines.push({
        component: line.component,
        label,
        accountRole: SQUARE_COMPONENT_ACCOUNT_ROLE[line.component],
        amountCents: line.amountCents,
        rowIndexes: [...line.rowIndexes],
        fingerprint: lineFingerprint(key, line.component, label, line.amountCents, ordinal),
      });
      ordinal += 1;
    }

    if (acc.componentCents.other !== 0) {
      acc.warnings.push({
        severity: 'warn',
        code: 'settlement.unmapped_component',
        message:
          `Settlement ${squareBankReference(acc.date)} carries ${formatMoney(acc.componentCents.other)} ` +
          'in unrecognised money columns. It is held for review, not guessed.',
      });
    }

    return {
      key,
      settlementId: acc.settlementId,
      date: acc.date,
      currency: acc.currency,
      type: acc.type,
      description: acc.description,
      bankReference: squareBankReference(acc.date),
      lines,
      componentCents: Object.freeze({ ...acc.componentCents }),
      netSalesCents: acc.netSalesCents,
      totalCollectedCents: acc.totalCollectedCents,
      reportedNetCents: acc.reportedNetCents,
      rowIndexes: [...acc.rowIndexes],
      warnings: acc.warnings,
    };
  });

  for (const row of skipped) {
    warnings.push({
      severity: SQUARE_BLOCKING_SKIP_CODES.includes(row.code) ? 'error' : 'info',
      code: row.code,
      rowIndex: row.rowIndex,
      message: row.reason,
    });
  }

  return {
    importerId: SQUARE_IMPORTER_ID,
    filename: file.filename,
    fileHash: file.sha256,
    headers,
    fields: resolution.fields,
    absentColumns,
    unmappedColumns: resolution.unmapped,
    settlements,
    rowCount: rows.length,
    skipped,
    warnings,
  };
}

function readCell(row: RawRow, header: string | undefined): string | null {
  if (header === undefined) return null;
  const value = (row.record[header] ?? '').trim();
  return value === '' ? null : value;
}

/** Drops a clock from a timestamp cell; a ledger only ever wants the date. */
function stripTime(value: string): string {
  return value.replace(/[T ]\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/, '').trim();
}

function normalizeOutflow(
  component: SquareComponent,
  cents: number,
  outflowsArePositive: boolean,
): number {
  if (!outflowsArePositive) return cents;
  if (!SQUARE_OUTFLOW_COMPONENTS.includes(component)) return cents;
  return cents === 0 ? 0 : -Math.abs(cents);
}

// ---------------------------------------------------------------------------
// Fingerprints
// ---------------------------------------------------------------------------

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * The settlement's idempotency container key.
 *
 * A settled payout is immutable: its component set never changes once the money
 * has moved. That makes re-importing an overlapping range free and silent, and
 * removes the occurrence-index machinery the bank importer needs.
 */
export function settlementKey(
  settlementId: string | null,
  currency: string,
  date: CalendarDate,
  netTotalCents: number,
): string {
  if (settlementId !== null && settlementId !== '') return `x:${settlementId}`;
  return sha256(['square', currency.toUpperCase(), date, String(netTotalCents)].join(SEP));
}

function lineFingerprint(
  key: string,
  component: SquareComponent,
  label: string,
  amountCents: number,
  ordinal: number,
): string {
  return sha256([key, component, label, String(amountCents), String(ordinal)].join(SEP));
}

// ---------------------------------------------------------------------------
// The identity
// ---------------------------------------------------------------------------

/**
 * A settlement's own arithmetic identity, checked before anything is believed.
 *
 * Field for field the shape of `Assertion` in `./types`, so the import UI can
 * render Relay's balance chain and Square's payout tie-out through one
 * component. It is declared here rather than imported because a settlement
 * importer does not otherwise fit that module's `Importer<TRow extends
 * ImportableRow>` contract: a payout is not a bank transaction, it has no bank
 * account, and its identity is a tie-out rather than a running balance.
 */
export interface SquareAssertion {
  /** Stable and machine-readable. The UI groups on these. */
  id: 'square.net_sales' | 'square.total_collected' | 'square.net_total';
  label: string;
  severity: 'fatal' | 'warn';
  passed: boolean;
  /** What the file states. */
  expectedCents: number;
  /** What the components compute. */
  actualCents: number;
  /** `actual − expected`. Zero, or the settlement does not tie. */
  differenceCents: number;
  detail: string;
}

/**
 * Why a settlement failed, not merely that it did.
 *
 * `ties_if_outflows_negated` is the one this format most expects to see the
 * first time a real export is run: the sign convention in
 * `docs/formats/square.md` §6 is corroborated, not verified, and this is how the
 * file itself tells us we got it wrong.
 */
export type SettlementDiagnosis =
  | 'ties'
  | 'ties_if_outflows_negated'
  | 'ties_without_unmapped'
  | 'off_by';

export interface SettlementBalanceReport {
  settlementKey: string;
  bankReference: string;
  date: CalendarDate;
  /** True when every `fatal` assertion passed. */
  ok: boolean;
  diagnosis: SettlementDiagnosis;
  /** The fatal identity's `actual − expected`. Zero when `ok`. */
  differenceCents: number;
  assertions: SquareAssertion[];
  /** The rejection a bookkeeper reads. */
  message: string;
}

/**
 * Asserts a settlement's own arithmetic, to the cent, with no tolerance.
 *
 *   (A) Net Sales       = Gross Sales + Returns + Discounts & Comps + Service Charges
 *   (B) Total Collected = Net Sales + Gift Card Sales + Tax + Tip + Partial Refunds
 *   (C) Net Total       = Total Collected + Fees
 *
 * (A) and (B) are `warn` — a file that omits `Net Sales` or `Total Collected`
 * simply cannot run them. **(C) is `fatal`**: it decides how much money the
 * payout delivers to the bank, and it is checkable whenever the component
 * columns exist. Nothing posts until (C) passes.
 *
 * Unmapped money columns are included in (C) rather than dropped. A dropped row
 * or column breaks the payout total, which is the only proof the parse was
 * complete — so when (C) fails, the report says whether it would tie without
 * them.
 */
export function assertSettlementBalances(settlement: SquareSettlement): SettlementBalanceReport {
  const c = settlement.componentCents;
  const assertions: SquareAssertion[] = [];

  const netSalesComputed = sumCents([c.gross_sales, c.returns, c.discounts, c.service_charges]);
  if (settlement.netSalesCents !== null) {
    const difference = netSalesComputed - settlement.netSalesCents;
    assertions.push({
      id: 'square.net_sales',
      label: 'Net Sales = Gross Sales + Returns + Discounts & Comps + Service Charges',
      severity: 'warn',
      passed: difference === 0,
      expectedCents: settlement.netSalesCents,
      actualCents: netSalesComputed,
      differenceCents: difference,
      detail:
        `components compute ${formatMoney(netSalesComputed)}; the file states ` +
        `${formatMoney(settlement.netSalesCents)}`,
    });
  }

  const totalCollectedComputed = sumCents([
    netSalesComputed,
    c.gift_card_sales,
    c.tax,
    c.tip,
    c.partial_refunds,
  ]);
  if (settlement.totalCollectedCents !== null) {
    const difference = totalCollectedComputed - settlement.totalCollectedCents;
    assertions.push({
      id: 'square.total_collected',
      label: 'Total Collected = Net Sales + Gift Card Sales + Tax + Tip + Partial Refunds',
      severity: 'warn',
      passed: difference === 0,
      expectedCents: settlement.totalCollectedCents,
      actualCents: totalCollectedComputed,
      differenceCents: difference,
      detail:
        `components compute ${formatMoney(totalCollectedComputed)}; the file states ` +
        `${formatMoney(settlement.totalCollectedCents)}`,
    });
  }

  const netTotalComputed = sumCents([totalCollectedComputed, c.fees, c.other]);
  const netDifference = netTotalComputed - settlement.reportedNetCents;
  assertions.push({
    id: 'square.net_total',
    label: 'Net Total = Total Collected + Fees',
    severity: 'fatal',
    passed: netDifference === 0,
    expectedCents: settlement.reportedNetCents,
    actualCents: netTotalComputed,
    differenceCents: netDifference,
    detail:
      `components compute ${formatMoney(netTotalComputed)}; the file states ` +
      `${formatMoney(settlement.reportedNetCents)}`,
  });

  const ok = netDifference === 0;
  const diagnosis = ok ? 'ties' : diagnose(settlement, netTotalComputed);

  return {
    settlementKey: settlement.key,
    bankReference: settlement.bankReference,
    date: settlement.date,
    ok,
    diagnosis,
    differenceCents: ok ? 0 : netDifference,
    assertions,
    message: balanceMessage(settlement, ok, diagnosis, netDifference, netTotalComputed),
  };
}

function diagnose(settlement: SquareSettlement, netTotalComputed: number): SettlementDiagnosis {
  const c = settlement.componentCents;

  const negated = sumCents([
    c.gross_sales,
    -Math.abs(c.returns),
    -Math.abs(c.discounts),
    c.service_charges,
    c.gift_card_sales,
    c.tax,
    c.tip,
    -Math.abs(c.partial_refunds),
    -Math.abs(c.fees),
    c.other,
  ]);
  if (negated === settlement.reportedNetCents) return 'ties_if_outflows_negated';

  if (c.other !== 0 && netTotalComputed - c.other === settlement.reportedNetCents) {
    return 'ties_without_unmapped';
  }

  return 'off_by';
}

function balanceMessage(
  settlement: SquareSettlement,
  ok: boolean,
  diagnosis: SettlementDiagnosis,
  differenceCents: number,
  netTotalComputed: number,
): string {
  if (ok) {
    return `Settlement ${settlement.bankReference} ties: ${formatMoney(settlement.reportedNetCents)}.`;
  }

  const head =
    `Settlement ${settlement.bankReference} (${settlement.date}) does not tie. Its components ` +
    `compute ${formatMoney(netTotalComputed)} but the file reports a payout of ` +
    `${formatMoney(settlement.reportedNetCents)} — a difference of ${formatMoney(differenceCents)}.`;

  switch (diagnosis) {
    case 'ties_if_outflows_negated':
      return (
        `${head} It ties exactly when Returns, Partial Refunds, Discounts & Comps and Fees are ` +
        'treated as outflows, so this file states money-out components as positive magnitudes. ' +
        'Re-parse with outflowsArePositive: true and correct docs/formats/square.md §4a and §6.'
      );
    case 'ties_without_unmapped':
      return (
        `${head} It ties exactly when the unrecognised money column(s) worth ` +
        `${formatMoney(settlement.componentCents.other)} are excluded, so those columns are ` +
        'derived or duplicated rather than a component. Add them to the alias table in ' +
        'src/lib/importers/square.ts as derived columns.'
      );
    default:
      return (
        `${head} Neither an inverted sign convention nor the unmapped columns explain it. The ` +
        'usual causes are a column-subset export, a date range that bisects the payout, or an ' +
        'edited file. Quarantine it and re-export whole payouts — never plug the difference.'
      );
  }
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

export interface SquarePreviewComponent {
  component: SquareComponent;
  accountRole: SquareAccountRole;
  /** Settlements that carried a non-zero amount for this component. */
  count: number;
  amountCents: number;
}

export interface SquarePreviewSettlement {
  key: string;
  settlementId: string | null;
  date: CalendarDate;
  bankReference: string;
  netTotalCents: number;
  ok: boolean;
  diagnosis: SettlementDiagnosis;
  differenceCents: number;
}

export interface SquarePreview {
  importerId: string;
  filename: string;
  fileHash: string;
  settlementCount: number;
  rowCount: number;
  dateRange: { min: CalendarDate; max: CalendarDate } | null;
  /** Σ of the settlements' reported payout totals — what should reach the bank. */
  netTotalCents: number;
  byComponent: SquarePreviewComponent[];
  settlements: SquarePreviewSettlement[];
  assertions: SquareAssertion[];
  failedSettlements: number;
  absentColumns: string[];
  unmappedColumns: SquareUnmappedColumn[];
  /** Settlements that must not post without a human: failed, or carrying `other`. */
  needsReview: number;
  skippedRows: number;
  /** Skips that prove the parse is incomplete (`SQUARE_BLOCKING_SKIP_CODES`). */
  blockingSkippedRows: number;
  warnings: SquareWarning[];
  /** False blocks posting: a failed identity, a blocking skip, or nothing to post. */
  ok: boolean;
}

/**
 * What the import screen shows before anything posts.
 *
 * `ok` is false when any settlement fails its fatal identity **or any row was
 * skipped**. The second half matters: in an importer that asserts a control
 * total, a dropped row is not a tolerable loss, it is proof the parse is wrong.
 */
export function previewSquareSettlements(parsed: SquareParseResult): SquarePreview {
  const reports = parsed.settlements.map(assertSettlementBalances);
  const assertions = reports.flatMap((report) => report.assertions);

  const totals = emptyComponents();
  const counts = emptyComponents();
  for (const settlement of parsed.settlements) {
    for (const component of SQUARE_COMPONENTS) {
      const cents = settlement.componentCents[component];
      totals[component] += cents;
      if (cents !== 0) counts[component] += 1;
    }
  }

  const dates = parsed.settlements.map((settlement) => settlement.date).sort();
  const failedSettlements = reports.filter((report) => !report.ok).length;
  const needsReview = parsed.settlements.filter(
    (settlement, index) =>
      settlement.componentCents.other !== 0 || !(reports[index]?.ok ?? false),
  ).length;

  const blockingSkippedRows = parsed.skipped.filter((row) =>
    SQUARE_BLOCKING_SKIP_CODES.includes(row.code),
  ).length;

  const warnings: SquareWarning[] = [...parsed.warnings];
  for (const report of reports) {
    if (report.ok) continue;
    warnings.push({
      severity: 'fatal',
      code: 'settlement.identity_failed',
      message: report.message,
    });
    if (report.diagnosis === 'ties_if_outflows_negated') {
      warnings.push({
        severity: 'fatal',
        code: 'settlement.outflow_sign',
        message:
          `Settlement ${report.bankReference} states money-out components as positive magnitudes. ` +
          'The whole file is probably written that way; re-parse it with outflowsArePositive: true.',
      });
    }
  }

  return {
    importerId: SQUARE_IMPORTER_ID,
    filename: parsed.filename,
    fileHash: parsed.fileHash,
    settlementCount: parsed.settlements.length,
    rowCount: parsed.rowCount,
    dateRange:
      dates.length === 0
        ? null
        : { min: dates[0] as CalendarDate, max: dates[dates.length - 1] as CalendarDate },
    netTotalCents: sumCents(parsed.settlements.map((settlement) => settlement.reportedNetCents)),
    byComponent: SQUARE_COMPONENTS.filter(
      (component) => totals[component] !== 0 || counts[component] !== 0,
    ).map((component) => ({
      component,
      accountRole: SQUARE_COMPONENT_ACCOUNT_ROLE[component],
      count: counts[component],
      amountCents: totals[component],
    })),
    settlements: parsed.settlements.map((settlement, index) => {
      const report = reports[index];
      return {
        key: settlement.key,
        settlementId: settlement.settlementId,
        date: settlement.date,
        bankReference: settlement.bankReference,
        netTotalCents: settlement.reportedNetCents,
        ok: report?.ok ?? false,
        diagnosis: report?.diagnosis ?? 'off_by',
        differenceCents: report?.differenceCents ?? 0,
      };
    }),
    assertions,
    failedSettlements,
    absentColumns: parsed.absentColumns.map((field) => CANONICAL_HEADER[field]),
    unmappedColumns: parsed.unmappedColumns,
    needsReview,
    skippedRows: parsed.skipped.length,
    blockingSkippedRows,
    warnings,
    ok: failedSettlements === 0 && blockingSkippedRows === 0 && parsed.settlements.length > 0,
  };
}

// ---------------------------------------------------------------------------
// The draft entry
// ---------------------------------------------------------------------------

export interface SquareDraftLine {
  accountRole: SquareAccountRole;
  /** Exactly one of `debitCents` / `creditCents` is non-zero. */
  debitCents: number;
  creditCents: number;
  memo: string;
  component: SquareComponent | 'net_total';
  /** The source line's fingerprint, so the posting is reversible line by line. */
  sourceFingerprint: string | null;
}

export interface SquareDraftEntry {
  date: CalendarDate;
  memo: string;
  sourceType: string;
  /** The settlement's container key. */
  sourceRef: string;
  bankReference: string;
  lines: SquareDraftLine[];
  totalDebitsCents: number;
  totalCreditsCents: number;
}

/**
 * The gross decomposition, as a balanced draft against Square Clearing.
 *
 * The clearing debit is the payout's net total — exactly what the bank will
 * deposit — so once the Relay deposits post their side, Square Clearing stands
 * at zero for this payout. That zero is the proof nothing was dropped.
 *
 * Throws when the settlement does not tie. Calling this on an untied settlement
 * is a pipeline error, not a data error: `assertSettlementBalances` is the gate.
 */
export function buildSquareClearingEntry(settlement: SquareSettlement): SquareDraftEntry {
  const report = assertSettlementBalances(settlement);
  if (!report.ok) throw new SquareSettlementNotBalancedError(report);

  const lines: SquareDraftLine[] = [];
  const lineByComponent = new Map<SquareComponent, SquareSettlementLine[]>();
  for (const line of settlement.lines) {
    const existing = lineByComponent.get(line.component);
    if (existing === undefined) lineByComponent.set(line.component, [line]);
    else existing.push(line);
  }

  const fingerprintOf = (component: SquareComponent): string | null => {
    const found = lineByComponent.get(component);
    return found === undefined || found.length !== 1 ? null : found[0]?.fingerprint ?? null;
  };

  if (settlement.reportedNetCents !== 0) {
    lines.push({
      accountRole: 'square_clearing',
      debitCents: Math.max(settlement.reportedNetCents, 0),
      creditCents: Math.max(-settlement.reportedNetCents, 0),
      memo: `Square payout ${settlement.bankReference}`,
      component: 'net_total',
      sourceFingerprint: null,
    });
  }

  for (const component of SQUARE_COMPONENTS) {
    const cents = settlement.componentCents[component];
    if (cents === 0) continue;

    // Money-in components credit; money-out components debit. The sign in the
    // file decides, so an unmapped `other` lands on whichever side it belongs.
    const isCredit = cents > 0;
    lines.push({
      accountRole: SQUARE_COMPONENT_ACCOUNT_ROLE[component],
      debitCents: isCredit ? 0 : -cents,
      creditCents: isCredit ? cents : 0,
      memo: `${CANONICAL_HEADER[component] ?? component} — ${settlement.bankReference}`,
      component,
      sourceFingerprint: fingerprintOf(component),
    });
  }

  const totalDebitsCents = sumCents(lines.map((line) => line.debitCents));
  const totalCreditsCents = sumCents(lines.map((line) => line.creditCents));
  if (totalDebitsCents !== totalCreditsCents) {
    /* c8 ignore next 4 */
    throw new Error(
      `square: draft entry for ${settlement.bankReference} does not balance — ` +
        `debits ${formatMoney(totalDebitsCents)} vs credits ${formatMoney(totalCreditsCents)}.`,
    );
  }

  return {
    date: settlement.date,
    memo: `Square settlement ${settlement.bankReference} (${settlement.currency} ${formatMoney(settlement.reportedNetCents)})`,
    sourceType: SQUARE_IMPORTER_ID,
    sourceRef: settlement.key,
    bankReference: settlement.bankReference,
    lines,
    totalDebitsCents,
    totalCreditsCents,
  };
}

// ---------------------------------------------------------------------------
// The bank link — SQ + YYMMDD
// ---------------------------------------------------------------------------

const SQ_CODE = /\bSQ(\d{6})\b/i;

/** `2026-01-26` → `SQ260126`, the reference Relay stamps on a Square deposit. */
export function squareBankReference(date: CalendarDate): string {
  if (!isCalendarDate(date)) {
    throw new Error(`squareBankReference: ${JSON.stringify(date)} is not a YYYY-MM-DD date.`);
  }
  return `SQ${date.slice(2, 4)}${date.slice(5, 7)}${date.slice(8, 10)}`;
}

/**
 * `SQ260126` → `2026-01-26`; anything else → `null`.
 *
 * The code is found anywhere in the reference, because a bank is free to wrap it
 * in its own text. The two-digit year expands to `20YY`: Relay did not exist in
 * 1926 and this ledger will not outlive 2099. Six digits that are not a real
 * calendar date (`SQ261332`) return `null` rather than a plausible wrong date.
 */
export function parseSquareBankReference(reference: string | null | undefined): CalendarDate | null {
  if (reference === null || reference === undefined) return null;
  const match = SQ_CODE.exec(reference);
  if (match === null) return null;

  const digits = match[1];
  /* c8 ignore next */
  if (digits === undefined) return null;

  const candidate = `20${digits.slice(0, 2)}-${digits.slice(2, 4)}-${digits.slice(4, 6)}`;
  return isCalendarDate(candidate) ? candidate : null;
}

export interface BankTransactionCandidate {
  /** `bank_transactions.id`, or any stable handle the caller can act on. */
  id: string;
  date: CalendarDate;
  /** Integer cents, signed from the company's point of view: positive = money in. */
  amountCents: number;
  reference: string | null;
  description?: string | null;
}

export interface SquarePayoutMatchInput {
  /** The settlement's container key, for the report. */
  key: string;
  /**
   * The date whose `YYMMDD` code the bank stamps — the transfer date when the
   * file carries one, otherwise the settlement date.
   */
  depositDate: CalendarDate;
  /** What the payout should deliver. Positive = money in, as everywhere else. */
  netCents: number;
}

export interface SquarePayoutMatchOptions {
  /**
   * Extra days after `depositDate` whose codes also count. Square's default
   * close of day is 5 PM PT and funds land the next business day, with nothing
   * sent on a Saturday, so a settlement's own date can trail its deposit by a
   * business day or more. Widening the window only adds candidates; the amount
   * stays exact. Default 5.
   */
  lagDays?: number;
  /** Above this, subsets are not enumerated and the result is `ambiguous`. Default 14. */
  maxSubsetCandidates?: number;
}

export type SquarePayoutMatchStatus = 'matched' | 'partial' | 'ambiguous' | 'unmatched';

export interface SquarePayoutMatch {
  status: SquarePayoutMatchStatus;
  /** `reference` = every coded candidate summed to the payout; `reference_subset` = one subset did. */
  matchedBy: 'reference' | 'reference_subset' | 'none';
  payoutKey: string;
  /** The primary code, `SQ` + `YYMMDD` of `depositDate`. */
  bankReference: string;
  /** Every code the window accepts, earliest first. */
  acceptedReferences: string[];
  expectedCents: number;
  matchedCents: number;
  /** `expected − matched`. Positive means money is still missing from the bank. */
  differenceCents: number;
  matched: BankTransactionCandidate[];
  /** Every candidate carrying an accepted code, on the right side of zero. */
  considered: BankTransactionCandidate[];
  /** Populated only when `ambiguous`: the competing exact subsets, capped at 5. */
  alternatives: BankTransactionCandidate[][];
  reason: string;
}

/**
 * Matches a Square payout to the bank rows that clear it.
 *
 * **One payout can arrive as several deposits.** On 2026-01-26 three separate
 * Relay rows carry the reference `SQ260126` — `+161.67`, `+3.25` and `+0.82`,
 * totalling the `165.74` of one Square batch. A matcher that stops at the first
 * row finds `161.67`, strands `4.07` in Square Clearing, and hands someone an
 * unexplained clearing balance to find six months later. So this matches sets:
 *
 *   1. Take every candidate whose reference carries an accepted `SQ` code and
 *      sits on the same side of zero as the payout.
 *   2. All of them sum to the payout → matched.
 *   3. Otherwise search subsets exhaustively for one that sums exactly. Exactly
 *      one → matched. More than one → `ambiguous`, and a human decides.
 *   4. None, and they sum to less → `partial`: a deposit is still in transit.
 *   5. None, and they sum to more → `unmatched`: two payouts have collided.
 *
 * The code is how candidates are found. Cents are how they are confirmed — the
 * amount is never approximate and there is no tolerance.
 */
export function matchSquarePayoutToBankTransaction(
  payout: SquarePayoutMatchInput,
  candidates: readonly BankTransactionCandidate[],
  options: SquarePayoutMatchOptions = {},
): SquarePayoutMatch {
  const lagDays = options.lagDays ?? 5;
  const maxSubsetCandidates = options.maxSubsetCandidates ?? 14;

  const acceptedReferences: string[] = [];
  for (let offset = 0; offset <= Math.max(lagDays, 0); offset += 1) {
    acceptedReferences.push(squareBankReference(addDays(payout.depositDate, offset)));
  }
  const acceptedSet = new Set(acceptedReferences);
  const bankReference = acceptedReferences[0] as string;

  const base = {
    payoutKey: payout.key,
    bankReference,
    acceptedReferences,
    expectedCents: payout.netCents,
    alternatives: [] as BankTransactionCandidate[][],
  };

  if (payout.netCents === 0) {
    return {
      ...base,
      status: 'unmatched',
      matchedBy: 'none',
      matchedCents: 0,
      differenceCents: 0,
      matched: [],
      considered: [],
      reason: 'The payout nets to zero, so no bank deposit is expected.',
    };
  }

  const wantPositive = payout.netCents > 0;
  const considered = candidates.filter((candidate) => {
    const code = parseSquareBankReference(candidate.reference);
    if (code === null) return false;
    if (!acceptedSet.has(squareBankReference(code))) return false;
    return wantPositive ? candidate.amountCents > 0 : candidate.amountCents < 0;
  });

  if (considered.length === 0) {
    return {
      ...base,
      status: 'unmatched',
      matchedBy: 'none',
      matchedCents: 0,
      differenceCents: payout.netCents,
      matched: [],
      considered,
      reason:
        `No bank row carries reference ${acceptedReferences.length === 1 ? bankReference : `${bankReference}…${acceptedReferences[acceptedReferences.length - 1]}`} ` +
        `for ${formatMoney(payout.netCents)}. Either the deposit has not landed or the payout was returned.`,
    };
  }

  const consideredTotal = sumCents(considered.map((candidate) => candidate.amountCents));

  if (consideredTotal === payout.netCents) {
    return {
      ...base,
      status: 'matched',
      matchedBy: 'reference',
      matchedCents: consideredTotal,
      differenceCents: 0,
      matched: considered,
      considered,
      reason:
        considered.length === 1
          ? `One deposit of ${formatMoney(consideredTotal)} carries ${bankReference}.`
          : `${considered.length} deposits carrying ${bankReference} total ${formatMoney(consideredTotal)}, exactly the payout.`,
    };
  }

  if (considered.length > maxSubsetCandidates) {
    return {
      ...base,
      status: 'ambiguous',
      matchedBy: 'none',
      matchedCents: consideredTotal,
      differenceCents: payout.netCents - consideredTotal,
      matched: [],
      considered,
      reason:
        `${considered.length} bank rows carry ${bankReference}, too many to search exhaustively ` +
        `(limit ${maxSubsetCandidates}). They total ${formatMoney(consideredTotal)} against a payout of ` +
        `${formatMoney(payout.netCents)}. Narrow the window or match by hand.`,
    };
  }

  const subsets = exactSubsets(considered, payout.netCents, 5);

  if (subsets.length === 1) {
    const matched = subsets[0] as BankTransactionCandidate[];
    return {
      ...base,
      status: 'matched',
      matchedBy: 'reference_subset',
      matchedCents: payout.netCents,
      differenceCents: 0,
      matched,
      considered,
      reason:
        `${matched.length} of the ${considered.length} bank rows carrying ${bankReference} sum to ` +
        `${formatMoney(payout.netCents)}; the rest belong to another payout.`,
    };
  }

  if (subsets.length > 1) {
    return {
      ...base,
      status: 'ambiguous',
      matchedBy: 'none',
      matchedCents: 0,
      differenceCents: payout.netCents,
      matched: [],
      considered,
      alternatives: subsets,
      reason:
        `${subsets.length} different sets of the bank rows carrying ${bankReference} each sum to ` +
        `${formatMoney(payout.netCents)}. The importer will not pick one.`,
    };
  }

  const difference = payout.netCents - consideredTotal;
  const short = wantPositive ? difference > 0 : difference < 0;

  return {
    ...base,
    status: short ? 'partial' : 'unmatched',
    matchedBy: 'none',
    matchedCents: consideredTotal,
    differenceCents: difference,
    matched: short ? considered : [],
    considered,
    reason: short
      ? `${considered.length} deposit(s) carrying ${bankReference} total ${formatMoney(consideredTotal)} ` +
        `against a payout of ${formatMoney(payout.netCents)} — ${formatMoney(Math.abs(difference))} is still in transit.`
      : `The bank rows carrying ${bankReference} total ${formatMoney(consideredTotal)}, more than the ` +
        `${formatMoney(payout.netCents)} payout. Two payouts have probably landed in one window.`,
  };
}

/**
 * Every subset of `candidates` summing exactly to `target`, up to `limit`.
 *
 * `candidates.length` is capped by the caller at 14, so this is at most 16,384
 * iterations of integer addition — cheaper than the database round trip that
 * fetched the rows.
 */
function exactSubsets(
  candidates: readonly BankTransactionCandidate[],
  target: number,
  limit: number,
): BankTransactionCandidate[][] {
  const found: BankTransactionCandidate[][] = [];
  const total = 1 << candidates.length;

  for (let mask = 1; mask < total; mask += 1) {
    let sum = 0;
    for (let index = 0; index < candidates.length; index += 1) {
      if ((mask & (1 << index)) !== 0) sum += candidates[index]?.amountCents ?? 0;
    }
    if (sum !== target) continue;

    const subset: BankTransactionCandidate[] = [];
    for (let index = 0; index < candidates.length; index += 1) {
      if ((mask & (1 << index)) !== 0) subset.push(candidates[index] as BankTransactionCandidate);
    }
    found.push(subset);
    if (found.length >= limit) break;
  }

  return found;
}

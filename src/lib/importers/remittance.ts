/**
 * Distributor remittance advices (UNFI, KeHE, DPI) — CSV/XLSX to the canonical
 * shape of docs/formats/distributor-deductions.md §2.4.
 *
 * There is no published column spec for these exports (§0), so nothing here
 * trusts a column position or a single header name. The file is read through a
 * header-alias profile per source; a header nobody mapped fails the file loudly
 * rather than being guessed at. Every row is normalised to one signed
 * `lineAmountCents` — negative is money the distributor kept, positive is money
 * it paid or gave back (§3.2) — whatever convention the export used: a signed
 * column, parentheses, a trailing minus, separate Debit/Credit columns, a D/C
 * flag, or a "Deduction Amount" column that prints deductions as positive.
 *
 * The rows are then grouped into advices, one per payment (§5.2 level 2), and
 * each advice is held to the one check that catches almost everything (§6.1):
 * its lines must sum to the payment to the cent. An advice that does not is
 * quarantined — returned with a fatal issue and never posted.
 *
 * This module is pure: it reads a `ParsedFile` (from `readFile`, which has
 * already sniffed the bytes, stripped the BOM and decoded the text) and returns
 * data. Posting is `@/lib/trade/remittances`.
 */

import { createHash } from 'node:crypto';

import type { ParsedFile } from '@/lib/banking/types';
import { type CalendarDate, parseDateInput } from '@/lib/dates';
import { formatMoney, parseMoney, sumCents } from '@/lib/money';

import type { Issue } from './types';

export const REMITTANCE_IMPORTER_ID = 'distributor.remittance';

export const REMITTANCE_SOURCES = ['UNFI', 'KEHE', 'DPI'] as const;
export type RemittanceSource = (typeof REMITTANCE_SOURCES)[number];

export const REMITTANCE_LINE_TYPES = [
  'INVOICE',
  'DEDUCTION',
  'CREDIT',
  'DISCOUNT',
  'REPAYMENT',
  'UNAPPLIED',
] as const;
export type RemittanceLineType = (typeof REMITTANCE_LINE_TYPES)[number];

/** §2.4, one row. Money in integer cents; units and unit rates stay exact decimal strings. */
export interface RemittanceRow {
  readonly sourceSystem: RemittanceSource;
  readonly adviceNumber: string | null;
  readonly paymentNumber: string;
  readonly paymentDate: CalendarDate;
  readonly paymentMethod: string | null;
  readonly paymentTotalCents: number | null;
  readonly regionDc: string | null;
  readonly lineType: RemittanceLineType;
  readonly documentNumber: string | null;
  readonly referenceInvoiceNumber: string | null;
  readonly invoiceDate: CalendarDate | null;
  readonly claimDate: CalendarDate | null;
  /** Verbatim, upper-cased, untranslated. */
  readonly reasonCode: string | null;
  readonly reasonDescription: string | null;
  readonly dealNumber: string | null;
  readonly poNumber: string | null;
  /** Left-padded to 14 digits. */
  readonly itemUpc: string | null;
  readonly itemDescription: string | null;
  readonly quantity: string | null;
  readonly unitAmount: string | null;
  /** Signed: negative = kept by the distributor, positive = paid or given back. */
  readonly lineAmountCents: number;
  readonly currency: string;
  readonly sourceFileHash: string;
  /** 1-based physical row in the file, for pointing a human at the line. */
  readonly sourceRowNumber: number;
  /** §5.2 level 4 fingerprint of the row's content. */
  readonly fingerprint: string;
  /** §5.2 level 5: 0 for the first row with this fingerprint in its payment, 1 for the second… */
  readonly occurrence: number;
}

/** One payment and the lines that explain it. */
export interface RemittanceAdvice {
  /** `source|region|payment_number` — §5.2 level 2. */
  readonly paymentKey: string;
  readonly sourceSystem: RemittanceSource;
  readonly paymentNumber: string;
  readonly paymentDate: CalendarDate;
  readonly paymentMethod: string | null;
  readonly paymentTotalCents: number;
  /** Part of the identity for UNFI (EAST/WEST); null for a KeHE advice spanning DCs. */
  readonly regionDc: string | null;
  readonly adviceNumber: string | null;
  readonly rows: readonly RemittanceRow[];
  readonly fileHash: string;
  readonly filename: string;
  /** Problems belonging to this payment alone. A fatal one quarantines it. */
  readonly issues: readonly Issue[];
}

export interface RemittanceParseResult {
  readonly sourceSystem: RemittanceSource | null;
  readonly rows: readonly RemittanceRow[];
  readonly advices: readonly RemittanceAdvice[];
  /** File-level problems. A fatal one means nothing in the file may be posted. */
  readonly issues: readonly Issue[];
  /** 0-based index into `ParsedFile.rows` of the header, or null when none was found. */
  readonly headerRow: number | null;
}

export interface RemittanceParseOptions {
  /**
   * Which distributor sent the file. Required when the file has no
   * `source_system` column, because the same header means different things per
   * source: KeHE's "Invoice Number" carries the deduction prefix, UNFI's does not.
   */
  sourceSystem?: RemittanceSource;
}

// ---------------------------------------------------------------------------
// Header profile — §2.4 "Observed header aliases"
// ---------------------------------------------------------------------------

type Field =
  | 'source_system'
  | 'remit_advice_number'
  | 'payment_number'
  | 'payment_date'
  | 'payment_method'
  | 'payment_total'
  | 'region_dc'
  | 'line_type'
  | 'document_number'
  | 'reference_invoice_number'
  | 'invoice_date'
  | 'claim_date'
  | 'reason_code'
  | 'reason_description'
  | 'deal_number'
  | 'po_number'
  | 'item_upc'
  | 'item_description'
  | 'quantity'
  | 'unit_amount'
  | 'line_amount'
  | 'deduction_amount'
  | 'debit'
  | 'credit'
  | 'direction'
  | 'currency';

/** Aliases every source shares. The canonical snake_case names are always accepted. */
const COMMON_ALIASES: Readonly<Record<Field, readonly string[]>> = {
  source_system: ['source system', 'source'],
  remit_advice_number: ['remit advice number', 'remittance number', 'advice number', 'remit advice'],
  payment_number: ['payment number', 'payment #', 'check number', 'check #', 'check/eft', 'payment ref', 'eft number'],
  payment_date: ['payment date', 'check date', 'pay date', 'remit date'],
  payment_method: ['payment method'],
  payment_total: ['payment total', 'payment amount', 'check amount', 'total payment'],
  region_dc: ['region dc', 'region', 'division', 'warehouse', 'dc', 'branch'],
  line_type: ['line type'],
  document_number: [
    'document number',
    'adjustment number',
    'adjustment #',
    'deduction number',
    'deduction id',
    'claim #',
    'claim number',
  ],
  reference_invoice_number: ['reference invoice number', 'reference invoice', 'original invoice', 'orig invoice'],
  invoice_date: ['invoice date', 'inv date', 'original invoice date'],
  claim_date: ['claim date'],
  reason_code: ['reason code', 'deduction type', 'adj type', 'code', 'prefix', 'deduction code', 'type'],
  reason_description: [
    'reason description',
    'description',
    'reason',
    'adjustment description',
    'comments',
    'deduction description',
  ],
  deal_number: ['deal number', 'deal #', 'deal'],
  po_number: ['po number', 'po #', 'po', 'purchase order'],
  item_upc: ['item upc', 'upc'],
  item_description: ['item description'],
  quantity: ['quantity', 'qty', 'cases'],
  unit_amount: ['unit amount', 'unit price', 'rate'],
  line_amount: ['line amount', 'amount', 'adjustment amount', 'net amount', 'credit amount'],
  // §3.2 rule 2: a column with one of these names holds deductions as positive numbers.
  deduction_amount: ['deduction amount', 'chargeback amount', 'claim amount'],
  debit: ['debit', 'debit amount'],
  credit: ['credit'],
  direction: ['d/c', 'dr/cr', 'debit/credit', 'credit/debit flag', 'direction'],
  currency: ['currency', 'curr'],
};

/** "Invoice Number" is the deduction's own document at KeHE (prefix appended) and the invoice at UNFI. */
const SOURCE_ALIASES: Readonly<Record<RemittanceSource, Partial<Record<Field, readonly string[]>>>> = {
  KEHE: { document_number: ['invoice number', 'invoice #'] },
  UNFI: { reference_invoice_number: ['invoice number', 'invoice #'] },
  DPI: { reference_invoice_number: ['invoice number', 'invoice #'] },
};

const AMBIGUOUS_WITHOUT_SOURCE = new Set(['invoice number', 'invoice #']);

function normalizeHeader(text: string): string {
  return text
    .replace(/^﻿/, '')
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function aliasMap(source: RemittanceSource | null): Map<string, Field> {
  const map = new Map<string, Field>();
  for (const [field, aliases] of Object.entries(COMMON_ALIASES) as [Field, readonly string[]][]) {
    map.set(normalizeHeader(field), field);
    for (const alias of aliases) map.set(alias, field);
  }
  if (source !== null) {
    for (const [field, aliases] of Object.entries(SOURCE_ALIASES[source]) as [Field, readonly string[]][]) {
      for (const alias of aliases) map.set(alias, field);
    }
  }
  return map;
}

/** Every alias any source knows, for finding the header before the source is known. */
function anyAlias(): Set<string> {
  const all = new Set<string>(aliasMap(null).keys());
  for (const source of REMITTANCE_SOURCES) for (const key of aliasMap(source).keys()) all.add(key);
  return all;
}

const HEADER_SCAN_ROWS = 15;
const MIN_HEADER_MATCHES = 3;

/** §6.3: the header is the first row where at least three cells are known aliases. */
function findHeaderRow(rows: readonly string[][]): number | null {
  const known = anyAlias();
  const limit = Math.min(rows.length, HEADER_SCAN_ROWS);
  for (let i = 0; i < limit; i += 1) {
    const matches = rows[i].filter((cell) => known.has(normalizeHeader(cell))).length;
    if (matches >= MIN_HEADER_MATCHES) return i;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Cell readers
// ---------------------------------------------------------------------------

function clean(text: string | undefined): string | null {
  if (text === undefined) return null;
  const collapsed = text.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  return collapsed === '' ? null : collapsed;
}

function upper(text: string | undefined): string | null {
  const value = clean(text);
  return value === null ? null : value.toUpperCase();
}

class RowError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly field: string,
  ) {
    super(message);
    this.name = 'RowError';
  }
}

/**
 * `1.122,00` or `10,5`: a US amount never ends in a comma and one or two digits,
 * and these are US-only files, so a comma decimal is quarantined, not guessed (§3.2).
 */
const COMMA_DECIMAL = /,\d{1,2}$/;

function readAmount(text: string, field: string): number {
  const stripped = text.replace(/[   ]/g, '').replace(/−/g, '-').replace(/USD/gi, '').trim();
  if (COMMA_DECIMAL.test(stripped.replace(/[\s$()+-]/g, ''))) {
    throw new RowError('amount.comma_decimal', `"${text}" uses a comma as the decimal separator.`, field);
  }
  try {
    return parseMoney(stripped);
  } catch (error) {
    throw new RowError('amount.unparsable', error instanceof Error ? error.message : String(error), field);
  }
}

function readDate(text: string | undefined, field: string): CalendarDate | null {
  const value = clean(text);
  if (value === null) return null;
  try {
    return parseDateInput(value);
  } catch (error) {
    throw new RowError('date.unparsable', error instanceof Error ? error.message : String(error), field);
  }
}

function readUpc(text: string | undefined): string | null {
  const value = clean(text);
  if (value === null) return null;
  const digits = value.replace(/\D/g, '');
  return digits === '' ? value : digits.padStart(14, '0');
}

function readDecimal(text: string | undefined, field: string): string | null {
  const value = clean(text);
  if (value === null) return null;
  const plain = value.replace(/[,$\s]/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(plain)) {
    throw new RowError('number.unparsable', `"${value}" is not a number.`, field);
  }
  return plain;
}

const FOOTER = /^(grand )?total|^net |^\*+|end of report/i;

// ---------------------------------------------------------------------------
// Row interpretation
// ---------------------------------------------------------------------------

type Cells = Partial<Record<Field, string>>;

function cellsOf(row: readonly string[], columns: ReadonlyMap<number, Field>): Cells {
  const cells: Cells = {};
  for (const [index, field] of columns) {
    const value = row[index];
    if (value !== undefined && value.trim() !== '') cells[field] = value;
  }
  return cells;
}

function signedAmount(cells: Cells, has: ReadonlySet<Field>): number | null {
  // §3.2 rule 1: an explicit direction flag wins over the printed sign.
  if (has.has('direction') && cells.direction !== undefined) {
    const raw = cells.line_amount ?? cells.deduction_amount ?? cells.debit ?? cells.credit;
    if (raw === undefined) return null;
    const magnitude = Math.abs(readAmount(raw, 'line_amount'));
    const flag = cells.direction.trim().toUpperCase();
    if (flag === 'D' || flag === 'DR' || flag === 'DEBIT') return magnitude === 0 ? 0 : -magnitude;
    if (flag === 'C' || flag === 'CR' || flag === 'CREDIT') return magnitude;
    throw new RowError('amount.direction', `Direction flag "${cells.direction}" is neither D nor C.`, 'direction');
  }
  // Separate Debit / Credit columns, both positive: a debit is money kept.
  if (has.has('debit') || has.has('credit')) {
    if (cells.debit !== undefined && cells.credit !== undefined) {
      throw new RowError('amount.both_sides', 'The row has both a debit and a credit amount.', 'debit');
    }
    if (cells.debit !== undefined) {
      const magnitude = Math.abs(readAmount(cells.debit, 'debit'));
      return magnitude === 0 ? 0 : -magnitude;
    }
    if (cells.credit !== undefined) return Math.abs(readAmount(cells.credit, 'credit'));
  }
  // §3.2 rule 2: "Deduction Amount" holds deductions as positive numbers.
  if (cells.deduction_amount !== undefined) {
    const magnitude = Math.abs(readAmount(cells.deduction_amount, 'deduction_amount'));
    return magnitude === 0 ? 0 : -magnitude;
  }
  if (cells.line_amount !== undefined) return readAmount(cells.line_amount, 'line_amount');
  return null;
}

const RECOVERY_CODES = new Set(['RP', 'PB', 'CBPB']);

function inferLineType(
  reasonCode: string | null,
  documentNumber: string | null,
  description: string | null,
  amount: number,
): RemittanceLineType {
  if (reasonCode === null && documentNumber === null && amount >= 0) return 'INVOICE';
  if (amount > 0 && (reasonCode !== null && RECOVERY_CODES.has(reasonCode))) return 'REPAYMENT';
  if (amount > 0 && documentNumber !== null && /PB$/.test(documentNumber)) return 'REPAYMENT';
  if (amount <= 0 && (reasonCode === 'CD' || /\b(TERMS|CASH|EARLY PAY(MENT)?) DISCOUNT\b/i.test(description ?? ''))) {
    return 'DISCOUNT';
  }
  if (reasonCode === null && amount >= 0) return 'INVOICE';
  return amount > 0 ? 'CREDIT' : 'DEDUCTION';
}

/**
 * KeHE's grid puts the invoice number with the deduction prefix appended in one
 * column (`INV4471001IA`, §5.1). The prefix is part of the deduction's identity;
 * the invoice it applies to is what is left when the prefix, or a `PB`/`PP`
 * suffix, is taken off.
 */
function splitKeheDocument(
  document: string,
  reasonCode: string | null,
): { documentNumber: string | null; referenceInvoiceNumber: string | null } {
  if (reasonCode === null) return { documentNumber: null, referenceInvoiceNumber: document };
  if (document.endsWith(reasonCode) && document.length > reasonCode.length) {
    return { documentNumber: document, referenceInvoiceNumber: document.slice(0, -reasonCode.length) };
  }
  const suffix = /^(.+?)(PB|PP)$/.exec(document);
  if (suffix) return { documentNumber: document, referenceInvoiceNumber: suffix[1] };
  return { documentNumber: document, referenceInvoiceNumber: null };
}

function normalizeForHash(text: string | null): string {
  return (text ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** §5.2 level 4 — survives a missing document number and re-wrapped descriptions. */
export function remittanceRowFingerprint(row: {
  sourceSystem: string;
  paymentNumber: string;
  referenceInvoiceNumber: string | null;
  reasonCode: string | null;
  reasonDescription: string | null;
  lineAmountCents: number;
  invoiceDate: string | null;
  documentNumber: string | null;
  lineType: string;
}): string {
  const parts = [
    row.sourceSystem,
    row.paymentNumber,
    row.lineType,
    row.documentNumber ?? '',
    row.referenceInvoiceNumber ?? '',
    row.reasonCode ?? '',
    normalizeForHash(row.reasonDescription),
    String(row.lineAmountCents),
    row.invoiceDate ?? '',
  ];
  return createHash('sha256').update(parts.join('|')).digest('hex');
}

/** §5.2 level 2. */
export function remittancePaymentKey(source: RemittanceSource, regionDc: string | null, paymentNumber: string): string {
  return `${source}|${regionDc ?? ''}|${paymentNumber}`;
}

/** §6.1: invoices plus every other line must equal the payment, to the cent. */
export function adviceArithmetic(advice: Pick<RemittanceAdvice, 'rows' | 'paymentTotalCents'>): {
  invoicesCents: number;
  adjustmentsCents: number;
  computedCents: number;
  paymentTotalCents: number;
  balanced: boolean;
} {
  const invoicesCents = sumCents(advice.rows.filter((r) => r.lineType === 'INVOICE').map((r) => r.lineAmountCents));
  const adjustmentsCents = sumCents(advice.rows.filter((r) => r.lineType !== 'INVOICE').map((r) => r.lineAmountCents));
  const computedCents = invoicesCents + adjustmentsCents;
  return {
    invoicesCents,
    adjustmentsCents,
    computedCents,
    paymentTotalCents: advice.paymentTotalCents,
    balanced: computedCents === advice.paymentTotalCents,
  };
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

const PAGINATION_CAPS = new Set([100, 500, 1000]);

interface Draft {
  row: Omit<RemittanceRow, 'fingerprint' | 'occurrence' | 'paymentTotalCents'> & { paymentTotalCents: number | null };
  rowIndex: number;
}

function isSource(value: string): value is RemittanceSource {
  return (REMITTANCE_SOURCES as readonly string[]).includes(value);
}

function isLineType(value: string): value is RemittanceLineType {
  return (REMITTANCE_LINE_TYPES as readonly string[]).includes(value);
}

/**
 * Reads a remittance export into canonical rows and per-payment advices.
 * Never throws for the contents of a file: every problem is an `Issue`, and a
 * fatal one (file-level or on an advice) means that part must not be posted.
 */
export function parseRemittance(file: ParsedFile, options: RemittanceParseOptions = {}): RemittanceParseResult {
  const issues: Issue[] = [];
  const empty = (headerRow: number | null, source: RemittanceSource | null): RemittanceParseResult => ({
    sourceSystem: source,
    rows: [],
    advices: [],
    issues,
    headerRow,
  });

  const headerRow = findHeaderRow(file.rows);
  if (headerRow === null) {
    issues.push({
      severity: 'fatal',
      code: 'header.not_found',
      message: `No header row in the first ${HEADER_SCAN_ROWS} rows has at least ${MIN_HEADER_MATCHES} recognised remittance columns.`,
      remedy: 'Export the remittance or deduction detail from the distributor portal (Advanced Search at UNFI, Deductions at KeHE) as CSV.',
    });
    return empty(null, options.sourceSystem ?? null);
  }

  const headers = file.rows[headerRow].map(normalizeHeader);

  // The source: the caller's word, else the file's own source_system column.
  let source: RemittanceSource | null = options.sourceSystem ?? null;
  if (source === null) {
    const sourceIndex = headers.findIndex((h) => h === 'source system' || h === 'source');
    const firstValue = sourceIndex === -1 ? undefined : file.rows[headerRow + 1]?.[sourceIndex];
    const candidate = firstValue === undefined ? '' : firstValue.trim().toUpperCase();
    if (isSource(candidate)) source = candidate;
  }
  if (source === null) {
    const ambiguous = headers.filter((h) => AMBIGUOUS_WITHOUT_SOURCE.has(h));
    issues.push({
      severity: 'fatal',
      code: 'source.unknown',
      message:
        ambiguous.length > 0
          ? `The file has no source_system column and "${ambiguous[0]}" means different things at UNFI and KeHE.`
          : 'The file has no source_system column, so the distributor is unknown.',
      remedy: 'Choose the distributor (UNFI, KeHE or DPI) when uploading the file.',
    });
    return empty(headerRow, null);
  }

  const aliases = aliasMap(source);
  const columns = new Map<number, Field>();
  const seen = new Map<Field, string>();
  const unmapped: string[] = [];
  headers.forEach((header, index) => {
    if (header === '') return;
    const field = aliases.get(header);
    if (field === undefined) {
      unmapped.push(file.rows[headerRow][index]);
      return;
    }
    const previous = seen.get(field);
    if (previous !== undefined) {
      issues.push({
        severity: 'fatal',
        code: 'header.duplicate',
        message: `Columns "${previous}" and "${file.rows[headerRow][index]}" both map to ${field}.`,
        field,
      });
      return;
    }
    seen.set(field, file.rows[headerRow][index]);
    columns.set(index, field);
  });
  for (const header of unmapped) {
    issues.push({
      severity: 'fatal',
      code: 'header.unmapped',
      message: `unmapped header: "${header}"`,
      remedy: 'Add the header to the remittance alias profile once its meaning is confirmed; it is never guessed.',
    });
  }
  const has = new Set(columns.values());
  const hasAmount = has.has('line_amount') || has.has('deduction_amount') || has.has('debit') || has.has('credit');
  if (!hasAmount) {
    issues.push({ severity: 'fatal', code: 'header.no_amount', message: 'The file has no amount column.' });
  }
  if (!has.has('payment_number')) {
    issues.push({
      severity: 'fatal',
      code: 'header.no_payment',
      message: 'The file has no payment/check number column. A deduction with no payment is a claim, not a deduction (§6.4).',
    });
  }
  if (issues.some((i) => i.severity === 'fatal')) return empty(headerRow, source);

  const drafts: Draft[] = [];
  let footerTotal: number | null = null;
  const carried: Cells = {};
  const carry: readonly Field[] =
    source === 'UNFI'
      ? ['payment_number', 'payment_date', 'payment_method', 'payment_total', 'remit_advice_number', 'currency', 'region_dc']
      : ['payment_number', 'payment_date', 'payment_method', 'payment_total', 'remit_advice_number', 'currency'];
  const headerSignature = file.rows[headerRow].join('');
  const errorsByPayment = new Map<string, Issue[]>();
  let dataRows = 0;

  for (let physical = headerRow + 1; physical < file.rows.length; physical += 1) {
    const raw = file.rows[physical];
    const rowIndex = physical - headerRow - 1;
    if (raw.join('') === headerSignature) continue; // a repeated page header

    const cells = cellsOf(raw, columns);
    const nonEmpty = raw.map((c) => c.trim()).filter((c) => c !== '');
    const description = clean(cells.reason_description);
    const isFooter =
      nonEmpty.every((c) => FOOTER.test(c.replace(/\s+/g, ' '))) ||
      (cells.reference_invoice_number === undefined &&
        cells.document_number === undefined &&
        cells.reason_code === undefined &&
        description !== null &&
        FOOTER.test(description));
    if (isFooter) {
      try {
        const total = signedAmount(cells, has);
        if (total !== null) footerTotal = Math.abs(total);
      } catch {
        // A footer whose total cannot be read is still a footer; the identity check decides.
      }
      continue;
    }
    dataRows += 1;

    // §6.3: merged cells come back blank below the first — carry the payment facts down.
    for (const field of carry) {
      if (cells[field] !== undefined) carried[field] = cells[field];
      else if (carried[field] !== undefined) cells[field] = carried[field];
    }

    try {
      const amount = signedAmount(cells, has);
      if (amount === null) throw new RowError('amount.missing', 'The row has no amount.', 'line_amount');
      const paymentNumber = upper(cells.payment_number);
      if (paymentNumber === null) {
        issues.push({
          severity: 'warn',
          code: 'row.no_payment',
          message: `Row ${physical + 1} has no payment number: an adjustment not yet taken on a payment is an open claim, not a deduction, and is not imported.`,
          rowIndex,
          rawRow: raw,
        });
        continue;
      }
      const paymentDate = readDate(cells.payment_date, 'payment_date');
      if (paymentDate === null) throw new RowError('date.missing', 'The row has no payment date.', 'payment_date');

      const currency = upper(cells.currency) ?? 'USD';
      const reasonCode = upper(cells.reason_code);
      let documentNumber = upper(cells.document_number);
      let referenceInvoiceNumber = upper(cells.reference_invoice_number);
      if (source === 'KEHE' && documentNumber !== null && !has.has('reference_invoice_number')) {
        ({ documentNumber, referenceInvoiceNumber } = splitKeheDocument(documentNumber, reasonCode));
      }

      const typeCell = upper(cells.line_type);
      let lineType: RemittanceLineType;
      if (typeCell !== null) {
        if (!isLineType(typeCell)) {
          throw new RowError('line_type.unknown', `Line type "${typeCell}" is not one of ${REMITTANCE_LINE_TYPES.join(', ')}.`, 'line_type');
        }
        lineType = typeCell;
      } else {
        lineType = inferLineType(reasonCode, documentNumber, description, amount);
      }

      const paymentTotal = cells.payment_total === undefined ? null : readAmount(cells.payment_total, 'payment_total');
      const sourceCell = upper(cells.source_system);
      if (sourceCell !== null && sourceCell !== source) {
        throw new RowError('source.mismatch', `Row says ${sourceCell} but the file is being read as ${source}.`, 'source_system');
      }

      drafts.push({
        rowIndex,
        row: {
          sourceSystem: source,
          adviceNumber: clean(cells.remit_advice_number),
          paymentNumber,
          paymentDate,
          paymentMethod: upper(cells.payment_method),
          paymentTotalCents: paymentTotal,
          regionDc: upper(cells.region_dc),
          lineType,
          documentNumber,
          referenceInvoiceNumber,
          invoiceDate: readDate(cells.invoice_date, 'invoice_date'),
          claimDate: readDate(cells.claim_date, 'claim_date'),
          reasonCode,
          reasonDescription: description,
          dealNumber: upper(cells.deal_number),
          poNumber: clean(cells.po_number),
          itemUpc: readUpc(cells.item_upc),
          itemDescription: clean(cells.item_description),
          quantity: readDecimal(cells.quantity, 'quantity'),
          unitAmount: readDecimal(cells.unit_amount, 'unit_amount'),
          lineAmountCents: amount,
          currency,
          sourceFileHash: file.sha256,
          sourceRowNumber: physical + 1,
        },
      });
    } catch (error) {
      if (!(error instanceof RowError)) throw error;
      const issue: Issue = {
        severity: error.code === 'amount.comma_decimal' ? 'fatal' : 'error',
        code: error.code,
        message: `Row ${physical + 1}: ${error.message}`,
        rowIndex,
        rawRow: raw,
        field: error.field,
      };
      issues.push(issue);
      // The payment facts were carried down above, so a bad row still knows its payment.
      const payment = upper(cells.payment_number);
      if (payment !== null) {
        const list = errorsByPayment.get(payment);
        if (list) list.push(issue);
        else errorsByPayment.set(payment, [issue]);
      }
    }
  }

  if (PAGINATION_CAPS.has(dataRows)) {
    issues.push({
      severity: 'warn',
      code: 'file.possibly_truncated',
      message: `The file has exactly ${dataRows} data rows, a common portal export cap. It may be truncated.`,
      remedy: 'Re-export in narrower date ranges and import each.',
    });
  }

  const advices = groupAdvices(drafts, file, footerTotal, errorsByPayment);
  const rows = advices.flatMap((a) => a.rows);
  return { sourceSystem: source, rows, advices, issues, headerRow };
}

function groupAdvices(
  drafts: readonly Draft[],
  file: ParsedFile,
  footerTotal: number | null,
  errorsByPayment: ReadonlyMap<string, readonly Issue[]>,
): RemittanceAdvice[] {
  const byPayment = new Map<string, Draft[]>();
  for (const draft of drafts) {
    const key = `${draft.row.sourceSystem}|${draft.row.paymentNumber}`;
    const list = byPayment.get(key);
    if (list) list.push(draft);
    else byPayment.set(key, [draft]);
  }

  const advices: RemittanceAdvice[] = [];
  for (const group of byPayment.values()) {
    const first = group[0].row;
    const issues: Issue[] = [];

    // UNFI's region is part of the payment's identity; a KeHE advice spans DCs.
    const regions = new Set(group.map((d) => d.row.regionDc));
    const regionDc = first.sourceSystem === 'UNFI' && regions.size === 1 ? first.regionDc : null;

    const dates = new Set(group.map((d) => d.row.paymentDate));
    if (dates.size > 1) {
      issues.push({
        severity: 'fatal',
        code: 'advice.dates_disagree',
        message: `Payment ${first.paymentNumber} carries more than one payment date: ${[...dates].join(', ')}.`,
      });
    }

    const totals = new Set(group.map((d) => d.row.paymentTotalCents).filter((t): t is number => t !== null));
    let paymentTotalCents: number;
    if (totals.size > 1) {
      issues.push({
        severity: 'fatal',
        code: 'advice.totals_disagree',
        message: `Payment ${first.paymentNumber} states more than one payment total.`,
      });
      paymentTotalCents = [...totals][0];
    } else if (totals.size === 1) {
      paymentTotalCents = [...totals][0];
    } else if (footerTotal !== null && byPayment.size === 1) {
      paymentTotalCents = footerTotal;
      issues.push({
        severity: 'info',
        code: 'advice.total_from_footer',
        message: `Payment total ${formatMoney(footerTotal)} read from the file's total row.`,
      });
    } else {
      issues.push({
        severity: 'fatal',
        code: 'advice.no_total',
        message: `Payment ${first.paymentNumber} states no payment total, so its lines cannot be checked against the cash.`,
      });
      paymentTotalCents = 0;
    }

    const currencies = new Set(group.map((d) => d.row.currency));
    for (const currency of currencies) {
      if (currency !== 'USD') {
        issues.push({
          severity: 'fatal',
          code: 'advice.currency',
          message: `Payment ${first.paymentNumber} is in ${currency}. Only USD remittances are imported (§3.3).`,
        });
      }
    }

    // A row of this payment that could not be read makes its arithmetic unknowable.
    for (const error of errorsByPayment.get(first.paymentNumber) ?? []) {
      issues.push({ ...error, severity: 'fatal', code: `advice.${error.code}` });
    }

    // §5.2 levels 4–5: fingerprint every line, number identical ones rather than drop them.
    const counts = new Map<string, number>();
    const rows: RemittanceRow[] = group.map((draft) => {
      const fingerprint = remittanceRowFingerprint(draft.row);
      const occurrence = counts.get(fingerprint) ?? 0;
      counts.set(fingerprint, occurrence + 1);
      if (occurrence > 0) {
        issues.push({
          severity: 'warn',
          code: 'line.duplicate',
          message: `Row ${draft.row.sourceRowNumber} is identical to an earlier line of payment ${first.paymentNumber}. Both are imported; confirm the distributor really took it twice.`,
          rowIndex: draft.rowIndex,
        });
      }
      return { ...draft.row, paymentTotalCents, fingerprint, occurrence };
    });

    const arithmetic = adviceArithmetic({ rows, paymentTotalCents });
    if (!arithmetic.balanced && !issues.some((i) => i.code === 'advice.no_total')) {
      issues.push({
        severity: 'fatal',
        code: 'advice.identity',
        message:
          `Payment ${first.paymentNumber}: invoices ${formatMoney(arithmetic.invoicesCents)} and adjustments ` +
          `${formatMoney(arithmetic.adjustmentsCents)} total ${formatMoney(arithmetic.computedCents)}, but the payment is ` +
          `${formatMoney(paymentTotalCents)}. The advice is quarantined.`,
        remedy:
          'Usually a total row counted as data, an inverted sign, or backup that belongs to a different payment (§6.1).',
      });
    }

    advices.push({
      paymentKey: remittancePaymentKey(first.sourceSystem, regionDc, first.paymentNumber),
      sourceSystem: first.sourceSystem,
      paymentNumber: first.paymentNumber,
      paymentDate: first.paymentDate,
      paymentMethod: first.paymentMethod,
      paymentTotalCents,
      regionDc,
      adviceNumber: first.adviceNumber,
      rows,
      fileHash: file.sha256,
      filename: file.filename,
      issues,
    });
  }
  return advices;
}

/** True when an advice may be posted: no fatal issue of its own. */
export function isPostable(advice: RemittanceAdvice): boolean {
  return !advice.issues.some((issue) => issue.severity === 'fatal');
}

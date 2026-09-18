/**
 * Amazon Seller Central settlement report, Flat File V2 — `docs/formats/amazon.md`.
 *
 * One file is one settlement: a header row, a summary row carrying the settlement id,
 * the period, the deposit date and `total-amount`, then detail rows with one signed
 * `amount` each (positive = Amazon owes Sooz more). The identity the whole file must
 * satisfy, exactly and with no tolerance, is `Σ amount == total-amount` (§5a). A
 * mismatch is a truncated download, never an accounting difference, and nothing posts.
 *
 * The file is tab-delimited and never quoted, so it is split on `\t` literally rather
 * than through a CSV reader (§6.16), and 23-field rows are padded to 24 (§6.2).
 *
 * Tax (§7c): in facilitator states the tax the customer paid (`ItemPrice/Tax`) and the
 * tax Amazon withholds to remit (`ItemWithheldTax/MarketplaceFacilitatorTax-*`) arrive
 * as an exactly offsetting pair on the same order line. Both are kept as
 * `facilitator_tax` lines so the file still ties, and neither ever reaches 2200. Only a
 * residual — tax charged on an order line that Amazon did not withhold — is Sooz's own
 * liability, and it is flagged for review because the file does not say which state.
 *
 * UNVERIFIED: no real Sooz Amazon settlement exists yet (Amazon selling is planned, not
 * live). The parser is built from the research document and its synthetic fixtures.
 */

import { fileHash } from '@/lib/banking/fingerprint';
import type { PayoutLineType } from '@/db/schema';
import type { CalendarDate } from '@/lib/dates';
import type { Assertion, Issue } from '@/lib/importers/types';
import { sumCents } from '@/lib/money';

import type { SettlementRole } from './accounts';
import { assertion, readCalendarDate, readCents, sha256 } from './parse-support';
import {
  type ParsedSettlement,
  type SettlementFile,
  SettlementFormatError,
  type SettlementLineDraft,
} from './types';

export const AMAZON_IMPORTER_ID = 'amazon.settlement.v2';

export const AMAZON_V2_HEADER = [
  'settlement-id',
  'settlement-start-date',
  'settlement-end-date',
  'deposit-date',
  'total-amount',
  'currency',
  'transaction-type',
  'order-id',
  'merchant-order-id',
  'adjustment-id',
  'shipment-id',
  'marketplace-name',
  'amount-type',
  'amount-description',
  'amount',
  'fulfillment-id',
  'posted-date',
  'posted-date-time',
  'order-item-code',
  'merchant-order-item-id',
  'merchant-adjustment-item-id',
  'sku',
  'quantity-purchased',
  'promotion-id',
] as const;

type AmazonColumn = (typeof AMAZON_V2_HEADER)[number];

const COLUMN_INDEX: Readonly<Record<AmazonColumn, number>> = Object.freeze(
  Object.fromEntries(AMAZON_V2_HEADER.map((name, index) => [name, index])) as Record<AmazonColumn, number>,
);

interface DetailRow {
  readonly rowIndex: number;
  readonly cells: readonly string[];
  readonly transactionType: string;
  readonly amountType: string;
  readonly amountDescription: string;
  readonly amountCents: number;
  readonly orderId: string;
  readonly orderItemCode: string;
  readonly sku: string;
  readonly quantity: string;
  readonly postedDate: CalendarDate | null;
}

function cell(cells: readonly string[], column: AmazonColumn): string {
  return (cells[COLUMN_INDEX[column]] ?? '').trim();
}

function fold(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Amazon prints amounts in the marketplace's locale (§3). A US file uses `.`; an EU file
 * `,`. When a comma is the only separator and exactly two digits follow it, it is a
 * decimal comma.
 */
function amazonCents(text: string): ReturnType<typeof readCents> {
  const trimmed = text.trim();
  const decimalComma = /^-?\d+,\d{2}$/.test(trimmed);
  const lastComma = trimmed.lastIndexOf(',');
  const lastDot = trimmed.lastIndexOf('.');
  let normalized = trimmed;
  if (decimalComma) normalized = trimmed.replace(',', '.');
  else if (lastComma > lastDot && lastDot !== -1) normalized = trimmed.replace(/\./g, '').replace(',', '.');
  return readCents(normalized);
}

function decode(bytes: Uint8Array): { text: string; issues: Issue[] } {
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
    throw new SettlementFormatError(
      'amazon.workbook',
      'This is a spreadsheet workbook, not the tab-delimited settlement file Amazon produces.',
      'Download the settlement again from Seller Central → Payments → All Statements → Download Flat File V2, and upload it without opening it in Excel.',
    );
  }
  const issues: Issue[] = [];
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    text = new TextDecoder('latin1').decode(bytes);
    issues.push({
      severity: 'warn',
      code: 'amazon.encoding',
      message: 'The file is not valid UTF-8 and was read as Latin-1. Check SKUs and promotion names for garbled characters.',
    });
  }
  text = text.replace(/^\uFEFF/, '');
  if (text.trimStart().startsWith('<')) {
    throw new SettlementFormatError(
      'amazon.html',
      'This file is a web page, not a settlement report.',
      'Download the settlement from Seller Central again; the link may have expired.',
    );
  }
  return { text, issues };
}

interface Classification {
  readonly lineType: PayoutLineType;
  readonly role: SettlementRole;
}

type TaxSide = 'collected' | 'withheld';

/** The tax half a row belongs to, if it is a tax row at all (§7b "Tax"). */
function taxSide(row: DetailRow): TaxSide | null {
  const at = fold(row.amountType);
  const ad = fold(row.amountDescription);
  if (at === 'itemwithheldtax' && ad.startsWith('marketplacefacilitator')) return 'withheld';
  if (at === 'itemprice' && (ad === 'tax' || ad === 'shippingtax' || ad === 'giftwraptax')) return 'collected';
  if (at === 'promotion' && ad === 'taxdiscount') return 'collected';
  return null;
}

const SELLING_FEES = new Set([
  'commission',
  'refundcommission',
  'variableclosingfee',
  'fixedclosingfee',
  'digitalservicesfee',
  'coupon redemption fee',
  'couponredemptionfee',
  'lightningdealfee',
]);

const FULFILLMENT_FEES = new Set([
  'fbaperunitfulfillmentfee',
  'fbaweightbasedfee',
  'fbaperorderfulfillmentfee',
  'shippingchargeback',
  'giftwrapchargeback',
  'shippinghb',
  'returnshipping',
  'liquidationsbrokeragefee',
  'removalcomplete',
  'disposalcomplete',
  'fbainboundtransportationfee',
]);

const STORAGE_FEES = new Set(['storagerenewalbilling', 'storagefee', 'fbastoragefee', 'fbalongtermstoragefee']);

/** Every non-tax row, by its case-folded `(transaction-type, amount-type, amount-description)` triple. */
function classify(row: DetailRow): Classification | null {
  const tt = fold(row.transactionType);
  const at = fold(row.amountType);
  const ad = fold(row.amountDescription);

  if (ad === 'current reserve amount') return { lineType: 'reserve_held', role: 'reserve_receivable' };
  if (ad === 'previous reserve amount balance') return { lineType: 'reserve_released', role: 'reserve_receivable' };
  if (at === 'cost of advertising') return { lineType: 'advertising', role: 'advertising' };
  if (at === 'fba inventory reimbursement') return { lineType: 'reimbursement', role: 'reimbursement_income' };

  if (at === 'itemprice') {
    if (tt === 'liquidations' && ad === 'principal') return { lineType: 'gross_sales', role: 'liquidation_sales' };
    if (tt === 'refund' && ['principal', 'shipping', 'giftwrap', 'goodwill', 'restockingfee'].includes(ad)) {
      return { lineType: 'refund', role: 'returns_allowances' };
    }
    if (tt === 'order' && (ad === 'principal' || ad === 'giftwrap')) return { lineType: 'gross_sales', role: 'channel_sales' };
    if (tt === 'order' && ad === 'shipping') return { lineType: 'shipping_income', role: 'shipping_income' };
    return null;
  }
  if (at === 'promotion' && (ad === 'principal' || ad === 'shipping')) {
    return { lineType: 'promotion_rebate', role: 'discounts_promotions' };
  }
  if (at === 'itemfees' || at === 'other-transaction') {
    if (SELLING_FEES.has(ad)) return { lineType: 'referral_fee', role: 'selling_fees' };
    if (FULFILLMENT_FEES.has(ad)) return { lineType: 'fulfillment_fee', role: 'fulfillment_fees' };
    if (STORAGE_FEES.has(ad)) return { lineType: 'storage_fee', role: 'storage_fees' };
    if (ad === 'subscription' || ad === 'subscription fee') return { lineType: 'subscription_fee', role: 'platform_fees' };
  }
  return null;
}

export interface AmazonParseOptions {
  /** The file name, for messages and the import record. */
  readonly filename: string;
}

/**
 * Parses one Flat File V2 settlement.
 *
 * @throws {SettlementFormatError} the file is not a V2 settlement report at all: a workbook,
 *   a web page, a V1 file, a comma-delimited re-save, or a header that is not the 24 columns.
 */
export function parseAmazonSettlement(bytes: Uint8Array, options: AmazonParseOptions): SettlementFile {
  const { text, issues } = decode(bytes);
  const physical = text.split(/\r?\n/);
  while (physical.length > 0 && physical[physical.length - 1].trim() === '') physical.pop();
  if (physical.length < 2) {
    throw new SettlementFormatError('amazon.empty', 'The file has no settlement rows.', 'Download the settlement again.');
  }

  const header = physical[0].split('\t').map((name) => name.trim().toLowerCase());
  if (header.length === 1 && header[0].includes(',') && header[0].includes('settlement-id')) {
    throw new SettlementFormatError(
      'amazon.resaved',
      'This settlement report was re-saved by a spreadsheet as comma-delimited; its identifiers and dates cannot be trusted.',
      'Re-download the original Flat File V2 from Seller Central and upload it unopened.',
    );
  }
  if (header[12] === 'shipment-fee-type') {
    throw new SettlementFormatError(
      'amazon.v1',
      'This is a V1 Flat File, which Amazon has retired.',
      'Re-download using "Download Flat File V2".',
    );
  }
  const expected = AMAZON_V2_HEADER.join('|');
  if (header.join('|') !== expected) {
    const missing = AMAZON_V2_HEADER.filter((name) => !header.includes(name));
    throw new SettlementFormatError(
      'amazon.header',
      missing.length > 0
        ? `This is not a Flat File V2 settlement: the header lacks ${missing.join(', ')}.`
        : 'The header does not match the 24 Flat File V2 columns in order.',
      'Download the settlement from Seller Central → Payments → All Statements → Download Flat File V2.',
    );
  }

  const filename = options.filename;
  const hash = fileHash(bytes);
  const rows: string[][] = [];
  physical.slice(1).forEach((line, index) => {
    const cells = line.split('\t');
    if (cells.length === 23) cells.push('');
    if (cells.length !== 24) {
      issues.push({
        severity: 'fatal',
        code: 'row.field_count',
        message: `Row ${index + 2} has ${cells.length} fields; a V2 settlement row has 23 or 24. The settlement cannot tie without it.`,
        rowIndex: index,
        rawRow: cells,
        remedy: 'Download the settlement again; the file is damaged.',
      });
      return;
    }
    rows.push(cells);
  });

  const summaryIndex = rows.findIndex((cells) => cell(cells, 'transaction-type') === '' && cell(cells, 'total-amount') !== '');
  if (summaryIndex === -1) {
    throw new SettlementFormatError(
      'amazon.no_summary',
      'The file has no summary row, so its total and period are unknown.',
      'Download the settlement again; the summary row is always the first after the header.',
    );
  }
  const summary = rows[summaryIndex];
  const settlementId = cell(summary, 'settlement-id');
  const currency = cell(summary, 'currency').toUpperCase() || 'USD';
  const periodStart = readCalendarDate(cell(summary, 'settlement-start-date'));
  const periodEnd = readCalendarDate(cell(summary, 'settlement-end-date'));
  const depositDate = readCalendarDate(cell(summary, 'deposit-date'));
  const total = amazonCents(cell(summary, 'total-amount'));

  if (!total.ok) {
    issues.push({ severity: 'fatal', code: 'amazon.total_unreadable', message: `total-amount cannot be read: ${total.reason}` });
  }
  if (periodEnd === null) {
    issues.push({ severity: 'fatal', code: 'amazon.period_unreadable', message: 'settlement-end-date cannot be read.' });
  }
  if (currency !== 'USD') {
    issues.push({
      severity: 'fatal',
      code: 'amazon.currency',
      message: `This settlement is in ${currency}. Sooz's books are kept in USD and no conversion is configured.`,
    });
  }

  const details: DetailRow[] = [];
  rows.forEach((cells, index) => {
    if (index === summaryIndex) return;
    if (cell(cells, 'settlement-id') !== settlementId) {
      issues.push({
        severity: 'fatal',
        code: 'amazon.mixed_settlements',
        message: `Row ${index + 2} belongs to settlement ${cell(cells, 'settlement-id') || '(blank)'}, not ${settlementId}. One file must hold one settlement.`,
        rowIndex: index,
        rawRow: cells,
      });
      return;
    }
    const amount = amazonCents(cell(cells, 'amount'));
    if (!amount.ok) {
      issues.push({
        severity: 'fatal',
        code: 'amount.unparsable',
        message: `Row ${index + 2}: amount cannot be read (${amount.reason}). The settlement cannot tie without it.`,
        rowIndex: index,
        rawRow: cells,
      });
      return;
    }
    details.push({
      rowIndex: index,
      cells,
      transactionType: cell(cells, 'transaction-type'),
      amountType: cell(cells, 'amount-type'),
      amountDescription: cell(cells, 'amount-description'),
      amountCents: amount.cents,
      orderId: cell(cells, 'order-id'),
      orderItemCode: cell(cells, 'order-item-code'),
      sku: cell(cells, 'sku'),
      quantity: cell(cells, 'quantity-purchased'),
      postedDate: readCalendarDate(cell(cells, 'posted-date')),
    });
  });

  const reportedNet = total.ok ? total.cents : 0;
  const lines = buildLines(settlementId, details, issues);
  const assertions: Assertion[] = [
    assertion(
      'amazon.sum_equals_total',
      'Σ amount == total-amount',
      reportedNet,
      sumCents(details.map((row) => row.amountCents)),
    ),
    assertion('amazon.lines_equal_total', 'Σ settlement lines == total-amount', reportedNet, sumCents(lines.map((l) => l.amountCents))),
    assertion(
      'amazon.facilitator_nets_to_zero',
      'Marketplace facilitator tax collected − withheld',
      0,
      sumCents(lines.filter((l) => l.lineType === 'facilitator_tax').map((l) => l.amountCents)),
    ),
  ];

  const settlement: ParsedSettlement = {
    provider: 'amazon',
    key: settlementId,
    periodStart,
    periodEnd: periodEnd ?? '1970-01-01',
    depositDate,
    currency,
    reportedNetCents: reportedNet,
    lines,
    assertions,
    issues: [
      {
        severity: 'info',
        code: 'amazon.period_dates_utc',
        message:
          'Amazon dates are UTC calendar dates. The settlement posts on its settlement-end-date; activity posted in the last hours of a month may belong to the next one in Central time.',
      },
    ],
  };

  const ok =
    total.ok &&
    periodEnd !== null &&
    !issues.some((issue) => issue.severity === 'fatal' || issue.severity === 'error') &&
    assertions.every((a) => a.passed || a.severity !== 'fatal');

  return {
    importerId: AMAZON_IMPORTER_ID,
    provider: 'amazon',
    filename,
    fileHash: hash,
    settlements: [settlement],
    issues,
    rowCount: rows.length,
    ok,
  };
}

interface Bucket {
  lineType: PayoutLineType;
  role: SettlementRole;
  taxSide: 'collected' | 'withheld' | null;
  label: string;
  amountCents: number;
  rowIndexes: number[];
  postedDate: CalendarDate | null;
  externalRef: string | null;
  sku: string | null;
}

/**
 * Aggregates detail rows into settlement lines, one per `(transaction-type, amount-type,
 * amount-description)` for ordinary rows and one per tax treatment for tax rows. Zero rows
 * (the `0.00` MCF principal) add nothing and are left out.
 */
function buildLines(settlementId: string, details: readonly DetailRow[], issues: Issue[]): SettlementLineDraft[] {
  const buckets = new Map<string, Bucket>();
  const add = (key: string, seed: Omit<Bucket, 'amountCents' | 'rowIndexes'>, amount: number, rowIndexes: readonly number[]) => {
    const bucket = buckets.get(key) ?? { ...seed, amountCents: 0, rowIndexes: [] };
    bucket.amountCents += amount;
    bucket.rowIndexes.push(...rowIndexes);
    if (bucket.postedDate === null || (seed.postedDate !== null && seed.postedDate > bucket.postedDate)) {
      bucket.postedDate = seed.postedDate;
    }
    buckets.set(key, bucket);
  };

  // Tax rows pair per order line: collected against withheld.
  const taxGroups = new Map<string, { collected: DetailRow[]; withheld: DetailRow[] }>();
  for (const row of details) {
    const side = taxSide(row);
    if (side !== null) {
      const key = `${fold(row.transactionType)}|${row.orderId}|${row.orderItemCode}`;
      const group = taxGroups.get(key) ?? { collected: [], withheld: [] };
      group[side].push(row);
      taxGroups.set(key, group);
      continue;
    }

    const kind = classify(row);
    const label = `${row.transactionType} / ${row.amountType} / ${row.amountDescription}`;
    if (kind === null) {
      if (row.amountCents === 0) continue;
      issues.push({
        severity: 'warn',
        code: 'amazon.unmapped',
        message: `Row ${row.rowIndex + 2}: "${label}" is not in the known Amazon vocabulary. It posts to 7900 Ask My Accountant for review rather than being dropped.`,
        rowIndex: row.rowIndex,
        rawRow: [...row.cells],
      });
      add(`other|${label.toLowerCase()}`, { lineType: 'other', role: 'ask_my_accountant', taxSide: null, label, postedDate: row.postedDate, externalRef: null, sku: null }, row.amountCents, [row.rowIndex]);
      continue;
    }
    if (row.amountCents === 0) continue;
    add(
      `${kind.lineType}|${kind.role}|${label.toLowerCase()}`,
      { ...kind, taxSide: null, label, postedDate: row.postedDate, externalRef: null, sku: null },
      row.amountCents,
      [row.rowIndex],
    );
  }

  for (const [key, group] of taxGroups) {
    const collected = sumCents(group.collected.map((r) => r.amountCents));
    const withheld = sumCents(group.withheld.map((r) => r.amountCents));
    const collectedRows = group.collected.map((r) => r.rowIndex);
    const withheldRows = group.withheld.map((r) => r.rowIndex);
    const dateOf = (rows: readonly DetailRow[]) => rows.map((r) => r.postedDate).find((d) => d !== null) ?? null;

    if (withheld !== 0) {
      // Amazon remitted `withheld`; the matching slice of what the customer paid is facilitator tax.
      add('facilitator|withheld', { lineType: 'facilitator_tax', role: 'facilitator_tax', taxSide: 'withheld', label: 'Marketplace facilitator tax withheld by Amazon', postedDate: dateOf(group.withheld), externalRef: null, sku: null }, withheld, withheldRows);
      add('facilitator|collected', { lineType: 'facilitator_tax', role: 'facilitator_tax', taxSide: 'collected', label: 'Tax collected by Amazon as marketplace facilitator', postedDate: dateOf(group.collected), externalRef: null, sku: null }, -withheld, collectedRows);
    }
    const residual = collected + withheld;
    if (residual !== 0) {
      const [, orderId] = key.split('|');
      issues.push({
        severity: 'warn',
        code: 'amazon.tax_residual',
        message: `Order ${orderId || '(none)'}: ${residual > 0 ? 'tax collected' : 'tax refunded'} that Amazon did not withhold as facilitator. It is Sooz's own sales tax and posts to 2200; the settlement does not name the state, so give it one when posting.`,
      });
      add('tax|residual', { lineType: 'sales_tax_collected', role: 'sales_tax_payable', taxSide: 'collected', label: 'Sales tax collected by Amazon for Sooz (not withheld)', postedDate: dateOf(group.collected), externalRef: null, sku: null }, residual, collectedRows);
    }
  }

  const ordinals = new Map<string, number>();
  const lines: SettlementLineDraft[] = [];
  for (const bucket of buckets.values()) {
    if (bucket.amountCents === 0) continue;
    const base = `${bucket.lineType}|${bucket.label}`;
    const ordinal = ordinals.get(base) ?? 0;
    ordinals.set(base, ordinal + 1);
    lines.push({
      lineType: bucket.lineType,
      role: bucket.role,
      amountCents: bucket.amountCents,
      label: bucket.label,
      postedDate: bucket.postedDate,
      externalRef: bucket.externalRef,
      sku: bucket.sku,
      quantity: null,
      jurisdiction: null,
      taxableCents: null,
      taxRegime: bucket.lineType === 'sales_tax_collected' ? 'unknown' : null,
      taxSide: bucket.taxSide,
      rowIndexes: [...bucket.rowIndexes].sort((a, b) => a - b),
      fingerprint: sha256([settlementId, bucket.lineType, bucket.role, bucket.label, bucket.amountCents, ordinal]),
    });
  }
  return lines;
}

/**
 * Faire payout summary export — `docs/formats/faire-wholesale.md` Part A.
 *
 * Faire owes Sooz, not the retailer, so a Faire order is never AR: each paid row posts
 * against 1130 Faire Clearing, and the bank deposit of the payout batch clears it. The
 * file has no payout id and no printed total. A batch is every row sharing a
 * `Payout Date` and currency, and its total is `Σ Payout Amount` (§5.A).
 *
 * The file's column semantics are genuinely ambiguous — whether `Order Total` is before
 * or after promotions, whether `Shipping Costs Applied` is a reimbursement or a cost — so
 * the parser does not guess. It probes (§3.A.3): each candidate formula is evaluated on
 * the rows with no damaged units, and one must hold within $0.01 on at least 95% of them.
 * If none does, the file is refused. Once a candidate is locked, what is left on a row is
 * the damages clawback, valued by Faire and recovered as the residual (§6.A.4).
 *
 * Never posted: `Insider Fees Charged to Faire` (Faire's own cost, §6.A.9) and `Taxes
 * Charged` (Faire is the marketplace facilitator and remits it, §7.A.4).
 *
 * UNVERIFIED: Sooz has no Faire account yet. Built from the research document and its
 * synthetic fixture; confirm the locked candidate against the first real export.
 */

import type { PayoutLineType } from '@/db/schema';
import { readFile } from '@/lib/banking/read-file';
import type { CalendarDate } from '@/lib/dates';
import type { Assertion, Issue } from '@/lib/importers/types';
import { formatMoney, sumCents } from '@/lib/money';

import type { SettlementRole } from './accounts';
import { assertion, headerKey, keyedRows, readCalendarDate, readCents, sha256, type KeyedRow } from './parse-support';
import { type ParsedSettlement, type SettlementFile, SettlementFormatError, type SettlementLineDraft } from './types';

export const FAIRE_IMPORTER_ID = 'faire.payout_summary';

type FaireColumn =
  | 'payout_date'
  | 'payout_amount'
  | 'order_number'
  | 'retailer'
  | 'order_date'
  | 'order_total'
  | 'currency'
  | 'damaged_qty'
  | 'promotions'
  | 'commission_rate'
  | 'new_customer_fee'
  | 'total_commission'
  | 'taxes_charged'
  | 'shipping'
  | 'processing_fees'
  | 'insider_free_shipping'
  | 'insider_fees_brand'
  | 'insider_fees_faire'
  | 'ship_with_faire';

const SYNONYMS: Readonly<Record<string, FaireColumn>> = Object.freeze({
  payoutdate: 'payout_date',
  payoutamount: 'payout_amount',
  ordernumber: 'order_number',
  retailershopname: 'retailer',
  retailer: 'retailer',
  orderdate: 'order_date',
  ordertotal: 'order_total',
  currency: 'currency',
  quantitydamagedormissing: 'damaged_qty',
  promotionsapplied: 'promotions',
  promotions: 'promotions',
  commissionrate: 'commission_rate',
  newcustomerfee: 'new_customer_fee',
  newcustomerfeeifapplicable: 'new_customer_fee',
  totalcommission: 'total_commission',
  totalcommissioncharged: 'total_commission',
  taxescharged: 'taxes_charged',
  taxes: 'taxes_charged',
  shippingcostsapplied: 'shipping',
  shippingcosts: 'shipping',
  paymentprocessingfees: 'processing_fees',
  paymentprocessingfee: 'processing_fees',
  insiderfreeshipping: 'insider_free_shipping',
  insiderfeeschargedtobrand: 'insider_fees_brand',
  insiderfeeschargedtothebrand: 'insider_fees_brand',
  insiderfeeschargedtofaire: 'insider_fees_faire',
  shipwithfaire: 'ship_with_faire',
});

const REQUIRED: readonly FaireColumn[] = [
  'payout_date',
  'payout_amount',
  'order_number',
  'order_total',
  'total_commission',
  'processing_fees',
];

const MONEY_COLUMNS: readonly FaireColumn[] = [
  'payout_amount',
  'order_total',
  'promotions',
  'new_customer_fee',
  'total_commission',
  'taxes_charged',
  'shipping',
  'processing_fees',
  'insider_fees_brand',
];

/** §3.A.3 — which formula turns a row's columns into its payout. */
export type FaireCandidate = 'gross_order_total_shipping_reimbursed' | 'net_order_total' | 'shipping_is_cost';

interface FaireRow {
  readonly rowIndex: number;
  readonly cells: readonly string[];
  readonly payoutDate: CalendarDate | null;
  readonly orderNumber: string;
  readonly currency: string;
  readonly damagedQty: number;
  readonly money: Readonly<Record<(typeof MONEY_COLUMNS)[number], number>>;
}

function expectedPayout(row: FaireRow, candidate: FaireCandidate): number {
  const m = row.money;
  const fees = m.total_commission + m.new_customer_fee + m.processing_fees + m.insider_fees_brand;
  switch (candidate) {
    case 'gross_order_total_shipping_reimbursed':
      return m.order_total + m.shipping - m.promotions - fees;
    case 'net_order_total':
      return m.order_total + m.shipping - fees;
    case 'shipping_is_cost':
      return m.order_total - m.shipping - m.promotions - fees;
  }
}

const CANDIDATES: readonly FaireCandidate[] = ['gross_order_total_shipping_reimbursed', 'net_order_total', 'shipping_is_cost'];
const PROBE_ROWS = 50;
const PROBE_TOLERANCE_CENTS = 1;
const PROBE_PASS_RATE = 0.95;

export interface FaireParseOptions {
  readonly filename: string;
  /**
   * The candidate locked for this brand account by an earlier import. When given it is
   * still verified, and a file that no longer satisfies it is refused.
   */
  readonly candidate?: FaireCandidate;
}

export interface FaireSettlementFile extends SettlementFile {
  readonly candidate: FaireCandidate | null;
  /** Shipped but not yet paid (blank `Payout Date`): real revenue, no deposit yet, not posted here. */
  readonly unpaid: { readonly rows: number; readonly payoutCents: number };
}

function probe(rows: readonly FaireRow[]): { candidate: FaireCandidate | null; rates: Record<FaireCandidate, number>; probed: number } {
  const sample = rows.filter((row) => row.damagedQty === 0 && row.money.order_total !== 0).slice(0, PROBE_ROWS);
  const rates = {} as Record<FaireCandidate, number>;
  let best: FaireCandidate | null = null;
  for (const candidate of CANDIDATES) {
    const hits = sample.filter(
      (row) => Math.abs(expectedPayout(row, candidate) - row.money.payout_amount) <= PROBE_TOLERANCE_CENTS,
    ).length;
    rates[candidate] = sample.length === 0 ? 0 : hits / sample.length;
    if (rates[candidate] >= PROBE_PASS_RATE && (best === null || rates[candidate] > rates[best])) best = candidate;
  }
  return { candidate: best, rates, probed: sample.length };
}

/**
 * Parses a Faire payout summary into one settlement per payout batch.
 *
 * @throws {SettlementFormatError} not a Faire payout summary, an unmapped column, or an
 *   order number Excel has turned into scientific notation.
 */
export async function parseFaireSettlements(
  bytes: Uint8Array,
  options: FaireParseOptions,
): Promise<FaireSettlementFile> {
  const file = await readFile(bytes, options.filename);
  const issues: Issue[] = [];

  const headerIndex = file.rows.findIndex(
    (row) => row.filter((name) => SYNONYMS[headerKey(name)] !== undefined).length >= 3,
  );
  if (headerIndex === -1) {
    throw new SettlementFormatError(
      'faire.header',
      'No Faire payout summary header was found in this file.',
      'Export Orders → Export → Payout summary (or Payouts → Export) from the Faire brand portal.',
    );
  }
  if (headerIndex > 0) {
    issues.push({ severity: 'info', code: 'faire.preamble', message: `${headerIndex} line(s) above the header were skipped.` });
  }

  const header = file.rows[headerIndex];
  const { rows: keyed, columns, unmapped } = keyedRows(header, file.rows.slice(headerIndex + 1), (key) => SYNONYMS[key] ?? null);
  if (unmapped.length > 0) {
    throw new SettlementFormatError(
      'faire.unmapped_header',
      `The export carries column(s) this importer does not know: ${unmapped.join(', ')}. A new fee column ignored would unbalance every entry.`,
      'Map the new column before importing; do not delete it from the file.',
    );
  }
  const missing = REQUIRED.filter((column) => !columns.has(column));
  if (missing.length > 0) {
    throw new SettlementFormatError(
      'faire.missing_columns',
      `The export lacks required column(s): ${missing.join(', ')}.`,
      'Export the full Payout summary from the Faire brand portal.',
    );
  }

  const rows: FaireRow[] = [];
  let footer = false;
  for (const row of keyed) {
    const order = row.get('order_number');
    if (footer) {
      issues.push({ severity: 'info', code: 'faire.after_footer', message: `Row ${row.rowIndex + 1} follows a totals row and was ignored.`, rowIndex: row.rowIndex, rawRow: [...row.cells] });
      continue;
    }
    if (order === '' && row.get('payout_amount') !== '') {
      footer = true;
      issues.push({ severity: 'info', code: 'faire.totals_row', message: `Row ${row.rowIndex + 1} is a totals row and was not imported.`, rowIndex: row.rowIndex, rawRow: [...row.cells] });
      continue;
    }
    if (/^\d+(\.\d+)?e\+\d+$/i.test(order)) {
      throw new SettlementFormatError(
        'faire.excel_mangled',
        `Order number "${order}" has been converted to scientific notation by a spreadsheet; order numbers cannot be recovered from it.`,
        'Export the payout summary from Faire again and upload it without opening it in Excel.',
      );
    }
    const parsed = readRow(row, issues);
    if (parsed !== null) rows.push(parsed);
  }

  const paid = rows.filter((row) => row.payoutDate !== null);
  const unpaidRows = rows.filter((row) => row.payoutDate === null);
  if (unpaidRows.length > 0) {
    issues.push({
      severity: 'info',
      code: 'faire.unpaid_rows',
      message: `${unpaidRows.length} order(s) have shipped but not been paid out (${formatMoney(sumCents(unpaidRows.map((r) => r.money.payout_amount)))}). They post when a later export carries their payout date.`,
    });
  }

  const probed = probe(paid);
  let candidate: FaireCandidate | null = probed.candidate;
  if (options.candidate !== undefined) {
    if (probed.probed > 0 && probed.rates[options.candidate] < PROBE_PASS_RATE) {
      issues.push({
        severity: 'fatal',
        code: 'faire.candidate_changed',
        message: `This account's locked payout formula (${options.candidate}) holds on only ${Math.round(probed.rates[options.candidate] * 100)}% of rows in this file. Faire may have changed the export; nothing was imported.`,
      });
    }
    candidate = options.candidate;
  } else if (candidate === null && paid.length > 0) {
    issues.push({
      severity: 'fatal',
      code: 'faire.identity_unresolved',
      message: `No payout formula holds on 95% of rows (${CANDIDATES.map((c) => `${c} ${Math.round(probed.rates[c] * 100)}%`).join(', ')}). The column meanings cannot be trusted, so nothing is posted.`,
      remedy: 'Send the export to support with this message; do not adjust figures to make it tie.',
    });
  }

  const batches = new Map<string, FaireRow[]>();
  for (const row of paid) {
    const key = `${row.payoutDate}|${row.currency}`;
    const batch = batches.get(key) ?? [];
    batch.push(row);
    batches.set(key, batch);
  }

  const settlements: ParsedSettlement[] = [];
  if (candidate !== null) {
    for (const [key, batch] of batches) {
      settlements.push(buildBatch(key, batch, candidate));
    }
  }
  settlements.sort((a, b) => (a.periodEnd < b.periodEnd ? -1 : a.periodEnd > b.periodEnd ? 1 : 0));

  const ok =
    !issues.some((issue) => issue.severity === 'fatal' || issue.severity === 'error') &&
    settlements.every(
      (s) =>
        s.assertions.every((a) => a.passed || a.severity !== 'fatal') &&
        !s.issues.some((issue) => issue.severity === 'fatal'),
    );

  return {
    importerId: FAIRE_IMPORTER_ID,
    provider: 'faire',
    filename: options.filename,
    fileHash: file.sha256,
    settlements,
    issues,
    rowCount: keyed.length,
    ok,
    candidate,
    unpaid: { rows: unpaidRows.length, payoutCents: sumCents(unpaidRows.map((r) => r.money.payout_amount)) },
  };
}

function readRow(row: KeyedRow, issues: Issue[]): FaireRow | null {
  const money = {} as Record<(typeof MONEY_COLUMNS)[number], number>;
  for (const column of MONEY_COLUMNS) {
    const read = readCents(row.get(column), { blankIsZero: column !== 'payout_amount' && column !== 'order_total' });
    if (!read.ok) {
      issues.push({
        severity: 'fatal',
        code: 'amount.unparsable',
        message: `Row ${row.rowIndex + 1}: ${column.replace(/_/g, ' ')} cannot be read (${read.reason}). The batch cannot tie without it.`,
        rowIndex: row.rowIndex,
        rawRow: [...row.cells],
        field: column,
      });
      return null;
    }
    money[column] = read.cents;
  }
  const payoutText = row.get('payout_date');
  const payoutDate = payoutText === '' ? null : readCalendarDate(payoutText);
  if (payoutText !== '' && payoutDate === null) {
    issues.push({
      severity: 'fatal',
      code: 'date.unparsable',
      message: `Row ${row.rowIndex + 1}: payout date "${payoutText}" cannot be read.`,
      rowIndex: row.rowIndex,
      rawRow: [...row.cells],
      field: 'payout_date',
    });
    return null;
  }
  const qtyText = row.get('damaged_qty');
  const damagedQty = qtyText === '' ? 0 : Number(qtyText);
  if (!Number.isInteger(damagedQty) || damagedQty < 0) {
    issues.push({
      severity: 'fatal',
      code: 'faire.damaged_qty',
      message: `Row ${row.rowIndex + 1}: "Quantity Damaged or Missing" is "${qtyText}"; it is a unit count and must be a whole number.`,
      rowIndex: row.rowIndex,
      rawRow: [...row.cells],
    });
    return null;
  }
  if (money.taxes_charged !== 0) {
    issues.push({
      severity: 'warn',
      code: 'faire.taxes_charged',
      message: `Order ${row.get('order_number')}: Faire charged ${formatMoney(money.taxes_charged)} of sales tax as marketplace facilitator. It is Faire's to remit and is not posted to 2200.`,
      rowIndex: row.rowIndex,
    });
  }
  return {
    rowIndex: row.rowIndex,
    cells: row.cells,
    payoutDate,
    orderNumber: row.get('order_number').toUpperCase(),
    currency: (row.get('currency') || 'USD').toUpperCase(),
    damagedQty,
    money,
  };
}

interface Bucket {
  lineType: PayoutLineType;
  role: SettlementRole;
  label: string;
  amountCents: number;
  rowIndexes: number[];
}

function buildBatch(key: string, batch: readonly FaireRow[], candidate: FaireCandidate): ParsedSettlement {
  const [payoutDate, currency] = key.split('|');
  const issues: Issue[] = [];
  const buckets = new Map<string, Bucket>();
  const add = (lineType: PayoutLineType, role: SettlementRole, label: string, amount: number, rowIndex: number) => {
    if (amount === 0) return;
    const bucketKey = `${lineType}|${role}|${label}`;
    const bucket = buckets.get(bucketKey) ?? { lineType, role, label, amountCents: 0, rowIndexes: [] };
    bucket.amountCents += amount;
    bucket.rowIndexes.push(rowIndex);
    buckets.set(bucketKey, bucket);
  };

  for (const row of batch) {
    const m = row.money;
    add('gross_sales', 'channel_sales', 'Order Total', m.order_total, row.rowIndex);
    if (candidate === 'shipping_is_cost') add('shipping_cost', 'outbound_shipping', 'Shipping Costs Applied', -m.shipping, row.rowIndex);
    else add('shipping_income', 'shipping_income', 'Shipping Costs Applied', m.shipping, row.rowIndex);
    if (candidate !== 'net_order_total') add('discount', 'discounts_promotions', 'Promotions Applied', -m.promotions, row.rowIndex);
    add('referral_fee', 'selling_fees', 'Total Commission + New Customer Fee', -(m.total_commission + m.new_customer_fee), row.rowIndex);
    add('processing_fee', 'payment_processing_fees', 'Payment Processing Fees', -m.processing_fees, row.rowIndex);
    add('shipping_cost', 'outbound_shipping', 'Insider Fees Charged to Brand', -m.insider_fees_brand, row.rowIndex);

    const residual = m.payout_amount - expectedPayout(row, candidate);
    if (residual === 0) continue;
    if (row.damagedQty > 0 && residual < 0) {
      add('refund', 'returns_allowances', 'Damaged or missing units (derived)', residual, row.rowIndex);
    } else if (row.damagedQty === 0 && Math.abs(residual) <= PROBE_TOLERANCE_CENTS) {
      add('processing_fee', 'payment_processing_fees', 'Payment Processing Fees', residual, row.rowIndex);
      issues.push({ severity: 'info', code: 'faire.rounding', message: `Order ${row.orderNumber}: a ${formatMoney(residual)} rounding difference was absorbed into processing fees.`, rowIndex: row.rowIndex });
    } else {
      add('adjustment', 'ask_my_accountant', 'Unexplained Faire adjustment', residual, row.rowIndex);
      issues.push({
        severity: 'warn',
        code: 'faire.unexplained_residual',
        message: `Order ${row.orderNumber}: the payout differs from its columns by ${formatMoney(residual)} with ${row.damagedQty} damaged unit(s). It posts to 7900 Ask My Accountant for review.`,
        rowIndex: row.rowIndex,
        rawRow: [...row.cells],
      });
    }
  }

  const reported = sumCents(batch.map((row) => row.money.payout_amount));
  const settlementKey = `faire:${payoutDate}:${currency}`;
  const lines: SettlementLineDraft[] = [...buckets.values()].map((bucket, index) => ({
    lineType: bucket.lineType,
    role: bucket.role,
    amountCents: bucket.amountCents,
    label: bucket.label,
    postedDate: payoutDate,
    externalRef: null,
    sku: null,
    quantity: null,
    jurisdiction: null,
    taxableCents: null,
    taxRegime: null,
    taxSide: null,
    rowIndexes: bucket.rowIndexes,
    fingerprint: sha256([settlementKey, bucket.lineType, bucket.role, bucket.label, bucket.amountCents, index]),
  }));

  const assertions: Assertion[] = [
    assertion('faire.batch_total', 'Σ settlement lines == Σ Payout Amount', reported, sumCents(lines.map((l) => l.amountCents))),
  ];
  if (currency !== 'USD') {
    issues.push({ severity: 'fatal', code: 'faire.currency', message: `Batch ${payoutDate} is in ${currency}; Sooz's books are kept in USD.` });
  }

  return {
    provider: 'faire',
    key: settlementKey,
    periodStart: payoutDate,
    periodEnd: payoutDate,
    depositDate: payoutDate,
    currency,
    reportedNetCents: reported,
    lines,
    assertions,
    issues,
  };
}


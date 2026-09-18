/**
 * Shopify Payments payouts — `docs/formats/shopify.md`.
 *
 * Two files. The **balance transactions** export is the cash: one signed `Amount` per
 * row from the Shopify balance's point of view, a `Fee` that is always positive, and
 * `Net = Amount − Fee`. Rows sharing a `Payout Date` make one payout, and that payout's
 * own `payout` row is the control: `Σ Net (every other row) == −Amount(payout row)`
 * (§6 gotcha 9). The **orders** export is what turns a `charge` into revenue: a charge
 * is product − discounts + shipping + tax + tip, and only the order says which is which.
 *
 * What each row becomes (§7b):
 *
 *   - `charge` → gross sales, discount, shipping income, sales tax, tip, and the gift-card
 *     portion redeemed, from the order; its `Fee` → processing fees. A charge whose order
 *     is not in the orders export cannot be decomposed and the file is refused: guessing
 *     revenue from a card total is the error the whole clearing pattern exists to stop.
 *   - `refund`, `dispute`, `dispute_reversal` → contra-revenue with the tax and shipping
 *     backed out in the order's proportions. Without the order the whole amount goes to
 *     4585 and the line is flagged, because its tax cannot be separated.
 *   - Tax on a `Source = shop_app` order is **marketplace-facilitator tax**: the Shop
 *     channel collects and remits it and withholds it from the payout as an `adjustment`
 *     row. Both halves are `facilitator_tax` and never reach 2200 (§7g).
 *   - `billing_debit` is Shopify's own invoice, never a processing fee (§7f).
 *   - An `adjustment` Shopify does not describe goes to 7900 for review, never guessed.
 *   - An unknown `Type` refuses the file (§2b): a dropped row breaks the payout tie-out.
 *
 * `pending` rows belong to no payout yet and are left for the export that carries them.
 *
 * UNVERIFIED: Sooz has no Shopify store yet. Built from the research document and its
 * synthetic fixtures (§8a / §8b); verify against the first real export before trusting it.
 */

import type { PayoutLineType } from '@/db/schema';
import { readFile } from '@/lib/banking/read-file';
import type { CalendarDate } from '@/lib/dates';
import type { Assertion, Issue } from '@/lib/importers/types';
import { allocateCents, formatMoney, sumCents } from '@/lib/money';

import type { SettlementRole } from './accounts';
import { assertion, headerKey, keyedRows, readCalendarDate, readCents, sha256, type KeyedRow } from './parse-support';
import { stateFromTaxName } from './states';
import {
  type ParsedSettlement,
  type SettlementFile,
  SettlementFormatError,
  type SettlementLineDraft,
  type TaxRegime,
} from './types';

export const SHOPIFY_IMPORTER_ID = 'shopify.payments.balance_transactions';

// ---------------------------------------------------------------------------
// Balance transactions
// ---------------------------------------------------------------------------

type BalanceColumn =
  | 'transaction_date'
  | 'type'
  | 'order'
  | 'card_brand'
  | 'card_source'
  | 'payout_status'
  | 'payout_date'
  | 'available_on'
  | 'checkout'
  | 'payment_method_name'
  | 'presentment_amount'
  | 'presentment_currency'
  | 'amount'
  | 'fee'
  | 'net'
  | 'currency';

const BALANCE_HEADERS: Readonly<Record<string, BalanceColumn>> = Object.freeze({
  transactiondate: 'transaction_date',
  type: 'type',
  order: 'order',
  cardbrand: 'card_brand',
  cardsource: 'card_source',
  payoutstatus: 'payout_status',
  payoutdate: 'payout_date',
  availableon: 'available_on',
  checkout: 'checkout',
  paymentmethodname: 'payment_method_name',
  presentmentamount: 'presentment_amount',
  presentmentcurrency: 'presentment_currency',
  amount: 'amount',
  fee: 'fee',
  net: 'net',
  currency: 'currency',
});

const REQUIRED_BALANCE: readonly BalanceColumn[] = ['transaction_date', 'type', 'amount', 'fee', 'net'];

/** How each `Type` is treated. Anything not listed refuses the file. */
type TypeTreatment =
  | { kind: 'charge' }
  | { kind: 'decompose'; lineType: 'refund' | 'chargeback' | 'chargeback_reversal' }
  | { kind: 'direct'; lineType: PayoutLineType; role: SettlementRole }
  | { kind: 'reserve' }
  | { kind: 'adjustment' }
  | { kind: 'review'; reason: string }
  | { kind: 'payout' };

const TYPES: Readonly<Record<string, TypeTreatment>> = Object.freeze({
  charge: { kind: 'charge' },
  refund: { kind: 'decompose', lineType: 'refund' },
  refund_failure: { kind: 'decompose', lineType: 'refund' },
  dispute: { kind: 'decompose', lineType: 'chargeback' },
  dispute_reversal: { kind: 'decompose', lineType: 'chargeback_reversal' },
  dispute_withdrawal: { kind: 'decompose', lineType: 'chargeback_reversal' },
  chargeback_fee: { kind: 'direct', lineType: 'processing_fee', role: 'payment_processing_fees' },
  chargeback_fee_refund: { kind: 'direct', lineType: 'processing_fee', role: 'payment_processing_fees' },
  chargeback_protection_credit: { kind: 'direct', lineType: 'chargeback_reversal', role: 'returns_allowances' },
  chargeback_protection_debit: { kind: 'direct', lineType: 'chargeback', role: 'returns_allowances' },
  chargeback_hold: { kind: 'reserve' },
  chargeback_hold_release: { kind: 'reserve' },
  reserved_funds: { kind: 'reserve' },
  reserved_funds_reversal: { kind: 'reserve' },
  reserved_funds_withdrawal: { kind: 'reserve' },
  billing_debit: { kind: 'direct', lineType: 'subscription_fee', role: 'platform_fees' },
  billing_debit_reversal: { kind: 'direct', lineType: 'subscription_fee', role: 'platform_fees' },
  shipping_label: { kind: 'direct', lineType: 'shipping_cost', role: 'outbound_shipping' },
  shipping_label_adjustment: { kind: 'direct', lineType: 'shipping_cost', role: 'outbound_shipping' },
  shipping_label_adjustment_base: { kind: 'direct', lineType: 'shipping_cost', role: 'outbound_shipping' },
  shipping_label_adjustment_surcharge: { kind: 'direct', lineType: 'shipping_cost', role: 'outbound_shipping' },
  shipping_return_to_origin_adjustment: { kind: 'direct', lineType: 'shipping_cost', role: 'outbound_shipping' },
  adjustment: { kind: 'adjustment' },
  charge_adjustment: { kind: 'review', reason: 'a correction to an earlier charge' },
  refund_adjustment: { kind: 'review', reason: 'a correction to an earlier refund' },
  tax_adjustment_credit: { kind: 'review', reason: 'a correction to tax already collected, with no state named' },
  tax_adjustment_debit: { kind: 'review', reason: 'a correction to tax already collected, with no state named' },
  payout_failure: { kind: 'review', reason: 'a failed payout returned to the balance; the earlier deposit never arrived' },
  payout_cancellation: { kind: 'review', reason: 'a cancelled payout returned to the balance' },
  customs_duty: { kind: 'review', reason: 'international duties (Managed Markets), which are not revenue' },
  import_tax: { kind: 'review', reason: 'international import tax (Managed Markets)' },
  import_tax_refund: { kind: 'review', reason: 'international import tax (Managed Markets)' },
  import_tax_adjustment: { kind: 'review', reason: 'international import tax (Managed Markets)' },
  transfer: { kind: 'review', reason: 'a transfer between Shopify balances' },
  balance_transfer_inbound: { kind: 'review', reason: 'a transfer between Shopify balances' },
  balance_transfer_outbound: { kind: 'review', reason: 'a transfer between Shopify balances' },
  shop_cash_credit: { kind: 'review', reason: 'Shop Cash campaign funding, whose treatment depends on the campaign terms' },
  shop_cash_billing_debit: { kind: 'review', reason: 'Shop Cash campaign billing' },
  shop_cash_campaign_billing_debit: { kind: 'review', reason: 'Shop Cash campaign billing' },
  advance: { kind: 'review', reason: 'Shopify Capital financing, which is a loan, not revenue' },
  advance_funding: { kind: 'review', reason: 'Shopify Capital financing, which is a loan, not revenue' },
  marketplace_fee_credit: { kind: 'review', reason: 'multi-channel settlement Sooz does not use' },
  markets_pro_credit: { kind: 'review', reason: 'Markets Pro settlement Sooz does not use' },
  payout: { kind: 'payout' },
});

function treatmentOf(type: string): TypeTreatment | null {
  const known = TYPES[type];
  if (known !== undefined) return known;
  if (/^lending_/.test(type)) return { kind: 'review', reason: 'Shopify Capital lending, which is a loan, not revenue' };
  if (/^(channel_|shopify_collective_)/.test(type)) return { kind: 'review', reason: 'multi-channel settlement Sooz does not use' };
  return null;
}

interface BalanceRow {
  readonly rowIndex: number;
  readonly cells: readonly string[];
  readonly type: string;
  readonly date: CalendarDate;
  readonly order: string;
  readonly payoutDate: CalendarDate | null;
  readonly pending: boolean;
  readonly amountCents: number;
  readonly feeCents: number;
  readonly netCents: number;
  readonly currency: string;
  readonly presentmentCents: number | null;
  readonly presentmentCurrency: string | null;
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

export interface ShopifyOrder {
  readonly name: string;
  readonly id: string;
  readonly currency: string;
  /** Σ Lineitem price × quantity: product before discounts. */
  readonly grossCents: number;
  /** Subtotal: product after discounts, before shipping and tax. */
  readonly subtotalCents: number;
  readonly shippingCents: number;
  readonly taxCents: number;
  readonly totalCents: number;
  readonly source: string;
  readonly paymentMethod: string;
  readonly taxLines: ReadonlyArray<{ readonly name: string; readonly cents: number }>;
}

const ORDER_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  name: 'name',
  id: 'id',
  currency: 'currency',
  subtotal: 'subtotal',
  shipping: 'shipping',
  taxes: 'taxes',
  total: 'total',
  discountamount: 'discount_amount',
  lineitemquantity: 'line_quantity',
  lineitemprice: 'line_price',
  lineitemdiscount: 'line_discount',
  paymentmethod: 'payment_method',
  source: 'source',
  financialstatus: 'financial_status',
});

function orderHeader(key: string): string | null {
  const known = ORDER_HEADERS[key];
  if (known !== undefined) return known;
  const tax = /^tax(\d+)(name|value)$/.exec(key);
  return tax === null ? null : `tax_${tax[1]}_${tax[2]}`;
}

/** Groups the orders export by `Name`, taking each order-level field from its first non-empty cell (§6 gotcha 14). */
export function parseShopifyOrders(rows: readonly (readonly string[])[], issues: Issue[]): Map<string, ShopifyOrder> {
  const headerIndex = rows.findIndex((row) => row.some((c) => headerKey(c) === 'name') && row.some((c) => headerKey(c) === 'subtotal'));
  if (headerIndex === -1) {
    throw new SettlementFormatError(
      'shopify.orders_header',
      'The orders file has no Shopify orders export header (Name, Subtotal, …).',
      'Export Orders → Export → "All columns" from the Shopify admin for the dates the payout covers.',
    );
  }
  const { rows: keyed, columns } = keyedRows(rows[headerIndex], rows.slice(headerIndex + 1), orderHeader);
  const taxIndexes = [...columns.keys()]
    .map((key) => /^tax_(\d+)_name$/.exec(key))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => m[1]);

  const groups = new Map<string, KeyedRow[]>();
  for (const row of keyed) {
    const name = row.get('name');
    if (name === '') continue;
    const group = groups.get(name) ?? [];
    group.push(row);
    groups.set(name, group);
  }

  const orders = new Map<string, ShopifyOrder>();
  for (const [name, group] of groups) {
    const first = (key: string) => group.map((row) => row.get(key)).find((value) => value !== '') ?? '';
    const money = (key: string): number => {
      const read = readCents(first(key), { blankIsZero: true });
      if (!read.ok) {
        issues.push({ severity: 'error', code: 'shopify.order_amount', message: `Order ${name}: ${key} cannot be read (${read.reason}).` });
        return 0;
      }
      return read.cents;
    };
    let gross = 0;
    let lineDiscounts = 0;
    for (const row of group) {
      const price = readCents(row.get('line_price'), { blankIsZero: true });
      const qty = Number(row.get('line_quantity') || '0');
      const discount = readCents(row.get('line_discount'), { blankIsZero: true });
      if (!price.ok || !Number.isInteger(qty) || !discount.ok) {
        issues.push({ severity: 'error', code: 'shopify.order_line', message: `Order ${name}: a line item's price, quantity or discount cannot be read.`, rowIndex: row.rowIndex, rawRow: [...row.cells] });
        continue;
      }
      gross += price.cents * qty;
      lineDiscounts += discount.cents;
    }
    const subtotal = money('subtotal');
    if (gross - lineDiscounts !== subtotal) {
      issues.push({
        severity: 'warn',
        code: 'shopify.order_subtotal',
        message: `Order ${name}: line items (${formatMoney(gross)}) less line discounts (${formatMoney(lineDiscounts)}) do not equal the subtotal ${formatMoney(subtotal)}. The discount is taken as gross − subtotal.`,
      });
    }
    const taxLines = taxIndexes
      .map((index) => {
        const taxName = first(`tax_${index}_name`);
        const value = readCents(first(`tax_${index}_value`), { blankIsZero: true });
        return { name: taxName, cents: value.ok ? value.cents : 0 };
      })
      .filter((line) => line.name !== '' || line.cents !== 0);

    orders.set(name, {
      name,
      id: first('id'),
      currency: (first('currency') || 'USD').toUpperCase(),
      grossCents: gross,
      subtotalCents: subtotal,
      shippingCents: money('shipping'),
      taxCents: money('taxes'),
      totalCents: money('total'),
      source: first('source').toLowerCase(),
      paymentMethod: first('payment_method').toLowerCase(),
      taxLines,
    });
  }
  return orders;
}

// ---------------------------------------------------------------------------
// Decomposition
// ---------------------------------------------------------------------------

/** `value × numerator ÷ denominator`, half away from zero, in integers. */
function scale(value: number, numerator: number, denominator: number): number {
  if (numerator === denominator) return value;
  const zero = BigInt(0);
  const two = BigInt(2);
  const product = BigInt(value) * BigInt(numerator);
  const den = BigInt(denominator);
  const negative = product < zero !== den < zero;
  const absProduct = product < zero ? -product : product;
  const absDen = den < zero ? -den : den;
  const quotient = (absProduct * two + absDen) / (absDen * two);
  return Number(negative ? -quotient : quotient);
}

interface Components {
  /** Product before discounts. */
  grossCents: number;
  discountCents: number;
  shippingCents: number;
  taxCents: number;
  tipCents: number;
  /** Paid off-gateway by gift card: a liability redeemed, not cash. */
  giftCardCents: number;
}

/**
 * The payout-currency components of a charge. `charge.amountCents` is authoritative;
 * converted components are rounded and the tip, recoverable only as a residual (§6
 * gotcha 16), absorbs nothing but the tip itself — when the order has no tip, rounding
 * lands in gross sales instead.
 */
function chargeComponents(order: ShopifyOrder, charge: BalanceRow, issues: Issue[]): Components {
  const discount = order.grossCents - order.subtotalCents;
  const presentmentTip = order.totalCents - order.subtotalCents - order.shippingCents - order.taxCents;
  const foreign =
    charge.presentmentCents !== null &&
    charge.presentmentCurrency !== null &&
    charge.presentmentCurrency !== charge.currency;

  if (!foreign) {
    const giftCard = order.totalCents - charge.amountCents;
    if (giftCard !== 0 && !order.paymentMethod.includes('gift_card')) {
      issues.push({
        severity: 'warn',
        code: 'shopify.charge_differs_from_total',
        message: `Order ${order.name}: the charge (${formatMoney(charge.amountCents)}) differs from the order total (${formatMoney(order.totalCents)}) with no gift card on the order. The difference is treated as a gift-card redemption; confirm it.`,
        rowIndex: charge.rowIndex,
      });
    }
    return {
      grossCents: order.grossCents,
      discountCents: discount,
      shippingCents: order.shippingCents,
      taxCents: order.taxCents,
      tipCents: presentmentTip,
      giftCardCents: giftCard,
    };
  }

  // Convert at the charge's own implied rate so the decomposition ties to the cent (§6 gotcha 17).
  const presentment = charge.presentmentCents ?? charge.amountCents;
  const convert = (cents: number) => scale(cents, charge.amountCents, presentment);
  const gross = convert(order.grossCents);
  const disc = convert(discount);
  const shipping = convert(order.shippingCents);
  const tax = convert(order.taxCents);
  const residual = charge.amountCents - (gross - disc + shipping + tax);
  return presentmentTip === 0
    ? { grossCents: gross + residual, discountCents: disc, shippingCents: shipping, taxCents: tax, tipCents: 0, giftCardCents: 0 }
    : { grossCents: gross, discountCents: disc, shippingCents: shipping, taxCents: tax, tipCents: residual, giftCardCents: 0 };
}

interface TaxTarget {
  readonly regime: TaxRegime;
  readonly state: string | null;
  readonly label: string;
}

function taxTargetOf(order: ShopifyOrder): TaxTarget {
  const names = order.taxLines.map((line) => line.name).filter((n) => n !== '');
  for (const name of names) {
    const state = stateFromTaxName(name);
    if (state !== null) return { regime: 'us_state', state, label: names.join(', ') };
  }
  if (names.length > 0) return { regime: 'foreign', state: null, label: names.join(', ') };
  return { regime: 'unknown', state: null, label: 'no tax jurisdiction on the order' };
}

function isFacilitatorOrder(order: ShopifyOrder): boolean {
  // Since 2025-01-01 the Shop channel is the marketplace facilitator for its US orders (§7g).
  return order.source === 'shop_app';
}

// ---------------------------------------------------------------------------
// Line accumulation
// ---------------------------------------------------------------------------

interface Bucket {
  lineType: PayoutLineType;
  role: SettlementRole;
  label: string;
  amountCents: number;
  taxableCents: number;
  jurisdiction: string | null;
  taxRegime: TaxRegime | null;
  taxSide: 'collected' | 'withheld' | null;
  rowIndexes: number[];
}

class LineBook {
  private readonly buckets = new Map<string, Bucket>();

  add(
    lineType: PayoutLineType,
    role: SettlementRole,
    label: string,
    amountCents: number,
    rowIndex: number,
    tax: { jurisdiction: string | null; regime: TaxRegime; taxableCents: number; side: 'collected' | 'withheld' } | null = null,
  ): void {
    if (amountCents === 0) return;
    const key = `${lineType}|${role}|${label}|${tax?.jurisdiction ?? ''}|${tax?.regime ?? ''}|${tax?.side ?? ''}`;
    const bucket = this.buckets.get(key) ?? {
      lineType,
      role,
      label,
      amountCents: 0,
      taxableCents: 0,
      jurisdiction: tax?.jurisdiction ?? null,
      taxRegime: tax?.regime ?? null,
      taxSide: tax?.side ?? null,
      rowIndexes: [],
    };
    bucket.amountCents += amountCents;
    bucket.taxableCents += tax?.taxableCents ?? 0;
    if (!bucket.rowIndexes.includes(rowIndex)) bucket.rowIndexes.push(rowIndex);
    this.buckets.set(key, bucket);
  }

  lines(settlementKey: string, date: CalendarDate): SettlementLineDraft[] {
    return [...this.buckets.values()]
      .filter((bucket) => bucket.amountCents !== 0)
      .map((bucket, index) => ({
        lineType: bucket.lineType,
        role: bucket.role,
        amountCents: bucket.amountCents,
        label: bucket.label,
        postedDate: date,
        externalRef: null,
        sku: null,
        quantity: null,
        jurisdiction: bucket.jurisdiction,
        taxableCents: bucket.taxRegime === null ? null : bucket.taxableCents,
        taxRegime: bucket.taxRegime,
        taxSide: bucket.taxSide,
        rowIndexes: [...bucket.rowIndexes].sort((a, b) => a - b),
        fingerprint: sha256([settlementKey, bucket.lineType, bucket.role, bucket.label, bucket.jurisdiction, bucket.amountCents, index]),
      }));
  }
}

function addTax(
  book: LineBook,
  order: ShopifyOrder,
  taxCents: number,
  taxableCents: number,
  rowIndex: number,
): void {
  if (taxCents === 0) return;
  const target = taxTargetOf(order);
  const where = target.state ?? target.label;
  if (isFacilitatorOrder(order)) {
    book.add('facilitator_tax', 'facilitator_tax', `Marketplace facilitator tax (Shop app) — ${where}`, taxCents, rowIndex, {
      jurisdiction: target.state,
      regime: target.regime,
      taxableCents,
      side: 'collected',
    });
    return;
  }
  book.add('sales_tax_collected', 'sales_tax_payable', `Sales tax collected — ${where}`, taxCents, rowIndex, {
    jurisdiction: target.state,
    regime: target.regime,
    taxableCents,
    side: 'collected',
  });
}

/** A refund, dispute or reversal of `row.amountCents`, split in the order's own proportions. */
function decompose(
  book: LineBook,
  row: BalanceRow,
  lineType: 'refund' | 'chargeback' | 'chargeback_reversal',
  order: ShopifyOrder | undefined,
  charge: Components | undefined,
  issues: Issue[],
): void {
  const label =
    lineType === 'refund' ? 'Refunds' : lineType === 'chargeback' ? 'Chargebacks (disputes lost or pending)' : 'Chargebacks won back';
  if (order === undefined || charge === undefined) {
    book.add(lineType, 'returns_allowances', label, row.amountCents, row.rowIndex);
    issues.push({
      severity: 'warn',
      code: 'shopify.undecomposed',
      message: `${row.type} ${row.order || '(no order)'} (${formatMoney(row.amountCents)}): the order is not in the orders export, so its sales tax and shipping cannot be separated. The whole amount posts to 4585; export the original order to split it.`,
      rowIndex: row.rowIndex,
    });
    return;
  }

  const product = charge.grossCents - charge.discountCents;
  const weights = [product, charge.shippingCents, charge.taxCents, charge.tipCents].map((w) => Math.max(w, 0));
  const chargeTotal = sumCents(weights);
  const full = Math.abs(row.amountCents) === chargeTotal;
  const sign = row.amountCents < 0 ? -1 : 1;
  const parts = chargeTotal === 0 ? [Math.abs(row.amountCents), 0, 0, 0] : allocateCents(Math.abs(row.amountCents), weights);
  if (!full) {
    issues.push({
      severity: 'warn',
      code: 'shopify.partial_refund_allocated',
      message: `${row.type} ${order.name} (${formatMoney(row.amountCents)}) is not the whole order; it was split across product, shipping, tax and tip in the order's proportions. Confirm against the refund in Shopify.`,
      rowIndex: row.rowIndex,
    });
  }
  const [productPart, shippingPart, taxPart, tipPart] = parts.map((part) => sign * part);
  book.add(lineType, 'returns_allowances', label, productPart, row.rowIndex);
  book.add('shipping_income', 'shipping_income', 'Shipping charged to customers', shippingPart, row.rowIndex);
  addTax(book, order, taxPart, productPart, row.rowIndex);
  book.add('tip', 'other_sales_income', 'Tips', tipPart, row.rowIndex);
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

export interface ShopifyParseInput {
  readonly balance: { readonly filename: string; readonly bytes: Uint8Array };
  /** The orders export covering the payout's charges. Without it no charge can be decomposed. */
  readonly orders?: { readonly filename: string; readonly bytes: Uint8Array };
}

function readBalanceRow(row: KeyedRow, issues: Issue[]): BalanceRow | null {
  const raw = [...row.cells];
  const type = row.get('type').toLowerCase();
  const date = readCalendarDate(row.get('transaction_date'));
  const amount = readCents(row.get('amount'));
  const fee = readCents(row.get('fee'));
  const net = readCents(row.get('net'));
  if (date === null || !amount.ok || !fee.ok || !net.ok) {
    issues.push({
      severity: 'fatal',
      code: 'row.unreadable',
      message: `Row ${row.rowIndex + 2}: the date, amount, fee or net cannot be read. The payout cannot tie without it.`,
      rowIndex: row.rowIndex,
      rawRow: raw,
    });
    return null;
  }
  if (net.cents !== amount.cents - fee.cents) {
    issues.push({
      severity: 'fatal',
      code: 'shopify.net_identity',
      message: `Row ${row.rowIndex + 2}: Net ${formatMoney(net.cents)} is not Amount ${formatMoney(amount.cents)} − Fee ${formatMoney(fee.cents)}. The file has been misread or edited.`,
      rowIndex: row.rowIndex,
      rawRow: raw,
    });
    return null;
  }
  const status = row.get('payout_status').toLowerCase();
  const payoutText = row.get('payout_date');
  const presentment = row.get('presentment_amount') === '' ? null : readCents(row.get('presentment_amount'));
  return {
    rowIndex: row.rowIndex,
    cells: row.cells,
    type,
    date,
    order: row.get('order'),
    payoutDate: payoutText === '' ? null : readCalendarDate(payoutText),
    pending: status === 'pending' || payoutText === '',
    amountCents: amount.cents,
    feeCents: fee.cents,
    netCents: net.cents,
    currency: (row.get('currency') || 'USD').toUpperCase(),
    presentmentCents: presentment !== null && presentment.ok ? presentment.cents : null,
    presentmentCurrency: row.get('presentment_currency') === '' ? null : row.get('presentment_currency').toUpperCase(),
  };
}

/**
 * Parses a balance transactions export (and the orders export behind it) into payouts.
 *
 * @throws {SettlementFormatError} not a balance transactions export, or the orders file
 *   is not an orders export.
 */
export async function parseShopifyPayouts(input: ShopifyParseInput): Promise<SettlementFile> {
  const file = await readFile(input.balance.bytes, input.balance.filename);
  const issues: Issue[] = [];

  const headerIndex = file.rows.findIndex((row) => row.filter((name) => BALANCE_HEADERS[headerKey(name)] !== undefined).length >= 5);
  if (headerIndex !== 0) {
    throw new SettlementFormatError(
      'shopify.header',
      headerIndex === -1
        ? 'This is not a Shopify Payments balance transactions export.'
        : 'The file has rows above its header; Shopify exports never do, so it has been edited.',
      'Export Finance → Payouts → (the payout) → Export transactions from the Shopify admin.',
    );
  }
  const { rows: keyed, columns } = keyedRows(file.rows[0], file.rows.slice(1), (key) => BALANCE_HEADERS[key] ?? null);
  const missing = REQUIRED_BALANCE.filter((column) => !columns.has(column));
  if (missing.length > 0) {
    throw new SettlementFormatError(
      'shopify.missing_columns',
      `The export lacks required column(s): ${missing.join(', ')}.`,
      'Export the balance transactions again with all columns.',
    );
  }

  const orders = new Map<string, ShopifyOrder>();
  if (input.orders !== undefined) {
    const ordersFile = await readFile(input.orders.bytes, input.orders.filename);
    for (const [name, order] of parseShopifyOrders(ordersFile.rows, issues)) orders.set(name, order);
  }

  const rows: BalanceRow[] = [];
  for (const row of keyed) {
    const parsed = readBalanceRow(row, issues);
    if (parsed === null) continue;
    if (treatmentOf(parsed.type) === null) {
      issues.push({
        severity: 'fatal',
        code: 'shopify.unknown_type',
        message: `Row ${row.rowIndex + 2}: transaction type "${parsed.type}" is not one this importer knows. Dropping it would break the payout tie-out, so nothing was imported.`,
        rowIndex: row.rowIndex,
        rawRow: [...row.cells],
        remedy: 'Add the type to the Shopify importer with its accounting treatment.',
      });
      continue;
    }
    rows.push(parsed);
  }

  const pending = rows.filter((row) => row.pending);
  if (pending.length > 0) {
    issues.push({
      severity: 'info',
      code: 'shopify.pending_rows',
      message: `${pending.length} row(s) are pending and belong to no payout yet (${formatMoney(sumCents(pending.map((r) => r.netCents)))} net). They import with the payout that carries them.`,
    });
  }

  const groups = new Map<string, BalanceRow[]>();
  for (const row of rows) {
    if (row.pending || row.payoutDate === null) continue;
    const key = `${row.payoutDate}|${row.currency}`;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }

  const settlements: ParsedSettlement[] = [];
  for (const [key, group] of groups) {
    settlements.push(buildPayout(key, group, orders));
  }
  settlements.sort((a, b) => (a.periodEnd < b.periodEnd ? -1 : a.periodEnd > b.periodEnd ? 1 : 0));

  const ok =
    !issues.some((issue) => issue.severity === 'fatal' || issue.severity === 'error') &&
    settlements.every(
      (s) => s.assertions.every((a) => a.passed || a.severity !== 'fatal') && !s.issues.some((i) => i.severity === 'fatal'),
    );

  return {
    importerId: SHOPIFY_IMPORTER_ID,
    provider: 'shopify',
    filename: input.balance.filename,
    fileHash: file.sha256,
    settlements,
    issues,
    rowCount: keyed.length,
    ok,
  };
}

function buildPayout(key: string, group: readonly BalanceRow[], orders: ReadonlyMap<string, ShopifyOrder>): ParsedSettlement {
  const [payoutDate, currency] = key.split('|');
  const issues: Issue[] = [];
  const book = new LineBook();

  const controls = group.filter((row) => row.type === 'payout');
  const activity = group.filter((row) => row.type !== 'payout');
  if (controls.length !== 1) {
    issues.push({
      severity: 'fatal',
      code: 'shopify.payout_row',
      message:
        controls.length === 0
          ? `Payout ${payoutDate} has no payout row in this file, so its total cannot be confirmed.`
          : `Payout ${payoutDate} has ${controls.length} payout rows; one payout date must carry exactly one.`,
      remedy: 'Export the payout from Finance → Payouts so the file holds the whole payout.',
    });
  }
  if (currency !== 'USD') {
    issues.push({ severity: 'fatal', code: 'shopify.currency', message: `Payout ${payoutDate} is in ${currency}; Sooz's books are kept in USD.` });
  }
  const reported = controls.length === 1 ? -controls[0].amountCents : sumCents(activity.map((row) => row.netCents));

  // The components of each order's charge in this payout, reused to split its refunds.
  const chargeByOrder = new Map<string, Components>();
  for (const row of activity) {
    if (row.type !== 'charge') continue;
    const order = orders.get(row.order);
    if (order === undefined) {
      issues.push({
        severity: 'fatal',
        code: 'shopify.order_missing',
        message: `Charge ${row.order || '(no order)'} (${formatMoney(row.amountCents)}) has no order in the orders export, so its sales, discount, shipping and tax cannot be told apart.`,
        rowIndex: row.rowIndex,
        remedy: 'Upload the orders export covering this payout alongside the balance transactions.',
      });
      continue;
    }
    chargeByOrder.set(order.name, chargeComponents(order, row, issues));
  }

  for (const row of activity) {
    const treatment = treatmentOf(row.type);
    if (treatment === null) continue;
    const order = orders.get(row.order);

    if (row.feeCents !== 0) {
      book.add('processing_fee', 'payment_processing_fees', 'Shopify Payments fees', -row.feeCents, row.rowIndex);
      if (row.type === 'refund') {
        issues.push({ severity: 'warn', code: 'shopify.refund_fee', message: `Refund ${row.order}: carries a fee of ${formatMoney(row.feeCents)}; Shopify does not normally charge one on a refund.`, rowIndex: row.rowIndex });
      }
    }

    switch (treatment.kind) {
      case 'charge': {
        const components = order === undefined ? undefined : chargeByOrder.get(order.name);
        if (order === undefined || components === undefined) break;
        book.add('gross_sales', 'channel_sales', 'Gross sales', components.grossCents, row.rowIndex);
        book.add('discount', 'discounts_promotions', 'Discounts', -components.discountCents, row.rowIndex);
        book.add('shipping_income', 'shipping_income', 'Shipping charged to customers', components.shippingCents, row.rowIndex);
        addTax(book, order, components.taxCents, components.grossCents - components.discountCents, row.rowIndex);
        book.add('tip', 'other_sales_income', 'Tips', components.tipCents, row.rowIndex);
        book.add('gift_card', 'gift_card_liability', 'Gift cards redeemed', -components.giftCardCents, row.rowIndex);
        break;
      }
      case 'decompose':
        decompose(book, row, treatment.lineType, order, order === undefined ? undefined : chargeByOrder.get(order.name) ?? componentsFromOrder(order), issues);
        break;
      case 'direct':
        book.add(treatment.lineType, treatment.role, labelForType(row.type), row.amountCents, row.rowIndex);
        break;
      case 'reserve':
        book.add(row.amountCents < 0 ? 'reserve_held' : 'reserve_released', 'reserve_receivable', 'Shopify reserve', row.amountCents, row.rowIndex);
        break;
      case 'adjustment': {
        const target = order === undefined ? null : taxTargetOf(order);
        if (order !== undefined && isFacilitatorOrder(order) && Math.abs(row.amountCents) === Math.abs(chargeByOrder.get(order.name)?.taxCents ?? order.taxCents)) {
          book.add('facilitator_tax', 'facilitator_tax', `Marketplace facilitator tax withheld by Shopify — ${target?.state ?? target?.label ?? ''}`, row.amountCents, row.rowIndex, {
            jurisdiction: target?.state ?? null,
            regime: target?.regime ?? 'unknown',
            taxableCents: 0,
            side: 'withheld',
          });
          break;
        }
        book.add('adjustment', 'ask_my_accountant', 'Shopify adjustments (unexplained)', row.amountCents, row.rowIndex);
        issues.push({
          severity: 'warn',
          code: 'shopify.adjustment',
          message: `Adjustment ${row.order || '(no order)'} (${formatMoney(row.amountCents)}): Shopify does not say what it is. It posts to 7900 Ask My Accountant; resolve it from the payout detail screen.`,
          rowIndex: row.rowIndex,
        });
        break;
      }
      case 'review':
        book.add('other', 'ask_my_accountant', labelForType(row.type), row.amountCents, row.rowIndex);
        issues.push({
          severity: 'warn',
          code: 'shopify.review',
          message: `${row.type} (${formatMoney(row.amountCents)}) is ${treatment.reason}. It posts to 7900 Ask My Accountant for review.`,
          rowIndex: row.rowIndex,
        });
        break;
      case 'payout':
        break;
    }
  }

  const settlementKey = `shopify:${currency}:${payoutDate}:${reported}`;
  const lines = book.lines(settlementKey, payoutDate);
  const dates = group.map((row) => row.date).sort();
  const assertions: Assertion[] = [
    assertion('shopify.payout_tie_out', 'Σ Net (payout rows) == −payout Amount', reported, sumCents(activity.map((row) => row.netCents))),
    assertion('shopify.lines_equal_payout', 'Σ settlement lines == payout', reported, sumCents(lines.map((l) => l.amountCents))),
    assertion(
      'shopify.facilitator_nets_to_zero',
      'Shop app facilitator tax collected − withheld',
      0,
      sumCents(lines.filter((l) => l.lineType === 'facilitator_tax').map((l) => l.amountCents)),
      'warn',
    ),
  ];

  return {
    provider: 'shopify',
    key: settlementKey,
    periodStart: dates[0] ?? payoutDate,
    periodEnd: payoutDate,
    depositDate: payoutDate,
    currency,
    reportedNetCents: reported,
    lines,
    assertions,
    issues,
  };
}

/** Components of an order whose charge is in an earlier payout: its refunds split the same way. */
function componentsFromOrder(order: ShopifyOrder): Components | undefined {
  if (order.currency !== 'USD') return undefined;
  return {
    grossCents: order.grossCents,
    discountCents: order.grossCents - order.subtotalCents,
    shippingCents: order.shippingCents,
    taxCents: order.taxCents,
    tipCents: order.totalCents - order.subtotalCents - order.shippingCents - order.taxCents,
    giftCardCents: 0,
  };
}

function labelForType(type: string): string {
  switch (type) {
    case 'chargeback_fee':
    case 'chargeback_fee_refund':
      return 'Chargeback fees';
    case 'billing_debit':
    case 'billing_debit_reversal':
      return 'Shopify bill deducted from payout';
    case 'shipping_label':
    case 'shipping_label_adjustment':
    case 'shipping_label_adjustment_base':
    case 'shipping_label_adjustment_surcharge':
    case 'shipping_return_to_origin_adjustment':
      return 'Shipping labels';
    case 'chargeback_protection_credit':
    case 'chargeback_protection_debit':
      return 'Shopify Protect';
    default:
      return `Shopify ${type.replace(/_/g, ' ')}`;
  }
}

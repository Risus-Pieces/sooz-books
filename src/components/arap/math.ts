/**
 * The arithmetic behind the invoice, bill, receipt and payment forms.
 *
 * The forms show a running total before anything reaches the server, and that
 * total has to be the one the engine will compute — so line extension here is
 * the same exact-decimal rule the engine uses (quantity to four places times
 * whole cents, rounded half away from zero, through BigInt), never a float.
 * Pure: no React, no network, no clock.
 */

import { daysBetween, isCalendarDate } from '@/lib/dates';
import { parseMoney } from '@/lib/money';

const QUANTITY = /^\d+(?:\.\d{1,4})?$/;
const SCALE = BigInt(10_000);
const HALF = BigInt(5_000);

/** Quantity text as a scaled integer (× 10,000), or null when it is not a quantity. */
export function scaledQuantity(text: string): bigint | null {
  const trimmed = text.trim().replace(/,/g, '');
  if (!QUANTITY.test(trimmed)) return null;
  const [whole, fraction = ''] = trimmed.split('.');
  return BigInt(whole) * SCALE + BigInt(fraction.padEnd(4, '0'));
}

/** round(quantity × unit), in cents, or null when the quantity cannot be read. */
export function extendCents(quantityText: string, unitCents: number): number | null {
  const scaled = scaledQuantity(quantityText);
  if (scaled === null) return null;
  const product = scaled * BigInt(unitCents);
  const negative = product < BigInt(0);
  const magnitude = negative ? -product : product;
  const rounded = (magnitude + HALF) / SCALE;
  return Number(negative ? -rounded : rounded);
}

export interface MoneyParse {
  /** Null for an empty field. */
  cents: number | null;
  error: string | null;
}

/** Reads a typed amount. Blank is not an error; unreadable text is. */
export function readMoney(text: string, options: { allowNegative?: boolean } = {}): MoneyParse {
  if (text.trim() === '') return { cents: null, error: null };
  try {
    const cents = parseMoney(text);
    if (cents < 0 && !options.allowNegative) return { cents: null, error: 'Enter a positive amount.' };
    return { cents, error: null };
  } catch {
    return { cents: null, error: 'Not an amount.' };
  }
}

/** round(amount × pct / 100) for a two-place percentage such as "2.00". */
export function percentOfCents(amountCents: number, pct: string): number {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(pct.trim());
  if (match === null) return 0;
  const hundredths = BigInt(match[1]) * BigInt(100) + BigInt((match[2] ?? '').padEnd(2, '0'));
  return Number((BigInt(amountCents) * hundredths + HALF) / SCALE);
}

/**
 * The early-payment discount the terms allow on an invoice paid on `paidOn`:
 * the percentage of the invoice total, if paid within the discount window.
 * Mirrors `allowedDiscountCents` in the engine, which has the final say.
 */
export function allowedDiscount(
  terms: { termsDiscountPct: string; termsDiscountDays: number },
  invoice: { date: string; totalCents: number },
  paidOn: string,
): number {
  if (terms.termsDiscountDays <= 0 || !isCalendarDate(paidOn)) return 0;
  if (daysBetween(invoice.date, paidOn) > terms.termsDiscountDays) return 0;
  return percentOfCents(invoice.totalCents, terms.termsDiscountPct);
}

/** "2/10 net 30", "Net 30", "Due on receipt". */
export function termsLabel(netDays: number, discountPct = '0', discountDays = 0): string {
  const net = netDays === 0 ? 'Due on receipt' : `Net ${netDays}`;
  const pct = Number(discountPct);
  if (!(pct > 0) || discountDays <= 0) return net;
  const pctText = discountPct.replace(/\.?0+$/, '');
  return `${pctText}/${discountDays} ${net.toLowerCase()}`;
}

/**
 * Spreads `amount` across open documents oldest-due first — how a bookkeeper
 * applies a lump payment when the remittance does not say otherwise.
 */
export function applyOldestFirst(
  amountCents: number,
  docs: readonly { id: string; dueDate: string; balanceCents: number }[],
): Map<string, number> {
  const ordered = [...docs].sort((a, b) => (a.dueDate === b.dueDate ? 0 : a.dueDate < b.dueDate ? -1 : 1));
  const out = new Map<string, number>();
  let left = amountCents;
  for (const doc of ordered) {
    if (left <= 0) break;
    const take = Math.min(left, doc.balanceCents);
    if (take > 0) out.set(doc.id, take);
    left -= take;
  }
  return out;
}

export interface InvoiceTotalsInput {
  lines: readonly { quantity: string; unitPriceCents: number; discountCents: number; taxCents: number }[];
  discountCents: number;
  shippingCents: number;
}

export interface InvoiceTotals {
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  shippingCents: number;
  totalCents: number;
}

/** The header figures the engine will write, from the lines as entered. */
export function invoiceTotals(input: InvoiceTotalsInput): InvoiceTotals {
  let subtotal = 0;
  let lineDiscounts = 0;
  let tax = 0;
  for (const line of input.lines) {
    subtotal += extendCents(line.quantity, line.unitPriceCents) ?? 0;
    lineDiscounts += line.discountCents;
    tax += line.taxCents;
  }
  const discount = lineDiscounts + input.discountCents;
  return {
    subtotalCents: subtotal,
    discountCents: discount,
    taxCents: tax,
    shippingCents: input.shippingCents,
    totalCents: subtotal - discount + input.shippingCents + tax,
  };
}

/** Days past due as of `asOf`; zero or negative while not yet due. */
export function daysPastDue(dueDate: string, asOf: string): number {
  return daysBetween(dueDate, asOf);
}

import { z } from 'zod';

import { isCalendarDate } from '@/lib/dates';
import { parseMoney, sumCents } from '@/lib/money';

import type { ExtractedReceipt } from './types';

/**
 * What the model is asked to fill in.
 *
 * Amounts are strings on purpose. A JSON number is a float, and a float has no place near a
 * ledger. They are read with `parseMoney`, which refuses what it cannot make sense of. The
 * `.describe()` text reaches the model as part of the JSON schema.
 */
export const extractionSchema = z.object({
  legible: z
    .boolean()
    .describe('False when the photo is too blurry, cropped or dark to read the total with confidence.'),
  vendorName: z.string().nullable().describe('The merchant as printed, without the address. Null if there is none.'),
  date: z.string().nullable().describe('The purchase date as YYYY-MM-DD. Null if the receipt shows no date.'),
  subtotal: z.string().nullable().describe('The amount before tax and tip, as printed, e.g. "38.00". Null if absent.'),
  tax: z.string().nullable().describe('Sales tax charged, e.g. "3.10". Null if none.'),
  tip: z.string().nullable().describe('Tip or gratuity, e.g. "5.00". Null if none.'),
  total: z.string().nullable().describe('The total paid, as printed. Null only when it cannot be read.'),
  cardLast4: z
    .string()
    .nullable()
    .describe('The last four digits of the card if printed. Never any other digits of a card number.'),
  items: z.array(
    z.object({
      description: z.string(),
      amount: z.string().describe('The line amount, e.g. "12.50". Negative for a discount.'),
      accountCode: z
        .string()
        .nullable()
        .describe('One code from the list of accounts you were given, or null if none clearly fits.'),
    }),
  ),
});

export type RawExtraction = z.infer<typeof extractionSchema>;

/** The receipt says something that is not an amount. Carries words a member can act on. */
export class UnparseableReceiptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnparseableReceiptError';
  }
}

function amount(what: string, value: string | null): number | null {
  if (value === null || value.trim() === '') return null;
  try {
    return parseMoney(value);
  } catch {
    throw new UnparseableReceiptError(`The ${what} on the receipt (“${value}”) is not an amount.`);
  }
}

/** Raw model output to cents. A date that is not a real calendar date becomes null, never a guess. */
export function parseExtraction(raw: RawExtraction): ExtractedReceipt {
  const vendorName = raw.vendorName?.trim() ? raw.vendorName.trim() : null;
  const date = raw.date !== null && isCalendarDate(raw.date.trim()) ? raw.date.trim() : null;
  const cardLast4 = raw.cardLast4 !== null && /^\d{4}$/.test(raw.cardLast4.trim()) ? raw.cardLast4.trim() : null;

  return {
    legible: raw.legible,
    vendorName,
    date,
    subtotalCents: amount('subtotal', raw.subtotal),
    taxCents: amount('tax', raw.tax) ?? 0,
    tipCents: amount('tip', raw.tip) ?? 0,
    totalCents: amount('total', raw.total),
    cardLast4,
    items: raw.items.map((item) => ({
      description: item.description.trim() || 'Item',
      cents: amount('line item', item.amount) ?? 0,
      accountCode: item.accountCode?.trim() ? item.accountCode.trim() : null,
    })),
  };
}

/**
 * Do the line items account for the total, either as printed or with tax and tip on top?
 * Code decides this, never the model: a misread digit is exactly what this catches.
 */
export function itemsExplainTotal(receipt: ExtractedReceipt): boolean {
  if (receipt.totalCents === null || receipt.items.length === 0) return false;
  const items = sumCents(receipt.items.map((item) => item.cents));
  return items === receipt.totalCents || items + receipt.taxCents + receipt.tipCents === receipt.totalCents;
}

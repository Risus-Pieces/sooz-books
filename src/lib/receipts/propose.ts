import { type CalendarDate, daysBetween } from '@/lib/dates';
import { allocateCents, sumCents } from '@/lib/money';

import { itemsExplainTotal } from './extract-schema';
import type { ExtractedReceipt, ProposalLine, ReceiptWarning, WarningCode } from './types';

export interface BuildInput {
  extracted: ExtractedReceipt;
  /** Account code to account id, for the accounts a receipt may post to. */
  idByCode: ReadonlyMap<string, string>;
  /** The vendor's default or most recent account. When known, it wins over the model's pick. */
  vendorAccountId: string | null;
}

export interface Built {
  lines: ProposalLine[];
  notes: ReceiptWarning[];
}

const note = (code: WarningCode, message: string, blocking: boolean): ReceiptWarning => ({ code, message, blocking });

/**
 * Turns what the receipt says into the debits the entry will carry.
 *
 * The total on the receipt is the ground truth for the cash that left, so the lines always add up
 * to it exactly. Tax and tip are part of the cost and are shared across the items in proportion.
 * When the items cannot account for the total, the result is one honest line for the total, not
 * an itemisation that does not add up.
 *
 * A line gets an account only from the vendor or from a code the model was allowed to name;
 * otherwise it has none and a person chooses. Nothing here guesses.
 */
export function buildProposalLines(input: BuildInput): Built {
  const { extracted, idByCode, vendorAccountId } = input;
  const total = extracted.totalCents;

  if (!extracted.legible || total === null) {
    return { lines: [], notes: [note('unreadable', 'The total could not be read from this receipt.', true)] };
  }
  if (total <= 0) {
    return {
      lines: [],
      notes: [note('refund', 'This looks like a refund or a zero receipt. Refunds are not handled here; enter it by hand.', true)],
    };
  }

  const accountFor = (code: string | null): string | null =>
    vendorAccountId ?? (code === null ? null : (idByCode.get(code) ?? null));
  const label = extracted.vendorName ?? 'Receipt';

  if (extracted.items.length === 0) {
    return { lines: [{ description: label, cents: total, accountId: vendorAccountId }], notes: [] };
  }

  if (!itemsExplainTotal(extracted)) {
    const biggest = [...extracted.items].sort((a, b) => b.cents - a.cents)[0];
    return {
      lines: [{ description: label, cents: total, accountId: accountFor(biggest.accountCode) }],
      notes: [
        note('total_mismatch', 'The line items do not add up to the total, so this is one line for the full total.', false),
      ],
    };
  }

  const extras = total - sumCents(extracted.items.map((item) => item.cents));
  const weights = extracted.items.map((item) => Math.max(item.cents, 0));
  const shares =
    extras === 0
      ? weights.map(() => 0)
      : weights.some((weight) => weight > 0)
        ? allocateCents(extras, weights)
        : [extras, ...weights.slice(1).map(() => 0)];

  return {
    lines: extracted.items.map((item, i) => ({
      description: item.description,
      cents: item.cents + shares[i],
      accountId: accountFor(item.accountCode),
    })),
    notes: [],
  };
}

export interface WarnState {
  payerId: string | null;
  date: CalendarDate | null;
  totalCents: number | null;
  lines: readonly ProposalLine[];
}

/** Warnings only ingest can know: they come from reading the receipt, not from the card's current state. */
export const INGEST_WARNING_CODES: ReadonlySet<WarningCode> = new Set<WarningCode>([
  'unreadable',
  'refund',
  'no_model',
  'total_mismatch',
  'possible_duplicate',
]);

const ONE_YEAR_DAYS = 365;

/**
 * The warnings for a proposal as it stands now. The ones only ingest can know are kept as they
 * were; everything else is worked out again from the current state, so an edit that fixes a
 * problem also clears its warning.
 */
export function recomputeWarnings(
  existing: readonly ReceiptWarning[],
  state: WarnState,
  todayDate: CalendarDate,
): ReceiptWarning[] {
  const warnings: ReceiptWarning[] = existing.filter((w) => INGEST_WARNING_CODES.has(w.code));

  if (state.lines.some((line) => line.accountId === null)) {
    warnings.push(note('no_account', 'Choose an account for every line.', true));
  }
  if (state.payerId === null) {
    warnings.push(note('no_payer', 'Choose which member paid.', true));
  }

  if (state.date === null) {
    if (!warnings.some((w) => w.code === 'unreadable')) {
      warnings.push(note('odd_date', 'No date was found on the receipt. Set one.', true));
    }
  } else if (daysBetween(todayDate, state.date) > 0) {
    warnings.push(note('odd_date', 'This receipt is dated in the future.', false));
  } else if (daysBetween(state.date, todayDate) > ONE_YEAR_DAYS) {
    warnings.push(note('odd_date', 'This receipt is more than a year old.', false));
  }

  if (
    state.lines.length > 0 &&
    state.totalCents !== null &&
    sumCents(state.lines.map((line) => line.cents)) !== state.totalCents
  ) {
    warnings.push(note('lines_off', 'The lines do not add up to the total.', true));
  }

  return warnings;
}

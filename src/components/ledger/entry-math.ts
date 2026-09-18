/**
 * The arithmetic behind the journal entry form.
 *
 * Kept apart from the component so it can be tested as what it is — a pure
 * function of the grid's state — and so the running totals, the auto-balance
 * action and the Post button all read the same numbers rather than each
 * computing their own. Nothing here touches React, the network or the clock.
 *
 * Amounts live in the form as the text the bookkeeper typed and are only ever
 * turned into cents here, through `parseMoney`. A float never appears.
 */

import { isCalendarDate } from '@/lib/dates';
import { parseMoney } from '@/lib/money';

import type { EntryLineInput, EntrySeedLine } from './types';

export type AmountSide = 'debit' | 'credit';

/** One row of the grid, exactly as the form holds it. */
export interface DraftLineState {
  /** Stable across re-orders and deletions; React keys and focus targets use it. */
  key: string;
  accountId: string | null;
  debit: string;
  credit: string;
  memo: string;
  channelId: string | null;
  productId: string | null;
}

export interface AmountParse {
  /** Null for an empty field, which is not an error. */
  cents: number | null;
  error: string | null;
}

let sequence = 0;

export function newLineKey(): string {
  sequence += 1;
  return `line-${sequence}`;
}

export function blankLine(): DraftLineState {
  return {
    key: newLineKey(),
    accountId: null,
    debit: '',
    credit: '',
    memo: '',
    channelId: null,
    productId: null,
  };
}

/**
 * Turns a saved entry back into grid rows.
 *
 * Keys are derived from the position rather than from the running counter, so a
 * server render and the hydration that follows it agree — the keys reach the
 * DOM as element ids, and a counter would hand out different ones on each side.
 * Rows the bookkeeper adds afterwards are client-only and use `newLineKey`.
 */
export function seedLines(
  lines: readonly EntrySeedLine[],
  minimumRows = 4,
): DraftLineState[] {
  const rows = lines.map((line, index) => ({
    key: `seed-${index}`,
    accountId: line.accountId,
    debit: line.debitCents === 0 ? '' : centsToField(line.debitCents),
    credit: line.creditCents === 0 ? '' : centsToField(line.creditCents),
    memo: line.memo,
    channelId: line.channelId,
    productId: line.productId,
  }));

  for (let index = rows.length; index < minimumRows; index += 1) {
    rows.push({
      key: `seed-${index}`,
      accountId: null,
      debit: '',
      credit: '',
      memo: '',
      channelId: null,
      productId: null,
    });
  }
  return rows;
}

/** Cents as the amount field shows them: plain digits, no grouping, no sign. */
function centsToField(cents: number): string {
  const abs = Math.abs(cents);
  return `${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/**
 * Reads one amount field. `parseMoney` accepts `1,234.56`, `$1,234.56`, `(50)`
 * and a trailing minus, and throws on anything else; a bookkeeper typing into a
 * grid gets a message on the line rather than an exception.
 */
export function parseAmount(text: string): AmountParse {
  const trimmed = text.trim();
  if (trimmed === '') return { cents: null, error: null };
  try {
    return { cents: parseMoney(trimmed), error: null };
  } catch {
    return { cents: null, error: `“${trimmed}” is not an amount.` };
  }
}

export interface LineAmounts {
  debitCents: number;
  creditCents: number;
  error: string | null;
}

/**
 * The two amount fields of a line resolved into the one side the ledger takes.
 *
 * A negative in either column means the other column: `(50)` typed under debit
 * is a $50 credit, which is how a bookkeeper writes a correction and how bank
 * exports hand over an amount. Both columns filled at once is a mistake rather
 * than a convention, so it is reported instead of netted.
 */
export function lineAmounts(line: DraftLineState): LineAmounts {
  const debit = parseAmount(line.debit);
  if (debit.error !== null) return { debitCents: 0, creditCents: 0, error: debit.error };
  const credit = parseAmount(line.credit);
  if (credit.error !== null) return { debitCents: 0, creditCents: 0, error: credit.error };

  const debitCents = debit.cents ?? 0;
  const creditCents = credit.cents ?? 0;

  if (debitCents !== 0 && creditCents !== 0) {
    return { debitCents: 0, creditCents: 0, error: 'A line takes a debit or a credit, not both.' };
  }

  const net = debitCents - creditCents;
  if (net === 0) return { debitCents: 0, creditCents: 0, error: null };
  return net > 0
    ? { debitCents: net, creditCents: 0, error: null }
    : { debitCents: 0, creditCents: -net, error: null };
}

/** A line nobody has touched. Blank lines are dropped rather than validated. */
export function isLineEmpty(line: DraftLineState): boolean {
  return (
    line.accountId === null &&
    line.debit.trim() === '' &&
    line.credit.trim() === '' &&
    line.memo.trim() === '' &&
    line.channelId === null &&
    line.productId === null
  );
}

export interface EntryTotals {
  debitCents: number;
  creditCents: number;
  /** Debits less credits. Zero when the entry balances. */
  differenceCents: number;
  balanced: boolean;
  /** Lines carrying an amount — an entry needs at least two of them. */
  amountLineCount: number;
  /** Lines the bookkeeper has begun, whether or not they carry an amount yet. */
  filledLineCount: number;
  /** Keyed by line key; a line with a readable problem appears here. */
  lineErrors: Readonly<Record<string, string>>;
}

export function entryTotals(lines: readonly DraftLineState[]): EntryTotals {
  let debitCents = 0;
  let creditCents = 0;
  let amountLineCount = 0;
  let filledLineCount = 0;
  const lineErrors: Record<string, string> = {};

  for (const line of lines) {
    if (isLineEmpty(line)) continue;
    filledLineCount += 1;

    const amounts = lineAmounts(line);
    if (amounts.error !== null) {
      lineErrors[line.key] = amounts.error;
      continue;
    }
    if (amounts.debitCents === 0 && amounts.creditCents === 0) {
      lineErrors[line.key] = 'This line has no amount.';
      continue;
    }
    if (line.accountId === null) {
      lineErrors[line.key] = 'Choose an account for this line.';
      continue;
    }

    debitCents += amounts.debitCents;
    creditCents += amounts.creditCents;
    amountLineCount += 1;
  }

  const differenceCents = debitCents - creditCents;
  return {
    debitCents,
    creditCents,
    differenceCents,
    balanced: differenceCents === 0,
    amountLineCount,
    filledLineCount,
    lineErrors,
  };
}

/**
 * What the auto-balance action would put on `key`: the side and amount that
 * closes the difference. Null when the entry already balances, when the target
 * line already carries an amount, or when no line is out.
 */
export function autoBalanceFor(
  lines: readonly DraftLineState[],
  key: string,
): { side: AmountSide; cents: number } | null {
  const target = lines.find((line) => line.key === key);
  if (target === undefined) return null;

  const amounts = lineAmounts(target);
  if (amounts.error !== null) return null;
  if (amounts.debitCents !== 0 || amounts.creditCents !== 0) return null;

  const others = lines.filter((line) => line.key !== key);
  const { differenceCents } = entryTotals(others);
  if (differenceCents === 0) return null;

  // Debits ahead of credits means the remainder belongs on the credit side.
  return differenceCents > 0
    ? { side: 'credit', cents: differenceCents }
    : { side: 'debit', cents: -differenceCents };
}

export interface PostReadiness {
  ready: boolean;
  /** Why not, phrased for the Post button's tooltip. Null when ready. */
  reason: string | null;
}

/**
 * Whether the entry may be posted. The database will judge it again — this
 * exists so the button can say what is missing before anyone presses it.
 */
export function postReadiness(
  lines: readonly DraftLineState[],
  date: string,
  totals: EntryTotals = entryTotals(lines),
): PostReadiness {
  if (!isCalendarDate(date)) return { ready: false, reason: 'Enter a date for the entry.' };

  const firstError = Object.values(totals.lineErrors)[0];
  if (firstError !== undefined) return { ready: false, reason: firstError };

  if (totals.amountLineCount < 2) {
    return { ready: false, reason: 'An entry needs at least two lines with amounts.' };
  }
  if (totals.debitCents === 0) return { ready: false, reason: 'The entry has no amounts to post.' };
  if (!totals.balanced) return { ready: false, reason: 'The entry is out of balance.' };
  return { ready: true, reason: null };
}

/** Whether there is anything worth saving as a draft. */
export function draftReadiness(lines: readonly DraftLineState[], date: string): PostReadiness {
  if (!isCalendarDate(date)) return { ready: false, reason: 'Enter a date for the entry.' };

  const totals = entryTotals(lines);
  const firstError = Object.values(totals.lineErrors)[0];
  if (firstError !== undefined) return { ready: false, reason: firstError };
  if (totals.filledLineCount === 0) return { ready: false, reason: 'Add a line first.' };
  return { ready: true, reason: null };
}

/**
 * The lines as the ledger takes them. Empty rows are dropped; anything left
 * carries an account and exactly one side, because `postReadiness` has already
 * refused the entry otherwise.
 */
export function toEntryLines(lines: readonly DraftLineState[]): EntryLineInput[] {
  const out: EntryLineInput[] = [];
  for (const line of lines) {
    if (isLineEmpty(line)) continue;
    const amounts = lineAmounts(line);
    if (amounts.error !== null) continue;
    if (line.accountId === null) continue;
    if (amounts.debitCents === 0 && amounts.creditCents === 0) continue;

    const memo = line.memo.trim();
    out.push({
      accountId: line.accountId,
      debitCents: amounts.debitCents,
      creditCents: amounts.creditCents,
      memo: memo === '' ? null : memo,
      channelId: line.channelId,
      productId: line.productId,
    });
  }
  return out;
}

/** Rewrites one amount field, clearing the other side the way a ledger column does. */
export function setAmount(
  line: DraftLineState,
  side: AmountSide,
  text: string,
): DraftLineState {
  const typed = text.trim() !== '';
  return side === 'debit'
    ? { ...line, debit: text, credit: typed ? '' : line.credit }
    : { ...line, credit: text, debit: typed ? '' : line.debit };
}

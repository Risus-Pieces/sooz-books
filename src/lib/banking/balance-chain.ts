/**
 * Running-balance validation.
 *
 * When a statement carries a balance column, this is the strongest integrity
 * check available anywhere in the import path — stronger than a row count,
 * stronger than a date range, stronger than any heuristic. If
 * `balance[n] == balance[n-1] + amount[n]` holds across the whole file, then every
 * row was parsed, every sign was read the right way round, every amount landed in
 * the right column and nothing was dropped or duplicated. If it breaks, the file
 * is incomplete or the parse is wrong, and the exact row is named.
 *
 * It also produces two things later phases depend on:
 *
 *  - **the chronological order.** Relay exports newest-first; other banks export
 *    oldest-first; the direction is read off the balance column rather than
 *    assumed. `assignOccurrences` must be fed the oldest-first order or a
 *    re-imported partial month renumbers its own duplicates.
 *  - **the opening balance**, derived as `first balance - first amount`. For
 *    Sooz's account #9726 the January file derives exactly $1,000.00, which is
 *    where the seeded `bank_accounts.opening_balance_cents` came from.
 */

import type { BalanceBreak, BalanceChainResult, NormalizedTxn } from './types';

export interface ValidateBalanceChainOptions {
  /**
   * The balance the account is known to have held before the first row. When
   * given, it is checked against the balance the file itself implies; a mismatch
   * is a break at the first row and usually means the statement starts mid-month
   * or a prior transaction was never imported.
   */
  openingBalanceCents?: number;
}

/** A row that can take part in the chain: parsed, and carrying a balance. */
function participates(row: NormalizedTxn): boolean {
  return row.usable && row.balanceCents !== null;
}

/**
 * Counts how many consecutive balance steps fail in a given ordering.
 *
 * Rows without a balance do not break the chain — several banks print one only on
 * the last row of a day — but their amounts still move the running expectation,
 * so they are carried forward rather than ignored.
 */
function countBreaks(ordered: readonly NormalizedTxn[]): { breaks: BalanceBreak[]; checked: number } {
  const breaks: BalanceBreak[] = [];
  let running: number | null = null;
  let checked = 0;

  for (const row of ordered) {
    if (!row.usable) continue;

    if (running === null) {
      if (row.balanceCents === null) continue;
      running = row.balanceCents;
      checked += 1;
      continue;
    }

    const expected: number = running + row.amountCents;
    if (row.balanceCents === null) {
      running = expected;
      continue;
    }

    checked += 1;
    if (row.balanceCents !== expected) {
      breaks.push({
        rowIndex: row.rowIndex,
        expected,
        actual: row.balanceCents,
        delta: row.balanceCents - expected,
      });
    }
    // Resynchronise on what the file says, so one missing transaction produces
    // one break rather than turning every later row into a failure.
    running = row.balanceCents;
  }

  return { breaks, checked };
}

/** True when the dates never decrease across the list. */
function datesAscend(rows: readonly NormalizedTxn[]): boolean {
  let previous = '';
  for (const row of rows) {
    if (row.date === '') continue;
    if (row.date < previous) return false;
    previous = row.date;
  }
  return true;
}

/**
 * Validates a statement's running balance and returns the rows in chronological
 * order.
 *
 * The direction is decided by trying the chain both ways and keeping whichever
 * fits — not by trusting the dates, because dates tie on the many rows that share
 * a day and the balance column does not. Dates are only the tie-break when both
 * orderings fit equally, which happens when there is too little to go on.
 */
export function validateBalanceChain(
  rows: readonly NormalizedTxn[],
  options: ValidateBalanceChainOptions = {},
): BalanceChainResult {
  const forward = [...rows];
  const reverse = [...rows].reverse();

  const chainable = rows.filter(participates);

  if (chainable.length === 0) {
    // Nothing to validate. An empty Relay statement lands here, and so does a
    // format with no balance column at all; neither is an error.
    const ordered = datesAscend(forward) ? forward : reverse;
    return {
      ordered,
      ok: true,
      openingBalanceCents: options.openingBalanceCents ?? null,
      closingBalanceCents: null,
      breaks: [],
      direction: rows.length === 0 ? 'unknown' : ordered === forward ? 'ascending' : 'descending',
      checked: 0,
    };
  }

  const forwardResult = countBreaks(forward);
  const reverseResult = countBreaks(reverse);

  let ordered: NormalizedTxn[];
  let result: { breaks: BalanceBreak[]; checked: number };
  let direction: BalanceChainResult['direction'];

  if (forwardResult.breaks.length < reverseResult.breaks.length) {
    ordered = forward;
    result = forwardResult;
    direction = 'ascending';
  } else if (reverseResult.breaks.length < forwardResult.breaks.length) {
    ordered = reverse;
    result = reverseResult;
    direction = 'descending';
  } else if (datesAscend(forward)) {
    ordered = forward;
    result = forwardResult;
    // With a single balanced row there is nothing to tell the two apart, and
    // claiming a direction we did not measure would be a lie the caller might act on.
    direction = result.checked > 1 ? 'ascending' : 'unknown';
  } else if (datesAscend(reverse)) {
    ordered = reverse;
    result = reverseResult;
    direction = result.checked > 1 ? 'descending' : 'unknown';
  } else {
    ordered = forward;
    result = forwardResult;
    direction = 'unknown';
  }

  const firstAt = ordered.findIndex(participates);
  let lastAt = firstAt;
  for (let i = ordered.length - 1; i > firstAt; i -= 1) {
    if (participates(ordered[i])) {
      lastAt = i;
      break;
    }
  }

  const first = ordered[firstAt];
  const last = ordered[lastAt];
  const firstBalance = first.balanceCents ?? 0;
  const lastBalance = last.balanceCents ?? 0;

  // Everything before the first row that carries a balance still moved the
  // account, so the opening balance has to be walked back past it.
  const leadingAmount = ordered
    .slice(0, firstAt)
    .filter((row) => row.usable)
    .reduce((sum, row) => sum + row.amountCents, 0);
  const derivedOpening = firstBalance - first.amountCents - leadingAmount;

  // Everything after the last row that carries a balance moves it again.
  const trailingAmount = ordered
    .slice(lastAt + 1)
    .filter((row) => row.usable)
    .reduce((sum, row) => sum + row.amountCents, 0);
  const closing = lastBalance + trailingAmount;

  const breaks = [...result.breaks];
  if (options.openingBalanceCents !== undefined && options.openingBalanceCents !== derivedOpening) {
    breaks.unshift({
      rowIndex: first.rowIndex,
      expected: options.openingBalanceCents + first.amountCents + leadingAmount,
      actual: firstBalance,
      delta: derivedOpening - options.openingBalanceCents,
    });
  }

  return {
    ordered,
    ok: breaks.length === 0,
    openingBalanceCents: derivedOpening,
    closingBalanceCents: closing,
    breaks,
    direction,
    checked: result.checked,
  };
}

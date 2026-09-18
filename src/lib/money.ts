/**
 * Money is always a whole number of cents held in a JS number. The safe-integer
 * ceiling is ~$90 trillion, so the only real constraint is that nothing in this
 * file may reach for a float as an intermediate representation of an amount.
 */

const CENTS_PER_UNIT = 100;

/** Characters that carry no sign and no value: currency marks, grouping, spacing. */
const NOISE = /[$\s,_  ]/g;

const AMOUNT = /^(?:\d+(?:\.\d*)?|\.\d+)$/;

function unparseable(input: string | number, reason: string): never {
  throw new Error(`Cannot read ${JSON.stringify(input)} as money: ${reason}.`);
}

function assertCents(cents: number): void {
  if (!Number.isSafeInteger(cents)) {
    throw new Error(
      `Money must be a whole number of cents inside the safe-integer range; received ${cents}.`,
    );
  }
}

/** Splits a non-negative cent count into its dollar and cent digit strings. */
function digitsOf(absCents: number): { whole: string; fraction: string } {
  const padded = String(absCents).padStart(3, '0');
  return { whole: padded.slice(0, -2), fraction: padded.slice(-2) };
}

function group(whole: string): string {
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * Reads an amount written by a human, a bank export or a spreadsheet and returns
 * integer cents. Accepts `1234.56`, `1,234.56`, `$1,234.56`, `-$1,234.56`,
 * `$(1,234.56)`, `(1,234.56)` and the trailing-minus form `1234.56-`.
 *
 * The decimal string is parsed digit by digit rather than multiplied by 100, so
 * `"1.005"` yields 101 cents instead of the 100 a float round-trip produces.
 */
export function parseMoney(input: string | number): number {
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) unparseable(input, 'not a finite number');
    const asText = String(input);
    // String() only produces exponent notation below ~1e-7 or at/above 1e21.
    // The small end is worth less than half a cent; the large end is far past
    // anything cents can hold.
    if (/e-/i.test(asText)) return 0;
    if (/e\+/i.test(asText)) unparseable(input, 'magnitude is too large to hold in cents');
    return parseMoney(asText);
  }

  let text = input.trim().replace(NOISE, '');
  if (text === '') unparseable(input, 'no amount present');

  let negatives = 0;
  if (text.startsWith('(') && text.endsWith(')')) {
    negatives += 1;
    text = text.slice(1, -1);
  }
  if (text.endsWith('-')) {
    negatives += 1;
    text = text.slice(0, -1);
  }
  if (text.startsWith('-')) {
    negatives += 1;
    text = text.slice(1);
  } else if (text.startsWith('+')) {
    text = text.slice(1);
  }

  if (negatives > 1) unparseable(input, 'more than one negative sign');
  if (!AMOUNT.test(text)) unparseable(input, 'not a recognisable amount');

  const dot = text.indexOf('.');
  const whole = dot === -1 ? text : text.slice(0, dot);
  const fraction = dot === -1 ? '' : text.slice(dot + 1);

  const wholeCents = Number(whole || '0') * CENTS_PER_UNIT;
  if (!Number.isSafeInteger(wholeCents)) {
    unparseable(input, 'magnitude is too large to hold in cents');
  }

  // Half-up on the third decimal digit, decided on the digit string itself.
  const roundUp = fraction.length > 2 && fraction.charCodeAt(2) >= 0x35;
  const cents = wholeCents + Number(`${fraction}00`.slice(0, 2)) + (roundUp ? 1 : 0);
  if (!Number.isSafeInteger(cents)) {
    unparseable(input, 'magnitude is too large to hold in cents');
  }

  // `cents !== 0` keeps "-0.00" from returning the negative zero that would then
  // fail every identity comparison downstream.
  return negatives === 1 && cents !== 0 ? -cents : cents;
}

export interface FormatMoneyOptions {
  /** Render zero as `$0.00`. Defaults to true; false renders an empty string. */
  showZero?: boolean;
  /** Render negatives as `($1,234.56)` instead of `-$1,234.56`. */
  parens?: boolean;
}

/** Formats cents for display: `$1,234.56`, `-$1,234.56`, or `($1,234.56)`. */
export function formatMoney(cents: number, opts: FormatMoneyOptions = {}): string {
  assertCents(cents);
  const { showZero = true, parens = false } = opts;
  if (cents === 0 && !showZero) return '';

  const { whole, fraction } = digitsOf(Math.abs(cents));
  const body = `$${group(whole)}.${fraction}`;
  if (cents >= 0) return body;
  return parens ? `(${body})` : `-${body}`;
}

/** Formats cents for CSV and Excel export: `1234.56`, `-1234.56`. */
export function formatMoneyPlain(cents: number): string {
  assertCents(cents);
  const { whole, fraction } = digitsOf(Math.abs(cents));
  return `${cents < 0 ? '-' : ''}${whole}.${fraction}`;
}

/** Adds cent amounts. Accepts an iterable or a plain argument list. */
export function sumCents(values: Iterable<number>): number;
export function sumCents(...values: number[]): number;
export function sumCents(...args: [Iterable<number>] | number[]): number {
  const values: Iterable<number> =
    args.length === 1 && typeof args[0] !== 'number' ? args[0] : (args as number[]);

  let total = 0;
  for (const value of values) {
    assertCents(value);
    total += value;
  }
  assertCents(total);
  return total;
}

/**
 * Splits `total` cents across `weights` in proportion, handing the rounding
 * remainder to the largest fractional shares. The returned parts always sum to
 * exactly `total`, which is what makes this safe for landed-cost and fee
 * allocation: nothing leaks into or out of the ledger on a rounding boundary.
 *
 * Weights may be any non-negative finite numbers (cases, pounds, dollars,
 * percentages). A zero weight always receives zero.
 */
export function allocateCents(total: number, weights: readonly number[]): number[] {
  assertCents(total);

  if (weights.length === 0) {
    if (total !== 0) {
      throw new Error(`allocateCents: cannot spread ${total} cents across zero parts.`);
    }
    return [];
  }

  let weightTotal = 0;
  weights.forEach((weight, i) => {
    if (!Number.isFinite(weight) || weight < 0) {
      throw new Error(
        `allocateCents: weight at index ${i} must be a finite, non-negative number; received ${weight}.`,
      );
    }
    weightTotal += weight;
  });

  if (weightTotal === 0) {
    if (total !== 0) {
      throw new Error(
        `allocateCents: every weight is zero, so ${total} cents cannot be allocated in proportion. Pass equal weights to split evenly.`,
      );
    }
    return weights.map(() => 0);
  }

  const sign = total < 0 ? -1 : 1;
  const magnitude = Math.abs(total);

  // Dividing the weight first keeps every ratio inside [0, 1], so no share can
  // overflow however extreme the weights are.
  const shares = weights.map((weight) => magnitude * (weight / weightTotal));
  const parts = shares.map((share) => Math.floor(share));

  const byRemainder = weights
    .map((_, i) => i)
    .filter((i) => weights[i] > 0)
    .sort(
      (a, b) =>
        shares[b] - parts[b] - (shares[a] - parts[a]) || weights[b] - weights[a] || a - b,
    );

  let leftover = magnitude - parts.reduce((sum, part) => sum + part, 0);
  for (let n = 0; leftover > 0; n += 1) {
    parts[byRemainder[n % byRemainder.length]] += 1;
    leftover -= 1;
  }
  // Float shares can overshoot as easily as undershoot; claw back from the
  // smallest remainders so the sum invariant holds in both directions.
  for (let n = 0; leftover < 0; n += 1) {
    const i = byRemainder[byRemainder.length - 1 - (n % byRemainder.length)];
    if (parts[i] === 0) continue;
    parts[i] -= 1;
    leftover += 1;
  }

  return sign === 1 ? parts : parts.map((part) => (part === 0 ? 0 : -part));
}

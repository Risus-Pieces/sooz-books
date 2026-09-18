/**
 * Quantities, held exactly.
 *
 * Quantities are not money, but they multiply money, so they get the same
 * treatment: no float ever stands between a CSV cell and a cent amount. The
 * database keeps them as `numeric(14,2)`; here they are an integer count of
 * hundredths of a unit (`12.5` cases is `1250`). Every product of a quantity and
 * a unit cost is taken in BigInt and rounded once, half away from zero.
 */

/** Hundredths of a unit per unit. */
export const QTY_SCALE = 100;

export class QuantityError extends Error {
  constructor(input: string, reason: string) {
    super(`Cannot read ${JSON.stringify(input)} as a quantity: ${reason}.`);
    this.name = 'QuantityError';
  }
}

export interface ParsedQuantity {
  /** Hundredths of a unit, signed. */
  hundredths: number;
  /** True when the input carried more than two decimals and was rounded. */
  rounded: boolean;
}

const QTY = /^(?:\d+(?:\.\d*)?|\.\d+)$/;

/**
 * Reads `1,234.5`, `-3`, `(12)`, `12.345` (rounded half away from zero to two
 * decimals, and flagged) into hundredths. Throws `QuantityError` for anything
 * that is not a number.
 */
export function parseQuantity(input: string): ParsedQuantity {
  let text = input.trim().replace(/[,\s_]/g, '');
  if (text === '') throw new QuantityError(input, 'empty');
  let negative = false;
  if (text.startsWith('(') && text.endsWith(')')) {
    negative = true;
    text = text.slice(1, -1);
  }
  if (text.startsWith('-')) {
    if (negative) throw new QuantityError(input, 'more than one negative sign');
    negative = true;
    text = text.slice(1);
  } else if (text.startsWith('+')) {
    text = text.slice(1);
  }
  if (!QTY.test(text)) throw new QuantityError(input, 'not a number');

  const dot = text.indexOf('.');
  const whole = dot === -1 ? text : text.slice(0, dot);
  const fraction = dot === -1 ? '' : text.slice(dot + 1);
  const roundUp = fraction.length > 2 && fraction.charCodeAt(2) >= 0x35;
  const value = Number(whole || '0') * QTY_SCALE + Number(`${fraction}00`.slice(0, 2)) + (roundUp ? 1 : 0);
  if (!Number.isSafeInteger(value)) throw new QuantityError(input, 'too large');
  return { hundredths: negative && value !== 0 ? -value : value, rounded: fraction.length > 2 };
}

/** A `numeric` string from the database (`'12.50'`, `'-3'`) as hundredths. */
export function quantityFromDb(value: string | number): number {
  return parseQuantity(String(value)).hundredths;
}

/** Hundredths back to the decimal string `numeric(14,2)` accepts: `1250` -> `'12.50'`. */
export function quantityToDb(hundredths: number): string {
  if (!Number.isSafeInteger(hundredths)) throw new Error(`Quantity ${hundredths} is not whole hundredths.`);
  const sign = hundredths < 0 ? '-' : '';
  const abs = Math.abs(hundredths);
  return `${sign}${Math.floor(abs / QTY_SCALE)}.${String(abs % QTY_SCALE).padStart(2, '0')}`;
}

/** For display: `1250` -> `'12.5'`, `1200` -> `'12'`. */
export function formatQuantity(hundredths: number): string {
  return quantityToDb(hundredths).replace(/\.?0+$/, '') || '0';
}

/** `numerator / denominator`, rounded half away from zero, in BigInt. */
export function roundDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator === BigInt(0)) throw new Error('roundDiv: division by zero.');
  const negative = numerator < BigInt(0) !== denominator < BigInt(0);
  const n = numerator < BigInt(0) ? -numerator : numerator;
  const d = denominator < BigInt(0) ? -denominator : denominator;
  const q = (n * BigInt(2) + d) / (d * BigInt(2));
  return negative ? -q : q;
}

function toSafe(value: bigint, what: string): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new Error(`${what} is outside the safe-integer range.`);
  return n === 0 ? 0 : n;
}

/** Cents for `hundredths` units at `unitCostCents` each, rounded once, half away from zero. */
export function extendCost(hundredths: number, unitCostCents: number): number {
  return toSafe(
    roundDiv(BigInt(hundredths) * BigInt(unitCostCents), BigInt(QTY_SCALE)),
    'Extended cost',
  );
}

/** Cents per unit for `totalCents` spread over `hundredths` units, rounded half away from zero. */
export function unitCostOf(totalCents: number, hundredths: number): number {
  if (hundredths === 0) throw new Error('unitCostOf: zero units.');
  return toSafe(
    roundDiv(BigInt(totalCents) * BigInt(QTY_SCALE), BigInt(hundredths)),
    'Unit cost',
  );
}

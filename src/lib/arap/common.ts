/**
 * Shared plumbing for the AR and AP engines: the transaction context, account
 * lookups, quantity arithmetic, document status and the application-date
 * convention.
 *
 * APPLICATION DATES. The application tables carry `applied_at timestamptz`.
 * The engine writes it as noon on the application's accounting date in the
 * books' time zone, so `(applied_at at time zone BOOKS_TIME_ZONE)::date` reads
 * back exactly the date the bookkeeper chose. Point-in-time aging depends on it:
 * a receipt dated 31 March that pays an invoice must reduce that invoice as of
 * 31 March, whatever the wall clock said when someone typed it in. The wall
 * clock is in audit_log.
 */

import { type SQL, eq, inArray, sql } from 'drizzle-orm';

import { withActor } from '@/db/client';
import { accounts } from '@/db/schema';
import { BOOKS_TIME_ZONE, type CalendarDate, isCalendarDate } from '@/lib/dates';
import { type LedgerDb, translateLedgerDbError } from '@/lib/ledger/post';

import { invalidInput } from './errors';

export type { LedgerDb };

export interface ArapContext {
  userId: string | null;
  /**
   * An open transaction (with `app.user_id` already set) to work inside. Without
   * it the engine opens its own through `withActor`.
   */
  tx?: LedgerDb;
}

/** Runs `fn` in the caller's transaction, or in a fresh `withActor` one. */
export async function runArap<T>(ctx: ArapContext, fn: (tx: LedgerDb) => Promise<T>): Promise<T> {
  if (ctx.tx) return fn(ctx.tx);
  try {
    return await withActor(ctx.userId, fn);
  } catch (error) {
    // A deferred balance check fails at COMMIT, outside any statement.
    throw translateLedgerDbError(error);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function requireUuid(field: string, value: string): string {
  if (!UUID.test(value)) throw invalidInput(`${field} is not a valid id.`);
  return value;
}

export function requireDate(field: string, value: string): CalendarDate {
  if (!isCalendarDate(value)) throw invalidInput(`${field} must be a YYYY-MM-DD date, received ${JSON.stringify(value)}.`);
  return value;
}

/** A whole, strictly positive number of cents. */
export function requirePositiveCents(field: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw invalidInput(`${field} must be a positive whole number of cents, received ${String(value)}.`);
  }
  return value;
}

/** A whole, non-negative number of cents. */
export function requireNonNegativeCents(field: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw invalidInput(`${field} must be zero or a positive whole number of cents, received ${String(value)}.`);
  }
  return value;
}

export function optionalText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

export function appendNote(memo: string | null, note: string): string {
  return memo === null || memo.trim() === '' ? note : `${memo} · ${note}`;
}

export function laterOf(a: CalendarDate, b: CalendarDate): CalendarDate {
  return a > b ? a : b;
}

// ---------------------------------------------------------------------------
// Application dates
// ---------------------------------------------------------------------------

/** The `applied_at` value that reads back as `date` on the books' calendar. */
export function appliedAtFor(date: CalendarDate): SQL {
  return sql`((${date}::date + time '12:00') at time zone ${BOOKS_TIME_ZONE})`;
}

/** The books-calendar date of an `applied_at` column. */
export function appliedOn(column: SQL | string): SQL {
  const ref = typeof column === 'string' ? sql.raw(column) : column;
  return sql`((${ref} at time zone ${BOOKS_TIME_ZONE})::date)`;
}

// ---------------------------------------------------------------------------
// Quantities
// ---------------------------------------------------------------------------

const QUANTITY_SCALE = BigInt(10_000);
const ZERO = BigInt(0);
const TWO = BigInt(2);
const HUNDRED = BigInt(100);
const HALF_OF_TEN_THOUSAND = BigInt(5_000);
const QUANTITY = /^\d+(?:\.\d{1,4})?$/;

/**
 * Quantities are exact decimals with up to four places (numeric(14,4)). They
 * are carried as a scaled bigint and never touch a float, because a line amount
 * is quantity × unit price and a float product can land half a cent off.
 */
export function parseQuantity(input: string | number): { text: string; scaled: bigint } {
  const text = typeof input === 'number' ? String(input) : input.trim();
  if (!QUANTITY.test(text)) {
    throw invalidInput(`Quantity ${JSON.stringify(input)} must be a non-negative number with at most four decimals.`);
  }
  const [whole, fraction = ''] = text.split('.');
  const scaled = BigInt(whole) * QUANTITY_SCALE + BigInt(fraction.padEnd(4, '0'));
  return { text, scaled };
}

/** round(quantity × unit price), half away from zero, in whole cents. */
export function extendCents(quantityScaled: bigint, unitCents: number): number {
  const product = quantityScaled * BigInt(unitCents);
  const negative = product < ZERO;
  const magnitude = negative ? -product : product;
  const rounded = (magnitude + QUANTITY_SCALE / TWO) / QUANTITY_SCALE;
  const value = Number(negative ? -rounded : rounded);
  if (!Number.isSafeInteger(value)) throw invalidInput('Line amount is too large.');
  return value;
}

/** round(amount × pct / 100) for a numeric(5,2) percentage string such as "2.00". */
export function percentOfCents(amountCents: number, pct: string): number {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(pct.trim());
  if (!match) throw invalidInput(`Percentage ${JSON.stringify(pct)} is not a decimal with two places.`);
  const hundredths = BigInt(match[1]) * HUNDRED + BigInt((match[2] ?? '').padEnd(2, '0'));
  const product = BigInt(amountCents) * hundredths;
  return Number((product + HALF_OF_TEN_THOUSAND) / QUANTITY_SCALE);
}

// ---------------------------------------------------------------------------
// Document status
// ---------------------------------------------------------------------------

export type OpenStatus = 'open' | 'partial' | 'paid';

/** Status of an issued document from its total and what has settled it. */
export function statusFor(totalCents: number, settledCents: number): OpenStatus {
  if (totalCents - settledCents === 0) return 'paid';
  return settledCents > 0 ? 'partial' : 'open';
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

export interface AccountInfo {
  id: string;
  code: string;
  name: string;
  type: string;
  subtype: string | null;
  isControl: boolean;
  isBank: boolean;
  active: boolean;
}

const ACCOUNT_COLUMNS = {
  id: accounts.id,
  code: accounts.code,
  name: accounts.name,
  type: accounts.type,
  subtype: accounts.subtype,
  isControl: accounts.isControl,
  isBank: accounts.isBank,
  active: accounts.active,
};

export async function accountById(tx: LedgerDb, id: string): Promise<AccountInfo> {
  const [row] = await tx.select(ACCOUNT_COLUMNS).from(accounts).where(eq(accounts.id, requireUuid('accountId', id)));
  if (row === undefined) throw invalidInput(`Account ${id} does not exist.`);
  return row;
}

export async function accountByCode(tx: LedgerDb, code: string): Promise<AccountInfo> {
  const [row] = await tx.select(ACCOUNT_COLUMNS).from(accounts).where(eq(accounts.code, code));
  if (row === undefined) throw invalidInput(`Account ${code} does not exist.`);
  return row;
}

export async function accountsById(tx: LedgerDb, ids: readonly string[]): Promise<Map<string, AccountInfo>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await tx.select(ACCOUNT_COLUMNS).from(accounts).where(inArray(accounts.id, unique));
  return new Map(rows.map((row) => [row.id, row]));
}

/** Account subtypes money can be received into or paid out of. */
export const MONEY_SUBTYPES: ReadonlySet<string> = new Set([
  'bank',
  'cash',
  'undeposited_funds',
  'clearing',
  'credit_card',
]);

export function isMoneyAccount(account: AccountInfo): boolean {
  return account.isBank || MONEY_SUBTYPES.has(account.subtype ?? '');
}

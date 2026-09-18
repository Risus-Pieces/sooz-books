/**
 * Shared plumbing for the trade engine: the transaction context, input guards
 * and the accounts every trade posting names.
 */

import { eq, inArray } from 'drizzle-orm';

import { accounts } from '@/db/schema';
import { runArap } from '@/lib/arap/common';
import { type CalendarDate, isCalendarDate } from '@/lib/dates';
import { ACCOUNTS } from '@/lib/ledger/coa';
import type { LedgerDb } from '@/lib/ledger/post';

import { invalidInput } from './errors';

export type { LedgerDb };

export interface TradeContext {
  userId: string | null;
  /** An open transaction (with `app.user_id` already set) to work inside. */
  tx?: LedgerDb;
}

/** Runs `fn` in the caller's transaction, or in a fresh `withActor` one. */
export function runTrade<T>(ctx: TradeContext, fn: (tx: LedgerDb) => Promise<T>): Promise<T> {
  return runArap(ctx, fn);
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

export function requirePositiveCents(field: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw invalidInput(`${field} must be a positive whole number of cents, received ${String(value)}.`);
  }
  return value;
}

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

/** Invoice numbers as distributors print them: `INV-4471001`, `inv 4471001` and `INV4471001` are one invoice. */
export function normalizeDocNo(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const key = value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return key === '' ? null : key;
}

/** The accounts the trade engine posts to by role, resolved to ids once per transaction. */
export const TRADE_ACCOUNT_CODES = {
  ar: ACCOUNTS.AR,
  deductionsReceivable: ACCOUNTS.DEDUCTIONS_RECEIVABLE,
  accruedTradeSpend: ACCOUNTS.ACCRUED_TRADE_SPEND,
  writeOff: ACCOUNTS.UNAUTHORIZED_DEDUCTIONS,
  undepositedFunds: ACCOUNTS.UNDEPOSITED_FUNDS,
  distributorFees: ACCOUNTS.DISTRIBUTOR_FEES,
} as const;

export async function accountIdsByCode(tx: LedgerDb, codes: readonly string[]): Promise<Map<string, string>> {
  const unique = [...new Set(codes)];
  if (unique.length === 0) return new Map();
  const rows = await tx.select({ id: accounts.id, code: accounts.code }).from(accounts).where(inArray(accounts.code, unique));
  const map = new Map(rows.map((r) => [r.code, r.id]));
  for (const code of unique) {
    if (!map.has(code)) throw invalidInput(`Account ${code} does not exist.`);
  }
  return map;
}

export async function accountIdOf(tx: LedgerDb, code: string): Promise<string> {
  const [row] = await tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.code, code));
  if (row === undefined) throw invalidInput(`Account ${code} does not exist.`);
  return row.id;
}

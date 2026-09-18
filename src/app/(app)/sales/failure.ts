/**
 * Turning a thrown error into the `{ ok: false, error }` a Sales or Purchases
 * form renders. Shared by both modules' Server Actions.
 *
 * An engine refusal (ArapError) or a ledger refusal already carries a sentence
 * a bookkeeper can act on and is passed through. A raw database error is
 * reported by its message, never by the failed query text, which carries SQL
 * and every bound value.
 */

import type { ActionFailure, ActionResult } from '@/components/arap/types';
import { isArapError } from '@/lib/arap';
import { isForbiddenError } from '@/lib/auth/roles';
import { isQueryError, postgresErrorOf } from '@/lib/db-errors';
import { isLedgerError } from '@/lib/ledger/errors';
import { translateLedgerDbError } from '@/lib/ledger/post';

export function failure(error: unknown): ActionFailure {
  if (isArapError(error)) return { code: error.code, message: error.message };
  if (isForbiddenError(error)) return { code: 'forbidden', message: error.message };
  const translated = translateLedgerDbError(error);
  if (isLedgerError(translated)) return { code: translated.code, message: translated.message };

  const pg = postgresErrorOf(error);
  if (pg !== null) return { code: 'unexpected', message: `The database refused this change: ${pg.message}` };
  if (isQueryError(error)) return { code: 'unexpected', message: 'The database could not complete this request.' };
  if (error instanceof Error) return { code: 'unexpected', message: error.message };
  return { code: 'unexpected', message: 'Something went wrong.' };
}

export function ok<T>(value: T): ActionResult<T> {
  return { ok: true, value };
}

export function fail<T>(error: unknown): ActionResult<T> {
  return { ok: false, error: failure(error) };
}

/** Whole cents from the client, checked before anything reaches the engine. */
export function wholeCents(field: string, value: number): number {
  if (!Number.isSafeInteger(value)) throw new Error(`${field} must be a whole number of cents.`);
  return value;
}

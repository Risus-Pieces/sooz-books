/**
 * Turning a thrown error into the `{ ok: false, error }` the Plan and Close
 * screens render. A planning, close or ledger refusal already carries a sentence
 * a bookkeeper can act on and is passed through with its detail lines. A raw
 * database error is reported by its message, never by the failed query text,
 * which carries SQL and every bound value.
 */

import type { ActionFailure, ActionResult } from '@/components/planning/types';
import { isForbiddenError } from '@/lib/auth/roles';
import { isCloseError } from '@/lib/close/errors';
import { isQueryError, postgresErrorOf } from '@/lib/db-errors';
import { PeriodHasDraftsError, isLedgerError } from '@/lib/ledger/errors';
import { translateLedgerDbError } from '@/lib/ledger/post';
import { isPlanningError } from '@/lib/planning/errors';

export function failure(error: unknown): ActionFailure {
  if (isPlanningError(error)) {
    return { code: error.code, message: error.message, details: [...error.details] };
  }
  if (isCloseError(error)) {
    return {
      code: error.code,
      message: error.message,
      details: error.outstanding.map((t) => (t.message === null ? t.label : `${t.label}: ${t.message}`)),
    };
  }
  if (isForbiddenError(error)) return { code: 'forbidden', message: error.message };
  const translated = translateLedgerDbError(error);
  if (translated instanceof PeriodHasDraftsError) {
    return {
      code: translated.code,
      message: translated.message,
      details: translated.drafts.map((d) => `#${d.entryNo} ${d.date}${d.memo ? ` ${d.memo}` : ''}`),
    };
  }
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

export function refused<T>(message: string): ActionResult<T> {
  return { ok: false, error: { code: 'invalid_input', message } };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

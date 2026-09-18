/**
 * Reading Postgres errors through drizzle's wrapper.
 *
 * drizzle-orm 0.45 wraps every failed statement in a `DrizzleQueryError` whose own
 * `code` is undefined; the driver's error, with the SQLSTATE and the constraint name,
 * is on `.cause`. Code that checks `error.code` at the top level therefore never sees a
 * trigger's exception or a constraint violation raised by a statement — only the
 * deferred checks that fail at COMMIT, which the driver throws unwrapped. Every module
 * that reacts to a database error reads it through here.
 */

import { DrizzleQueryError } from 'drizzle-orm';

/** The fields of a Postgres error that callers read. */
export interface PostgresErrorFields {
  readonly code: string;
  readonly message: string;
  readonly constraint_name?: string;
  readonly constraint?: string;
}

/**
 * The Postgres error at the bottom of `error`, wherever it is. The chain is walked a
 * few levels deep, because a transaction wrapper may add one more.
 */
export function postgresErrorOf(error: unknown): PostgresErrorFields | null {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && typeof current === 'object' && current !== null; depth += 1) {
    const candidate = current as { code?: unknown; message?: unknown; cause?: unknown };
    // A SQLSTATE is exactly five characters of digits and upper-case letters, which
    // no application error code ("batch.not_found", "unbalanced_entry") can be
    // mistaken for.
    if (typeof candidate.code === 'string' && /^[0-9A-Z]{5}$/.test(candidate.code)) {
      return current as PostgresErrorFields;
    }
    current = candidate.cause;
  }
  return null;
}

/** The constraint or index a Postgres error names, if any. */
export function constraintOf(pg: PostgresErrorFields): string | undefined {
  return typeof pg.constraint_name === 'string' ? pg.constraint_name : pg.constraint;
}

/** True for a Postgres unique-violation on a named constraint or index, however wrapped. */
export function isUniqueViolation(error: unknown, constraint: string): boolean {
  const pg = postgresErrorOf(error);
  if (pg === null || pg.code !== '23505') return false;
  return constraintOf(pg) === constraint;
}

/**
 * True when `error` is, or wraps, a failed query. Its message is
 * `Failed query: <sql> params: <every bound value>`, which must never reach a
 * user or a log.
 */
export function isQueryError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && typeof current === 'object' && current !== null; depth += 1) {
    if (current instanceof DrizzleQueryError) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

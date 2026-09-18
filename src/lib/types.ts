/**
 * Shared primitives. Nothing in this file may import from `@/db` — these types
 * travel into client components as well as server code.
 */

/**
 * Mirrors the `app_role` enum in the database. `src/db/schema/enums.ts` builds
 * its pgEnum from this list, so the two cannot drift apart.
 */
export const APP_ROLES = ['owner', 'bookkeeper', 'approver', 'viewer'] as const;

export type AppRole = (typeof APP_ROLES)[number];

export function isAppRole(value: unknown): value is AppRole {
  return typeof value === 'string' && (APP_ROLES as readonly string[]).includes(value);
}

/**
 * Success/failure channel for operations whose failure is an expected business
 * outcome — an unbalanced entry, a closed period, a row a CSV import could not
 * match. Throwing stays reserved for programmer error and infrastructure faults.
 */
export type Result<T, E = string> = { ok: true; value: T } | { ok: false; error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

export function isOk<T, E>(result: Result<T, E>): result is { ok: true; value: T } {
  return result.ok;
}

export function isErr<T, E>(result: Result<T, E>): result is { ok: false; error: E } {
  return !result.ok;
}

import { isForbiddenError } from '@/lib/auth/roles';
import { isArapError } from '@/lib/arap';
import { isBankingError } from '@/lib/banking/post';
import { isQueryError, postgresErrorOf } from '@/lib/db-errors';
import { isLedgerError } from '@/lib/ledger/errors';
import { translateLedgerDbError } from '@/lib/ledger/post';
import { isStagingError } from './staging';

/** Confirming a staged change is for a signed-in person, never a scoped key. */
export function assertNotKey(user: { key?: unknown }): void {
  if (user.key) {
    throw new McpInputError('A scoped key cannot confirm changes. The person signs in and confirms the staged change themselves.');
  }
}

/** A key may stage (which writes nothing to the ledger) only if its scopes say so. */
export function assertMayStage(user: { key?: { name: string; scopes: readonly string[] } | null }): void {
  if (user.key && !user.key.scopes.includes('stage')) {
    throw new McpInputError(`The key "${user.key.name}" is not allowed to stage changes.`);
  }
}

/** A problem with what Claude asked for, which Claude can fix by asking differently. */
export class McpInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpInputError';
  }
}

/**
 * The sentence a tool returns when something is refused. Typed errors already carry wording written
 * for people; a raw database failure never leaks its SQL.
 */
export function describeError(error: unknown): string {
  if (error instanceof McpInputError) return error.message;
  if (isStagingError(error)) return error.message;
  if (isForbiddenError(error)) return error.message;
  if (isBankingError(error)) return error.message;
  if (isArapError(error)) return error.message;
  const translated = translateLedgerDbError(error);
  if (isLedgerError(translated)) return translated.message;
  const pg = postgresErrorOf(error);
  if (pg !== null) return `The database refused this change: ${pg.message}`;
  if (isQueryError(error)) return 'The database could not complete this request.';
  if (error instanceof Error) return error.message;
  return 'Something went wrong.';
}

import { isForbiddenError } from '@/lib/auth/roles';
import { isArapError } from '@/lib/arap';
import { isBankingError } from '@/lib/banking/post';
import { isQueryError, postgresErrorOf } from '@/lib/db-errors';
import { isLedgerError } from '@/lib/ledger/errors';
import { translateLedgerDbError } from '@/lib/ledger/post';
import { isStagingError } from './staging';

/** Stage and commit are for a signed-in person, never a scoped key. */
export function assertNotKey(user: { key?: unknown }): void {
  if (user.key) {
    throw new McpInputError('A scoped key cannot stage or confirm changes. Leave this for a person signed in to Sooz Books.');
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

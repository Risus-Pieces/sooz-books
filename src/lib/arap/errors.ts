/**
 * Typed failures from the AR and AP engines.
 *
 * Like the ledger's own errors these are expected business outcomes — paying
 * more than a bill is owed, voiding an invoice a customer already paid, matching
 * a bank line that has already been booked — so each carries a code a Server
 * Action can branch on and a sentence a bookkeeper can act on.
 */

export type ArapErrorCode =
  | 'not_found'
  | 'invalid_input'
  | 'invalid_state'
  | 'over_application'
  | 'party_mismatch'
  | 'discount_not_allowed'
  | 'duplicate_document'
  | 'already_posted';

export class ArapError extends Error {
  constructor(
    readonly code: ArapErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ArapError';
  }
}

export function isArapError(error: unknown): error is ArapError {
  return error instanceof ArapError;
}

export function notFound(what: string, id: string): ArapError {
  return new ArapError('not_found', `${what} ${id} does not exist.`);
}

export function invalidInput(message: string): ArapError {
  return new ArapError('invalid_input', message);
}

export function invalidState(message: string): ArapError {
  return new ArapError('invalid_state', message);
}

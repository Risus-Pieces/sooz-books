/**
 * Typed failures from the trade engine: remittances, deductions, promotions.
 *
 * Expected business outcomes — recovering more than a deduction is worth,
 * disputing after the window has closed, validating a deduction nobody has
 * classified — so each carries a code a Server Action can branch on and a
 * sentence a bookkeeper can act on.
 */

export type TradeErrorCode =
  | 'not_found'
  | 'invalid_input'
  | 'invalid_state'
  | 'over_resolution'
  | 'window_closed'
  | 'needs_classification'
  | 'already_accrued';

export class TradeError extends Error {
  constructor(
    readonly code: TradeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'TradeError';
  }
}

export function isTradeError(error: unknown): error is TradeError {
  return error instanceof TradeError;
}

export function notFound(what: string, id: string): TradeError {
  return new TradeError('not_found', `${what} ${id} does not exist.`);
}

export function invalidInput(message: string): TradeError {
  return new TradeError('invalid_input', message);
}

export function invalidState(message: string): TradeError {
  return new TradeError('invalid_state', message);
}

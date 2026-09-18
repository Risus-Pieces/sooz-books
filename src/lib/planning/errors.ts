/**
 * Typed failures of the planning module. Kept free of any database import so the
 * pure forecast arithmetic can use them.
 */

export type PlanningErrorCode =
  | 'not_found'
  | 'invalid_input'
  | 'invalid_state'
  | 'duplicate'
  | 'import_refused';

/** An expected business outcome, carrying a message a bookkeeper can read. */
export class PlanningError extends Error {
  readonly code: PlanningErrorCode;
  /** Line-level detail, e.g. every bad row of a CSV import. */
  readonly details: readonly string[];

  constructor(code: PlanningErrorCode, message: string, details: readonly string[] = []) {
    super(message);
    this.name = 'PlanningError';
    this.code = code;
    this.details = details;
  }
}

export function isPlanningError(error: unknown): error is PlanningError {
  return error instanceof PlanningError;
}

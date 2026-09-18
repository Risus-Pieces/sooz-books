/**
 * Typed failures of the month-end close. `blocked` carries the tasks that stand
 * between the checklist and a closed period, so the screen can list them.
 */

export type CloseErrorCode = 'not_found' | 'invalid_input' | 'invalid_state' | 'blocked';

export interface OutstandingTask {
  key: string;
  label: string;
  status: string;
  message: string | null;
}

export class CloseError extends Error {
  readonly code: CloseErrorCode;
  readonly outstanding: readonly OutstandingTask[];

  constructor(code: CloseErrorCode, message: string, outstanding: readonly OutstandingTask[] = []) {
    super(message);
    this.name = 'CloseError';
    this.code = code;
    this.outstanding = outstanding;
  }
}

export function isCloseError(error: unknown): error is CloseError {
  return error instanceof CloseError;
}

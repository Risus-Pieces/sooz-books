/**
 * Typed failures of the inventory module. Each carries a stable `code` a server
 * action can switch on and a message a bookkeeper can read.
 */

export type InventoryErrorCode =
  | 'not_found'
  | 'invalid_state'
  | 'invalid_input'
  | 'allocation'
  | 'missing_cost'
  | 'duplicate'
  | 'unposted_bill'
  | 'import_refused';

export class InventoryError extends Error {
  readonly code: InventoryErrorCode;
  readonly details: readonly string[];

  constructor(code: InventoryErrorCode, message: string, details: readonly string[] = []) {
    super(message);
    this.name = 'InventoryError';
    this.code = code;
    this.details = details;
  }
}

export function isInventoryError(error: unknown): error is InventoryError {
  return error instanceof InventoryError;
}

import { isForbiddenError } from '@/lib/auth/roles';
import { isLedgerError } from '@/lib/ledger/errors';

import { ExtractionError } from './extractor';
import { isReceiptError } from './post';

export interface ActionFailure {
  /** A `ReceiptErrorCode`, an `ExtractionFailureKind`, a `LedgerErrorCode`, `forbidden`, or `unexpected`. */
  code: string;
  message: string;
}

/**
 * A thrown error as the `{ ok: false, error }` a server action returns.
 *
 * Refusals made to be read (ours, the ledger's, the model's, a permission check's) keep their own
 * words. Anything else is a bug or an outage, and its text is for a developer, so it is replaced.
 */
export function toActionFailure(error: unknown): ActionFailure {
  if (isForbiddenError(error)) return { code: 'forbidden', message: error.message };
  if (isReceiptError(error)) return { code: error.code, message: error.message };
  if (isLedgerError(error)) return { code: error.code, message: error.message };
  if (error instanceof ExtractionError) return { code: error.kind, message: error.message };
  return { code: 'unexpected', message: 'Something went wrong. Try again.' };
}

/**
 * Expected refusals from the channels module.
 *
 * Every one is a business outcome, not a crash: a settlement that does not tie, a
 * payout already posted, a return filed twice. Server actions hand `message` to the
 * UI as-is; `code` is for code that needs to branch on the reason.
 */

export type ChannelErrorCode =
  | 'not_found'
  | 'already_posted'
  | 'not_posted'
  | 'unbalanced'
  | 'no_reported_total'
  | 'no_lines'
  | 'no_date'
  | 'unmapped_line'
  | 'facilitator_not_netted'
  | 'tax_state_unknown'
  | 'deposit_mismatch'
  | 'deposit_unavailable'
  | 'filed'
  | 'already_filed'
  | 'nothing_to_file'
  | 'already_paid'
  | 'payment_mismatch'
  | 'not_a_bank_account'
  | 'invalid_input'
  | 'not_importable';

export class ChannelError extends Error {
  readonly code: ChannelErrorCode;
  readonly remedy: string | null;

  constructor(code: ChannelErrorCode, message: string, remedy: string | null = null) {
    super(message);
    this.name = 'ChannelError';
    this.code = code;
    this.remedy = remedy;
  }
}

export function isChannelError(error: unknown): error is ChannelError {
  return error instanceof ChannelError;
}

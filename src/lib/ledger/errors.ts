/**
 * Typed failures from the posting engine.
 *
 * Every error here is an expected business outcome rather than a programmer
 * mistake: an entry that does not balance, a period that is already closed, a
 * manual entry aimed at a control account. Server Actions catch them and hand
 * the UI `{ ok: false, error }`, so each one carries the detail a message needs
 * — the account code, the period, the offending line — rather than a bare
 * string the caller would have to parse back apart.
 */

export type LedgerErrorCode =
  | 'unbalanced_entry'
  | 'invalid_amount'
  | 'invalid_date'
  | 'invalid_reference'
  | 'unknown_account'
  | 'rollup_account'
  | 'control_account'
  | 'closed_period'
  | 'period_has_drafts'
  | 'entry_not_found'
  | 'entry_not_posted'
  | 'entry_immutable'
  | 'already_reversed'
  | 'account_in_use'
  | 'duplicate_account'
  | 'not_permitted';

export abstract class LedgerError extends Error {
  abstract readonly code: LedgerErrorCode;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export function isLedgerError(error: unknown): error is LedgerError {
  return error instanceof LedgerError;
}

/** Debits and credits disagree, or there are too few lines to make an entry. */
export class UnbalancedEntryError extends LedgerError {
  readonly code = 'unbalanced_entry';

  constructor(
    readonly debitCents: number,
    readonly creditCents: number,
    readonly lineCount: number,
    message?: string,
  ) {
    super(
      message ??
        `Entry is out of balance: debits ${debitCents} ≠ credits ${creditCents} across ${lineCount} lines.`,
    );
  }

  static tooFewLines(lineCount: number): UnbalancedEntryError {
    return new UnbalancedEntryError(
      0,
      0,
      lineCount,
      `A journal entry needs at least two lines; this one has ${lineCount}.`,
    );
  }
}

/** A line amount is negative, fractional, out of safe-integer range, or on both sides at once. */
export class InvalidAmountError extends LedgerError {
  readonly code = 'invalid_amount';

  constructor(
    readonly lineNo: number,
    readonly reason: string,
    readonly debitCents?: number,
    readonly creditCents?: number,
  ) {
    super(`Line ${lineNo}: ${reason}.`);
  }
}

export class InvalidDateError extends LedgerError {
  readonly code = 'invalid_date';

  constructor(
    readonly value: string,
    message?: string,
  ) {
    super(message ?? `${JSON.stringify(value)} is not a calendar date in YYYY-MM-DD form.`);
  }
}

/** A dimension id (channel, customer, vendor, product, user) is malformed or points nowhere. */
export class InvalidReferenceError extends LedgerError {
  readonly code = 'invalid_reference';

  constructor(
    readonly field: string,
    readonly value: string | null,
    message?: string,
  ) {
    super(message ?? `${field} ${JSON.stringify(value)} does not exist.`);
  }
}

export type UnknownAccountReason = 'missing' | 'inactive' | 'ambiguous';

export class UnknownAccountError extends LedgerError {
  readonly code = 'unknown_account';

  constructor(
    readonly reference: { accountCode?: string; accountId?: string },
    readonly reason: UnknownAccountReason = 'missing',
    readonly lineNo?: number,
  ) {
    super(UnknownAccountError.describe(reference, reason, lineNo));
  }

  private static describe(
    reference: { accountCode?: string; accountId?: string },
    reason: UnknownAccountReason,
    lineNo?: number,
  ): string {
    const named = reference.accountCode
      ? `Account ${reference.accountCode}`
      : `Account ${reference.accountId ?? '(none given)'}`;
    const where = lineNo === undefined ? '' : ` on line ${lineNo}`;
    if (reason === 'inactive') return `${named}${where} is no longer active.`;
    if (reason === 'ambiguous') {
      return `${named}${where} was given by both code and id, and the two disagree.`;
    }
    return `${named}${where} does not exist.`;
  }
}

/**
 * A rollup — an account other accounts name as their parent — is a report header.
 * Its figure on a statement is the sum of its children, so a posting of its own
 * would leave the parent and its children no longer tying.
 */
export class RollupAccountError extends LedgerError {
  readonly code = 'rollup_account';

  constructor(
    readonly accountCode: string,
    readonly accountName: string,
    readonly lineNo?: number,
  ) {
    super(
      `${accountCode} ${accountName}${lineNo === undefined ? '' : ` on line ${lineNo}`} is a rollup ` +
        `that only totals the accounts under it; post to one of those instead.`,
    );
  }
}

/**
 * AR and AP are control accounts: their balance is owned by the invoice and
 * bill sub-ledgers, so only entries those modules raise may move them. A manual
 * journal entry that touched AR would put the aging report out of step with the
 * general ledger with nothing to reconcile it back.
 */
export class ControlAccountError extends LedgerError {
  readonly code = 'control_account';

  constructor(
    readonly accountCode: string,
    readonly accountName: string,
    readonly sourceType: string,
    readonly lineNo?: number,
  ) {
    super(
      `${accountCode} ${accountName} is a control account: it is only posted by the sub-ledgers ` +
        `(invoices, bills, payments, credit memos, deductions), not by a ${sourceType} entry.`,
    );
  }
}

export class ClosedPeriodError extends LedgerError {
  readonly code = 'closed_period';

  constructor(
    readonly year: number,
    readonly month: number,
    readonly date: string,
  ) {
    super(
      `${date} falls in ${String(year)}-${String(month).padStart(2, '0')}, which is closed. ` +
        `Post to an open period, or reopen that one first.`,
    );
  }
}

export interface DraftEntryRef {
  id: string;
  entryNo: number;
  date: string;
  memo: string | null;
}

/** A month cannot be closed while entries in it are still unposted. */
export class PeriodHasDraftsError extends LedgerError {
  readonly code = 'period_has_drafts';

  constructor(
    readonly year: number,
    readonly month: number,
    readonly drafts: readonly DraftEntryRef[],
  ) {
    super(
      `${String(year)}-${String(month).padStart(2, '0')} still has ${drafts.length} draft ` +
        `${drafts.length === 1 ? 'entry' : 'entries'} (${drafts
          .slice(0, 5)
          .map((d) => `#${d.entryNo}`)
          .join(', ')}${drafts.length > 5 ? ', …' : ''}). Post or delete them before closing.`,
    );
  }
}

export class EntryNotFoundError extends LedgerError {
  readonly code = 'entry_not_found';

  constructor(readonly entryId: string) {
    super(`Journal entry ${entryId} does not exist.`);
  }
}

export class EntryNotPostedError extends LedgerError {
  readonly code = 'entry_not_posted';

  constructor(
    readonly entryId: string,
    readonly status: string,
  ) {
    super(
      `Journal entry ${entryId} is a ${status} and has never hit the ledger; ` +
        `delete the draft instead of reversing it.`,
    );
  }
}

/** The database refused to change a posted entry. Corrections are reversals. */
export class ImmutableEntryError extends LedgerError {
  readonly code = 'entry_immutable';

  constructor(message: string) {
    super(message);
  }
}

export class AlreadyReversedError extends LedgerError {
  readonly code = 'already_reversed';

  constructor(
    readonly entryId: string,
    readonly entryNo: number,
    readonly reversedByEntryNo: number | null,
  ) {
    super(
      `Entry #${entryNo} was already reversed` +
        (reversedByEntryNo === null ? '.' : ` by #${reversedByEntryNo}.`),
    );
  }
}

/** An account with history cannot simply disappear; it needs a successor to carry the reporting. */
export class AccountInUseError extends LedgerError {
  readonly code = 'account_in_use';

  constructor(
    readonly accountId: string,
    readonly accountCode: string,
    readonly postedLineCount: number,
    message?: string,
  ) {
    super(
      message ??
        `Account ${accountCode} carries ${postedLineCount} posted ` +
          `${postedLineCount === 1 ? 'line' : 'lines'}. Name a successor account to deactivate it.`,
    );
  }
}

export class DuplicateAccountError extends LedgerError {
  readonly code = 'duplicate_account';

  constructor(readonly accountCode: string) {
    super(`Account code ${accountCode} is already in use.`);
  }
}

export class NotPermittedError extends LedgerError {
  readonly code = 'not_permitted';

  constructor(
    readonly action: string,
    readonly userId: string | null,
    readonly role: string | null,
  ) {
    super(
      `${role ? `The ${role} role` : 'This user'} may not ${action}.` +
        (role === null ? ' Only an owner can.' : ''),
    );
  }
}

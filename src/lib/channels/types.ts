/**
 * The shape every settlement parser in this module produces.
 *
 * Shopify, Amazon and Faire look nothing alike on disk, but each decomposes into the
 * same thing: settlements, each with a provider key, the net the provider says it paid,
 * and signed lines that must add up to exactly that net. `./intake` writes these to
 * `payout_imports` / `payout_lines`, the same tables and the same guarantees as the
 * Square intake (`@/lib/importers/square-intake`): nothing is written unless the whole
 * file ties, and re-importing a settlement is a no-op.
 *
 * Amounts are signed from Sooz's point of view: positive increases what the channel
 * owes Sooz (a sale, tax collected, a reimbursement), negative reduces it (a fee, a
 * refund, a reserve held back).
 */

import type { PayoutLineType } from '@/db/schema';
import type { CalendarDate } from '@/lib/dates';
import type { Assertion, Issue } from '@/lib/importers/types';

import type { SettlementProvider, SettlementRole } from './accounts';

export type TaxRegime = 'us_state' | 'foreign' | 'unknown';

export interface SettlementLineDraft {
  readonly lineType: PayoutLineType;
  readonly role: SettlementRole;
  readonly amountCents: number;
  /** What a bookkeeper reads on the line: the file's own vocabulary, verbatim. */
  readonly label: string;
  readonly postedDate: CalendarDate | null;
  /** Order id, adjustment id or other provider reference. */
  readonly externalRef: string | null;
  readonly sku: string | null;
  /** Units, as an exact decimal string. */
  readonly quantity: string | null;
  /** Two-letter state code, on tax lines where the source names one. */
  readonly jurisdiction: string | null;
  /** On a tax line: the sales the tax was charged on, when the source says. */
  readonly taxableCents: number | null;
  /**
   * On a tax line: whose tax it is. `us_state` names its state in `jurisdiction`;
   * `foreign` is non-US tax (Canadian GST/HST on a Shopify order) that no state return
   * reports; `unknown` is US tax whose state the source does not say.
   */
  readonly taxRegime: TaxRegime | null;
  /**
   * On a facilitator-tax line: `collected` is the tax the customer paid, `withheld` is the
   * marketplace taking it back to remit. Only the collected half is reportable sales tax.
   */
  readonly taxSide: 'collected' | 'withheld' | null;
  /** 0-based data-row indexes that produced this line. */
  readonly rowIndexes: readonly number[];
  /** Stable per-line key: settlement key, role, reference, amount, ordinal. */
  readonly fingerprint: string;
}

export interface ParsedSettlement {
  readonly provider: SettlementProvider;
  /** `payout_imports.external_id`: the provider's settlement id, or a derived payout key. */
  readonly key: string;
  readonly periodStart: CalendarDate | null;
  readonly periodEnd: CalendarDate;
  /** When the provider says the money leaves for the bank. */
  readonly depositDate: CalendarDate | null;
  readonly currency: string;
  /** What the provider states the settlement pays out. */
  readonly reportedNetCents: number;
  readonly lines: readonly SettlementLineDraft[];
  /** Every identity checked for this settlement. A failed fatal one refuses the file. */
  readonly assertions: readonly Assertion[];
  readonly issues: readonly Issue[];
}

export interface SettlementFile {
  readonly importerId: string;
  readonly provider: SettlementProvider;
  readonly filename: string;
  readonly fileHash: string;
  readonly settlements: readonly ParsedSettlement[];
  /** File-level issues: unreadable rows, unmapped headers, rows left out and why. */
  readonly issues: readonly Issue[];
  /** Data rows seen. */
  readonly rowCount: number;
  /**
   * True when every fatal assertion passed and no row was lost. Settlement files assert
   * to a control total, so a skipped row is proof the parse is wrong, not a tolerable loss.
   */
  readonly ok: boolean;
}

/** Raised when the file cannot be read as this provider's settlement at all. */
export class SettlementFormatError extends Error {
  readonly code: string;
  readonly remedy: string;

  constructor(code: string, message: string, remedy: string) {
    super(message);
    this.name = 'SettlementFormatError';
    this.code = code;
    this.remedy = remedy;
  }
}

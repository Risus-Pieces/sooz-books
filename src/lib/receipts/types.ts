import type { CalendarDate } from '@/lib/dates';

export type WarningCode =
  | 'total_mismatch' // line items do not explain the total; posted as one line
  | 'lines_off' // the lines on the card do not add up to the total
  | 'possible_duplicate'
  | 'unreadable'
  | 'refund'
  | 'no_account'
  | 'no_payer'
  | 'odd_date'
  | 'no_model';

export interface ReceiptWarning {
  code: WarningCode;
  message: string;
  /** A blocking warning disables Post until it is resolved. */
  blocking: boolean;
}

export interface ExtractedItem {
  description: string;
  /** Signed: a discount is negative. */
  cents: number;
  /** A code the model chose from the list it was given, or null. Validated before use. */
  accountCode: string | null;
}

export interface ExtractedReceipt {
  legible: boolean;
  vendorName: string | null;
  date: CalendarDate | null;
  subtotalCents: number | null;
  taxCents: number;
  tipCents: number;
  totalCents: number | null;
  /** The last four digits only. Nothing longer is ever kept. */
  cardLast4: string | null;
  items: ExtractedItem[];
}

/** One debit the entry will carry, before lines on the same account are merged. */
export interface ProposalLine {
  description: string;
  /** Signed: a negative line becomes a credit on its account. */
  cents: number;
  accountId: string | null;
}

export type ProposalStatus = 'proposed' | 'posted' | 'skipped';

/** Everything a card needs. Plain data, safe to hand to a client component. */
export interface ProposalView {
  id: string;
  status: ProposalStatus;
  attachmentId: string;
  filename: string;
  vendorName: string | null;
  /** True when no existing vendor matched; one is created when the entry posts. */
  vendorIsNew: boolean;
  date: CalendarDate | null;
  totalCents: number | null;
  payerId: string | null;
  lines: Array<{ description: string; cents: number; accountId: string | null; accountLabel: string | null }>;
  warnings: ReceiptWarning[];
  error: string | null;
  entryId: string | null;
  entryNo: number | null;
  /** A possible duplicate is present: posting needs the member to say it is a different purchase. */
  needsConfirmation: boolean;
  /** Nothing blocks posting right now. */
  canPost: boolean;
}

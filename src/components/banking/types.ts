/**
 * The shapes that cross the server/client boundary in the banking screens.
 *
 * Everything here is plain serialisable data. A Server Component reads through the banking
 * engine and projects its rows into these; a Server Action takes ids and decisions back. The
 * review queue's own row type is the engine's `QueueRow`, re-exported so the client never
 * imports server code to name it.
 */

export type {
  AccountRef,
  QueueFlag,
  QueueRow,
  QueueSource,
  QueueStage,
} from '@/lib/banking/queue';
export type { RuleCondition, RuleDirection, RuleField, RuleOperator } from '@/lib/banking/rules';
export type { AccountOption, ActionFailure, ActionResult } from '@/components/ledger/types';

import type { QueueRow, QueueStage } from '@/lib/banking/queue';
import type { ImportProfile } from '@/lib/banking/types';
import type { RuleCondition, RuleDirection } from '@/lib/banking/rules';

export interface BankAccountTab {
  id: string;
  name: string;
  mask: string | null;
  kind: string;
  glAccountId: string;
  glCode: string;
  /** Rows by review stage, for the tab badges. */
  counts: Record<QueueStage, number>;
  /** The bank's own printed balance after the latest imported row, where the file had one. */
  statementBalanceCents: number | null;
  statementBalanceDate: string | null;
  /** The general ledger's balance of the account's GL account, posted entries only. */
  ledgerBalanceCents: number;
  /** What the account held on the day the books start for it. */
  openingBalanceCents: number;
  openingDate: string | null;
}

/** A bank row as the register shows it, with the balance after it. */
export interface RegisterRowView {
  row: QueueRow;
  /** The bank's printed balance, or the opening balance plus every row through this one. */
  balanceCents: number;
  /** True when the bank printed the balance itself. */
  printed: boolean;
}

export interface VendorOption {
  id: string;
  name: string;
}

/** One line of a posted entry, shown when a register row is expanded. */
export interface EntryLine {
  id: string;
  lineNo: number;
  accountCode: string;
  accountName: string;
  memo: string | null;
  debitCents: number;
  creditCents: number;
}

export interface EntrySummary {
  id: string;
  entryNo: number;
  date: string;
  memo: string | null;
  sourceType: string;
  lines: EntryLine[];
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

export interface RuleRow {
  id: string;
  name: string;
  priority: number;
  bankAccountId: string | null;
  bankAccountLabel: string | null;
  conditions: RuleCondition[];
  direction: RuleDirection;
  amountMinCents: number | null;
  amountMaxCents: number | null;
  accountId: string | null;
  accountCode: string | null;
  accountName: string | null;
  vendorId: string | null;
  vendorName: string | null;
  memoTemplate: string | null;
  autoPost: boolean;
  active: boolean;
  hitCount: number;
  /** Pre-formatted on the server so the label does not change on hydration. */
  lastHit: string | null;
  /** Bank rows whose current suggestion came from this rule. */
  currentMatches: number;
}

/** A rule as the editor submits it. Amounts in cents; conditions as typed. */
export interface RuleDraft {
  id: string | null;
  name: string;
  priority: number;
  bankAccountId: string | null;
  conditions: RuleCondition[];
  direction: RuleDirection;
  amountMinCents: number | null;
  amountMaxCents: number | null;
  accountId: string | null;
  vendorId: string | null;
  memoTemplate: string | null;
  autoPost: boolean;
  active: boolean;
}

export interface RulePreviewRow {
  id: string;
  txnDate: string;
  payee: string;
  reference: string | null;
  amountCents: number;
  bankMask: string | null;
  /** The rule that wins this row today, when it is not the one being edited. */
  wonBy: string | null;
  posted: boolean;
}

export interface RulePreview {
  /** Transactions the draft matches at all. */
  matched: number;
  /** Of those, how many it would win against the other active rules. */
  wins: number;
  /** Matched rows already in the ledger: a rule never changes them. */
  posted: number;
  sample: RulePreviewRow[];
  /** Why the draft cannot run yet, in words; empty when it can. */
  problems: string[];
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

export interface ImportIssueView {
  severity: 'info' | 'warn' | 'error' | 'fatal';
  code: string;
  message: string;
  rowIndex: number | null;
  remedy: string | null;
}

export interface ImportRowView {
  rowIndex: number;
  class: 'new' | 'duplicate' | 'skipped';
  txnDate: string;
  payee: string;
  reference: string | null;
  amountCents: number;
  balanceCents: number | null;
  proposedStatus: string;
  suggestion: {
    accountLabel: string | null;
    source: string;
    confidence: number;
    autoPost: boolean;
  } | null;
  decisionRequired: string | null;
}

/** The column mapping, editable. Mirrors the parser's ImportProfile. */
export interface MappingView {
  name: string;
  date_column: string;
  date_format: string | null;
  description_columns: string[];
  counterparty_column: string | null;
  mode: 'signed' | 'debit_credit' | 'amount_with_type';
  amount_column: string | null;
  debit_column: string | null;
  credit_column: string | null;
  type_column: string | null;
  debit_type_values: string[];
  credit_type_values: string[];
  balance_column: string | null;
  reference_column: string | null;
  invert_sign: boolean;
}

export interface ImportPreviewView {
  batchId: string;
  bankAccountId: string;
  bankAccountName: string;
  bankAccountMask: string | null;
  importerId: string;
  importerLabel: string;
  detectionConfidence: number;
  detectionReasons: string[];
  filename: string;
  profileId: string | null;
  profileName: string | null;
  mapping: MappingView;
  /** The full mapping the file was read with; the editor's changes are laid over it. */
  baseMapping: ImportProfile;
  /** Every header the file has, for the mapping editor. */
  headers: string[];
  profileConfirmationRequired: boolean;
  /** True for a bank read through a column mapping (not a built-in format like Relay). */
  mappingEditable: boolean;
  decisionsRequired: number[];
  counts: {
    total: number;
    new: number;
    duplicate: number;
    skipped: number;
    needsReview: number;
    autoPost: number;
    excluded: number;
  };
  dateRange: { min: string; max: string } | null;
  totals: { inflowCents: number; outflowCents: number; netCents: number };
  balanceChain: {
    ok: boolean;
    checked: number;
    openingBalanceCents: number | null;
    closingBalanceCents: number | null;
    breaks: { rowIndex: number; expectedCents: number; actualCents: number; deltaCents: number }[];
  } | null;
  assertions: { id: string; label: string; passed: boolean; severity: 'fatal' | 'warn'; detail: string | null }[];
  issues: ImportIssueView[];
  issueCounts: Record<'info' | 'warn' | 'error' | 'fatal', number>;
  rows: ImportRowView[];
  priorImport: { filename: string; importedAt: string; importedCount: number } | null;
  blocked: boolean;
  /** The file's period as the source states it, and whether that period is still open. */
  partial: boolean;
}

export interface ImportDecisionView {
  rowIndex: number;
  choice: 'exclude' | 'skip' | 'review';
}

export interface ImportCommitView {
  inserted: number;
  duplicates: number;
  skipped: number;
  conflicts: number;
  transferPairsLinked: number;
  returnedPairsLinked: number;
  issues: ImportIssueView[];
  ai: {
    attempted: number;
    written: number;
    discarded: number;
    unanswered: number;
    modelId: string | null;
    failures: string[];
    skippedReason: string | null;
  } | null;
}

export interface RecentImport {
  id: string;
  filename: string;
  bankLabel: string;
  status: string;
  importedCount: number;
  duplicateCount: number;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

export interface ReconSummaryView {
  id: string;
  status: 'in_progress' | 'completed' | 'abandoned';
  statementStartDate: string;
  statementDate: string;
  openingBalanceCents: number;
  closingBalanceCents: number;
  previouslyClearedCents: number;
  clearedThisPeriodCents: number;
  clearedCount: number;
  clearedBalanceCents: number;
  differenceCents: number;
  openingDifferenceCents: number;
}

export interface ReconLineView {
  journalLineId: string;
  entryId: string;
  entryNo: number;
  date: string;
  amountCents: number;
  memo: string | null;
  bankTransactionId: string | null;
  payee: string | null;
  cleared: boolean;
}

export interface ReconHistoryRow {
  id: string;
  status: 'in_progress' | 'completed' | 'abandoned';
  statementStartDate: string;
  statementDate: string;
  closingBalanceCents: number;
  completedAt: string | null;
  completedBy: string | null;
  /** Only the latest completed reconciliation of an account can be undone. */
  undoable: boolean;
}

export interface StatementProposalView {
  month: string;
  statementStartDate: string;
  statementDate: string;
  openingBalanceCents: number | null;
  closingBalanceCents: number | null;
  transactionCount: number;
  netChangeCents: number;
  basis: 'balance_chain' | 'carried_forward' | 'no_data';
  chainOk: boolean;
  breaks: { date: string; expectedCents: number; actualCents: number }[];
  ledgerBalanceCents: number;
}

// ---------------------------------------------------------------------------
// Matching a bank line to what the books already hold
// ---------------------------------------------------------------------------

/** An entry already in the ledger that records the same money on the row's bank account. */
export interface BookedEntryView {
  entryId: string;
  entryNo: number;
  entryDate: string;
  memo: string | null;
  sourceType: string;
  documentNo: string | null;
  partyName: string | null;
  /** Signed from the bank's side: positive is money in. */
  amountCents: number;
  /** Days from the entry date to the bank date; negative when the entry is later. */
  daysApart: number;
}

export interface MatchDocumentView {
  kind: 'invoice' | 'bill';
  id: string;
  docNo: string;
  partyName: string;
  dueDate: string;
  balanceCents: number;
}

/** One or more open documents the row could pay, as bank matching proposes them. */
export interface DocumentMatchView {
  kind: 'exact' | 'combination';
  totalCents: number;
  reasons: string[];
  documents: MatchDocumentView[];
}

export interface MatchOptionsView {
  direction: 'inflow' | 'outflow';
  booked: BookedEntryView[];
  documents: DocumentMatchView[];
  /** Why no invoice or bill can be matched, when that is the case. */
  documentsBlocked: string | null;
  /** Whether this person may record the receipt or bill payment a document match creates. */
  mayRecordDocuments: boolean;
}

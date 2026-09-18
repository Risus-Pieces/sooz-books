/**
 * The shapes that cross the server/client boundary in the ledger interface.
 *
 * Everything here is plain serialisable data: a Server Component reads the
 * database, projects a row into one of these, and hands it to a client
 * component; a Server Action takes one back. Timestamps arrive pre-formatted
 * because the server and the browser sit in different zones and a label
 * computed on both sides would not match on hydration.
 */

import type { AccountType } from '@/db/schema';

export interface ActionFailure {
  /** A `LedgerErrorCode`, `forbidden`, or `unexpected`. */
  code: string;
  message: string;
  /** The drafts standing in the way, when `code` is `period_has_drafts`. */
  blocking?: BlockingDraft[];
}

export interface BlockingDraft {
  id: string;
  entryNo: number;
  date: string;
  memo: string | null;
}

export type ActionResult<T> = { ok: true; value: T } | { ok: false; error: ActionFailure };

export interface AccountOption {
  id: string;
  code: string;
  name: string;
  type: AccountType;
  subtype: string | null;
  active: boolean;
  isControl: boolean;
  isBank: boolean;
  parentId: string | null;
  /** False for a rollup header, which carries children and takes no postings. */
  postable: boolean;
}

export interface ChannelOption {
  id: string;
  code: string;
  name: string;
}

export interface ProductOption {
  id: string;
  sku: string;
  name: string;
}

export interface EntryLineInput {
  accountId: string;
  debitCents: number;
  creditCents: number;
  memo: string | null;
  channelId: string | null;
  productId: string | null;
}

/** A line as the form is opened with it: an existing entry, or a duplicate of one. */
export interface EntrySeedLine {
  accountId: string | null;
  debitCents: number;
  creditCents: number;
  memo: string;
  channelId: string | null;
  productId: string | null;
}

export interface EntryInput {
  /** The draft this entry replaces, when one was saved earlier. */
  draftId: string | null;
  date: string;
  memo: string;
  lines: EntryLineInput[];
}

export interface EntryRef {
  entryId: string;
  entryNo: number;
}

export interface ReversalRef extends EntryRef {
  date: string;
  /** Set when a closed period forced the reversal off the date that was asked for. */
  movedFrom: string | null;
  linked: boolean;
}

/** An account as the chart of accounts screen shows it. */
export interface AccountTreeRow extends AccountOption {
  /** Depth in the tree, for the indent. */
  depth: number;
  parentCode: string | null;
  description: string | null;
  /** Signed by the account's normal balance: positive means a normal balance. */
  balanceCents: number;
  /** Posted lines on the account — what makes a change to its shape unsafe. */
  postedLineCount: number;
  childCount: number;
}

export interface NewAccountForm {
  code: string;
  name: string;
  type: AccountType;
  subtype: string | null;
  parentCode: string | null;
  description: string | null;
  isBank: boolean;
}

/** The same fields less `code`, which never changes once an account exists. */
export type AccountEditForm = Omit<NewAccountForm, 'code'>;

export interface JournalRow {
  id: string;
  entryNo: number;
  date: string;
  memo: string | null;
  sourceType: string;
  sourceId: string | null;
  status: 'draft' | 'posted';
  debitCents: number;
  lineCount: number;
  reversesEntryNo: number | null;
  reversedByEntryNo: number | null;
}

export interface JournalLineRow {
  id: string;
  entryId: string;
  lineNo: number;
  accountId: string;
  accountCode: string;
  accountName: string;
  debitCents: number;
  creditCents: number;
  memo: string | null;
  channelId: string | null;
  channelCode: string | null;
  productId: string | null;
  productSku: string | null;
}

export interface EntryDetailRow {
  id: string;
  entryNo: number;
  date: string;
  memo: string | null;
  status: 'draft' | 'posted';
  sourceType: string;
  sourceId: string | null;
  createdAtLabel: string;
  createdByLabel: string | null;
  postedAtLabel: string | null;
  postedByLabel: string | null;
  reversesId: string | null;
  reversesEntryNo: number | null;
  reversedById: string | null;
  reversedByEntryNo: number | null;
}

export interface JournalFilters {
  from: string;
  to: string;
  status: string;
  sourceType: string;
  accountId: string;
  minAmount: string;
  maxAmount: string;
  q: string;
}

export interface AuditEntryRow {
  id: number;
  op: 'INSERT' | 'UPDATE' | 'DELETE';
  tableName: string;
  rowId: string;
  atLabel: string;
  actorLabel: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

export interface AuditFilters {
  table: string;
  op: string;
  actorId: string;
  from: string;
  to: string;
  q: string;
}

export interface ActorOption {
  id: string;
  label: string;
}

export interface PeriodRow {
  year: number;
  month: number;
  status: 'open' | 'closed';
  closedAtLabel: string | null;
  closedByLabel: string | null;
  entryCount: number;
  draftCount: number;
  debitCents: number;
  start: string;
  end: string;
  /** True for the month the books are sitting in today. */
  current: boolean;
}

/** `periods.month` is 1-12; every month label in the interface comes from here. */
export const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

export function monthLabel(year: number, month: number): string {
  return `${MONTH_NAMES[month - 1] ?? '—'} ${year}`;
}

export function periodKey(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}`;
}

/** Human labels for `source_type`, which is free text in the database. */
export const SOURCE_LABELS: Readonly<Record<string, string>> = {
  manual: 'Manual',
  bank: 'Bank',
  invoice: 'Invoice',
  receipt: 'Receipt',
  credit_memo: 'Credit memo',
  bill: 'Bill',
  bill_payment: 'Bill payment',
  vendor_credit: 'Vendor credit',
  payout: 'Payout',
  deduction: 'Deduction',
  cogs: 'COGS',
  inventory: 'Inventory',
  landed_cost: 'Landed cost',
  accrual: 'Accrual',
  depreciation: 'Depreciation',
  payroll: 'Payroll',
  sales_tax: 'Sales tax',
  recurring: 'Recurring',
  reversal: 'Reversal',
  opening_balance: 'Opening balance',
  qbo_migration: 'QuickBooks migration',
};

export function sourceLabel(sourceType: string): string {
  return SOURCE_LABELS[sourceType] ?? sourceType;
}

/**
 * Where a source document lives, once the module that owns it exists. Routes
 * that are not built yet are deliberately absent: the entry detail renders a
 * disabled affordance for those rather than a link that 404s.
 */
export const SOURCE_ROUTES: Readonly<Partial<Record<string, string>>> = {
  invoice: '/sales/invoices',
  receipt: '/sales/receipts',
  bill: '/purchases/bills',
  bill_payment: '/purchases/payments',
};

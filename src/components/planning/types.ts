/**
 * The shapes the Plan, Close and Dashboard screens are handed by their pages and
 * Server Actions. Plain data only: no database types cross into a component.
 */

export interface ActionFailure {
  code: string;
  message: string;
  /** Line-level detail: every bad row of a budget import, every task left before a close. */
  details?: string[];
}

export type ActionResult<T> = { ok: true; value: T } | { ok: false; error: ActionFailure };

/* ------------------------------------------------------------------- budget */

export interface BudgetVersionOption {
  id: string;
  name: string;
  fiscalYear: number;
  status: 'draft' | 'active' | 'archived';
  lineCount: number;
}

export interface BudgetAccountOption {
  id: string;
  code: string;
  name: string;
  type: 'revenue' | 'expense';
}

/** One account's no-channel budget for the twelve months, cents in statement sign. */
export interface BudgetGridRow {
  accountId: string;
  code: string;
  name: string;
  type: 'revenue' | 'expense';
  /** Index 0 is January. Null is a cell with no line. */
  months: (number | null)[];
}

export interface BudgetCellChange {
  accountCode: string;
  month: number;
  amountCents: number;
}

/** A budget-vs-actual row, flattened for the variance table. */
export interface VarianceRow {
  id: string;
  label: string;
  code: string | null;
  level: number;
  style: 'section' | 'account' | 'subtotal' | 'total';
  actualCents: number;
  budgetCents: number;
  varianceCents: number;
  /** Basis points of |budget|; 0 when there is no budget. */
  variancePctBp: number;
  /** True when a positive variance is good news (income lines and profit totals). */
  incomeLike: boolean;
  drilldownHref: string | null;
}

/* ----------------------------------------------------------------- forecast */

export type RecurrenceKey = 'none' | 'weekly' | 'biweekly' | 'semimonthly' | 'monthly' | 'quarterly';

export interface ForecastItemRow {
  id: string;
  label: string;
  category: string;
  direction: 'inflow' | 'outflow';
  amountCents: number;
  expectedDate: string;
  recurrence: RecurrenceKey;
  endDate: string | null;
  bankAccountId: string | null;
  confidence: string;
  notes: string | null;
}

export interface ForecastItemForm {
  label: string;
  category: string;
  direction: 'inflow' | 'outflow';
  amountCents: number;
  expectedDate: string;
  recurrence: RecurrenceKey;
  endDate: string | null;
  bankAccountId: string | null;
  confidence: string;
  notes: string | null;
}

export interface ForecastWeekRow {
  weekStart: string;
  weekEnd: string;
  openingCents: number;
  arInflowCents: number;
  itemInflowCents: number;
  apOutflowCents: number;
  itemOutflowCents: number;
  closingCents: number;
  flows: { date: string; label: string; direction: 'inflow' | 'outflow'; amountCents: number; overdue: boolean }[];
}

export interface BankAccountOption {
  id: string;
  label: string;
}

/* -------------------------------------------------------------------- close */

export type CloseTaskState = 'not_started' | 'pending' | 'in_progress' | 'done' | 'skipped' | 'blocked';

export interface CloseTaskRow {
  key: string;
  /** Null until the month's checklist has been started. */
  id: string | null;
  label: string;
  description: string;
  blocking: boolean;
  automatic: boolean;
  state: CloseTaskState;
  notes: string | null;
  completedLabel: string | null;
  /** The check run against the books as they stand right now. Null for a manual task. */
  live: { ok: boolean; message: string } | null;
  /** What the last recorded run found, when it has run. */
  recorded: { ok: boolean; message: string; checkedAtLabel: string } | null;
  fix: { href: string; label: string } | null;
}

export interface CloseMonthOption {
  key: string;
  year: number;
  month: number;
  label: string;
  status: 'open' | 'closed';
  current: boolean;
}

export interface ClosedPeriodRow {
  key: string;
  year: number;
  month: number;
  label: string;
  closedAtLabel: string | null;
  closedByLabel: string | null;
  viaChecklist: boolean;
  skippedCount: number;
}

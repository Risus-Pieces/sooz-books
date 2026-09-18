import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

import { bankAccounts } from './banking';
import { accounts, appUsers, channels } from './ledger';

/**
 * Budgets, the thirteen-week cash forecast, the period-close checklist,
 * recurring entries and the attachment index. Mirrors
 * supabase/migrations/0010_planning_close.sql as it stands in the live database.
 */

export const closeTaskStatusEnum = pgEnum('close_task_status', [
  'pending',
  'in_progress',
  'done',
  'skipped',
  'blocked',
]);

export const forecastDirectionEnum = pgEnum('forecast_direction', ['inflow', 'outflow']);

export type CloseTaskStatus = (typeof closeTaskStatusEnum.enumValues)[number];
export type ForecastDirection = (typeof forecastDirectionEnum.enumValues)[number];

/** One week of a cash forecast as it was projected. All amounts are cents. */
export interface ForecastWeek {
  /** Monday of the week, YYYY-MM-DD. */
  weekStart: string;
  openingCents: number;
  inflowCents: number;
  outflowCents: number;
  closingCents: number;
}

/**
 * What an automatic close check found when it ran. `values` carries the numbers
 * the check compared, so the checklist can show why it passed or failed without
 * running it again.
 */
export interface CloseTaskResult {
  ok: boolean;
  /** When the check ran, as an ISO 8601 timestamp. */
  checkedAt: string;
  message: string;
  values?: Record<string, string | number | null>;
}

/**
 * One line of a recurring entry's template. Accounts and channels are named by
 * code rather than id so a template survives a re-seed of the chart of accounts.
 * Exactly one of the two amounts is non-zero, as on a real journal line.
 */
export interface RecurringEntryLine {
  accountCode: string;
  debitCents: number;
  creditCents: number;
  memo?: string;
  channelCode?: string;
  productSku?: string;
}

export const budgetVersions = pgTable(
  'budget_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    fiscalYear: integer('fiscal_year').notNull(),
    status: text('status', { enum: ['draft', 'active', 'archived'] })
      .notNull()
      .default('draft'),
    notes: text('notes'),
    createdBy: uuid('created_by').references(() => appUsers.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('budget_versions_name_fiscal_year_key').on(t.name, t.fiscalYear),
    /** At most one active version per fiscal year — the one reports compare against. */
    uniqueIndex('budget_active_idx')
      .on(t.fiscalYear)
      .where(sql`${t.status} = 'active'`),
  ],
);

export const budgetLines = pgTable(
  'budget_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    versionId: uuid('version_id')
      .notNull()
      .references(() => budgetVersions.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    channelId: uuid('channel_id').references(() => channels.id),
    year: integer('year').notNull(),
    month: integer('month').notNull(),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull().default(0),
    notes: text('notes'),
  },
  (t) => [
    unique('budget_lines_version_id_account_id_channel_id_year_month_key').on(
      t.versionId,
      t.accountId,
      t.channelId,
      t.year,
      t.month,
    ),
    index('budget_lines_period_idx').on(t.versionId, t.year, t.month),
    check('budget_lines_month_check', sql`${t.month} >= 1 and ${t.month} <= 12`),
  ],
);

/**
 * A known future movement of cash that the ledger cannot derive — a deposit the
 * founder has promised, a co-man invoice not yet billed. `amount_cents` is
 * always positive; `direction` carries the sign.
 */
export const forecastItems = pgTable(
  'forecast_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    label: text('label').notNull(),
    category: text('category').notNull(),
    direction: forecastDirectionEnum('direction').notNull(),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    expectedDate: date('expected_date', { mode: 'string' }).notNull(),
    recurrence: text('recurrence', {
      enum: ['none', 'weekly', 'biweekly', 'semimonthly', 'monthly', 'quarterly'],
    })
      .notNull()
      .default('none'),
    endDate: date('end_date', { mode: 'string' }),
    bankAccountId: uuid('bank_account_id').references((): AnyPgColumn => bankAccounts.id),
    /** 0.000–1.000 as an exact decimal string; weights the item in the forecast. */
    confidence: numeric('confidence', { precision: 4, scale: 3, mode: 'string' })
      .notNull()
      .default('1.000'),
    active: boolean('active').notNull().default(true),
    notes: text('notes'),
    createdBy: uuid('created_by').references(() => appUsers.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('forecast_items_date_idx')
      .on(t.expectedDate)
      .where(sql`${t.active}`),
    check('forecast_items_amount_cents_check', sql`${t.amountCents} > 0`),
  ],
);

/** A forecast frozen as it stood, so last month's projection can be scored against reality. */
export const forecastSnapshots = pgTable('forecast_snapshots', {
  id: uuid('id').primaryKey().defaultRandom(),
  asOfDate: date('as_of_date', { mode: 'string' })
    .notNull()
    .unique('forecast_snapshots_as_of_date_key'),
  weeks: jsonb('weeks').$type<ForecastWeek[]>().notNull(),
  createdBy: uuid('created_by').references(() => appUsers.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const closeChecklists = pgTable(
  'close_checklists',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    year: integer('year').notNull(),
    month: integer('month').notNull(),
    status: text('status', { enum: ['open', 'in_progress', 'complete'] })
      .notNull()
      .default('open'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    completedBy: uuid('completed_by').references(() => appUsers.id),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('close_checklists_year_month_key').on(t.year, t.month),
    check('close_checklists_month_check', sql`${t.month} >= 1 and ${t.month} <= 12`),
  ],
);

/**
 * One item on a month's checklist. A `blocking` task must be done, or skipped
 * with a reason, before the period locks. When `auto_check` is set the task is
 * evaluated by the system rather than ticked by hand and the outcome lands in
 * `result`.
 */
export const closeTasks = pgTable(
  'close_tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    checklistId: uuid('checklist_id')
      .notNull()
      .references(() => closeChecklists.id, { onDelete: 'cascade' }),
    /** Stable identifier, e.g. 'bank_recs_complete'. */
    key: text('key').notNull(),
    label: text('label').notNull(),
    description: text('description'),
    sortOrder: integer('sort_order').notNull().default(0),
    blocking: boolean('blocking').notNull().default(true),
    /** Names the automatic check to run, e.g. 'no_draft_entries', 'clearing_zero', 'ar_ties'. */
    autoCheck: text('auto_check'),
    status: closeTaskStatusEnum('status').notNull().default('pending'),
    result: jsonb('result').$type<CloseTaskResult>(),
    completedBy: uuid('completed_by').references(() => appUsers.id),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    notes: text('notes'),
  },
  (t) => [unique('close_tasks_checklist_id_key_key').on(t.checklistId, t.key)],
);

/**
 * A journal entry that repeats — rent, depreciation, amortised prepaid,
 * standing accruals. `auto_post` is the only thing that lets one reach the
 * ledger without a human, and is set deliberately.
 */
export const recurringEntries = pgTable(
  'recurring_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    frequency: text('frequency', {
      enum: ['weekly', 'monthly', 'quarterly', 'annually'],
    }).notNull(),
    dayOfMonth: integer('day_of_month'),
    startDate: date('start_date', { mode: 'string' }).notNull(),
    endDate: date('end_date', { mode: 'string' }),
    /** The next date this entry is due; advanced after each posting. */
    nextDate: date('next_date', { mode: 'string' }).notNull(),
    memo: text('memo'),
    template: jsonb('template').$type<RecurringEntryLine[]>().notNull(),
    autoPost: boolean('auto_post').notNull().default(false),
    active: boolean('active').notNull().default(true),
    lastPostedDate: date('last_posted_date', { mode: 'string' }),
    createdBy: uuid('created_by').references(() => appUsers.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('recurring_next_idx')
      .on(t.nextDate)
      .where(sql`${t.active}`),
  ],
);

/**
 * Receipts, vendor invoices, statements and remittance PDFs. The files live in
 * Supabase Storage; this is the index. `entity_type` is open — 'journal_entry',
 * 'bill', 'invoice', 'bank_transaction', 'deduction' and more — and is not
 * constrained in SQL, so it is left as plain text here.
 */
export const attachments = pgTable(
  'attachments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    filename: text('filename').notNull(),
    storagePath: text('storage_path').notNull(),
    mimeType: text('mime_type'),
    sizeBytes: bigint('size_bytes', { mode: 'number' }),
    /** Content hash, so the same receipt is not stored twice. */
    sha256: text('sha256'),
    uploadedBy: uuid('uploaded_by').references(() => appUsers.id),
    uploadedAt: timestamp('uploaded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('attachments_entity_idx').on(t.entityType, t.entityId),
    index('attachments_sha_idx').on(t.sha256),
  ],
);

export type BudgetVersion = typeof budgetVersions.$inferSelect;
export type NewBudgetVersion = typeof budgetVersions.$inferInsert;

export type BudgetLine = typeof budgetLines.$inferSelect;
export type NewBudgetLine = typeof budgetLines.$inferInsert;

export type ForecastItem = typeof forecastItems.$inferSelect;
export type NewForecastItem = typeof forecastItems.$inferInsert;

export type ForecastSnapshot = typeof forecastSnapshots.$inferSelect;
export type NewForecastSnapshot = typeof forecastSnapshots.$inferInsert;

export type CloseChecklist = typeof closeChecklists.$inferSelect;
export type NewCloseChecklist = typeof closeChecklists.$inferInsert;

export type CloseTask = typeof closeTasks.$inferSelect;
export type NewCloseTask = typeof closeTasks.$inferInsert;

export type RecurringEntry = typeof recurringEntries.$inferSelect;
export type NewRecurringEntry = typeof recurringEntries.$inferInsert;

export type Attachment = typeof attachments.$inferSelect;
export type NewAttachment = typeof attachments.$inferInsert;

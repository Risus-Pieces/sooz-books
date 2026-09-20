import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  pgView,
  text,
  timestamp,
  unique,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

import { accountTypeEnum, appRoleEnum, jeStatusEnum, periodStatusEnum } from './enums';

/**
 * These definitions mirror the live schema created by supabase/migrations. The
 * SQL is the contract — migrations are hand-written and applied with psql — so
 * anything changed here must already be true of the database.
 */

export const appUsers = pgTable('app_users', {
  // One row per auth.users row. The ON DELETE CASCADE foreign key onto that
  // table lives in SQL; the auth schema belongs to Supabase and is deliberately
  // not modelled here so nothing in this repo can be diffed against it.
  id: uuid('id').primaryKey(),
  email: text('email').notNull(),
  fullName: text('full_name'),
  role: appRoleEnum('role').notNull().default('viewer'),
  active: boolean('active').notNull().default(true),
  // The member's own capital accounts. Null falls back to the pooled 3015 / 3020,
  // which is what a single-member set of books wants. See `lib/ledger/member-equity`.
  contributionsAccountId: uuid('contributions_account_id'),
  drawsAccountId: uuid('draws_account_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const channels = pgTable('channels', {
  id: uuid('id').primaryKey().defaultRandom(),
  code: text('code').notNull().unique('channels_code_key'),
  name: text('name').notNull(),
  active: boolean('active').notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
});

export const products = pgTable('products', {
  id: uuid('id').primaryKey().defaultRandom(),
  sku: text('sku').notNull().unique('products_sku_key'),
  name: text('name').notNull(),
  unit: text('unit').notNull().default('each'),
  unitsPerCase: integer('units_per_case'),
  active: boolean('active').notNull().default(true),
  peasyId: text('peasy_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const accounts = pgTable(
  'accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    code: text('code').notNull().unique('accounts_code_key'),
    name: text('name').notNull(),
    type: accountTypeEnum('type').notNull(),
    subtype: text('subtype'),
    parentId: uuid('parent_id').references((): AnyPgColumn => accounts.id),
    description: text('description'),
    isBank: boolean('is_bank').notNull().default(false),
    isControl: boolean('is_control').notNull().default(false),
    clearingForChannelId: uuid('clearing_for_channel_id').references(() => channels.id),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('accounts_parent_idx').on(t.parentId), index('accounts_type_idx').on(t.type)],
);

export const periods = pgTable(
  'periods',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    year: integer('year').notNull(),
    month: integer('month').notNull(),
    status: periodStatusEnum('status').notNull().default('open'),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    closedBy: uuid('closed_by').references(() => appUsers.id),
  },
  (t) => [
    unique('periods_year_month_key').on(t.year, t.month),
    check('periods_month_check', sql`${t.month} >= 1 and ${t.month} <= 12`),
  ],
);

export const journalEntries = pgTable(
  'journal_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Handed out by journal_entry_number_seq. Never supplied by the application.
    entryNo: bigint('entry_no', { mode: 'number' })
      .notNull()
      .default(sql`nextval('journal_entry_number_seq'::regclass)`),
    entryDate: date('entry_date', { mode: 'string' }).notNull(),
    memo: text('memo'),
    // A posted entry is immutable and must balance; the only legal sequence is
    // insert as 'draft', insert lines, update to 'posted', all in one
    // transaction. See withActor() in src/db/client.ts.
    status: jeStatusEnum('status').notNull().default('draft'),
    sourceType: text('source_type').notNull().default('manual'),
    sourceId: uuid('source_id'),
    reversesId: uuid('reverses_id').references((): AnyPgColumn => journalEntries.id),
    reversedById: uuid('reversed_by_id').references((): AnyPgColumn => journalEntries.id),
    createdBy: uuid('created_by').references(() => appUsers.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    postedBy: uuid('posted_by').references(() => appUsers.id),
    postedAt: timestamp('posted_at', { withTimezone: true }),
  },
  (t) => [
    unique('journal_entries_entry_no_key').on(t.entryNo),
    index('je_date_idx').on(t.entryDate),
    index('je_source_idx').on(t.sourceType, t.sourceId),
    index('je_status_idx').on(t.status),
  ],
);

export const journalLines = pgTable(
  'journal_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entryId: uuid('entry_id')
      .notNull()
      .references(() => journalEntries.id, { onDelete: 'cascade' }),
    lineNo: integer('line_no').notNull(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    debitCents: bigint('debit_cents', { mode: 'number' }).notNull().default(0),
    creditCents: bigint('credit_cents', { mode: 'number' }).notNull().default(0),
    memo: text('memo'),
    channelId: uuid('channel_id').references(() => channels.id),
    // customers and vendors arrive in a later migration; their foreign keys are
    // added in SQL there rather than declared here.
    customerId: uuid('customer_id'),
    vendorId: uuid('vendor_id'),
    productId: uuid('product_id').references(() => products.id),
  },
  (t) => [
    unique('journal_lines_entry_id_line_no_key').on(t.entryId, t.lineNo),
    index('jl_account_idx').on(t.accountId),
    index('jl_channel_idx').on(t.channelId),
    index('jl_entry_idx').on(t.entryId),
    index('jl_product_idx').on(t.productId),
    check('journal_lines_debit_cents_check', sql`${t.debitCents} >= 0`),
    check('journal_lines_credit_cents_check', sql`${t.creditCents} >= 0`),
    check(
      'one_side_only',
      sql`${t.debitCents} > 0 and ${t.creditCents} = 0 or ${t.creditCents} > 0 and ${t.debitCents} = 0 or ${t.debitCents} = 0 and ${t.creditCents} = 0`,
    ),
  ],
);

export const auditLog = pgTable(
  'audit_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    tableName: text('table_name').notNull(),
    // Written as text so the trigger can log any table's primary key shape.
    rowId: text('row_id').notNull(),
    op: text('op', { enum: ['INSERT', 'UPDATE', 'DELETE'] }).notNull(),
    actorId: uuid('actor_id'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    before: jsonb('before').$type<Record<string, unknown>>(),
    after: jsonb('after').$type<Record<string, unknown>>(),
  },
  (t) => [
    index('audit_at_idx').on(t.at.desc()),
    index('audit_row_idx').on(t.tableName, t.rowId),
    check('audit_log_op_check', sql`${t.op} = any (array['INSERT', 'UPDATE', 'DELETE'])`),
  ],
);

/**
 * Posted-only balances per account, summed in the database. Postgres reports
 * every view column as nullable, but the definition COALESCEs both sums and
 * selects only NOT NULL account columns, so nothing here can come back null.
 * The sums widen to numeric because sum(bigint) does.
 */
export const accountBalances = pgView('account_balances', {
  accountId: uuid('account_id').notNull(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  type: accountTypeEnum('type').notNull(),
  debitCents: numeric('debit_cents', { mode: 'number' }).notNull(),
  creditCents: numeric('credit_cents', { mode: 'number' }).notNull(),
  balanceCents: numeric('balance_cents', { mode: 'number' }).notNull(),
}).existing();

export type AppUser = typeof appUsers.$inferSelect;
export type NewAppUser = typeof appUsers.$inferInsert;

export type Channel = typeof channels.$inferSelect;
export type NewChannel = typeof channels.$inferInsert;

export type Product = typeof products.$inferSelect;
export type NewProduct = typeof products.$inferInsert;

export type Account = typeof accounts.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;

export type Period = typeof periods.$inferSelect;
export type NewPeriod = typeof periods.$inferInsert;

export type JournalEntry = typeof journalEntries.$inferSelect;
export type NewJournalEntry = typeof journalEntries.$inferInsert;

export type JournalLine = typeof journalLines.$inferSelect;
export type NewJournalLine = typeof journalLines.$inferInsert;

export type AuditLogRow = typeof auditLog.$inferSelect;
export type NewAuditLogRow = typeof auditLog.$inferInsert;

export type AccountBalance = typeof accountBalances.$inferSelect;

import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  pgView,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

import { customers } from './arap';
import { bankTransactions, type ImportIssue, type RawImportRow } from './banking';
import { accounts, appUsers, channels, journalEntries, products } from './ledger';

/**
 * Channel settlements and sales tax. Mirrors supabase/migrations/0007_channels_tax.sql
 * as it stands in the live database.
 *
 * Revenue is never booked net. A Shopify, Amazon or Faire settlement arrives as
 * a payout with its full gross detail — sales, shipping, refunds, every fee —
 * and posts against that channel's clearing account; the bank deposit then
 * clears that account to zero. `payout_lines.amount_cents` is signed from the
 * company's point of view: positive increases the payout, negative reduces it,
 * and the lines must sum to `reported_total_cents` before anything posts.
 */

export const payoutProviderEnum = pgEnum('payout_provider', [
  'shopify',
  'amazon',
  'faire',
  'stripe',
  'paypal',
  'other',
  // Appended by migration 0014; pg_enum keeps labels in the order they were added.
  'square',
]);

export const payoutStatusEnum = pgEnum('payout_status', [
  'imported',
  'posted',
  'deposited',
  'discrepancy',
]);

export const payoutLineTypeEnum = pgEnum('payout_line_type', [
  'gross_sales',
  'shipping_income',
  'tip',
  'gift_card',
  'discount',
  'coupon',
  'promotion_rebate',
  'refund',
  'chargeback',
  'chargeback_reversal',
  'sales_tax_collected',
  'facilitator_tax',
  'referral_fee',
  'processing_fee',
  'fulfillment_fee',
  'storage_fee',
  'shipping_cost',
  'advertising',
  'subscription_fee',
  'reimbursement',
  'adjustment',
  'reserve_held',
  'reserve_released',
  'other',
]);

export type PayoutProvider = (typeof payoutProviderEnum.enumValues)[number];
export type PayoutStatus = (typeof payoutStatusEnum.enumValues)[number];
export type PayoutLineType = (typeof payoutLineTypeEnum.enumValues)[number];

/**
 * One settlement from one channel. `computed_total_cents` is what the lines add
 * up to and `reported_total_cents` is what the provider claims; any gap lands in
 * `discrepancy_cents` and holds the batch at `discrepancy` rather than posting.
 */
export const payoutImports = pgTable(
  'payout_imports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    provider: payoutProviderEnum('provider').notNull(),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id),
    /** The provider's own settlement id, where it gives one. */
    externalId: text('external_id'),
    periodStart: date('period_start', { mode: 'string' }),
    periodEnd: date('period_end', { mode: 'string' }),
    depositDate: date('deposit_date', { mode: 'string' }),
    reportedTotalCents: bigint('reported_total_cents', { mode: 'number' }),
    computedTotalCents: bigint('computed_total_cents', { mode: 'number' }).notNull().default(0),
    grossCents: bigint('gross_cents', { mode: 'number' }).notNull().default(0),
    feesCents: bigint('fees_cents', { mode: 'number' }).notNull().default(0),
    netCents: bigint('net_cents', { mode: 'number' }).notNull().default(0),
    clearingAccountId: uuid('clearing_account_id').references(() => accounts.id),
    status: payoutStatusEnum('status').notNull().default('imported'),
    discrepancyCents: bigint('discrepancy_cents', { mode: 'number' }).notNull().default(0),
    filename: text('filename'),
    fileHash: text('file_hash'),
    storagePath: text('storage_path'),
    journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id),
    bankTransactionId: uuid('bank_transaction_id').references((): AnyPgColumn => bankTransactions.id),
    warnings: jsonb('warnings').$type<ImportIssue[]>().notNull().default([]),
    importedBy: uuid('imported_by').references(() => appUsers.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('payout_external_idx')
      .on(t.provider, t.externalId)
      .where(sql`${t.externalId} is not null`),
    uniqueIndex('payout_file_hash_idx')
      .on(t.provider, t.fileHash)
      .where(sql`${t.fileHash} is not null`),
    index('payout_deposit_idx').on(t.depositDate),
  ],
);

/** One gross-detail line of a settlement, kept beside the row it was parsed from. */
export const payoutLines = pgTable(
  'payout_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    payoutImportId: uuid('payout_import_id')
      .notNull()
      .references(() => payoutImports.id, { onDelete: 'cascade' }),
    lineNo: integer('line_no').notNull(),
    lineType: payoutLineTypeEnum('line_type').notNull(),
    postedDate: date('posted_date', { mode: 'string' }),
    /** Order id or adjustment id, as the provider writes it. */
    externalRef: text('external_ref'),
    sku: text('sku'),
    productId: uuid('product_id').references(() => products.id),
    /** Units, not money: an exact decimal string with four places. */
    quantity: numeric('quantity', { precision: 14, scale: 4, mode: 'string' }),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    accountId: uuid('account_id').references(() => accounts.id),
    /** State code on a tax line. */
    jurisdiction: text('jurisdiction'),
    description: text('description'),
    raw: jsonb('raw').$type<RawImportRow>(),
  },
  (t) => [
    unique('payout_lines_payout_import_id_line_no_key').on(t.payoutImportId, t.lineNo),
    index('payout_lines_import_idx').on(t.payoutImportId),
    index('payout_lines_type_idx').on(t.lineType),
    index('payout_lines_product_idx').on(t.productId),
  ],
);

/** One filed return per state per period. */
export const salesTaxFilings = pgTable(
  'sales_tax_filings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    state: text('state').notNull(),
    periodStart: date('period_start', { mode: 'string' }).notNull(),
    periodEnd: date('period_end', { mode: 'string' }).notNull(),
    grossSalesCents: bigint('gross_sales_cents', { mode: 'number' }).notNull().default(0),
    taxableCents: bigint('taxable_cents', { mode: 'number' }).notNull().default(0),
    taxDueCents: bigint('tax_due_cents', { mode: 'number' }).notNull().default(0),
    taxPaidCents: bigint('tax_paid_cents', { mode: 'number' }).notNull().default(0),
    filedAt: timestamp('filed_at', { withTimezone: true }),
    paidAt: date('paid_at', { mode: 'string' }),
    confirmation: text('confirmation'),
    journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('sales_tax_filings_state_period_start_period_end_key').on(
      t.state,
      t.periodStart,
      t.periodEnd,
    ),
  ],
);

/**
 * Sales tax as it was charged, whatever charged it. `facilitator_remitted` is
 * the whole point: tax a marketplace already sent to the state is reported but
 * not owed, and is excluded from what the filing has to pay.
 */
export const salesTaxEntries = pgTable(
  'sales_tax_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceType: text('source_type', { enum: ['invoice', 'payout', 'manual'] }).notNull(),
    sourceId: uuid('source_id'),
    taxDate: date('tax_date', { mode: 'string' }).notNull(),
    /** Two-letter state code. */
    state: text('state').notNull(),
    /** County, city or special district, where the source breaks it out. */
    jurisdiction: text('jurisdiction'),
    channelId: uuid('channel_id').references(() => channels.id),
    customerId: uuid('customer_id').references((): AnyPgColumn => customers.id),
    taxableCents: bigint('taxable_cents', { mode: 'number' }).notNull().default(0),
    exemptCents: bigint('exempt_cents', { mode: 'number' }).notNull().default(0),
    taxCents: bigint('tax_cents', { mode: 'number' }).notNull().default(0),
    facilitatorRemitted: boolean('facilitator_remitted').notNull().default(false),
    filingId: uuid('filing_id').references(() => salesTaxFilings.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('sales_tax_state_date_idx').on(t.state, t.taxDate),
    index('sales_tax_source_idx').on(t.sourceType, t.sourceId),
  ],
);

/**
 * Tax collected per state per month, split into what a marketplace facilitator
 * already remitted and what Sooz still owes. Grouped over NOT NULL columns, so
 * every column here is non-null.
 */
export const salesTaxLiability = pgView('sales_tax_liability', {
  state: text('state').notNull(),
  /** First day of the month, from date_trunc. */
  period: date('period', { mode: 'string' }).notNull(),
  taxableCents: numeric('taxable_cents', { mode: 'number' }).notNull(),
  taxCents: numeric('tax_cents', { mode: 'number' }).notNull(),
  facilitatorCents: numeric('facilitator_cents', { mode: 'number' }).notNull(),
  owedCents: numeric('owed_cents', { mode: 'number' }).notNull(),
}).existing();

/**
 * Posted balance of every channel clearing account. A settled channel reads
 * zero; anything else is a payout that has not been matched to its deposit, and
 * the close checklist blocks on it.
 */
export const channelClearingBalances = pgView('channel_clearing_balances', {
  accountId: uuid('account_id').notNull(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  channelCode: text('channel_code').notNull(),
  balanceCents: numeric('balance_cents', { mode: 'number' }).notNull(),
}).existing();

export type PayoutImport = typeof payoutImports.$inferSelect;
export type NewPayoutImport = typeof payoutImports.$inferInsert;

export type PayoutLine = typeof payoutLines.$inferSelect;
export type NewPayoutLine = typeof payoutLines.$inferInsert;

export type SalesTaxEntry = typeof salesTaxEntries.$inferSelect;
export type NewSalesTaxEntry = typeof salesTaxEntries.$inferInsert;

export type SalesTaxFiling = typeof salesTaxFilings.$inferSelect;
export type NewSalesTaxFiling = typeof salesTaxFilings.$inferInsert;

export type SalesTaxLiabilityRow = typeof salesTaxLiability.$inferSelect;
export type ChannelClearingBalance = typeof channelClearingBalances.$inferSelect;

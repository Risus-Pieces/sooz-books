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
  pgView,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

import { customers, invoices, receipts } from './arap';
import { bankTransactions, type ImportIssue, type RawImportRow } from './banking';
import { accounts, appUsers, channels, journalEntries, products } from './ledger';

/**
 * Trade spend and deductions — the distributor side of a CPG P&L. Mirrors
 * supabase/migrations/0008_trade.sql as it stands in the live database.
 *
 * A distributor pays an invoice short and tells you why in a remittance advice.
 * Each short-pay line becomes a `deduction` that is tracked from arrival to
 * resolution, never silently netted against revenue: `deduction_treatment`
 * records where it lands, and `deductions.status` records whether it was valid.
 *
 * Sooz is pre-launch and has no distributor yet, so these tables are empty; the
 * shapes are here so the first remittance has somewhere correct to go.
 */

export const promoTypeEnum = pgEnum('promo_type', [
  'off_invoice',
  'billback',
  'mcb',
  'scan_down',
  'slotting',
  'free_fill',
  'new_item_allowance',
  'ad_fee',
  'tpr',
  'demo',
  'sampling',
  'spoils_allowance',
  'freight_allowance',
  'early_pay_discount',
  'other',
]);

export const promoStatusEnum = pgEnum('promo_status', [
  'planned',
  'active',
  'completed',
  'cancelled',
]);

export const deductionStatusEnum = pgEnum('deduction_status', [
  'open',
  'validated',
  'disputed',
  'recovered',
  'written_off',
  'partially_recovered',
]);

export const deductionTreatmentEnum = pgEnum('deduction_treatment', [
  'contra_revenue',
  'dispute',
  'cogs',
  'expense',
  'ar_payment',
]);

export type PromoType = (typeof promoTypeEnum.enumValues)[number];
export type PromoStatus = (typeof promoStatusEnum.enumValues)[number];
export type DeductionStatus = (typeof deductionStatusEnum.enumValues)[number];
export type DeductionTreatment = (typeof deductionTreatmentEnum.enumValues)[number];

/**
 * The distributor's own reason codes, mapped once to how each should be booked.
 * An unmapped code posts to unapplied deductions and blocks the close rather
 * than guessing — docs/formats/distributor-deductions.md §7.4.
 */
export const deductionReasonCodes = pgTable('deduction_reason_codes', {
  /** The distributor's code, verbatim. Natural primary key. */
  code: text('code').primaryKey(),
  label: text('label').notNull(),
  /** Grouping for reporting: promotion, shortage, quality, pricing, admin, … */
  category: text('category').notNull(),
  defaultTreatment: deductionTreatmentEnum('default_treatment').notNull(),
  defaultAccountId: uuid('default_account_id').references(() => accounts.id),
  /** How long after the deduction date it may still be challenged. */
  disputeWindowDays: integer('dispute_window_days').notNull().default(90),
  /** False for codes that are usually worth disputing. */
  typicallyValid: boolean('typically_valid').notNull().default(true),
  notes: text('notes'),
  active: boolean('active').notNull().default(true),
});

/** A planned trade promotion: what was authorized, accrued and actually spent. */
export const promotions = pgTable(
  'promotions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    customerId: uuid('customer_id').references((): AnyPgColumn => customers.id),
    channelId: uuid('channel_id').references(() => channels.id),
    promoType: promoTypeEnum('promo_type').notNull(),
    startDate: date('start_date', { mode: 'string' }).notNull(),
    endDate: date('end_date', { mode: 'string' }).notNull(),
    /** The ship window, which may lead or lag the performance window. */
    shipStartDate: date('ship_start_date', { mode: 'string' }),
    shipEndDate: date('ship_end_date', { mode: 'string' }),
    /** Units, not money: an exact decimal string with two places. */
    plannedUnits: numeric('planned_units', { precision: 14, scale: 2, mode: 'string' }),
    allowancePerUnitCents: bigint('allowance_per_unit_cents', { mode: 'number' }),
    plannedSpendCents: bigint('planned_spend_cents', { mode: 'number' }).notNull().default(0),
    accruedCents: bigint('accrued_cents', { mode: 'number' }).notNull().default(0),
    actualSpendCents: bigint('actual_spend_cents', { mode: 'number' }).notNull().default(0),
    status: promoStatusEnum('status').notNull().default('planned'),
    authorizationNo: text('authorization_no'),
    notes: text('notes'),
    createdBy: uuid('created_by').references(() => appUsers.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('promotions_customer_idx').on(t.customerId),
    index('promotions_dates_idx').on(t.startDate, t.endDate),
    check('promo_dates', sql`${t.endDate} >= ${t.startDate}`),
  ],
);

/** Per-SKU detail of a promotion, where the allowance differs by product. */
export const promotionProducts = pgTable(
  'promotion_products',
  {
    promotionId: uuid('promotion_id')
      .notNull()
      .references(() => promotions.id, { onDelete: 'cascade' }),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id),
    plannedUnits: numeric('planned_units', { precision: 14, scale: 2, mode: 'string' }),
    allowancePerUnitCents: bigint('allowance_per_unit_cents', { mode: 'number' }),
  },
  (t) => [primaryKey({ name: 'promotion_products_pkey', columns: [t.promotionId, t.productId] })],
);

/**
 * A remittance advice: the document that explains a distributor's payment.
 * `invoices_gross_cents` less `deductions_cents` must equal `total_cents`, and
 * the importer refuses the file if it does not.
 */
export const remittances = pgTable(
  'remittances',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    customerId: uuid('customer_id')
      .notNull()
      .references((): AnyPgColumn => customers.id),
    remittanceDate: date('remittance_date', { mode: 'string' }).notNull(),
    reference: text('reference'),
    totalCents: bigint('total_cents', { mode: 'number' }).notNull(),
    invoicesGrossCents: bigint('invoices_gross_cents', { mode: 'number' }).notNull().default(0),
    deductionsCents: bigint('deductions_cents', { mode: 'number' }).notNull().default(0),
    filename: text('filename'),
    fileHash: text('file_hash'),
    storagePath: text('storage_path'),
    receiptId: uuid('receipt_id').references((): AnyPgColumn => receipts.id),
    bankTransactionId: uuid('bank_transaction_id').references((): AnyPgColumn => bankTransactions.id),
    status: text('status', { enum: ['imported', 'posted', 'discrepancy'] })
      .notNull()
      .default('imported'),
    warnings: jsonb('warnings').$type<ImportIssue[]>().notNull().default([]),
    importedBy: uuid('imported_by').references(() => appUsers.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('remittance_hash_idx')
      .on(t.customerId, t.fileHash)
      .where(sql`${t.fileHash} is not null`),
  ],
);

/** One invoice's worth of a remittance: what was billed, taken and paid. */
export const remittanceLines = pgTable(
  'remittance_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    remittanceId: uuid('remittance_id')
      .notNull()
      .references(() => remittances.id, { onDelete: 'cascade' }),
    lineNo: integer('line_no').notNull(),
    /** As printed on the advice, before it is resolved to an invoice row. */
    invoiceNo: text('invoice_no'),
    invoiceId: uuid('invoice_id').references((): AnyPgColumn => invoices.id),
    grossCents: bigint('gross_cents', { mode: 'number' }).notNull().default(0),
    deductionCents: bigint('deduction_cents', { mode: 'number' }).notNull().default(0),
    netCents: bigint('net_cents', { mode: 'number' }).notNull().default(0),
    reasonCode: text('reason_code').references(() => deductionReasonCodes.code),
    description: text('description'),
    raw: jsonb('raw').$type<RawImportRow>(),
  },
  (t) => [unique('remittance_lines_remittance_id_line_no_key').on(t.remittanceId, t.lineNo)],
);

/**
 * One short-pay, tracked from arrival to resolution. `amount_cents` is always
 * positive — the direction is carried by `treatment`. `recovered_cents` plus
 * `written_off_cents` may never exceed it.
 */
export const deductions = pgTable(
  'deductions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    deductionNo: text('deduction_no').notNull().unique('deductions_deduction_no_key'),
    customerId: uuid('customer_id')
      .notNull()
      .references((): AnyPgColumn => customers.id),
    deductionDate: date('deduction_date', { mode: 'string' }).notNull(),
    reasonCode: text('reason_code').references(() => deductionReasonCodes.code),
    invoiceId: uuid('invoice_id').references((): AnyPgColumn => invoices.id),
    /** Kept verbatim even when the invoice cannot be resolved. */
    invoiceNo: text('invoice_no'),
    promotionId: uuid('promotion_id').references(() => promotions.id),
    remittanceId: uuid('remittance_id').references(() => remittances.id),
    remittanceLineId: uuid('remittance_line_id').references(() => remittanceLines.id),
    reference: text('reference'),
    description: text('description'),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    status: deductionStatusEnum('status').notNull().default('open'),
    treatment: deductionTreatmentEnum('treatment').notNull().default('dispute'),
    recoveredCents: bigint('recovered_cents', { mode: 'number' }).notNull().default(0),
    writtenOffCents: bigint('written_off_cents', { mode: 'number' }).notNull().default(0),
    journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id),
    resolutionEntryId: uuid('resolution_entry_id').references(() => journalEntries.id),
    disputedAt: timestamp('disputed_at', { withTimezone: true }),
    disputeReference: text('dispute_reference'),
    disputeNotes: text('dispute_notes'),
    /** After this date the deduction can no longer be challenged. */
    disputeDeadline: date('dispute_deadline', { mode: 'string' }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolvedBy: uuid('resolved_by').references(() => appUsers.id),
    assignedTo: uuid('assigned_to').references(() => appUsers.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('deductions_customer_idx').on(t.customerId),
    index('deductions_date_idx').on(t.deductionDate),
    index('deductions_promo_idx').on(t.promotionId),
    index('deductions_status_idx')
      .on(t.status)
      .where(sql`${t.status} in ('open', 'disputed')`),
    index('deductions_deadline_idx')
      .on(t.disputeDeadline)
      .where(sql`${t.status} in ('open', 'disputed')`),
    check('deductions_amount_cents_check', sql`${t.amountCents} > 0`),
    check(
      'deduction_resolution_within_amount',
      sql`${t.recoveredCents} + ${t.writtenOffCents} <= ${t.amountCents}`,
    ),
  ],
);

/**
 * The monthly trade accrual, so a promotion's cost sits in the period it was
 * earned rather than the period the distributor got round to taking it.
 */
export const tradeAccruals = pgTable(
  'trade_accruals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    periodYear: integer('period_year').notNull(),
    periodMonth: integer('period_month').notNull(),
    promotionId: uuid('promotion_id').references(() => promotions.id),
    customerId: uuid('customer_id').references((): AnyPgColumn => customers.id),
    basis: text('basis', { enum: ['planned', 'rate', 'manual'] })
      .notNull()
      .default('planned'),
    accruedCents: bigint('accrued_cents', { mode: 'number' }).notNull().default(0),
    /** Relieved by deductions that actually arrived against this accrual. */
    relievedCents: bigint('relieved_cents', { mode: 'number' }).notNull().default(0),
    reversedCents: bigint('reversed_cents', { mode: 'number' }).notNull().default(0),
    journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id),
    reversalEntryId: uuid('reversal_entry_id').references(() => journalEntries.id),
    notes: text('notes'),
    createdBy: uuid('created_by').references(() => appUsers.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('trade_accruals_period_idx').on(t.periodYear, t.periodMonth),
    check('trade_accruals_period_month_check', sql`${t.periodMonth} >= 1 and ${t.periodMonth} <= 12`),
  ],
);

/**
 * Unresolved deductions with their clocks. Filtered to open, disputed and
 * partially recovered rows, so a row here always has something left to chase.
 * `reason_code`, `reason_label` and `category` are null when the distributor
 * used a code that has not been mapped yet.
 */
export const deductionAging = pgView('deduction_aging', {
  id: uuid('id').notNull(),
  deductionNo: text('deduction_no').notNull(),
  customerId: uuid('customer_id').notNull(),
  customerName: text('customer_name').notNull(),
  deductionDate: date('deduction_date', { mode: 'string' }).notNull(),
  reasonCode: text('reason_code'),
  reasonLabel: text('reason_label'),
  category: text('category'),
  amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
  recoveredCents: bigint('recovered_cents', { mode: 'number' }).notNull(),
  writtenOffCents: bigint('written_off_cents', { mode: 'number' }).notNull(),
  openCents: bigint('open_cents', { mode: 'number' }).notNull(),
  status: deductionStatusEnum('status').notNull(),
  disputeDeadline: date('dispute_deadline', { mode: 'string' }),
  daysOutstanding: integer('days_outstanding').notNull(),
  /** Null when no deadline is recorded; negative once it has passed. */
  daysToDeadline: integer('days_to_deadline'),
}).existing();

/**
 * Planned against actual trade spend per promotion. `deducted_cents` is the sum
 * of the deductions attributed to it and `variance_cents` is plan less actual,
 * so a negative variance is an overspend. Both widen to numeric because sum()
 * over bigint does; both are COALESCEd and cannot be null.
 */
export const promotionPerformance = pgView('promotion_performance', {
  id: uuid('id').notNull(),
  name: text('name').notNull(),
  promoType: promoTypeEnum('promo_type').notNull(),
  customerId: uuid('customer_id'),
  customerName: text('customer_name'),
  startDate: date('start_date', { mode: 'string' }).notNull(),
  endDate: date('end_date', { mode: 'string' }).notNull(),
  status: promoStatusEnum('status').notNull(),
  plannedSpendCents: bigint('planned_spend_cents', { mode: 'number' }).notNull(),
  accruedCents: bigint('accrued_cents', { mode: 'number' }).notNull(),
  deductedCents: numeric('deducted_cents', { mode: 'number' }).notNull(),
  varianceCents: numeric('variance_cents', { mode: 'number' }).notNull(),
}).existing();

export type DeductionReasonCode = typeof deductionReasonCodes.$inferSelect;
export type NewDeductionReasonCode = typeof deductionReasonCodes.$inferInsert;

export type Promotion = typeof promotions.$inferSelect;
export type NewPromotion = typeof promotions.$inferInsert;

export type PromotionProduct = typeof promotionProducts.$inferSelect;
export type NewPromotionProduct = typeof promotionProducts.$inferInsert;

export type Remittance = typeof remittances.$inferSelect;
export type NewRemittance = typeof remittances.$inferInsert;

export type RemittanceLine = typeof remittanceLines.$inferSelect;
export type NewRemittanceLine = typeof remittanceLines.$inferInsert;

export type Deduction = typeof deductions.$inferSelect;
export type NewDeduction = typeof deductions.$inferInsert;

export type TradeAccrual = typeof tradeAccruals.$inferSelect;
export type NewTradeAccrual = typeof tradeAccruals.$inferInsert;

export type DeductionAgingRow = typeof deductionAging.$inferSelect;
export type PromotionPerformanceRow = typeof promotionPerformance.$inferSelect;

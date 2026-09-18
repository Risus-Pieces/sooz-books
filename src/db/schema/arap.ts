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
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

import { bankTransactions } from './banking';
import { accounts, appUsers, channels, journalEntries, products } from './ledger';
import { remittances } from './trade';

/**
 * Accounts receivable and accounts payable: customers, invoices, receipts and
 * credit memos on one side; vendors, bills, payments and vendor credits on the
 * other. Mirrors supabase/migrations/0005_ar_ap.sql and the vendor_aliases table
 * added in 0011_sooz_setup.sql as they stand in the live database.
 *
 * Money is integer cents in `bigint`. `numeric` columns are quantities and rates
 * and come back as exact decimal strings — they are not money and never go
 * through the cents path.
 */

export const docStatusEnum = pgEnum('doc_status', ['draft', 'open', 'partial', 'paid', 'void']);

export const paymentMethodEnum = pgEnum('payment_method', [
  'ach',
  'check',
  'wire',
  'card',
  'cash',
  'marketplace',
  'bill_pay',
  'other',
]);

export const customerTypeEnum = pgEnum('customer_type', [
  'dtc',
  'marketplace',
  'distributor',
  'wholesale',
  'foodservice',
  'other',
]);

export const vendorTypeEnum = pgEnum('vendor_type', [
  'co_manufacturer',
  'ingredients',
  'packaging',
  'freight',
  'warehouse_3pl',
  'broker',
  'marketing',
  'professional',
  'software',
  'other',
]);

export type DocStatus = (typeof docStatusEnum.enumValues)[number];
export type PaymentMethod = (typeof paymentMethodEnum.enumValues)[number];
export type CustomerType = (typeof customerTypeEnum.enumValues)[number];
export type VendorType = (typeof vendorTypeEnum.enumValues)[number];

/** A postal address as captured from a customer or vendor record. */
export interface PostalAddress {
  line1?: string;
  line2?: string;
  city?: string;
  /** Two-letter code for US addresses. */
  state?: string;
  postalCode?: string;
  /** ISO 3166-1 alpha-2; absent means US. */
  country?: string;
}

/**
 * The ids a party is known by in other systems, keyed by system name —
 * 'shopify', 'faire', 'amazon', 'peasy', or a distributor's vendor number.
 */
export type ExternalIds = Record<string, string>;

export const customers = pgTable(
  'customers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    displayName: text('display_name'),
    customerType: customerTypeEnum('customer_type').notNull().default('wholesale'),
    channelId: uuid('channel_id').references(() => channels.id),
    email: text('email'),
    phone: text('phone'),
    billingAddress: jsonb('billing_address').$type<PostalAddress>(),
    shippingAddress: jsonb('shipping_address').$type<PostalAddress>(),
    /** Net days, plus an optional early-payment discount: 2/10 net 30 is 2.00, 10, 30. */
    termsDays: integer('terms_days').notNull().default(30),
    termsDiscountPct: numeric('terms_discount_pct', { precision: 5, scale: 2, mode: 'string' })
      .notNull()
      .default('0'),
    termsDiscountDays: integer('terms_discount_days').notNull().default(0),
    creditLimitCents: bigint('credit_limit_cents', { mode: 'number' }),
    externalIds: jsonb('external_ids').$type<ExternalIds>().notNull().default({}),
    notes: text('notes'),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('customers_name_idx').on(sql`lower(${t.name})`),
    index('customers_channel_idx').on(t.channelId),
  ],
);

/**
 * `total_cents` less `paid_cents`, `credited_cents` and `deducted_cents` is what
 * is still open; the ar_open_items view below is the single definition of that
 * arithmetic. `deducted_cents` is what a distributor short-paid and is tracked
 * separately from a credit memo, because a deduction may still be recovered.
 */
export const invoices = pgTable(
  'invoices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    invoiceNo: text('invoice_no').notNull().unique('invoices_invoice_no_key'),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id),
    channelId: uuid('channel_id').references(() => channels.id),
    invoiceDate: date('invoice_date', { mode: 'string' }).notNull(),
    dueDate: date('due_date', { mode: 'string' }).notNull(),
    termsDays: integer('terms_days').notNull().default(30),
    poNumber: text('po_number'),
    memo: text('memo'),
    status: docStatusEnum('status').notNull().default('draft'),
    subtotalCents: bigint('subtotal_cents', { mode: 'number' }).notNull().default(0),
    discountCents: bigint('discount_cents', { mode: 'number' }).notNull().default(0),
    shippingCents: bigint('shipping_cents', { mode: 'number' }).notNull().default(0),
    taxCents: bigint('tax_cents', { mode: 'number' }).notNull().default(0),
    totalCents: bigint('total_cents', { mode: 'number' }).notNull().default(0),
    paidCents: bigint('paid_cents', { mode: 'number' }).notNull().default(0),
    creditedCents: bigint('credited_cents', { mode: 'number' }).notNull().default(0),
    deductedCents: bigint('deducted_cents', { mode: 'number' }).notNull().default(0),
    journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id),
    /** manual, shopify, faire, amazon, import, qbo_migration — open by design. */
    source: text('source').notNull().default('manual'),
    externalId: text('external_id'),
    createdBy: uuid('created_by').references(() => appUsers.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('invoices_customer_idx').on(t.customerId),
    index('invoices_date_idx').on(t.invoiceDate),
    index('invoices_due_idx')
      .on(t.dueDate)
      .where(sql`${t.status} in ('open', 'partial')`),
    index('invoices_status_idx')
      .on(t.status)
      .where(sql`${t.status} in ('open', 'partial')`),
    uniqueIndex('invoices_source_external_idx')
      .on(t.source, t.externalId)
      .where(sql`${t.externalId} is not null`),
    check(
      'invoice_amounts_nonneg',
      sql`${t.subtotalCents} >= 0 and ${t.shippingCents} >= 0 and ${t.taxCents} >= 0
        and ${t.paidCents} >= 0 and ${t.creditedCents} >= 0 and ${t.deductedCents} >= 0`,
    ),
  ],
);

export const invoiceLines = pgTable(
  'invoice_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoices.id, { onDelete: 'cascade' }),
    lineNo: integer('line_no').notNull(),
    productId: uuid('product_id').references(() => products.id),
    description: text('description').notNull(),
    /** Units, not money: an exact decimal string with four places. */
    quantity: numeric('quantity', { precision: 14, scale: 4, mode: 'string' })
      .notNull()
      .default('1'),
    unitPriceCents: bigint('unit_price_cents', { mode: 'number' }).notNull().default(0),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull().default(0),
    discountCents: bigint('discount_cents', { mode: 'number' }).notNull().default(0),
    taxCents: bigint('tax_cents', { mode: 'number' }).notNull().default(0),
    revenueAccountId: uuid('revenue_account_id').references(() => accounts.id),
    channelId: uuid('channel_id').references(() => channels.id),
  },
  (t) => [
    unique('invoice_lines_invoice_id_line_no_key').on(t.invoiceId, t.lineNo),
    index('invoice_lines_invoice_idx').on(t.invoiceId),
    index('invoice_lines_product_idx').on(t.productId),
  ],
);

/**
 * Cash in. `customer_id` is nullable because a deposit can land before anyone
 * knows whose it is; `remittance_id` ties a distributor's advice to the money
 * that actually arrived.
 */
export const receipts = pgTable(
  'receipts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    receiptNo: text('receipt_no').notNull().unique('receipts_receipt_no_key'),
    customerId: uuid('customer_id').references(() => customers.id),
    receiptDate: date('receipt_date', { mode: 'string' }).notNull(),
    method: paymentMethodEnum('method').notNull().default('ach'),
    reference: text('reference'),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    appliedCents: bigint('applied_cents', { mode: 'number' }).notNull().default(0),
    depositAccountId: uuid('deposit_account_id')
      .notNull()
      .references(() => accounts.id),
    journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id),
    bankTransactionId: uuid('bank_transaction_id').references((): AnyPgColumn => bankTransactions.id),
    remittanceId: uuid('remittance_id').references((): AnyPgColumn => remittances.id),
    memo: text('memo'),
    createdBy: uuid('created_by').references(() => appUsers.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('receipts_customer_idx').on(t.customerId),
    index('receipts_date_idx').on(t.receiptDate),
    check('receipts_amount_cents_check', sql`${t.amountCents} > 0`),
  ],
);

export const receiptApplications = pgTable(
  'receipt_applications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    receiptId: uuid('receipt_id')
      .notNull()
      .references(() => receipts.id, { onDelete: 'cascade' }),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoices.id),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    /** Early-payment discount taken on this application, booked separately. */
    discountCents: bigint('discount_cents', { mode: 'number' }).notNull().default(0),
    appliedAt: timestamp('applied_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('receipt_applications_receipt_id_invoice_id_key').on(t.receiptId, t.invoiceId),
    index('receipt_apps_invoice_idx').on(t.invoiceId),
    check('receipt_applications_amount_cents_check', sql`${t.amountCents} > 0`),
    check('receipt_applications_discount_cents_check', sql`${t.discountCents} >= 0`),
  ],
);

export const creditMemos = pgTable(
  'credit_memos',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    memoNo: text('memo_no').notNull().unique('credit_memos_memo_no_key'),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id),
    memoDate: date('memo_date', { mode: 'string' }).notNull(),
    reason: text('reason').notNull(),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    appliedCents: bigint('applied_cents', { mode: 'number' }).notNull().default(0),
    /** The contra-revenue account the credit lands in; never netted against sales. */
    revenueAccountId: uuid('revenue_account_id').references(() => accounts.id),
    journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id),
    createdBy: uuid('created_by').references(() => appUsers.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check('credit_memos_amount_cents_check', sql`${t.amountCents} > 0`)],
);

export const creditMemoApplications = pgTable(
  'credit_memo_applications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    creditMemoId: uuid('credit_memo_id')
      .notNull()
      .references(() => creditMemos.id, { onDelete: 'cascade' }),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoices.id),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    appliedAt: timestamp('applied_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('credit_memo_applications_credit_memo_id_invoice_id_key').on(
      t.creditMemoId,
      t.invoiceId,
    ),
    check('credit_memo_applications_amount_cents_check', sql`${t.amountCents} > 0`),
  ],
);

export const vendors = pgTable(
  'vendors',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    displayName: text('display_name'),
    vendorType: vendorTypeEnum('vendor_type').notNull().default('other'),
    email: text('email'),
    phone: text('phone'),
    address: jsonb('address').$type<PostalAddress>(),
    termsDays: integer('terms_days').notNull().default(30),
    termsDiscountPct: numeric('terms_discount_pct', { precision: 5, scale: 2, mode: 'string' })
      .notNull()
      .default('0'),
    termsDiscountDays: integer('terms_discount_days').notNull().default(0),
    /** 1099-NEC tracking. Only the last four of the TIN is ever stored. */
    is1099: boolean('is_1099').notNull().default(false),
    taxIdLast4: text('tax_id_last4'),
    w9OnFile: boolean('w9_on_file').notNull().default(false),
    w9ReceivedAt: date('w9_received_at', { mode: 'string' }),
    legalName: text('legal_name'),
    defaultExpenseAccountId: uuid('default_expense_account_id').references(() => accounts.id),
    externalIds: jsonb('external_ids').$type<ExternalIds>().notNull().default({}),
    notes: text('notes'),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('vendors_name_idx').on(sql`lower(${t.name})`),
    index('vendors_1099_idx')
      .on(t.is1099)
      .where(sql`${t.is1099}`),
  ],
);

/**
 * The same merchant appears under several spellings on a statement — GOOGLE /
 * Google, FedEx / FEDEX533300619, "SP+AFF * META STORE -". Matching goes through
 * `alias_normalized`, which the database generates with normalize_description();
 * it is a stored generated column and is never written by the application.
 */
export const vendorAliases = pgTable(
  'vendor_aliases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    vendorId: uuid('vendor_id')
      .notNull()
      .references(() => vendors.id, { onDelete: 'cascade' }),
    alias: text('alias').notNull(),
    aliasNormalized: text('alias_normalized').generatedAlwaysAs(
      sql`normalize_description(alias)`,
    ),
    source: text('source', { enum: ['manual', 'learned'] })
      .notNull()
      .default('manual'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('vendor_aliases_vendor_id_alias_key').on(t.vendorId, t.alias),
    index('vendor_alias_norm_idx').on(t.aliasNormalized),
  ],
);

/** A vendor's bill number is unique per vendor, not globally. */
export const bills = pgTable(
  'bills',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    billNo: text('bill_no').notNull(),
    vendorId: uuid('vendor_id')
      .notNull()
      .references(() => vendors.id),
    billDate: date('bill_date', { mode: 'string' }).notNull(),
    dueDate: date('due_date', { mode: 'string' }).notNull(),
    termsDays: integer('terms_days').notNull().default(30),
    poNumber: text('po_number'),
    memo: text('memo'),
    status: docStatusEnum('status').notNull().default('draft'),
    subtotalCents: bigint('subtotal_cents', { mode: 'number' }).notNull().default(0),
    taxCents: bigint('tax_cents', { mode: 'number' }).notNull().default(0),
    shippingCents: bigint('shipping_cents', { mode: 'number' }).notNull().default(0),
    totalCents: bigint('total_cents', { mode: 'number' }).notNull().default(0),
    paidCents: bigint('paid_cents', { mode: 'number' }).notNull().default(0),
    creditedCents: bigint('credited_cents', { mode: 'number' }).notNull().default(0),
    journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id),
    /** manual, peasy, import, qbo_migration — open by design. */
    source: text('source').notNull().default('manual'),
    externalId: text('external_id'),
    createdBy: uuid('created_by').references(() => appUsers.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('bills_vendor_id_bill_no_key').on(t.vendorId, t.billNo),
    index('bills_vendor_idx').on(t.vendorId),
    index('bills_date_idx').on(t.billDate),
    index('bills_open_idx')
      .on(t.dueDate)
      .where(sql`${t.status} in ('open', 'partial')`),
  ],
);

/**
 * `is_inventory` marks a line that capitalizes rather than expensing — the
 * ingredient and packaging purchases that land in 1320 / 1330 instead of the
 * P&L. `production_run_id` carries it on to a run for landed costing.
 */
export const billLines = pgTable(
  'bill_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    billId: uuid('bill_id')
      .notNull()
      .references(() => bills.id, { onDelete: 'cascade' }),
    lineNo: integer('line_no').notNull(),
    description: text('description').notNull(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    /** Units purchased, not money: an exact decimal string with four places. */
    quantity: numeric('quantity', { precision: 14, scale: 4, mode: 'string' }),
    unitCostCents: bigint('unit_cost_cents', { mode: 'number' }),
    productId: uuid('product_id').references(() => products.id),
    channelId: uuid('channel_id').references(() => channels.id),
    isInventory: boolean('is_inventory').notNull().default(false),
    /**
     * The database holds `bill_lines_production_run_fk` — production_runs(id)
     * on delete set null. It is deliberately not mirrored as a `.references()`
     * here: that would make this module import ./inventory, and ./inventory
     * needs `importStatusEnum` from ./banking at module-evaluation time, which
     * would put an eagerly-read binding inside an import cycle. Same reasoning
     * as journal_lines.customer_id / vendor_id in ./ledger.
     */
    productionRunId: uuid('production_run_id'),
  },
  (t) => [
    unique('bill_lines_bill_id_line_no_key').on(t.billId, t.lineNo),
    index('bill_lines_bill_idx').on(t.billId),
    index('bill_lines_account_idx').on(t.accountId),
  ],
);

export const billPayments = pgTable(
  'bill_payments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    paymentNo: text('payment_no').notNull().unique('bill_payments_payment_no_key'),
    vendorId: uuid('vendor_id')
      .notNull()
      .references(() => vendors.id),
    paymentDate: date('payment_date', { mode: 'string' }).notNull(),
    method: paymentMethodEnum('method').notNull().default('ach'),
    reference: text('reference'),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    appliedCents: bigint('applied_cents', { mode: 'number' }).notNull().default(0),
    paymentAccountId: uuid('payment_account_id')
      .notNull()
      .references(() => accounts.id),
    journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id),
    bankTransactionId: uuid('bank_transaction_id').references((): AnyPgColumn => bankTransactions.id),
    /** Defaults true; cleared per payment when the vendor is not 1099-reportable. */
    is1099Reportable: boolean('is_1099_reportable').notNull().default(true),
    memo: text('memo'),
    createdBy: uuid('created_by').references(() => appUsers.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('bill_payments_vendor_idx').on(t.vendorId),
    index('bill_payments_date_idx').on(t.paymentDate),
    check('bill_payments_amount_cents_check', sql`${t.amountCents} > 0`),
  ],
);

export const billPaymentApplications = pgTable(
  'bill_payment_applications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    paymentId: uuid('payment_id')
      .notNull()
      .references(() => billPayments.id, { onDelete: 'cascade' }),
    billId: uuid('bill_id')
      .notNull()
      .references(() => bills.id),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    discountCents: bigint('discount_cents', { mode: 'number' }).notNull().default(0),
    appliedAt: timestamp('applied_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('bill_payment_applications_payment_id_bill_id_key').on(t.paymentId, t.billId),
    index('bill_payment_apps_bill_idx').on(t.billId),
    check('bill_payment_applications_amount_cents_check', sql`${t.amountCents} > 0`),
  ],
);

export const vendorCredits = pgTable(
  'vendor_credits',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    creditNo: text('credit_no').notNull().unique('vendor_credits_credit_no_key'),
    vendorId: uuid('vendor_id')
      .notNull()
      .references(() => vendors.id),
    creditDate: date('credit_date', { mode: 'string' }).notNull(),
    reason: text('reason').notNull(),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    appliedCents: bigint('applied_cents', { mode: 'number' }).notNull().default(0),
    /** The account the credit reverses — usually the original expense. */
    accountId: uuid('account_id').references(() => accounts.id),
    journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check('vendor_credits_amount_cents_check', sql`${t.amountCents} > 0`)],
);

export const vendorCreditApplications = pgTable(
  'vendor_credit_applications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    creditId: uuid('credit_id')
      .notNull()
      .references(() => vendorCredits.id, { onDelete: 'cascade' }),
    billId: uuid('bill_id')
      .notNull()
      .references(() => bills.id),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    appliedAt: timestamp('applied_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('vendor_credit_applications_credit_id_bill_id_key').on(t.creditId, t.billId),
    check('vendor_credit_applications_amount_cents_check', sql`${t.amountCents} > 0`),
  ],
);

/**
 * Open receivables with the balance arithmetic done once, in the database.
 * Postgres reports every view column as nullable; the columns marked notNull
 * here are selected from NOT NULL columns through an inner join, or are
 * arithmetic over them, so none can come back null.
 */
export const arOpenItems = pgView('ar_open_items', {
  invoiceId: uuid('invoice_id').notNull(),
  invoiceNo: text('invoice_no').notNull(),
  customerId: uuid('customer_id').notNull(),
  customerName: text('customer_name').notNull(),
  channelId: uuid('channel_id'),
  invoiceDate: date('invoice_date', { mode: 'string' }).notNull(),
  dueDate: date('due_date', { mode: 'string' }).notNull(),
  totalCents: bigint('total_cents', { mode: 'number' }).notNull(),
  paidCents: bigint('paid_cents', { mode: 'number' }).notNull(),
  creditedCents: bigint('credited_cents', { mode: 'number' }).notNull(),
  deductedCents: bigint('deducted_cents', { mode: 'number' }).notNull(),
  balanceCents: bigint('balance_cents', { mode: 'number' }).notNull(),
  /** Negative until the due date passes. */
  daysPastDue: integer('days_past_due').notNull(),
}).existing();

/** Open payables, same construction as ar_open_items. */
export const apOpenItems = pgView('ap_open_items', {
  billId: uuid('bill_id').notNull(),
  billNo: text('bill_no').notNull(),
  vendorId: uuid('vendor_id').notNull(),
  vendorName: text('vendor_name').notNull(),
  billDate: date('bill_date', { mode: 'string' }).notNull(),
  dueDate: date('due_date', { mode: 'string' }).notNull(),
  totalCents: bigint('total_cents', { mode: 'number' }).notNull(),
  paidCents: bigint('paid_cents', { mode: 'number' }).notNull(),
  creditedCents: bigint('credited_cents', { mode: 'number' }).notNull(),
  balanceCents: bigint('balance_cents', { mode: 'number' }).notNull(),
  daysPastDue: integer('days_past_due').notNull(),
}).existing();

export type Customer = typeof customers.$inferSelect;
export type NewCustomer = typeof customers.$inferInsert;

export type Invoice = typeof invoices.$inferSelect;
export type NewInvoice = typeof invoices.$inferInsert;

export type InvoiceLine = typeof invoiceLines.$inferSelect;
export type NewInvoiceLine = typeof invoiceLines.$inferInsert;

export type Receipt = typeof receipts.$inferSelect;
export type NewReceipt = typeof receipts.$inferInsert;

export type ReceiptApplication = typeof receiptApplications.$inferSelect;
export type NewReceiptApplication = typeof receiptApplications.$inferInsert;

export type CreditMemo = typeof creditMemos.$inferSelect;
export type NewCreditMemo = typeof creditMemos.$inferInsert;

export type CreditMemoApplication = typeof creditMemoApplications.$inferSelect;
export type NewCreditMemoApplication = typeof creditMemoApplications.$inferInsert;

export type Vendor = typeof vendors.$inferSelect;
export type NewVendor = typeof vendors.$inferInsert;

export type VendorAlias = typeof vendorAliases.$inferSelect;
export type NewVendorAlias = typeof vendorAliases.$inferInsert;

export type Bill = typeof bills.$inferSelect;
export type NewBill = typeof bills.$inferInsert;

export type BillLine = typeof billLines.$inferSelect;
export type NewBillLine = typeof billLines.$inferInsert;

export type BillPayment = typeof billPayments.$inferSelect;
export type NewBillPayment = typeof billPayments.$inferInsert;

export type BillPaymentApplication = typeof billPaymentApplications.$inferSelect;
export type NewBillPaymentApplication = typeof billPaymentApplications.$inferInsert;

export type VendorCredit = typeof vendorCredits.$inferSelect;
export type NewVendorCredit = typeof vendorCredits.$inferInsert;

export type VendorCreditApplication = typeof vendorCreditApplications.$inferSelect;
export type NewVendorCreditApplication = typeof vendorCreditApplications.$inferInsert;

export type ArOpenItem = typeof arOpenItems.$inferSelect;
export type ApOpenItem = typeof apOpenItems.$inferSelect;

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

import { billLines, bills, customers, vendors } from './arap';
import { importStatusEnum, type ImportIssue } from './banking';
import { accounts, appUsers, channels, journalEntries, products } from './ledger';

/**
 * Production, landed cost, inventory and COGS. Mirrors
 * supabase/migrations/0009_inventory_cogs.sql as it stands in the live database.
 *
 * The chain is: a production run collects its landed costs, which set a unit
 * cost effective from a date; shipped units in a period are valued at the cost
 * effective on that date and relieved from inventory in one COGS batch; the
 * resulting inventory balance is tied out against a counted snapshot.
 *
 * Quantities are `numeric` and come back as exact decimal strings. They are not
 * money and never go through the integer-cents path — `unit_cost_cents` and
 * `value_cents` carry the money, in cents, as everywhere else.
 */

export const costComponentEnum = pgEnum('cost_component', [
  'tolling',
  'ingredients',
  'packaging',
  'freight_in',
  'duty',
  'labor',
  'overhead',
  'other',
]);

export const costMethodEnum = pgEnum('cost_method', [
  'actual_run',
  'standard',
  'moving_average',
]);

export const inventoryAdjustmentReasonEnum = pgEnum('inventory_adjustment_reason', [
  'count_variance',
  'spoilage',
  'damage',
  'expiry',
  'samples',
  'demo',
  'donation',
  'theft',
  'rework',
  'revaluation',
  'opening_balance',
]);

export type CostComponent = (typeof costComponentEnum.enumValues)[number];
export type CostMethod = (typeof costMethodEnum.enumValues)[number];
export type InventoryAdjustmentReason = (typeof inventoryAdjustmentReasonEnum.enumValues)[number];

/**
 * Cents per component behind a unit cost, so the P&L can show tolling against
 * ingredients against freight-in. The parts sum to the unit cost they explain.
 */
export type CostBreakdown = Partial<Record<CostComponent, number>>;

/**
 * One co-manufacturing run. Stays `open` while its bills arrive, becomes
 * `costed` once `unit_cost_cents` is struck, then `closed`.
 */
export const productionRuns = pgTable(
  'production_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runNo: text('run_no').notNull().unique('production_runs_run_no_key'),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id),
    coManVendorId: uuid('co_man_vendor_id').references((): AnyPgColumn => vendors.id),
    runDate: date('run_date', { mode: 'string' }).notNull(),
    lotCode: text('lot_code'),
    unitsPlanned: numeric('units_planned', { precision: 14, scale: 2, mode: 'string' }),
    unitsProduced: numeric('units_produced', { precision: 14, scale: 2, mode: 'string' })
      .notNull()
      .default('0'),
    unitsRejected: numeric('units_rejected', { precision: 14, scale: 2, mode: 'string' })
      .notNull()
      .default('0'),
    status: text('status', { enum: ['open', 'costed', 'closed'] })
      .notNull()
      .default('open'),
    totalCostCents: bigint('total_cost_cents', { mode: 'number' }).notNull().default(0),
    /** Struck once the run is costed: total landed cost over good units. */
    unitCostCents: bigint('unit_cost_cents', { mode: 'number' }),
    costedAt: timestamp('costed_at', { withTimezone: true }),
    peasyWorkOrderId: text('peasy_work_order_id'),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('production_runs_product_idx').on(t.productId),
    index('production_runs_date_idx').on(t.runDate),
  ],
);

/** One cost that lands on a run: a co-man invoice, an ingredient bill, inbound freight, duty. */
export const landedCosts = pgTable(
  'landed_costs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    productionRunId: uuid('production_run_id')
      .notNull()
      .references(() => productionRuns.id, { onDelete: 'cascade' }),
    component: costComponentEnum('component').notNull(),
    billId: uuid('bill_id').references((): AnyPgColumn => bills.id),
    billLineId: uuid('bill_line_id').references((): AnyPgColumn => billLines.id),
    description: text('description'),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    allocationBasis: text('allocation_basis', { enum: ['units', 'value', 'manual'] }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('landed_costs_run_idx').on(t.productionRunId),
    index('landed_costs_bill_idx').on(t.billId),
  ],
);

/**
 * The cost used to value a unit shipped on a given date. One row per product per
 * effective date; the database's unit_cost_at(product, date) reads the latest
 * row at or before the date.
 */
export const productCosts = pgTable(
  'product_costs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id),
    effectiveDate: date('effective_date', { mode: 'string' }).notNull(),
    unitCostCents: bigint('unit_cost_cents', { mode: 'number' }).notNull(),
    method: costMethodEnum('method').notNull().default('actual_run'),
    productionRunId: uuid('production_run_id').references(() => productionRuns.id),
    breakdown: jsonb('breakdown').$type<CostBreakdown>().notNull().default({}),
    notes: text('notes'),
    createdBy: uuid('created_by').references(() => appUsers.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('product_costs_product_id_effective_date_key').on(t.productId, t.effectiveDate),
    index('product_costs_lookup_idx').on(t.productId, t.effectiveDate.desc()),
    check('product_costs_unit_cost_cents_check', sql`${t.unitCostCents} >= 0`),
  ],
);

/** An inventory count file, usually exported from Peasy. */
export const inventoryImports = pgTable(
  'inventory_imports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    source: text('source', { enum: ['peasy', 'manual', 'csv'] })
      .notNull()
      .default('peasy'),
    snapshotDate: date('snapshot_date', { mode: 'string' }).notNull(),
    filename: text('filename'),
    fileHash: text('file_hash'),
    storagePath: text('storage_path'),
    rowCount: integer('row_count').notNull().default(0),
    totalValueCents: bigint('total_value_cents', { mode: 'number' }).notNull().default(0),
    status: importStatusEnum('status').notNull().default('preview'),
    warnings: jsonb('warnings').$type<ImportIssue[]>().notNull().default([]),
    importedBy: uuid('imported_by').references(() => appUsers.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('inventory_import_hash_idx')
      .on(t.fileHash)
      .where(sql`${t.fileHash} is not null`),
  ],
);

/** What was on hand, where, at what stage, on a date — the counted side of a tie-out. */
export const inventorySnapshots = pgTable(
  'inventory_snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    importId: uuid('import_id').references(() => inventoryImports.id, { onDelete: 'cascade' }),
    snapshotDate: date('snapshot_date', { mode: 'string' }).notNull(),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id),
    location: text('location').notNull().default('default'),
    stage: text('stage', { enum: ['raw', 'packaging', 'wip', 'finished', 'in_transit'] })
      .notNull()
      .default('finished'),
    quantity: numeric('quantity', { precision: 14, scale: 2, mode: 'string' })
      .notNull()
      .default('0'),
    unitCostCents: bigint('unit_cost_cents', { mode: 'number' }).notNull().default(0),
    valueCents: bigint('value_cents', { mode: 'number' }).notNull().default(0),
  },
  (t) => [
    unique('inventory_snapshots_snapshot_date_product_id_location_stage_key').on(
      t.snapshotDate,
      t.productId,
      t.location,
      t.stage,
    ),
    index('inventory_snapshots_date_idx').on(t.snapshotDate),
  ],
);

/** A month's shipped-units file — the quantity side of the COGS calculation. */
export const shipmentImports = pgTable(
  'shipment_imports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** No CHECK on this column in SQL; 'peasy' is the default, others are free text. */
    source: text('source').notNull().default('peasy'),
    periodYear: integer('period_year').notNull(),
    periodMonth: integer('period_month').notNull(),
    filename: text('filename'),
    fileHash: text('file_hash'),
    rowCount: integer('row_count').notNull().default(0),
    status: importStatusEnum('status').notNull().default('preview'),
    importedBy: uuid('imported_by').references(() => appUsers.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'shipment_imports_period_month_check',
      sql`${t.periodMonth} >= 1 and ${t.periodMonth} <= 12`,
    ),
  ],
);

/**
 * Units shipped in a period per product, channel and customer. The unique key
 * treats a null channel or customer as its own bucket, which is how Postgres
 * NULLS DISTINCT behaves and is intended here: unattributed units are one row.
 */
export const shipmentUnits = pgTable(
  'shipment_units',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    importId: uuid('import_id').references(() => shipmentImports.id, { onDelete: 'cascade' }),
    periodYear: integer('period_year').notNull(),
    periodMonth: integer('period_month').notNull(),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id),
    channelId: uuid('channel_id').references(() => channels.id),
    customerId: uuid('customer_id').references((): AnyPgColumn => customers.id),
    units: numeric('units', { precision: 14, scale: 2, mode: 'string' }).notNull().default('0'),
    returnsUnits: numeric('returns_units', { precision: 14, scale: 2, mode: 'string' })
      .notNull()
      .default('0'),
  },
  (t) => [
    unique('shipment_units_period_year_period_month_product_id_channel__key').on(
      t.periodYear,
      t.periodMonth,
      t.productId,
      t.channelId,
      t.customerId,
    ),
    check('shipment_units_period_month_check', sql`${t.periodMonth} >= 1 and ${t.periodMonth} <= 12`),
  ],
);

/** One month's COGS relief. At most one batch per period may reach `posted`. */
export const cogsBatches = pgTable(
  'cogs_batches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    periodYear: integer('period_year').notNull(),
    periodMonth: integer('period_month').notNull(),
    status: text('status', { enum: ['draft', 'posted', 'reversed'] })
      .notNull()
      .default('draft'),
    totalUnits: numeric('total_units', { precision: 14, scale: 2, mode: 'string' })
      .notNull()
      .default('0'),
    totalCogsCents: bigint('total_cogs_cents', { mode: 'number' }).notNull().default(0),
    journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id),
    reversalEntryId: uuid('reversal_entry_id').references(() => journalEntries.id),
    notes: text('notes'),
    createdBy: uuid('created_by').references(() => appUsers.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('cogs_batch_posted_idx')
      .on(t.periodYear, t.periodMonth)
      .where(sql`${t.status} = 'posted'`),
    check('cogs_batches_period_month_check', sql`${t.periodMonth} >= 1 and ${t.periodMonth} <= 12`),
  ],
);

export const cogsBatchLines = pgTable(
  'cogs_batch_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    batchId: uuid('batch_id')
      .notNull()
      .references(() => cogsBatches.id, { onDelete: 'cascade' }),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id),
    channelId: uuid('channel_id').references(() => channels.id),
    units: numeric('units', { precision: 14, scale: 2, mode: 'string' }).notNull().default('0'),
    unitCostCents: bigint('unit_cost_cents', { mode: 'number' }).notNull().default(0),
    cogsCents: bigint('cogs_cents', { mode: 'number' }).notNull().default(0),
    breakdown: jsonb('breakdown').$type<CostBreakdown>().notNull().default({}),
  },
  (t) => [
    unique('cogs_batch_lines_batch_id_product_id_channel_id_key').on(
      t.batchId,
      t.productId,
      t.channelId,
    ),
    index('cogs_lines_product_idx').on(t.productId),
  ],
);

/**
 * Write-offs, samples, spoilage and count variances. `quantity` is signed — a
 * write-off is negative — and `value_cents` follows it.
 */
export const inventoryAdjustments = pgTable(
  'inventory_adjustments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    adjustmentNo: text('adjustment_no').notNull().unique('inventory_adjustments_adjustment_no_key'),
    adjustmentDate: date('adjustment_date', { mode: 'string' }).notNull(),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id),
    reason: inventoryAdjustmentReasonEnum('reason').notNull(),
    quantity: numeric('quantity', { precision: 14, scale: 2, mode: 'string' }).notNull(),
    unitCostCents: bigint('unit_cost_cents', { mode: 'number' }).notNull().default(0),
    valueCents: bigint('value_cents', { mode: 'number' }).notNull(),
    /** Where the write-off lands; null means it nets within inventory. */
    expenseAccountId: uuid('expense_account_id').references(() => accounts.id),
    channelId: uuid('channel_id').references(() => channels.id),
    memo: text('memo'),
    journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id),
    createdBy: uuid('created_by').references(() => appUsers.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('inventory_adjustments_date_idx').on(t.adjustmentDate)],
);

/**
 * The counted snapshot against the ledger's inventory balance on a date. One row
 * per date; a non-zero variance has to be explained or adjusted before the
 * period closes.
 */
export const inventoryTieouts = pgTable('inventory_tieouts', {
  id: uuid('id').primaryKey().defaultRandom(),
  asOfDate: date('as_of_date', { mode: 'string' })
    .notNull()
    .unique('inventory_tieouts_as_of_date_key'),
  snapshotValueCents: bigint('snapshot_value_cents', { mode: 'number' }).notNull(),
  ledgerValueCents: bigint('ledger_value_cents', { mode: 'number' }).notNull(),
  varianceCents: bigint('variance_cents', { mode: 'number' }).notNull(),
  explanation: text('explanation'),
  adjustmentEntryId: uuid('adjustment_entry_id').references(() => journalEntries.id),
  resolved: boolean('resolved').notNull().default(false),
  createdBy: uuid('created_by').references(() => appUsers.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Posted revenue and COGS by product, channel and month, read straight off the
 * journal lines. Everything but `period` is nullable because a journal line
 * need not carry a product or channel dimension; the two cents columns widen to
 * numeric because sum() over bigint does, and are non-null sums over a non-empty
 * group.
 */
export const marginByProductChannel = pgView('margin_by_product_channel', {
  productId: uuid('product_id'),
  sku: text('sku'),
  productName: text('product_name'),
  channelId: uuid('channel_id'),
  channelCode: text('channel_code'),
  /** First day of the month, from date_trunc. */
  period: date('period', { mode: 'string' }).notNull(),
  netSalesCents: numeric('net_sales_cents', { mode: 'number' }).notNull(),
  cogsCents: numeric('cogs_cents', { mode: 'number' }).notNull(),
}).existing();

export type ProductionRun = typeof productionRuns.$inferSelect;
export type NewProductionRun = typeof productionRuns.$inferInsert;

export type LandedCost = typeof landedCosts.$inferSelect;
export type NewLandedCost = typeof landedCosts.$inferInsert;

export type ProductCost = typeof productCosts.$inferSelect;
export type NewProductCost = typeof productCosts.$inferInsert;

export type InventoryImport = typeof inventoryImports.$inferSelect;
export type NewInventoryImport = typeof inventoryImports.$inferInsert;

export type InventorySnapshot = typeof inventorySnapshots.$inferSelect;
export type NewInventorySnapshot = typeof inventorySnapshots.$inferInsert;

export type ShipmentImport = typeof shipmentImports.$inferSelect;
export type NewShipmentImport = typeof shipmentImports.$inferInsert;

export type ShipmentUnit = typeof shipmentUnits.$inferSelect;
export type NewShipmentUnit = typeof shipmentUnits.$inferInsert;

export type CogsBatch = typeof cogsBatches.$inferSelect;
export type NewCogsBatch = typeof cogsBatches.$inferInsert;

export type CogsBatchLine = typeof cogsBatchLines.$inferSelect;
export type NewCogsBatchLine = typeof cogsBatchLines.$inferInsert;

export type InventoryAdjustment = typeof inventoryAdjustments.$inferSelect;
export type NewInventoryAdjustment = typeof inventoryAdjustments.$inferInsert;

export type InventoryTieout = typeof inventoryTieouts.$inferSelect;
export type NewInventoryTieout = typeof inventoryTieouts.$inferInsert;

export type MarginByProductChannelRow = typeof marginByProductChannel.$inferSelect;

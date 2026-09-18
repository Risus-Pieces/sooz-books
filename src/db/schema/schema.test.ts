import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { getTableName, getViewName, isTable, type Table } from 'drizzle-orm';
import { getTableConfig, isPgView, type PgView } from 'drizzle-orm/pg-core';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * These definitions are only useful if they are true of the live database, so
 * this suite checks them against it rather than against the migration files.
 *
 * Three things are verified for the sub-ledger schema:
 *
 *  1. every exported table and view can be selected from — Postgres resolves
 *     every column name in the generated list, so a typo or a stale column
 *     fails here rather than silently in a report;
 *  2. every column matches pg_catalog on SQL type and nullability, and neither
 *     side has a column the other does not;
 *  3. every declared pgEnum has exactly the labels pg_enum has, in order.
 *
 * Nothing is written. Every statement is a read, so the suite is safe to run
 * against the shared development database while other work is in flight.
 */

// vitest does not load .env.local on its own, and src/db/client.ts refuses to
// build a pool without DATABASE_URL. Read it the same way the app would.
if (!process.env.DATABASE_URL) {
  const envPath = resolve(process.cwd(), '.env.local');
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const match = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    process.env[key] = rawValue.trim().replace(/^(['"])(.*)\1$/, '$2');
  }
}

const { db, sql } = await import('@/db/client');
const schema = await import('./index');

const arap = await import('./arap');
const banking = await import('./banking');
const channels = await import('./channels');
const inventory = await import('./inventory');
const planning = await import('./planning');
const trade = await import('./trade');

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

/**
 * Every sub-ledger table these six modules own, as named in the database: the
 * 52 base tables public holds beyond the eight core-ledger ones in ./ledger.
 */
const EXPECTED_TABLES = [
  // arap.ts
  'customers',
  'invoices',
  'invoice_lines',
  'receipts',
  'receipt_applications',
  'credit_memos',
  'credit_memo_applications',
  'vendors',
  'vendor_aliases',
  'bills',
  'bill_lines',
  'bill_payments',
  'bill_payment_applications',
  'vendor_credits',
  'vendor_credit_applications',
  // banking.ts
  'bank_accounts',
  'import_profiles',
  'import_batches',
  'bank_transactions',
  'categorization_rules',
  'reconciliations',
  'reconciliation_items',
  // channels.ts
  'payout_imports',
  'payout_lines',
  'sales_tax_entries',
  'sales_tax_filings',
  // trade.ts
  'deduction_reason_codes',
  'promotions',
  'promotion_products',
  'remittances',
  'remittance_lines',
  'deductions',
  'trade_accruals',
  // inventory.ts
  'production_runs',
  'landed_costs',
  'product_costs',
  'inventory_imports',
  'inventory_snapshots',
  'shipment_imports',
  'shipment_units',
  'cogs_batches',
  'cogs_batch_lines',
  'inventory_adjustments',
  'inventory_tieouts',
  // planning.ts
  'budget_versions',
  'budget_lines',
  'forecast_items',
  'forecast_snapshots',
  'close_checklists',
  'close_tasks',
  'recurring_entries',
  'attachments',
] as const;

/** The sub-ledger views, declared with pgView(...).existing(). */
const EXPECTED_VIEWS = [
  'ar_open_items',
  'ap_open_items',
  'sales_tax_liability',
  'channel_clearing_balances',
  'deduction_aging',
  'promotion_performance',
  'margin_by_product_channel',
] as const;

/**
 * The part of a pgEnum this suite reads. Declared structurally because
 * PgEnum<T> is invariant in its label tuple, so a heterogeneous list of them
 * cannot be given one concrete PgEnum type.
 */
interface DeclaredEnum {
  readonly enumName: string;
  readonly enumValues: readonly string[];
}

/** The pgEnums declared by these modules, paired with their SQL type name. */
const DECLARED_ENUMS: ReadonlyArray<readonly [string, DeclaredEnum]> = [
  ['doc_status', arap.docStatusEnum],
  ['payment_method', arap.paymentMethodEnum],
  ['customer_type', arap.customerTypeEnum],
  ['vendor_type', arap.vendorTypeEnum],
  ['bank_account_kind', banking.bankAccountKindEnum],
  ['bank_txn_status', banking.bankTxnStatusEnum],
  ['import_status', banking.importStatusEnum],
  ['suggestion_source', banking.suggestionSourceEnum],
  ['amount_mode', banking.amountModeEnum],
  ['recon_status', banking.reconStatusEnum],
  ['payout_provider', channels.payoutProviderEnum],
  ['payout_status', channels.payoutStatusEnum],
  ['payout_line_type', channels.payoutLineTypeEnum],
  ['promo_type', trade.promoTypeEnum],
  ['promo_status', trade.promoStatusEnum],
  ['deduction_status', trade.deductionStatusEnum],
  ['deduction_treatment', trade.deductionTreatmentEnum],
  ['cost_component', inventory.costComponentEnum],
  ['cost_method', inventory.costMethodEnum],
  ['inventory_adjustment_reason', inventory.inventoryAdjustmentReasonEnum],
  ['close_task_status', planning.closeTaskStatusEnum],
  ['forecast_direction', planning.forecastDirectionEnum],
];

type SchemaExport = Record<string, unknown>;

const MODULES = [arap, banking, channels, inventory, planning, trade] as const;

/** Every table exported from the six sub-ledger modules, keyed by SQL name. */
const exportedTables = new Map<string, Table>();
/** Every view exported from those modules, keyed by SQL name. */
const exportedViews = new Map<string, PgView>();

for (const schemaModule of MODULES) {
  for (const value of Object.values(schemaModule as SchemaExport)) {
    if (isTable(value)) exportedTables.set(getTableName(value), value);
    else if (isPgView(value)) exportedViews.set(getViewName(value), value);
  }
}

interface PgColumn {
  table_name: string;
  column_name: string;
  sql_type: string;
  not_null: boolean;
}

/** Normalises 'numeric(14, 4)' and 'numeric(14,4)' to one spelling. */
function normaliseType(type: string): string {
  return type.replace(/\s+/g, '');
}

describe('sub-ledger schema', () => {
  it('exports every sub-ledger table and view, and nothing that is not one', () => {
    expect([...exportedTables.keys()].sort()).toEqual([...EXPECTED_TABLES].sort());
    expect([...exportedViews.keys()].sort()).toEqual([...EXPECTED_VIEWS].sort());
    expect(exportedTables.size).toBe(52);
    expect(exportedViews.size).toBe(7);
  });

  it('re-exports every module through @/db/schema', () => {
    const indexNames = new Set(Object.keys(schema as SchemaExport));
    for (const name of ['customers', 'bankTransactions', 'payoutLines', 'deductions', 'cogsBatches', 'closeTasks']) {
      expect(indexNames.has(name)).toBe(true);
    }
  });

  describe.each([...exportedTables.entries()])('table %s', (name, table) => {
    it('can be selected from with the column list it declares', async () => {
      const rows = await db.select().from(table).limit(0);
      expect(rows).toEqual([]);
    });
  });

  describe.each([...exportedViews.entries()])('view %s', (name, view) => {
    it('can be selected from with the column list it declares', async () => {
      const rows = await db.select().from(view).limit(0);
      expect(rows).toEqual([]);
    });
  });

  it('matches pg_catalog on every column name, type and nullability', async () => {
    const live = await sql<PgColumn[]>`
      select c.relname            as table_name,
             a.attname            as column_name,
             format_type(a.atttypid, a.atttypmod) as sql_type,
             a.attnotnull         as not_null
        from pg_attribute a
        join pg_class     c on c.oid = a.attrelid
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public'
         and c.relkind = 'r'
         and a.attnum > 0
         and not a.attisdropped
         and c.relname = any(${[...EXPECTED_TABLES]}::text[])
    `;

    const liveByTable = new Map<string, Map<string, PgColumn>>();
    for (const row of live) {
      const columns = liveByTable.get(row.table_name) ?? new Map<string, PgColumn>();
      columns.set(row.column_name, row);
      liveByTable.set(row.table_name, columns);
    }

    const mismatches: string[] = [];
    for (const [tableName, table] of exportedTables) {
      const liveColumns = liveByTable.get(tableName);
      expect(liveColumns, `${tableName} is missing from the database`).toBeDefined();
      if (!liveColumns) continue;

      const declared = getTableConfig(table).columns;
      const declaredNames = new Set(declared.map((c) => c.name));

      for (const column of declared) {
        const liveColumn = liveColumns.get(column.name);
        if (!liveColumn) {
          mismatches.push(`${tableName}.${column.name}: declared but not in the database`);
          continue;
        }
        const declaredType = normaliseType(column.getSQLType());
        const liveType = normaliseType(liveColumn.sql_type);
        if (declaredType !== liveType) {
          mismatches.push(`${tableName}.${column.name}: declared ${declaredType}, database ${liveType}`);
        }
        if (column.notNull !== liveColumn.not_null) {
          mismatches.push(
            `${tableName}.${column.name}: declared ${column.notNull ? 'not null' : 'nullable'}, ` +
              `database ${liveColumn.not_null ? 'not null' : 'nullable'}`,
          );
        }
      }

      for (const liveName of liveColumns.keys()) {
        if (!declaredNames.has(liveName)) {
          mismatches.push(`${tableName}.${liveName}: in the database but not declared`);
        }
      }
    }

    expect(mismatches).toEqual([]);
  });

  it('declares every enum with exactly the labels pg_enum has, in order', async () => {
    const live = await sql<{ typname: string; labels: string[] }[]>`
      select t.typname,
             array_agg(e.enumlabel order by e.enumsortorder) as labels
        from pg_type      t
        join pg_enum      e on e.enumtypid = t.oid
        join pg_namespace n on n.oid = t.typnamespace
       where n.nspname = 'public'
       group by t.typname
    `;
    const liveByName = new Map(live.map((row) => [row.typname, row.labels]));

    for (const [typeName, pgEnumValue] of DECLARED_ENUMS) {
      expect(pgEnumValue.enumName, 'pgEnum name').toBe(typeName);
      expect(liveByName.get(typeName), `${typeName} is missing from pg_enum`).toBeDefined();
      expect([...pgEnumValue.enumValues], typeName).toEqual(liveByName.get(typeName));
    }

    expect(DECLARED_ENUMS.length).toBe(22);
  });
});

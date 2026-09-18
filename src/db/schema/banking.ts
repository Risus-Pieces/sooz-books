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

import { customers, vendors } from './arap';
import { accounts, appUsers, channels, journalEntries, journalLines } from './ledger';

/**
 * Bank and credit-card statement intake, categorization and reconciliation.
 * Mirrors supabase/migrations/0006_banking.sql as it stands in the live
 * database — the SQL is the contract, this file is the typed view of it.
 *
 * Two conventions hold everywhere below:
 *
 * - `*_cents` is a signed integer in a `bigint` column. On
 *   `bank_transactions.amount_cents` the sign is from the company's point of
 *   view: **positive is money in, negative is money out**, for every statement
 *   format. `bank_accounts.statement_sign` records how to get there from the
 *   file's own convention.
 * - `numeric` columns come back as exact decimal **strings**. They are
 *   quantities, rates and confidences — not money — and are never routed
 *   through the integer-cents path. Parse at the point of use rather than
 *   letting a float sit in a financial record.
 */

export const bankAccountKindEnum = pgEnum('bank_account_kind', [
  'checking',
  'savings',
  'credit_card',
  'line_of_credit',
  'merchant',
]);

export const bankTxnStatusEnum = pgEnum('bank_txn_status', [
  'unreviewed',
  'categorized',
  'matched',
  'transfer',
  'excluded',
]);

export const importStatusEnum = pgEnum('import_status', [
  'parsing',
  'preview',
  'imported',
  'failed',
  'cancelled',
]);

export const suggestionSourceEnum = pgEnum('suggestion_source', ['rule', 'history', 'ai', 'match']);

export const amountModeEnum = pgEnum('amount_mode', [
  'signed',
  'debit_credit',
  'amount_with_type',
]);

export const reconStatusEnum = pgEnum('recon_status', ['in_progress', 'completed', 'abandoned']);

export type BankAccountKind = (typeof bankAccountKindEnum.enumValues)[number];
export type BankTxnStatus = (typeof bankTxnStatusEnum.enumValues)[number];
export type ImportStatus = (typeof importStatusEnum.enumValues)[number];
export type SuggestionSource = (typeof suggestionSourceEnum.enumValues)[number];
export type AmountMode = (typeof amountModeEnum.enumValues)[number];
export type ReconStatus = (typeof reconStatusEnum.enumValues)[number];

/**
 * The severity ladder from docs/formats/README.md §1.3. `error` skips a row and
 * leaves the rest of the file importable; `fatal` quarantines the whole file.
 */
export type ImportIssueSeverity = 'info' | 'warn' | 'error' | 'fatal';

/** One entry in an import's `warnings` array. Shape fixed by docs/formats/README.md §1.3. */
export interface ImportIssue {
  severity: ImportIssueSeverity;
  /** Stable and machine-readable, e.g. 'date.unparsable', 'row.field_count'. */
  code: string;
  /** What a bookkeeper reads. */
  message: string;
  /** 0-based index into the physical data rows. */
  rowIndex?: number;
  /** The offending row verbatim — always attached on `error` and `fatal`. */
  rawRow?: string[];
  field?: string;
  remedy?: string;
}

/**
 * A parsed source row kept verbatim beside what was derived from it, so a
 * fingerprint can be recomputed years later without the original file. Keys are
 * the source's own column headers; a missing cell is null, never coerced.
 */
export type RawImportRow = Record<string, string | null>;

/** One clause of a categorization rule. All clauses must match for the rule to fire. */
export interface RuleCondition {
  field: 'payee' | 'description' | 'reference' | 'type';
  op: 'contains' | 'starts_with' | 'ends_with' | 'exact' | 'regex' | 'not_contains';
  value: string;
}

/**
 * A row-level filter applied during parsing. `skip` drops the row silently;
 * `flag` imports it and records `reason` as a warning on the batch.
 */
export interface SkipRowRule {
  field: string;
  op: string;
  value: string;
  action: 'skip' | 'flag';
  reason?: string;
}

/**
 * A GL account plus the real-world details of the statement it produces.
 * One bank account per GL account, enforced by the unique key on account_id.
 */
export const bankAccounts = pgTable(
  'bank_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .unique('bank_accounts_account_id_key')
      .references(() => accounts.id),
    name: text('name').notNull(),
    institution: text('institution'),
    kind: bankAccountKindEnum('kind').notNull().default('checking'),
    /** Last four digits, for matching a file to the account it belongs to. */
    mask: text('mask'),
    /**
     * -1 means "a positive amount in the file is money leaving the company",
     * which is how a credit card statement presents a charge.
     */
    statementSign: integer('statement_sign').notNull().default(1),
    openingBalanceCents: bigint('opening_balance_cents', { mode: 'number' }).notNull().default(0),
    openingDate: date('opening_date', { mode: 'string' }),
    defaultProfileId: uuid('default_profile_id').references(
      (): AnyPgColumn => importProfiles.id,
      { onDelete: 'set null' },
    ),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check('bank_accounts_statement_sign_check', sql`${t.statementSign} in (1, -1)`)],
);

/**
 * The saved answer to "what do this bank's columns mean?". Confirmed once by a
 * human on the first import of a given layout, reused silently afterwards.
 */
export const importProfiles = pgTable(
  'import_profiles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    bankAccountId: uuid('bank_account_id').references(() => bankAccounts.id, {
      onDelete: 'cascade',
    }),
    fileType: text('file_type', { enum: ['csv', 'xlsx'] })
      .notNull()
      .default('csv'),
    delimiter: text('delimiter').notNull().default(','),
    encoding: text('encoding').notNull().default('utf-8'),
    skipRows: integer('skip_rows').notNull().default(0),
    headerRow: integer('header_row').notNull().default(0),
    dateColumn: text('date_column').notNull(),
    dateFormat: text('date_format'),
    /** Joined in order to build the description; Relay uses {Payee}. */
    descriptionColumns: text('description_columns').array().notNull().default([]),
    counterpartyColumn: text('counterparty_column'),
    mode: amountModeEnum('mode').notNull().default('signed'),
    amountColumn: text('amount_column'),
    debitColumn: text('debit_column'),
    creditColumn: text('credit_column'),
    typeColumn: text('type_column'),
    debitTypeValues: text('debit_type_values').array().notNull().default([]),
    creditTypeValues: text('credit_type_values').array().notNull().default([]),
    balanceColumn: text('balance_column'),
    referenceColumn: text('reference_column'),
    externalIdColumn: text('external_id_column'),
    invertSign: boolean('invert_sign').notNull().default(false),
    skipRowRules: jsonb('skip_row_rules').$type<SkipRowRule[]>().notNull().default([]),
    detectedFromFilename: text('detected_from_filename'),
    timesUsed: integer('times_used').notNull().default(0),
    createdBy: uuid('created_by').references(() => appUsers.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'amount_columns_present',
      sql`${t.mode} = 'signed' and ${t.amountColumn} is not null
        or ${t.mode} = 'debit_credit' and ${t.debitColumn} is not null and ${t.creditColumn} is not null
        or ${t.mode} = 'amount_with_type' and ${t.amountColumn} is not null and ${t.typeColumn} is not null`,
    ),
  ],
);

/**
 * One uploaded statement file. `file_hash` is sha256 of the raw bytes and is
 * checked before parsing, so re-uploading a file the account already imported
 * is caught rather than duplicated — the partial unique index only guards
 * batches that actually made it to `imported`.
 */
export const importBatches = pgTable(
  'import_batches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    bankAccountId: uuid('bank_account_id')
      .notNull()
      .references(() => bankAccounts.id),
    profileId: uuid('profile_id').references(() => importProfiles.id),
    filename: text('filename').notNull(),
    fileHash: text('file_hash').notNull(),
    storagePath: text('storage_path'),
    rowCount: integer('row_count').notNull().default(0),
    importedCount: integer('imported_count').notNull().default(0),
    duplicateCount: integer('duplicate_count').notNull().default(0),
    skippedCount: integer('skipped_count').notNull().default(0),
    periodStart: date('period_start', { mode: 'string' }),
    periodEnd: date('period_end', { mode: 'string' }),
    status: importStatusEnum('status').notNull().default('preview'),
    error: text('error'),
    warnings: jsonb('warnings').$type<ImportIssue[]>().notNull().default([]),
    importedBy: uuid('imported_by').references(() => appUsers.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('import_batches_hash_idx')
      .on(t.bankAccountId, t.fileHash)
      .where(sql`${t.status} = 'imported'`),
  ],
);

/**
 * One line of a bank statement, from unreviewed through categorized to
 * reconciled. `amount_cents` is signed from the company's point of view:
 * positive is money in. Nothing here posts to the ledger without a human, except
 * through a rule the owner explicitly marked `auto_post`.
 */
export const bankTransactions = pgTable(
  'bank_transactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    bankAccountId: uuid('bank_account_id')
      .notNull()
      .references(() => bankAccounts.id),
    importBatchId: uuid('import_batch_id').references(() => importBatches.id),
    txnDate: date('txn_date', { mode: 'string' }).notNull(),
    postDate: date('post_date', { mode: 'string' }),
    description: text('description').notNull(),
    /** normalize_description(description), supplied by the importer. */
    descriptionNormalized: text('description_normalized').notNull(),
    counterparty: text('counterparty'),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    /** Running statement balance where the file carries one; not derived. */
    balanceCents: bigint('balance_cents', { mode: 'number' }),
    reference: text('reference'),
    externalId: text('external_id'),
    /** Stable identity of the row within its account; the duplicate guard. */
    fingerprint: text('fingerprint').notNull(),
    status: bankTxnStatusEnum('status').notNull().default('unreviewed'),
    journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id),
    matchedType: text('matched_type', {
      enum: ['invoice', 'bill', 'receipt', 'bill_payment', 'payout', 'transfer'],
    }),
    matchedId: uuid('matched_id'),
    transferPairId: uuid('transfer_pair_id').references((): AnyPgColumn => bankTransactions.id),
    suggestedAccountId: uuid('suggested_account_id').references(() => accounts.id),
    suggestedVendorId: uuid('suggested_vendor_id').references((): AnyPgColumn => vendors.id),
    suggestedCustomerId: uuid('suggested_customer_id').references((): AnyPgColumn => customers.id),
    suggestedChannelId: uuid('suggested_channel_id').references(() => channels.id),
    suggestedMemo: text('suggested_memo'),
    suggestionSource: suggestionSourceEnum('suggestion_source'),
    /** 0.000–1.000 as an exact decimal string; compare after parsing. */
    suggestionConfidence: numeric('suggestion_confidence', {
      precision: 4,
      scale: 3,
      mode: 'string',
    }),
    suggestionReasoning: text('suggestion_reasoning'),
    ruleId: uuid('rule_id').references((): AnyPgColumn => categorizationRules.id, {
      onDelete: 'set null',
    }),
    reconciliationId: uuid('reconciliation_id').references(
      (): AnyPgColumn => reconciliations.id,
      { onDelete: 'set null' },
    ),
    reconciledAt: timestamp('reconciled_at', { withTimezone: true }),
    notes: text('notes'),
    reviewedBy: uuid('reviewed_by').references(() => appUsers.id),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('bank_txn_fingerprint_idx').on(t.bankAccountId, t.fingerprint),
    index('bank_txn_date_idx').on(t.bankAccountId, t.txnDate),
    index('bank_txn_amount_idx').on(t.amountCents),
    index('bank_txn_desc_idx').using('gin', sql`to_tsvector('english', ${t.description})`),
    index('bank_txn_status_idx')
      .on(t.status)
      .where(sql`${t.status} = 'unreviewed'`),
    check('bank_txn_amount_nonzero', sql`${t.amountCents} <> 0`),
  ],
);

/**
 * A saved categorization decision. Every condition in `conditions` must match.
 * `auto_post` is the only way anything reaches the ledger without a human
 * approving it, so it is set deliberately and rarely.
 */
export const categorizationRules = pgTable(
  'categorization_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    /** Lower runs first. */
    priority: integer('priority').notNull().default(100),
    bankAccountId: uuid('bank_account_id').references(() => bankAccounts.id, {
      onDelete: 'cascade',
    }),
    conditions: jsonb('conditions').$type<RuleCondition[]>().notNull().default([]),
    amountMinCents: bigint('amount_min_cents', { mode: 'number' }),
    amountMaxCents: bigint('amount_max_cents', { mode: 'number' }),
    direction: text('direction', { enum: ['in', 'out', 'any'] })
      .notNull()
      .default('any'),
    accountId: uuid('account_id').references(() => accounts.id),
    vendorId: uuid('vendor_id').references((): AnyPgColumn => vendors.id),
    customerId: uuid('customer_id').references((): AnyPgColumn => customers.id),
    channelId: uuid('channel_id').references(() => channels.id),
    memoTemplate: text('memo_template'),
    autoPost: boolean('auto_post').notNull().default(false),
    active: boolean('active').notNull().default(true),
    hitCount: integer('hit_count').notNull().default(0),
    lastHitAt: timestamp('last_hit_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => appUsers.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('rules_priority_idx')
      .on(t.priority)
      .where(sql`${t.active}`),
    index('rules_conditions_idx').using('gin', t.conditions),
    check(
      'rule_has_conditions',
      sql`jsonb_typeof(${t.conditions}) = 'array' and jsonb_array_length(${t.conditions}) > 0`,
    ),
  ],
);

/**
 * A statement reconciliation. It may only be completed once it ties —
 * `completed_must_tie` refuses a `completed` row with a non-zero difference.
 */
export const reconciliations = pgTable(
  'reconciliations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    bankAccountId: uuid('bank_account_id')
      .notNull()
      .references(() => bankAccounts.id),
    statementStartDate: date('statement_start_date', { mode: 'string' }).notNull(),
    statementDate: date('statement_date', { mode: 'string' }).notNull(),
    openingBalanceCents: bigint('opening_balance_cents', { mode: 'number' }).notNull(),
    closingBalanceCents: bigint('closing_balance_cents', { mode: 'number' }).notNull(),
    clearedBalanceCents: bigint('cleared_balance_cents', { mode: 'number' }).notNull().default(0),
    differenceCents: bigint('difference_cents', { mode: 'number' }).notNull().default(0),
    status: reconStatusEnum('status').notNull().default('in_progress'),
    notes: text('notes'),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    completedBy: uuid('completed_by').references(() => appUsers.id),
    createdBy: uuid('created_by').references(() => appUsers.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('recon_period_idx')
      .on(t.bankAccountId, t.statementDate)
      .where(sql`${t.status} <> 'abandoned'`),
    check(
      'completed_must_tie',
      sql`${t.status} <> 'completed' or ${t.differenceCents} = 0`,
    ),
  ],
);

/** One cleared item inside a reconciliation: a statement line, a ledger line, or both. */
export const reconciliationItems = pgTable(
  'reconciliation_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    reconciliationId: uuid('reconciliation_id')
      .notNull()
      .references(() => reconciliations.id, { onDelete: 'cascade' }),
    bankTransactionId: uuid('bank_transaction_id').references(() => bankTransactions.id),
    journalLineId: uuid('journal_line_id').references(() => journalLines.id),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    cleared: boolean('cleared').notNull().default(true),
  },
  (t) => [
    unique('reconciliation_items_reconciliation_id_bank_transaction_id_key').on(
      t.reconciliationId,
      t.bankTransactionId,
    ),
    check(
      'recon_item_target',
      sql`${t.bankTransactionId} is not null or ${t.journalLineId} is not null`,
    ),
  ],
);

export type BankAccount = typeof bankAccounts.$inferSelect;
export type NewBankAccount = typeof bankAccounts.$inferInsert;

export type ImportProfile = typeof importProfiles.$inferSelect;
export type NewImportProfile = typeof importProfiles.$inferInsert;

export type ImportBatch = typeof importBatches.$inferSelect;
export type NewImportBatch = typeof importBatches.$inferInsert;

export type BankTransaction = typeof bankTransactions.$inferSelect;
export type NewBankTransaction = typeof bankTransactions.$inferInsert;

export type CategorizationRule = typeof categorizationRules.$inferSelect;
export type NewCategorizationRule = typeof categorizationRules.$inferInsert;

export type Reconciliation = typeof reconciliations.$inferSelect;
export type NewReconciliation = typeof reconciliations.$inferInsert;

export type ReconciliationItem = typeof reconciliationItems.$inferSelect;
export type NewReconciliationItem = typeof reconciliationItems.$inferInsert;

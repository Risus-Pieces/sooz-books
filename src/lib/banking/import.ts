/**
 * Import orchestration: preview, then commit.
 *
 * The two-step shape is not a UI convenience, it is the control. Nothing from a
 * statement reaches the ledger without a human, so the import has to be
 * inspectable *before* it exists: `previewImport` reads the file, works out what
 * is new and what the company already has, proposes a categorization for every
 * new row, checks the statement's own arithmetic — and writes nothing but the
 * `import_batches` row that records the attempt. `commitImport` then takes that
 * batch plus the decisions a human made and writes the transactions in one
 * transaction.
 *
 * Three properties this module exists to guarantee:
 *
 *  1. **Re-importing is safe and is the normal case.** Relay exports a
 *     `(Partial)` month and then the same month complete; every row in the
 *     overlap arrives twice, every month, forever. A duplicate is counted and
 *     reported, never inserted, and never an error.
 *  2. **A preview can be abandoned.** The unique index on
 *     `(bank_account_id, file_hash)` is partial — it only guards batches that
 *     reached `imported` — so a preview that is never committed leaves nothing
 *     behind that stops the same file being previewed again.
 *  3. **The database has the last word.** The in-memory classification decides
 *     what to *offer*; the unique index on `(bank_account_id, fingerprint)` is
 *     what makes it true. A conflict there is caught and counted as a duplicate,
 *     not raised.
 */

import { and, eq, gte, inArray, isNotNull, isNull, lte, sql as sqlTag } from 'drizzle-orm';

import type { Tx } from '@/db/client';
import {
  bankAccounts,
  bankTransactions,
  importBatches,
  importProfiles,
  type BankTxnStatus,
  type ImportIssue,
  plaidAccounts,
  plaidItems,
} from '@/db/schema';
import { addDays, type CalendarDate } from '@/lib/dates';
import { isUniqueViolation, postgresErrorOf } from '@/lib/db-errors';
import { formatMoney } from '@/lib/money';

import { GENERIC_IMPORTER_ID, missingProfileColumns } from '@/lib/importers/generic';
import { PLAID_IMPORTER_ID } from '@/lib/importers/plaid';
import { RETURN_WINDOW_DAYS } from '@/lib/importers/relay';
import {
  detectImporter,
  importerById,
  type AnyImporter,
} from '@/lib/importers/registry';
import {
  countBySeverity,
  hasFatal,
  type Assertion,
  type Delivery,
  type DetectionResult,
  type FileHeader,
  type ImportableRow,
  type ImporterParseResult,
  type Issue,
  type IssueSeverity,
  type PreviewSummary,
  type SourceFile,
} from '@/lib/importers/types';

import { applyAiSuggestions, type AiTierOptions, type AiTierReport } from './ai-tier';
import { fileHash } from './fingerprint';
import { normalizeDescription } from './normalize';
import { readFile } from './read-file';
import {
  createRuleEngine,
  loadCategorizationRules,
  recordRuleHits,
  type RuleEngine,
} from './rules';
import { loadPayeeHistory, suggestBatch, toDbSuggestionSource, type Suggestion } from './suggest';
import { detectTransfers, labelledTransferSide, type IdentifiedTxn } from './transfers';
import type { ImportProfile, ParsedFile, SkipRowOp } from './types';
import { loadVendorIndex } from './vendors';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * The import cannot proceed, and the message says why in words a bookkeeper can
 * act on. Distinct from a row-level problem, which is an `Issue` and never stops
 * the file.
 */
export class ImportError extends Error {
  readonly code: string;
  readonly remedy: string | null;

  constructor(
    code: string,
    message: string,
    remedy: string | null = null,
    options?: { readonly cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ImportError';
    this.code = code;
    this.remedy = remedy;
  }
}

// ---------------------------------------------------------------------------
// Database errors
// ---------------------------------------------------------------------------

// The helpers live in '@/lib/db-errors', shared with the ledger; re-exported so this
// module's callers and tests keep their import path.
export { isUniqueViolation, postgresErrorOf };
export type { PostgresErrorFields } from '@/lib/db-errors';

/**
 * An error safe to show a bookkeeper or write to a log.
 *
 * A `DrizzleQueryError`'s message is `Failed query: <sql> params: <every bound
 * value>` — for an import that is payees, amounts and the batch's whole warnings
 * JSON, raw rows included. None of that may leave this module in an error message.
 * The Postgres error is kept as the cause (its message names the constraint, not the
 * data); the wrapper, and its parameters, are dropped.
 */
function sanitizeDatabaseError(error: unknown, what: string): unknown {
  if (error instanceof ImportError) return error;
  const pg = postgresErrorOf(error);
  if (pg === null) return error;
  return new ImportError(
    'import.database_error',
    `${what} could not be written: the database refused it (${pg.code}: ${pg.message}). Nothing from this attempt was saved.`,
    'Try again. If it keeps failing, the message above names the rule the database enforced.',
    { cause: pg },
  );
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/** The private bucket created by `supabase/migrations/0013_statement_storage.sql`. */
export const STATEMENT_BUCKET = 'bank-statements';

/**
 * Where the original upload is kept.
 *
 * Archiving the raw bytes is not optional in the long run: fingerprint recipes
 * change, and recomputing historical keys has to be a migration rather than an
 * apology to a user who deleted the file two years ago. It is deliberately an
 * interface — the default is Supabase Storage, and a test hands in its own.
 */
export interface StatementStorage {
  readonly bucket: string;
  put(path: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(path: string): Promise<Uint8Array>;
}

/**
 * The Supabase-backed store, or null when this process has no service-role key.
 *
 * Null rather than a throw, and null rather than a silent no-op: the caller is
 * forced by the type to decide, and `previewImport` decides to record a warning
 * and carry on. Refusing to import nine months of bank statements because a file
 * could not be archived would be the wrong trade; leaving the bookkeeper unaware
 * that the archive is empty would be worse.
 */
export function createStatementStorage(): StatementStorage | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;

  const client = async () => {
    const { createClient } = await import('@supabase/supabase-js');
    return createClient(url, key, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    });
  };

  return {
    bucket: STATEMENT_BUCKET,
    async put(path, bytes, contentType) {
      const supabase = await client();
      const { error } = await supabase.storage
        .from(STATEMENT_BUCKET)
        // Idempotent: the path contains the file hash, so the same bytes always
        // land in the same place and a retry overwrites itself.
        .upload(path, bytes, { contentType, upsert: true });
      if (error) throw new ImportError('storage.put_failed', error.message);
    },
    async get(path) {
      const supabase = await client();
      const { data, error } = await supabase.storage.from(STATEMENT_BUCKET).download(path);
      if (error) throw new ImportError('storage.get_failed', error.message);
      return new Uint8Array(await data.arrayBuffer());
    },
  };
}

/** `<bank account>/<file hash>/<filename>`: stable, collision-free, and readable in the dashboard. */
export function statementStoragePath(
  bankAccountId: string,
  hash: string,
  filename: string,
): string {
  const safe = (filename.split(/[\\/]/).pop() ?? 'statement.csv')
    .replace(/[^A-Za-z0-9.()#_ -]/g, '_')
    .slice(0, 120);
  return `${bankAccountId}/${hash}/${safe}`;
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** What happened to one row of the file. */
export type RowClass =
  /** Not in the ledger for this account; it will be inserted. */
  | 'new'
  /** The ledger already holds this transaction. Counted, never inserted, never an error. */
  | 'duplicate'
  /** Never became a transaction: unparsable, zero-amount, or dropped by a profile rule. */
  | 'skipped';

export interface PreviewSuggestion {
  readonly accountId: string | null;
  readonly vendorId: string | null;
  readonly customerId: string | null;
  readonly channelId: string | null;
  readonly memo: string | null;
  readonly source: Suggestion['source'];
  readonly confidence: number;
  readonly reasoning: string;
  readonly ruleId: string | null;
  /** True only when a rule the owner marked `auto_post` won and named an account. */
  readonly autoPost: boolean;
  /** The other side of a proposed transfer: a `bank_transactions.id`, or null when it is in this same file. */
  readonly transferPairTxnId: string | null;
}

export interface PreviewRow {
  /** 0-based index among the file's data rows. The key decisions are made against. */
  readonly rowIndex: number;
  readonly class: RowClass;
  readonly fingerprint: string;
  readonly txnDate: CalendarDate | '';
  /** The payee. Never Relay's `Description`, which is the string `Unknown`. */
  readonly description: string;
  readonly counterparty: string | null;
  readonly amountCents: number;
  readonly balanceCents: number | null;
  readonly reference: string | null;
  readonly rawType: string | null;
  readonly status: string | null;
  /** True when the source says this money never moved: a returned ACH. */
  readonly returned: boolean;
  /** Set when this row and another in the same file cancel each other out. */
  readonly returnedPairRowIndex: number | null;
  readonly internalTransfer: boolean;
  readonly occurrence: number;
  /** The `bank_transactions.id` this duplicates, when it was identified. */
  readonly existingTxnId: string | null;
  /**
   * A transaction already in the ledger that this row cancels or is cancelled by: the
   * settled debit a later `RETURNED` row reverses, or the return an earlier import
   * already holds. Both sides are written `excluded` and linked on commit.
   */
  readonly returnedLedgerTxnId: string | null;
  /**
   * Set when the row cannot be committed on the importer's say-so and needs an
   * explicit decision (a status, or `skip`). The text says why.
   */
  readonly decisionRequired: string | null;
  readonly suggestion: PreviewSuggestion | null;
  /** The status the row will be written with unless a decision overrides it. */
  readonly proposedStatus: BankTxnStatus;
  readonly issues: readonly Issue[];
  /** The source row verbatim, so a fingerprint can be recomputed without the file. */
  readonly raw: Record<string, string>;
}

export interface ImportCounts {
  readonly total: number;
  readonly new: number;
  readonly duplicate: number;
  readonly skipped: number;
  readonly needsReview: number;
  readonly autoPost: number;
  readonly excluded: number;
}

export interface BalanceChainReport {
  readonly ok: boolean;
  readonly direction: 'ascending' | 'descending' | 'unknown';
  readonly checked: number;
  readonly openingBalanceCents: number | null;
  readonly closingBalanceCents: number | null;
  readonly breaks: ReadonlyArray<{
    readonly rowIndex: number;
    readonly expectedCents: number;
    readonly actualCents: number;
    readonly deltaCents: number;
  }>;
}

export interface ImportPreview {
  readonly batchId: string;
  readonly bankAccountId: string;
  readonly bankAccountName: string;
  readonly bankAccountMask: string | null;
  readonly importerId: string;
  readonly importerLabel: string;
  readonly detection: DetectionResult;
  readonly filename: string;
  readonly fileHash: string;
  readonly storagePath: string | null;
  readonly profileId: string | null;
  readonly profileName: string | null;
  /**
   * The column mapping the file was read with. For a bank with no saved mapping this
   * is the one `detectColumns` proposed, for a person to confirm or correct and save
   * with `saveImportProfile`.
   */
  readonly columnMapping: ImportProfile;
  /** True when `columnMapping` is a proposal: the file cannot be committed until it is saved. */
  readonly profileConfirmationRequired: boolean;
  /** Rows that need an explicit decision before `commitImport` will accept the batch. */
  readonly decisionsRequired: readonly number[];
  readonly header: FileHeader;
  readonly counts: ImportCounts;
  readonly dateRange: { readonly min: CalendarDate; readonly max: CalendarDate } | null;
  readonly totals: {
    readonly inflowCents: number;
    readonly outflowCents: number;
    readonly netCents: number;
  };
  readonly byType: PreviewSummary['byType'];
  readonly balanceChain: BalanceChainReport | null;
  readonly assertions: readonly Assertion[];
  readonly issues: readonly Issue[];
  /** The import report's headline count, by severity. */
  readonly issueCounts: Readonly<Record<IssueSeverity, number>>;
  readonly rows: readonly PreviewRow[];
  /** A batch that already imported these exact bytes into this account. */
  readonly priorImport: {
    readonly batchId: string;
    readonly filename: string;
    readonly importedAt: string;
    readonly importedCount: number;
  } | null;
  /** True when nothing may be written: the file is not what it claims to be. */
  readonly blocked: boolean;
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

export interface PreviewImportInput {
  readonly bankAccountId: string;
  readonly filename: string;
  readonly bytes: Uint8Array | ArrayBuffer;
  /** An `import_profiles.id`. Defaults to the bank account's own, then to the importer's built-in. */
  readonly profileId?: string;
  readonly userId: string | null;
  /** Skip detection and use this importer. */
  readonly importerId?: string;
  /** Overrides the default Supabase store; `null` archives nothing and says so. */
  readonly storage?: StatementStorage | null;
  readonly delivery?: Delivery;
}

interface AccountRow {
  readonly id: string;
  readonly name: string;
  readonly mask: string | null;
  readonly openingBalanceCents: number;
  readonly openingDate: CalendarDate | null;
  readonly defaultProfileId: string | null;
}

async function loadBankAccount(id: string): Promise<AccountRow> {
  const { db } = await import('@/db/client');
  const [row] = await db
    .select({
      id: bankAccounts.id,
      name: bankAccounts.name,
      mask: bankAccounts.mask,
      openingBalanceCents: bankAccounts.openingBalanceCents,
      openingDate: bankAccounts.openingDate,
      defaultProfileId: bankAccounts.defaultProfileId,
    })
    .from(bankAccounts)
    .where(eq(bankAccounts.id, id))
    .limit(1);

  if (row === undefined) {
    throw new ImportError(
      'bank_account.not_found',
      `No bank account with id ${id}. Pick the account this statement belongs to before importing it.`,
    );
  }
  return row;
}

const SKIP_ROW_OPS: readonly SkipRowOp[] = [
  'contains',
  'not_contains',
  'exact',
  'starts_with',
  'ends_with',
  'regex',
  'blank',
  'not_blank',
];

function isSkipRowOp(value: string): value is SkipRowOp {
  return (SKIP_ROW_OPS as readonly string[]).includes(value);
}

/** Reads an `import_profiles` row back into the parser's own shape. */
async function loadProfile(id: string): Promise<{ profile: ImportProfile; name: string }> {
  const { db } = await import('@/db/client');
  const [row] = await db.select().from(importProfiles).where(eq(importProfiles.id, id)).limit(1);
  if (row === undefined) {
    throw new ImportError('profile.not_found', `No import profile with id ${id}.`);
  }

  return {
    name: row.name,
    profile: {
      id: row.id,
      name: row.name,
      file_type: row.fileType,
      delimiter: row.delimiter,
      encoding: row.encoding,
      skip_rows: row.skipRows,
      header_row: row.headerRow,
      date_column: row.dateColumn,
      date_format: row.dateFormat,
      description_columns: row.descriptionColumns,
      counterparty_column: row.counterpartyColumn,
      mode: row.mode,
      amount_column: row.amountColumn,
      debit_column: row.debitColumn,
      credit_column: row.creditColumn,
      type_column: row.typeColumn,
      debit_type_values: row.debitTypeValues,
      credit_type_values: row.creditTypeValues,
      balance_column: row.balanceColumn,
      reference_column: row.referenceColumn,
      external_id_column: row.externalIdColumn,
      invert_sign: row.invertSign,
      skip_row_rules: row.skipRowRules.map((rule) => ({
        field: rule.field,
        // The column is plain jsonb, so the operator is validated on the way out
        // rather than trusted. An operator nobody recognises must not silently
        // become `contains` and start dropping rows.
        op: isSkipRowOp(rule.op) ? rule.op : 'exact',
        value: rule.value,
        action: rule.action,
        ...(rule.reason === undefined ? {} : { reason: rule.reason }),
      })),
      detected_from_filename: row.detectedFromFilename,
    },
  };
}

/** The natural key §3.4 reconciles on: the fingerprint without its occurrence index. */
function naturalKey(date: string, amountCents: number, description: string): string {
  return `${date}|${amountCents}|${normalizeDescription(description)}`;
}

interface ExistingTxn {
  readonly id: string;
  readonly txnDate: CalendarDate;
  readonly amountCents: number;
  readonly descriptionNormalized: string;
  readonly fingerprint: string;
}

/**
 * Every transaction this account already holds on any of the file's dates.
 *
 * Restricted to those dates on purpose. §3.4's reconciliation counts how many of
 * a natural key the ledger already has, and counting them across all time would
 * let a $4.79 coffee bought on the 12th of March suppress the identical one
 * bought on the 12th of April. The date is part of the key, so the date is the
 * scope.
 */
async function loadExistingByDate(
  bankAccountId: string,
  dates: readonly CalendarDate[],
  tx?: Tx,
): Promise<ExistingTxn[]> {
  if (dates.length === 0) return [];
  const { db } = await import('@/db/client');
  const exec = tx ?? db;

  return exec
    .select({
      id: bankTransactions.id,
      txnDate: bankTransactions.txnDate,
      amountCents: bankTransactions.amountCents,
      descriptionNormalized: bankTransactions.descriptionNormalized,
      fingerprint: bankTransactions.fingerprint,
    })
    .from(bankTransactions)
    .where(
      and(
        eq(bankTransactions.bankAccountId, bankAccountId),
        inArray(bankTransactions.txnDate, [...new Set(dates)]),
      ),
    )
    .orderBy(bankTransactions.txnDate, bankTransactions.createdAt, bankTransactions.id);
}

interface Classified {
  readonly row: ImportableRow;
  readonly class: RowClass;
  readonly occurrence: number;
  readonly fingerprint: string;
  readonly existingTxnId: string | null;
}

/**
 * §3.4's M/N reconciliation, which is what makes a re-imported `(Partial)` month
 * cost nothing.
 *
 * For each natural key `(date, amount, normalised payee)`: `M` rows in the file,
 * `N` already in the ledger on that date. The first `N` of the file's rows are
 * duplicates; the rest are new and are numbered from `N` upward, so their
 * fingerprints continue the sequence the ledger already holds rather than
 * restarting it.
 *
 * Numbering against the ledger rather than against the file is the part that
 * survives a file whose window starts mid-day. The occurrence index the parser
 * assigned is a property of one file; this one is a property of the account.
 *
 * `M < N` is not a duplicate and not a failure — it means the ledger holds more
 * of something than this file does, usually because someone exported a narrower
 * filter. Nothing is deleted and the key is reported.
 */
function classifyRows(
  rows: readonly ImportableRow[],
  existing: readonly ExistingTxn[],
  bankAccountId: string,
  fingerprintOf: (row: ImportableRow, occurrence: number) => string,
): { classified: Classified[]; issues: Issue[] } {
  const ledger = new Map<string, ExistingTxn[]>();
  // The same buckets, holding only rows with no bank-provided id: what a file-based import wrote.
  const fileLedger = new Map<string, ExistingTxn[]>();
  const byFingerprint = new Map<string, ExistingTxn>();
  for (const txn of existing) {
    byFingerprint.set(txn.fingerprint, txn);
    const key = naturalKey(txn.txnDate, txn.amountCents, txn.descriptionNormalized);
    const bucket = ledger.get(key);
    if (bucket === undefined) ledger.set(key, [txn]);
    else bucket.push(txn);
    if (!txn.fingerprint.startsWith('x:')) {
      const fileBucket = fileLedger.get(key);
      if (fileBucket === undefined) fileLedger.set(key, [txn]);
      else fileBucket.push(txn);
    }
  }

  const seen = new Map<string, number>();
  const seenWithId = new Map<string, number>();
  const classified: Classified[] = [];
  const issues: Issue[] = [];
  const fileCounts = new Map<string, number>();

  for (const row of rows) {
    if (!row.usable || row.date === '') continue;
    const key = naturalKey(row.date, row.amountCents, row.description);
    fileCounts.set(key, (fileCounts.get(key) ?? 0) + 1);
  }

  for (const row of rows) {
    if (!row.usable || row.date === '') {
      classified.push({
        row,
        class: 'skipped',
        occurrence: 0,
        fingerprint: '',
        existingTxnId: null,
      });
      continue;
    }

    const key = naturalKey(row.date, row.amountCents, row.description);

    // A row the bank identified (a feed's transaction id) is a duplicate only of that same id. Counting
    // it against the day's lookalikes would assume the source covers whole days, which a nightly feed
    // does not: a second, identical $15 fee posted the next night would be taken for the first. It is
    // still matched against rows an uploaded statement wrote, which carry no id, so a feed that starts
    // on the statement's last day does not bring that day's lines in twice.
    if (row.externalId !== null && row.externalId !== '') {
      const same = byFingerprint.get(fingerprintOf(row, 0));
      if (same !== undefined) {
        classified.push({ row, class: 'duplicate', occurrence: 0, fingerprint: same.fingerprint, existingTxnId: same.id });
        continue;
      }
      const index = seenWithId.get(key) ?? 0;
      seenWithId.set(key, index + 1);
      const fromFiles = fileLedger.get(key) ?? [];
      if (index < fromFiles.length) {
        classified.push({ row, class: 'duplicate', occurrence: index, fingerprint: fromFiles[index].fingerprint, existingTxnId: fromFiles[index].id });
        continue;
      }
      classified.push({ row, class: 'new', occurrence: 0, fingerprint: fingerprintOf(row, 0), existingTxnId: null });
      continue;
    }

    const index = seen.get(key) ?? 0;
    seen.set(key, index + 1);

    const already = ledger.get(key) ?? [];
    if (index < already.length) {
      classified.push({
        row,
        class: 'duplicate',
        occurrence: index,
        fingerprint: already[index].fingerprint,
        existingTxnId: already[index].id,
      });
      continue;
    }

    classified.push({
      row,
      class: 'new',
      occurrence: index,
      fingerprint: fingerprintOf(row, index),
      existingTxnId: null,
    });
  }

  for (const [key, already] of ledger) {
    const inFile = fileCounts.get(key) ?? 0;
    if (inFile === 0 || already.length <= inFile) continue;
    const [date, cents] = key.split('|');
    issues.push({
      severity: 'warn',
      code: 'dedupe.ledger_has_more',
      message: `The ledger already holds ${already.length} transactions on ${date} for ${formatMoney(Number(cents))} matching this payee, but the file has only ${inFile}. Nothing was removed — the extra rows in ${bankAccountId} are worth a look before the month is closed.`,
    });
  }

  return { classified, issues };
}

/**
 * Did the source itself label this row an internal transfer?
 *
 * Necessary for a row to be *written* as a transfer, never sufficient on its own. A
 * `transfer`-sourced suggestion on an unlabelled row is the amount-and-date guess — a
 * $50 supplier payment and a $50 deposit look exactly like it — and stays a proposal
 * in the review queue.
 */
function isBankLabelledTransfer(row: ImportableRow): boolean {
  return labelledTransferSide(toIdentified(row, '', '')) !== null;
}

function counterpartyMaskOf(row: ImportableRow): string | null {
  const mask = (row as Partial<{ counterpartyMask: string | null }>).counterpartyMask ?? null;
  const trimmed = (mask ?? '').trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * True only when the row is provably money moving between two of the company's own
 * accounts: the bank labelled it a transfer **and** either its other leg was found,
 * or the account it names is one of the company's.
 *
 * The label alone is not enough. Relay writes `Receive-transfer` for money from any
 * Relay account, including somebody else's — the real 2026-04-30 +$4.55 from #3474 is
 * exactly that. Written as `transfer`, such a row drops out of the review queue and
 * has no other leg for the ledger to post against: a real inflow the books would
 * never see.
 */
function isInternalTransfer(
  row: ImportableRow,
  suggestion: Suggestion,
  companyMasks: ReadonlySet<string>,
): boolean {
  if (suggestion.source !== 'transfer' || !isBankLabelledTransfer(row)) return false;
  if (suggestion.transferPairTxnId !== null) return true;
  const mask = counterpartyMaskOf(row);
  return mask !== null && companyMasks.has(mask);
}

/** The status a row is written with when nobody overrides it. */
function proposedStatus(
  row: ImportableRow,
  suggestion: Suggestion | null,
  companyMasks: ReadonlySet<string>,
  returnedLink: ReturnedLink | null = null,
): BankTxnStatus {
  const relay = row as Partial<{ returned: boolean; returnedPairRowIndex: number | null }>;
  // A returned ACH and the settled row that cancels it net to zero and neither is
  // an economic event. They are imported for the record and barred from posting.
  if (relay.returned === true || relay.returnedPairRowIndex != null) return 'excluded';
  if (returnedLink !== null) return 'excluded';
  if (suggestion === null) return 'unreviewed';
  if (suggestion.source === 'transfer') {
    return isInternalTransfer(row, suggestion, companyMasks) ? 'transfer' : 'unreviewed';
  }
  // A rule the owner marked `auto_post` is the only categorization that stands
  // without a human. Everything else waits in the review queue.
  if (suggestion.autoPost && suggestion.accountId !== null) return 'categorized';
  return 'unreviewed';
}

interface SuggestionPass {
  readonly engine: RuleEngine;
  readonly byRowIndex: ReadonlyMap<number, Suggestion>;
  /** The statement masks of every bank account the company holds. */
  readonly companyMasks: ReadonlySet<string>;
}

/** Stable, collision-free ids for rows that are not in the database yet. */
function pendingId(rowIndex: number): string {
  return `pending:${rowIndex}`;
}

function toIdentified(row: ImportableRow, bankAccountId: string, id: string): IdentifiedTxn {
  return {
    id,
    bankAccountId,
    txnDate: row.date === '' ? '1970-01-01' : row.date,
    payee: row.counterparty,
    description: row.description,
    reference: row.reference,
    type: row.rawType,
    amountCents: row.amountCents,
    status: row.status ?? null,
    counterpartyMask:
      (row as Partial<{ counterpartyMask: string | null }>).counterpartyMask ?? null,
  };
}

/**
 * The source's transfer label for a row already in the ledger.
 *
 * `bank_transactions` does not keep the source's raw type, but it keeps the verdict:
 * `status = 'transfer'` is written only for a row the bank itself labelled (see
 * `proposedStatus`) or one a human confirmed as a transfer. Without restoring the
 * label here, the leg imported first — Relay writes each leg in a different
 * account's statement — is invisible to the bank-labelled pass, and the leg imported
 * second can never find it.
 */
function storedTransferLabel(row: { status: BankTxnStatus; amountCents: number }): string | null {
  if (row.status !== 'transfer') return null;
  return row.amountCents < 0 ? 'Spend-transfer' : 'Receive-transfer';
}

/**
 * Runs the categorization pipeline over the rows that will actually be inserted.
 *
 * Transfers are detected across the file **and** the surrounding weeks of every
 * other account, because both sides of an internal transfer are never in the same
 * file — Relay writes the outgoing leg in ••9973's statement and the incoming leg
 * in ••9726's. An importer that only ever showed `detectTransfers` one account's
 * rows would pair nothing, ever.
 */
async function runSuggestions(
  candidates: readonly Classified[],
  bankAccountId: string,
  dateRange: { min: CalendarDate; max: CalendarDate } | null,
  tx?: Tx,
): Promise<SuggestionPass> {
  const emptyRange = candidates.length === 0 || dateRange === null;
  const { db } = await import('@/db/client');
  const exec = tx ?? db;
  const window = 3;

  // Every read goes through `exec`. When the caller holds a transaction — the
  // commit does — a read on the shared pool would wait for a second connection while
  // holding the first, which deadlocks as soon as the pool is exhausted: with a
  // one-connection pool on the first import, and under Supabase's session-mode
  // pooler whenever other clients have its slots.
  const [{ rules, warnings }, vendors, history, neighbours, accounts] = await Promise.all([
    loadCategorizationRules({ bankAccountId, ...(tx === undefined ? {} : { tx }) }),
    loadVendorIndex(tx === undefined ? {} : { tx }),
    emptyRange
      ? Promise.resolve(undefined)
      : loadPayeeHistory({ asOf: dateRange.max, ...(tx === undefined ? {} : { tx }) }),
    emptyRange
      ? Promise.resolve([])
      : exec
          .select({
            id: bankTransactions.id,
            bankAccountId: bankTransactions.bankAccountId,
            txnDate: bankTransactions.txnDate,
            counterparty: bankTransactions.counterparty,
            description: bankTransactions.description,
            reference: bankTransactions.reference,
            amountCents: bankTransactions.amountCents,
            status: bankTransactions.status,
            transferPairId: bankTransactions.transferPairId,
          })
          .from(bankTransactions)
          .where(
            and(
              gte(bankTransactions.txnDate, addDays(dateRange.min, -window)),
              lte(bankTransactions.txnDate, addDays(dateRange.max, window)),
            ),
          ),
    exec.select({ id: bankAccounts.id, mask: bankAccounts.mask }).from(bankAccounts),
  ]);

  const engine = createRuleEngine(rules, { initialWarnings: warnings });
  // Every account the company holds, active or not: a transfer to an account that
  // has since been closed was still internal when it happened.
  const companyMasks = new Set(
    accounts
      .map((account) => (account.mask ?? '').trim())
      .filter((mask) => mask !== ''),
  );
  if (emptyRange) return { engine, byRowIndex: new Map(), companyMasks };

  const incoming = candidates.map((entry) =>
    toIdentified(entry.row, bankAccountId, pendingId(entry.row.rowIndex)),
  );

  const existing: IdentifiedTxn[] = neighbours.map((row) => ({
    id: row.id,
    bankAccountId: row.bankAccountId,
    txnDate: row.txnDate,
    payee: row.counterparty,
    description: row.description,
    reference: row.reference,
    type: storedTransferLabel(row),
    amountCents: row.amountCents,
  }));

  const alreadyPaired = new Set(
    neighbours.filter((row) => row.transferPairId !== null).map((row) => row.id),
  );

  const masks = new Map<string, string | null>(
    accounts.map((account) => [account.id, account.mask]),
  );

  const transfers = detectTransfers([...incoming, ...existing], {
    windowDays: window,
    bankAccountMasks: masks,
    alreadyPairedTxnIds: alreadyPaired,
  });

  const suggested = suggestBatch(incoming, { engine, vendors, transfers, history });
  const byRowIndex = new Map<number, Suggestion>();
  suggested.forEach((entry, index) => {
    if (entry.suggestion !== null) byRowIndex.set(candidates[index].row.rowIndex, entry.suggestion);
  });

  return { engine, byRowIndex, companyMasks };
}

function toBalanceReport(parsed: ImporterParseResult<ImportableRow>): BalanceChainReport | null {
  const chain = parsed.balanceChain;
  if (chain === null) return null;
  return {
    ok: chain.ok,
    direction: chain.direction,
    checked: chain.checked,
    openingBalanceCents: chain.openingBalanceCents,
    closingBalanceCents: chain.closingBalanceCents,
    breaks: chain.breaks.map((entry) => ({
      rowIndex: entry.rowIndex,
      expectedCents: entry.expected,
      actualCents: entry.actual,
      deltaCents: entry.delta,
    })),
  };
}

function toImportIssue(issue: Issue): ImportIssue {
  return {
    severity: issue.severity,
    code: issue.code,
    message: issue.message,
    ...(issue.rowIndex === undefined ? {} : { rowIndex: issue.rowIndex }),
    ...(issue.rawRow === undefined ? {} : { rawRow: [...issue.rawRow] }),
    ...(issue.field === undefined ? {} : { field: issue.field }),
    ...(issue.remedy === undefined ? {} : { remedy: issue.remedy }),
  };
}

function toPreviewSuggestion(suggestion: Suggestion): PreviewSuggestion {
  return {
    accountId: suggestion.accountId,
    vendorId: suggestion.vendorId,
    customerId: suggestion.customerId,
    channelId: suggestion.channelId,
    memo: suggestion.memo,
    source: suggestion.source,
    confidence: suggestion.confidence,
    reasoning: suggestion.reasoning,
    ruleId: suggestion.ruleId,
    autoPost: suggestion.autoPost,
    // A pending id points at a row in this same file, which has no database id
    // yet. It is resolved after the insert, never guessed at here.
    transferPairTxnId:
      suggestion.transferPairTxnId !== null && suggestion.transferPairTxnId.startsWith('pending:')
        ? null
        : suggestion.transferPairTxnId,
  };
}

/** The importer and its detection, either forced by id or worked out from the bytes. */
function chooseImporter(
  file: ParsedFile,
  source: SourceFile,
  forcedId?: string,
): { importer: AnyImporter; detection: DetectionResult } {
  if (forcedId !== undefined) {
    const importer = importerById(forcedId);
    if (importer === null) {
      throw new ImportError('importer.unknown', `No importer registered as "${forcedId}".`);
    }
    return { importer, detection: importer.detect(file, source) };
  }

  const outcome = detectImporter(file, source);
  switch (outcome.kind) {
    case 'selected':
      return { importer: outcome.importer, detection: outcome.detection };
    case 'rejected':
      throw new ImportError(
        outcome.detection.rejection?.code ?? 'importer.rejected',
        outcome.detection.rejection?.message ?? 'This file was recognised and refused.',
        outcome.detection.rejection?.remedy ?? null,
      );
    case 'ambiguous':
      throw new ImportError(
        'importer.ambiguous',
        `More than one importer could read "${source.filename}" and none is clearly right: ${outcome.candidates
          .map((c) => `${c.importer.label} (${c.detection.confidence.toFixed(2)})`)
          .join(', ')}.`,
        'Pick the format explicitly rather than letting it be guessed.',
      );
    case 'unknown':
      throw new ImportError(
        'importer.unknown_format',
        `Nothing here recognises "${source.filename}". ${outcome.attempts
          .flatMap((attempt) => attempt.reasons)
          .join('; ')}`,
        'Check that this is the CSV the bank exported, downloaded rather than saved from a spreadsheet.',
      );
  }
}

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

interface ChosenProfile {
  /** The `import_profiles.id` actually used to read the file, or null for the importer's own. */
  readonly id: string | null;
  readonly loaded: { readonly profile: ImportProfile; readonly name: string } | null;
  readonly issues: readonly Issue[];
}

/**
 * Which saved mapping reads this file.
 *
 * One the caller names is always used — a person chose it. The account's default is
 * used only when it fits: its columns are all in the file. An account's saved Chase
 * mapping applied to an Amex export uploaded to the same account would read the
 * wrong column as the amount; ignoring it and proposing a fresh mapping is the safe
 * failure, and the preview says so.
 */
async function chooseProfile(
  file: ParsedFile,
  explicitId: string | undefined,
  account: AccountRow,
): Promise<ChosenProfile> {
  if (explicitId !== undefined) {
    return { id: explicitId, loaded: await loadProfile(explicitId), issues: [] };
  }
  if (account.defaultProfileId === null) return { id: null, loaded: null, issues: [] };

  const loaded = await loadProfile(account.defaultProfileId);
  const missing = missingProfileColumns(file, loaded.profile);
  if (missing.length === 0) return { id: account.defaultProfileId, loaded, issues: [] };

  return {
    id: null,
    loaded: null,
    issues: [
      {
        severity: 'info',
        code: 'profile.default_not_applicable',
        message: `${account.name}'s saved column mapping "${loaded.name}" does not fit this file (it has no ${missing
          .filter((column) => column !== '')
          .map((column) => `"${column}"`)
          .join(', ')} column), so it was not used.`,
      },
    ],
  };
}

export interface SaveImportProfileInput {
  readonly bankAccountId: string;
  /**
   * The mapping to save: usually `ImportPreview.columnMapping` as a person confirmed
   * or corrected it. An `id` on it is ignored; `profileId` below decides update vs insert.
   */
  readonly profile: ImportProfile;
  /** Defaults to the profile's own name, then to "<account> statement". */
  readonly name?: string;
  /** Update this saved profile in place instead of creating a new one. */
  readonly profileId?: string;
  /** Make it the account's default mapping. Default true. */
  readonly setAsDefault?: boolean;
}

export interface SavedImportProfile {
  readonly id: string;
  readonly name: string;
  readonly isDefault: boolean;
}

/** Why a mapping cannot be saved, in words a bookkeeper can act on; empty when it can. */
export function importProfileProblems(profile: ImportProfile): string[] {
  const problems: string[] = [];
  const blank = (value: string | null | undefined): boolean => (value ?? '').trim() === '';

  if (blank(profile.date_column)) problems.push('choose the date column');
  switch (profile.mode) {
    case 'signed':
      if (blank(profile.amount_column)) problems.push('choose the amount column');
      break;
    case 'debit_credit':
      if (blank(profile.debit_column)) problems.push('choose the money-out (debit) column');
      if (blank(profile.credit_column)) problems.push('choose the money-in (credit) column');
      break;
    case 'amount_with_type':
      if (blank(profile.amount_column)) problems.push('choose the amount column');
      if (blank(profile.type_column)) problems.push('choose the column that says debit or credit');
      if ((profile.debit_type_values ?? []).length === 0 && (profile.credit_type_values ?? []).length === 0) {
        problems.push('say which values in the type column mean money out and which mean money in');
      }
      break;
    default:
      problems.push(`"${String(profile.mode)}" is not an amount mode`);
  }
  const amountColumns = [profile.amount_column, profile.debit_column, profile.credit_column];
  if (!blank(profile.balance_column) && amountColumns.includes(profile.balance_column)) {
    problems.push('the running balance cannot also be the amount');
  }
  if ((profile.skip_rows ?? 0) < 0 || (profile.header_row ?? 0) < 0) {
    problems.push('rows to skip and the header row cannot be negative');
  }
  for (const rule of profile.skip_row_rules ?? []) {
    if (!isSkipRowOp(rule.op)) problems.push(`skip rule on "${rule.field}" has unknown operator "${rule.op}"`);
    if (rule.action !== 'skip' && rule.action !== 'flag') {
      problems.push(`skip rule on "${rule.field}" must skip or flag`);
    }
  }
  return problems;
}

/**
 * Saves a confirmed column mapping for a bank account, and by default makes it the
 * account's mapping for every statement after this one.
 *
 * This is the step that turns a proposal from `detectColumns` into a mapping the
 * importer will trust: `commitImport` refuses a generic bank file until one exists.
 * Validated here first, so the answer is a sentence rather than the database's
 * `amount_columns_present` check constraint.
 */
export async function saveImportProfile(
  input: SaveImportProfileInput,
  options: { readonly userId: string | null },
): Promise<SavedImportProfile> {
  const problems = importProfileProblems(input.profile);
  if (problems.length > 0) {
    throw new ImportError(
      'profile.invalid',
      `This column mapping cannot be saved yet: ${problems.join('; ')}.`,
      'Correct the mapping and save it again.',
    );
  }

  const account = await loadBankAccount(input.bankAccountId);
  const name =
    (input.name ?? '').trim() || (input.profile.name ?? '').trim() || `${account.name} statement`;
  const profile = input.profile;
  const values = {
    name,
    bankAccountId: account.id,
    fileType: profile.file_type ?? 'csv',
    delimiter: profile.delimiter ?? ',',
    encoding: profile.encoding ?? 'utf-8',
    skipRows: profile.skip_rows ?? 0,
    headerRow: profile.header_row ?? 0,
    dateColumn: profile.date_column.trim(),
    dateFormat: profile.date_format ?? null,
    descriptionColumns: profile.description_columns ?? [],
    counterpartyColumn: profile.counterparty_column ?? null,
    mode: profile.mode,
    amountColumn: profile.amount_column ?? null,
    debitColumn: profile.debit_column ?? null,
    creditColumn: profile.credit_column ?? null,
    typeColumn: profile.type_column ?? null,
    debitTypeValues: profile.debit_type_values ?? [],
    creditTypeValues: profile.credit_type_values ?? [],
    balanceColumn: profile.balance_column ?? null,
    referenceColumn: profile.reference_column ?? null,
    externalIdColumn: profile.external_id_column ?? null,
    invertSign: profile.invert_sign ?? false,
    skipRowRules: (profile.skip_row_rules ?? []).map((rule) => ({
      field: rule.field,
      op: rule.op,
      // `blank` / `not_blank` take no value; the column stores an empty string for them.
      value: rule.value ?? '',
      action: rule.action,
      ...(rule.reason === undefined ? {} : { reason: rule.reason }),
    })),
    detectedFromFilename: profile.detected_from_filename ?? null,
  };

  const setAsDefault = input.setAsDefault ?? true;
  const { withActor } = await import('@/db/client');
  return withActor(options.userId, async (tx) => {
    let id: string;
    if (input.profileId !== undefined) {
      const [updated] = await tx
        .update(importProfiles)
        .set(values)
        .where(and(eq(importProfiles.id, input.profileId), eq(importProfiles.bankAccountId, account.id)))
        .returning({ id: importProfiles.id });
      if (updated === undefined) {
        throw new ImportError(
          'profile.not_found',
          `No import profile ${input.profileId} belongs to ${account.name}.`,
        );
      }
      id = updated.id;
    } else {
      const [inserted] = await tx
        .insert(importProfiles)
        .values({ ...values, createdBy: options.userId })
        .returning({ id: importProfiles.id });
      id = inserted.id;
    }

    if (setAsDefault) {
      await tx
        .update(bankAccounts)
        .set({ defaultProfileId: id })
        .where(eq(bankAccounts.id, account.id));
    }
    return { id, name, isDefault: setAsDefault };
  }).catch((error: unknown) => {
    throw sanitizeDatabaseError(error, 'The column mapping');
  });
}

// ---------------------------------------------------------------------------
// Returned ACH across files
// ---------------------------------------------------------------------------

interface ReturnedLink {
  readonly ledgerTxnId: string;
  readonly ledgerTxnDate: CalendarDate;
  /** What the ledger row is: the settled original this return reverses, or the return that reverses this row. */
  readonly ledgerRole: 'original' | 'return';
}

interface ReturnScan {
  readonly links: ReadonlyMap<number, ReturnedLink>;
  /** rowIndex → why a person has to decide this row. */
  readonly decisionsRequired: ReadonlyMap<number, string>;
  readonly issues: readonly Issue[];
}

interface RelayReturnFields {
  readonly returned?: boolean;
  readonly returnedPairRowIndex?: number | null;
}

/** Relay's reference on a returned row: `Returned received ACH transaction #… due to: …`. */
const RETURNED_REFERENCE = /^Returned\b/i;

/**
 * Pairs a returned ACH with its settled original when the two are not in the same
 * file — the case the parser cannot see.
 *
 * The parser links a return to its original only inside one statement. A debit on
 * 5/29 returned on 6/2 lands in two different files, and without this the +$10
 * return is excluded while the −$10 debit it cancels sits in the review queue with
 * an ads suggestion, postable: expense overstated by $10 and ledger cash $10 below
 * the bank.
 *
 * Both directions are handled, because statements are not always imported in date
 * order:
 *
 *   - **A new return, original already in the ledger.** Found by opposite amount,
 *     same normalised payee, on or up to {@link RETURN_WINDOW_DAYS} before. If the
 *     original has already posted or been reconciled, nothing is written (fatal):
 *     the posted entry has to be reversed first. If no original exists anywhere, the
 *     row needs an explicit decision — "excluded" is not a safe default for money
 *     whose other half nobody can find.
 *   - **A new debit, its return already in the ledger.** A stored `excluded` row with
 *     Relay's `Returned …` reference, no pair, opposite amount and same payee, dated
 *     on or up to the window after. The new debit is written `excluded` and linked.
 */
async function scanLedgerForReturns(
  candidates: readonly Classified[],
  bankAccountId: string,
  exec: Tx | Awaited<typeof import('@/db/client')>['db'],
): Promise<ReturnScan> {
  const links = new Map<number, ReturnedLink>();
  const decisionsRequired = new Map<number, string>();
  const issues: Issue[] = [];

  const relayRows = candidates.filter((entry) => {
    const relay = entry.row as RelayReturnFields;
    return entry.class === 'new' && relay.returned !== undefined && relay.returnedPairRowIndex == null;
  });
  if (relayRows.length === 0) return { links, decisionsRequired, issues };

  const dates = relayRows.map((entry) => entry.row.date as CalendarDate).sort();
  const ledger = await exec
    .select({
      id: bankTransactions.id,
      txnDate: bankTransactions.txnDate,
      amountCents: bankTransactions.amountCents,
      descriptionNormalized: bankTransactions.descriptionNormalized,
      status: bankTransactions.status,
      reference: bankTransactions.reference,
      journalEntryId: bankTransactions.journalEntryId,
      reconciliationId: bankTransactions.reconciliationId,
    })
    .from(bankTransactions)
    .where(
      and(
        eq(bankTransactions.bankAccountId, bankAccountId),
        isNull(bankTransactions.transferPairId),
        gte(bankTransactions.txnDate, addDays(dates[0], -RETURN_WINDOW_DAYS)),
        lte(bankTransactions.txnDate, addDays(dates[dates.length - 1], RETURN_WINDOW_DAYS)),
      ),
    )
    .orderBy(bankTransactions.txnDate, bankTransactions.createdAt, bankTransactions.id);

  const claimed = new Set<string>();
  // Returns first: a return has exactly one original, and it should get first pick.
  const ordered = [...relayRows].sort(
    (a, b) =>
      Number((b.row as RelayReturnFields).returned === true) -
        Number((a.row as RelayReturnFields).returned === true) ||
      a.row.rowIndex - b.row.rowIndex,
  );

  for (const entry of ordered) {
    const row = entry.row;
    const date = row.date as CalendarDate;
    const payee = row.descriptionNormalized;
    const isReturn = (row as RelayReturnFields).returned === true;

    if (isReturn) {
      const earliest = addDays(date, -RETURN_WINDOW_DAYS);
      // Nearest earlier first: the latest date on or before the return.
      const original = [...ledger]
        .reverse()
        .find(
          (txn) =>
            !claimed.has(txn.id) &&
            txn.status !== 'excluded' &&
            txn.amountCents === -row.amountCents &&
            txn.descriptionNormalized === payee &&
            txn.txnDate <= date &&
            txn.txnDate >= earliest,
        );

      if (original === undefined) {
        const reason = `${date} ${row.description} ${formatMoney(row.amountCents)} is a RETURNED ACH, and no settled ${formatMoney(-row.amountCents)} to the same payee in the ${RETURN_WINDOW_DAYS} days before it is in this file or in the ledger. Import the earlier statement first, or decide this row explicitly.`;
        decisionsRequired.set(row.rowIndex, reason);
        issues.push({
          severity: 'error',
          code: 'relay.returned_unpaired',
          message: reason,
          rowIndex: row.rowIndex,
          remedy:
            'Import the statement that holds the original debit and preview this file again, or commit with an explicit decision for this row.',
        });
        continue;
      }

      claimed.add(original.id);
      if (original.journalEntryId !== null || original.reconciliationId !== null) {
        issues.push({
          severity: 'fatal',
          code: 'relay.returned_original_posted',
          message: `${date} ${row.description} ${formatMoney(row.amountCents)} is a RETURNED ACH reversing the ${original.txnDate} ${formatMoney(original.amountCents)} already ${original.journalEntryId !== null ? 'posted to the ledger' : 'reconciled'}. The money never moved, so that entry is wrong — and a posted entry cannot be changed by an import.`,
          rowIndex: row.rowIndex,
          remedy: `Reverse the posted entry for the ${original.txnDate} transaction, then import this statement again.`,
        });
        continue;
      }

      links.set(row.rowIndex, {
        ledgerTxnId: original.id,
        ledgerTxnDate: original.txnDate,
        ledgerRole: 'original',
      });
      issues.push({
        severity: 'warn',
        code: 'relay.returned_linked_to_ledger',
        message: `${date} ${row.description} ${formatMoney(row.amountCents)} is a RETURNED ACH reversing the ${original.txnDate} ${formatMoney(original.amountCents)} already imported. Both are excluded from posting and linked on commit.`,
        rowIndex: row.rowIndex,
      });
      continue;
    }

    // A settled row whose return was imported first.
    const latest = addDays(date, RETURN_WINDOW_DAYS);
    const stored = ledger.find(
      (txn) =>
        !claimed.has(txn.id) &&
        txn.status === 'excluded' &&
        RETURNED_REFERENCE.test(txn.reference ?? '') &&
        txn.amountCents === -row.amountCents &&
        txn.descriptionNormalized === payee &&
        txn.txnDate >= date &&
        txn.txnDate <= latest,
    );
    if (stored === undefined) continue;

    claimed.add(stored.id);
    links.set(row.rowIndex, {
      ledgerTxnId: stored.id,
      ledgerTxnDate: stored.txnDate,
      ledgerRole: 'return',
    });
    issues.push({
      severity: 'warn',
      code: 'relay.returned_linked_to_ledger',
      message: `${date} ${row.description} ${formatMoney(row.amountCents)} was returned on ${stored.txnDate} (already imported). No money moved: it is excluded from posting and linked to the return on commit.`,
      rowIndex: row.rowIndex,
    });
  }

  return { links, decisionsRequired, issues };
}

/**
 * Reads a statement, works out what it would do, and writes nothing but the batch
 * that records the attempt.
 *
 * Throws only when the import cannot begin at all — unreadable bytes, an unknown
 * account, a file that is not the format it claims. Everything else is an issue
 * on the returned preview, including a broken balance chain, which sets `blocked`
 * so the UI can show the whole file and refuse to commit it.
 */
export async function previewImport(input: PreviewImportInput): Promise<ImportPreview> {
  const bytes =
    input.bytes instanceof ArrayBuffer ? new Uint8Array(input.bytes) : input.bytes;
  const hash = fileHash(bytes);

  const account = await loadBankAccount(input.bankAccountId);
  const file = await readFile(bytes, input.filename);

  const source: SourceFile = {
    bytes,
    sha256: hash,
    filename: input.filename,
    delivery: input.delivery ?? 'upload',
    receivedAt: new Date().toISOString(),
  };

  const { importer, detection } = chooseImporter(file, source, input.importerId);

  const chosen = await chooseProfile(file, input.profileId, account);
  const loaded = chosen.loaded;

  const parsed = importer.parse(file, {
    bankAccountId: account.id,
    bankAccountMask: account.mask,
    ...(loaded === null ? {} : { profile: loaded.profile }),
  });

  const summary = importer.preview(parsed.rows, parsed.header, parsed);
  const issues: Issue[] = [...chosen.issues, ...parsed.issues];

  const dates = parsed.rows
    .filter((row) => row.usable && row.date !== '')
    .map((row) => row.date as CalendarDate);

  const existing = await loadExistingByDate(account.id, dates);
  const { classified, issues: dedupeIssues } = classifyRows(
    parsed.rows,
    existing,
    account.id,
    (row, occurrence) =>
      importerFingerprint(importer, row, occurrence, account.id, loaded?.profile),
  );
  issues.push(...dedupeIssues);

  const fresh = classified.filter((entry) => entry.class === 'new');
  const { byRowIndex, companyMasks } = await runSuggestions(fresh, account.id, summary.dateRange);

  const { db } = await import('@/db/client');
  const returns = await scanLedgerForReturns(fresh, account.id, db);
  issues.push(...returns.issues);

  issues.push(...(await openingBalanceIssues(parsed, account, summary.dateRange)));
  if (importer.id !== PLAID_IMPORTER_ID) issues.push(...(await feedOverlapIssues(account.id, summary.dateRange)));

  const profileConfirmationRequired = importer.id === GENERIC_IMPORTER_ID && loaded === null;

  const rows: PreviewRow[] = classified.map((entry) =>
    toPreviewRow(entry, byRowIndex.get(entry.row.rowIndex) ?? null, parsed.issues, {
      companyMasks,
      link: returns.links.get(entry.row.rowIndex) ?? null,
      decisionRequired: returns.decisionsRequired.get(entry.row.rowIndex) ?? null,
    }),
  );

  const counts = countRows(rows);
  const blocked = hasFatal(issues);

  const prior = await findPriorImport(account.id, hash);

  const { withActor } = await import('@/db/client');
  const batchId = await withActor(input.userId, async (tx) => {
    const [batch] = await tx
      .insert(importBatches)
      .values({
        bankAccountId: account.id,
        profileId: chosen.id,
        filename: input.filename,
        fileHash: hash,
        rowCount: counts.total,
        importedCount: 0,
        duplicateCount: counts.duplicate,
        skippedCount: counts.skipped,
        periodStart: summary.dateRange?.min ?? parsed.header.periodStart,
        periodEnd: summary.dateRange?.max ?? parsed.header.periodEnd,
        status: 'preview',
        warnings: issues.map(toImportIssue),
        importedBy: input.userId,
      })
      .returning({ id: importBatches.id });
    return batch.id;
  }).catch((error: unknown) => {
    throw sanitizeDatabaseError(error, 'The import preview');
  });

  const storagePath = await archive(
    input.storage === undefined ? createStatementStorage() : input.storage,
    account.id,
    hash,
    input.filename,
    bytes,
    batchId,
    input.userId,
    issues,
  );

  return {
    batchId,
    bankAccountId: account.id,
    bankAccountName: account.name,
    bankAccountMask: account.mask,
    importerId: importer.id,
    importerLabel: importer.label,
    detection,
    filename: input.filename,
    fileHash: hash,
    storagePath,
    profileId: chosen.id,
    profileName: loaded?.name ?? parsed.profile.name ?? null,
    columnMapping: parsed.profile,
    profileConfirmationRequired,
    decisionsRequired: [...returns.decisionsRequired.keys()].sort((a, b) => a - b),
    header: parsed.header,
    counts,
    dateRange: summary.dateRange,
    totals: summary.totals,
    byType: summary.byType,
    balanceChain: toBalanceReport(parsed),
    assertions: summary.assertions,
    issues,
    issueCounts: countBySeverity(issues),
    rows,
    priorImport: prior,
    blocked,
  };
}

/**
 * A statement for an account the bank feed already fills. The feed's rows carry the bank's own ids and
 * often its own wording, so a statement covering the same days can bring the same money in a second
 * time. Said loudly rather than refused: a statement is also how a gap in the feed is filled.
 */
async function feedOverlapIssues(
  bankAccountId: string,
  range: { min: CalendarDate; max: CalendarDate } | null,
): Promise<Issue[]> {
  if (range === null) return [];
  const { db } = await import('@/db/client');
  const [feed] = await db
    .select({ syncFrom: plaidAccounts.syncFrom })
    .from(plaidAccounts)
    .innerJoin(plaidItems, eq(plaidItems.id, plaidAccounts.plaidItemId))
    .where(and(eq(plaidAccounts.bankAccountId, bankAccountId), eq(plaidItems.status, 'active'), isNotNull(plaidAccounts.confirmedAt)));
  if (feed === undefined || feed.syncFrom === null || range.max < feed.syncFrom) return [];
  return [
    {
      severity: 'warn',
      code: 'feed.overlap',
      message: `The bank feed already brings this account in from ${feed.syncFrom}. Rows in this file from that date on may be the same money as feed rows, worded differently.`,
      remedy: 'Import only the days before the feed started, or check the review queue for pairs before approving.',
    },
  ];
}

/**
 * The fingerprint for a row at a given occurrence.
 *
 * The importer owns the recipe; this re-runs it with the occurrence the ledger
 * dictates rather than the one the file happened to imply.
 */
function importerFingerprint(
  importer: AnyImporter,
  row: ImportableRow,
  occurrence: number,
  bankAccountId: string,
  profile?: ImportProfile,
): string {
  return importer.fingerprint({ ...row, occurrence } as ImportableRow, {
    bankAccountId,
    ...(profile === undefined ? {} : { profile }),
  });
}

/**
 * Checks the opening balance this file implies against the balance the ledger
 * already accounts for on the day before it starts.
 *
 * The file's own chain proves it is internally consistent; this proves it joins
 * up with what came before it. A gap is a `warn`, never a refusal: the usual
 * cause is an earlier month that has not been imported yet, which is a normal
 * state for a company catching up — and is exactly the state in which someone
 * would otherwise reconcile to a number that is quietly wrong.
 */
async function openingBalanceIssues(
  parsed: ImporterParseResult<ImportableRow>,
  account: AccountRow,
  dateRange: { min: CalendarDate; max: CalendarDate } | null,
): Promise<Issue[]> {
  const chain = parsed.balanceChain;
  if (chain === null || dateRange === null || chain.openingBalanceCents === null) return [];
  // A file that starts before the account was opened has nothing to join up to.
  if (account.openingDate === null || account.openingDate > dateRange.min) return [];

  const { db } = await import('@/db/client');
  const [prior] = await db
    .select({ total: sqlTag<string>`coalesce(sum(${bankTransactions.amountCents}), 0)::text` })
    .from(bankTransactions)
    .where(
      and(
        eq(bankTransactions.bankAccountId, account.id),
        sqlTag`${bankTransactions.txnDate} < ${dateRange.min}::date`,
      ),
    );

  const expected = account.openingBalanceCents + Number(prior?.total ?? '0');
  const issues: Issue[] = [
    {
      severity: 'info',
      code: 'balance.opening_derived',
      message: `This file implies an opening balance of ${formatMoney(chain.openingBalanceCents)} on ${dateRange.min} and a closing balance of ${formatMoney(chain.closingBalanceCents ?? 0)} on ${dateRange.max}.`,
    },
  ];

  if (expected !== chain.openingBalanceCents) {
    issues.push({
      severity: 'warn',
      code: 'balance.opening_mismatch',
      message: `This statement opens at ${formatMoney(chain.openingBalanceCents)}, but the ledger accounts for ${formatMoney(expected)} in ${account.name} before ${dateRange.min} — a gap of ${formatMoney(chain.openingBalanceCents - expected)}. Almost always an earlier statement that has not been imported yet.`,
      remedy: 'Import the earlier months first; the gap should close to zero.',
    });
  }

  return issues;
}

function toPreviewRow(
  entry: Classified,
  suggestion: Suggestion | null,
  issues: readonly Issue[],
  context: {
    readonly companyMasks: ReadonlySet<string>;
    readonly link: ReturnedLink | null;
    readonly decisionRequired: string | null;
  },
): PreviewRow {
  const row = entry.row;
  const relay = row as Partial<{
    returned: boolean;
    returnedPairRowIndex: number | null;
    internalTransfer: boolean;
  }>;

  return {
    rowIndex: row.rowIndex,
    class: entry.class,
    fingerprint: entry.fingerprint,
    txnDate: row.date,
    description: row.description,
    counterparty: row.counterparty,
    amountCents: row.amountCents,
    balanceCents: row.balanceCents,
    reference: row.reference,
    rawType: row.rawType,
    status: row.status,
    returned: relay.returned ?? false,
    returnedPairRowIndex: relay.returnedPairRowIndex ?? null,
    internalTransfer: relay.internalTransfer ?? false,
    occurrence: entry.occurrence,
    existingTxnId: entry.existingTxnId,
    returnedLedgerTxnId: context.link?.ledgerTxnId ?? null,
    decisionRequired: context.decisionRequired,
    suggestion: suggestion === null ? null : toPreviewSuggestion(suggestion),
    proposedStatus: proposedStatus(row, suggestion, context.companyMasks, context.link),
    issues: issues.filter((issue) => issue.rowIndex === row.rowIndex),
    raw: row.raw,
  };
}

function countRows(rows: readonly PreviewRow[]): ImportCounts {
  let fresh = 0;
  let duplicate = 0;
  let skipped = 0;
  let needsReview = 0;
  let autoPost = 0;
  let excluded = 0;

  for (const row of rows) {
    if (row.class === 'new') fresh += 1;
    else if (row.class === 'duplicate') duplicate += 1;
    else skipped += 1;

    if (row.class !== 'new') continue;
    if (row.proposedStatus === 'excluded') excluded += 1;
    else if (row.proposedStatus === 'unreviewed') needsReview += 1;
    if (row.suggestion?.autoPost === true) autoPost += 1;
  }

  return {
    total: rows.length,
    new: fresh,
    duplicate,
    skipped,
    needsReview,
    autoPost,
    excluded,
  };
}

async function findPriorImport(
  bankAccountId: string,
  hash: string,
): Promise<ImportPreview['priorImport']> {
  const { db } = await import('@/db/client');
  const [row] = await db
    .select({
      id: importBatches.id,
      filename: importBatches.filename,
      createdAt: importBatches.createdAt,
      importedCount: importBatches.importedCount,
    })
    .from(importBatches)
    .where(
      and(
        eq(importBatches.bankAccountId, bankAccountId),
        eq(importBatches.fileHash, hash),
        eq(importBatches.status, 'imported'),
      ),
    )
    .limit(1);

  return row === undefined
    ? null
    : {
        batchId: row.id,
        filename: row.filename,
        importedAt: row.createdAt.toISOString(),
        importedCount: row.importedCount,
      };
}

/** Archives the upload, downgrading a storage failure to a warning on the batch. */
async function archive(
  storage: StatementStorage | null,
  bankAccountId: string,
  hash: string,
  filename: string,
  bytes: Uint8Array,
  batchId: string,
  userId: string | null,
  issues: Issue[],
): Promise<string | null> {
  if (storage === null) {
    issues.push({
      severity: 'warn',
      code: 'storage.unavailable',
      message:
        'The original file was not archived: this process has no Supabase service-role key, so it cannot write to the private bank-statements bucket. The import itself is unaffected.',
      remedy: 'Set SUPABASE_SERVICE_ROLE_KEY so uploaded statements are kept alongside the batch.',
    });
    return null;
  }

  const path = statementStoragePath(bankAccountId, hash, filename);
  try {
    await storage.put(path, bytes, 'text/csv');
  } catch (error) {
    issues.push({
      severity: 'warn',
      code: 'storage.put_failed',
      message: `The original file could not be archived: ${error instanceof Error ? error.message : String(error)}. The import itself is unaffected.`,
    });
    return null;
  }

  const { withActor } = await import('@/db/client');
  await withActor(userId, async (tx) => {
    await tx
      .update(importBatches)
      .set({ storagePath: path, warnings: issues.map(toImportIssue) })
      .where(eq(importBatches.id, batchId));
  });
  return path;
}

// ---------------------------------------------------------------------------
// Commit
// ---------------------------------------------------------------------------

/**
 * A human's answer for one row, keyed by its index among the file's data rows.
 *
 * `rowIndex` and not the fingerprint: the fingerprint carries the occurrence
 * index, which is recomputed against the ledger at commit time and can legally
 * differ from what the preview showed if something else was imported in between.
 * The row's position in the file cannot.
 */
export interface ImportDecision {
  readonly rowIndex: number;
  /** `skip` leaves the row out of the ledger entirely. Default `import`. */
  readonly action?: 'import' | 'skip';
  readonly accountId?: string | null;
  readonly vendorId?: string | null;
  readonly customerId?: string | null;
  readonly channelId?: string | null;
  readonly memo?: string | null;
  readonly status?: BankTxnStatus;
  readonly notes?: string | null;
}

export interface CommitImportInput {
  readonly batchId: string;
  readonly decisions?: readonly ImportDecision[];
  readonly userId: string | null;
  /** The original bytes. Fetched from storage when absent. */
  readonly bytes?: Uint8Array | ArrayBuffer;
  readonly storage?: StatementStorage | null;
  /**
   * The AI tier, run over the inserted rows every deterministic tier declined. On by
   * default, resolving the model from the environment; with no model configured it
   * records that and does nothing. `false` skips it outright.
   */
  readonly ai?: AiTierOptions | false;
}

export interface CommitResult {
  readonly batchId: string;
  readonly bankAccountId: string;
  readonly status: 'imported' | 'cancelled';
  readonly inserted: number;
  /** Rows the ledger already held, plus any the unique index caught on the way in. */
  readonly duplicates: number;
  readonly skipped: number;
  readonly rowCount: number;
  /** Rows the unique index refused although the preview believed them new. */
  readonly conflicts: number;
  readonly transferPairsLinked: number;
  readonly returnedPairsLinked: number;
  readonly issues: readonly Issue[];
  readonly txnIds: readonly string[];
  /** What the AI tier did; null when it was switched off or nothing was inserted. */
  readonly ai: AiTierReport | null;
}

interface BatchRow {
  readonly id: string;
  readonly bankAccountId: string;
  readonly profileId: string | null;
  readonly filename: string;
  readonly fileHash: string;
  readonly storagePath: string | null;
  readonly status: 'parsing' | 'preview' | 'imported' | 'failed' | 'cancelled';
}

async function loadBatch(id: string): Promise<BatchRow> {
  const { db } = await import('@/db/client');
  const [row] = await db
    .select({
      id: importBatches.id,
      bankAccountId: importBatches.bankAccountId,
      profileId: importBatches.profileId,
      filename: importBatches.filename,
      fileHash: importBatches.fileHash,
      storagePath: importBatches.storagePath,
      status: importBatches.status,
    })
    .from(importBatches)
    .where(eq(importBatches.id, id))
    .limit(1);

  if (row === undefined) {
    throw new ImportError('batch.not_found', `No import batch with id ${id}.`);
  }
  return row;
}

/**
 * Writes the transactions the preview proposed, honouring the decisions a human
 * made against them.
 *
 * Everything happens inside one `withActor` transaction, so a failure anywhere
 * leaves the batch in `preview` and the ledger untouched. The file is re-parsed
 * from the bytes rather than trusted from the preview: between preview and commit
 * another import may have landed, and the occurrence indices have to be computed
 * against the ledger as it is now.
 *
 * The AI tier runs afterwards, outside that transaction — a model call must never
 * hold a database connection open — and only ever writes suggestion columns on rows
 * that are still untouched and unreviewed.
 */
export async function commitImport(input: CommitImportInput): Promise<CommitResult> {
  const batch = await loadBatch(input.batchId);

  if (batch.status === 'imported') {
    throw new ImportError(
      'batch.already_imported',
      `Batch ${batch.id} ("${batch.filename}") has already been imported. Preview the file again to import anything it is still missing.`,
    );
  }
  if (batch.status !== 'preview') {
    throw new ImportError(
      'batch.not_previewable',
      `Batch ${batch.id} is ${batch.status}, not preview, so there is nothing to commit.`,
    );
  }

  const bytes = await recoverBytes(batch, input);
  const hash = fileHash(bytes);
  if (hash !== batch.fileHash) {
    throw new ImportError(
      'batch.file_changed',
      `The file given to commit is not the file that was previewed: its sha256 is ${hash}, the batch recorded ${batch.fileHash}. Preview the new file instead of committing it against an old batch.`,
    );
  }

  // Layer 0. An identical file already imported into this account is a whole-file
  // duplicate; the partial unique index would refuse the batch update anyway, so
  // it is answered here as a counted outcome rather than a raised error.
  const prior = await findPriorImport(batch.bankAccountId, hash);
  if (prior !== null) {
    return cancelAsDuplicateFile(batch, prior, input.userId);
  }

  const account = await loadBankAccount(batch.bankAccountId);
  const file = await readFile(bytes, batch.filename);
  const source: SourceFile = {
    bytes,
    sha256: hash,
    filename: batch.filename,
    delivery: 'upload',
    receivedAt: new Date().toISOString(),
  };

  const { importer } = chooseImporter(file, source);
  const loaded = batch.profileId === null ? null : await loadProfile(batch.profileId);

  if (importer.id === GENERIC_IMPORTER_ID && loaded === null) {
    throw new ImportError(
      'profile.unconfirmed',
      `"${batch.filename}" was read with a column mapping worked out automatically, and no person has confirmed it. A wrong guess about which column is the amount, or which way its sign runs, would import every row wrong.`,
      'Save the mapping shown in the preview with saveImportProfile (correcting it if needed), preview the file again, and commit that batch.',
    );
  }

  const parsed = importer.parse(file, {
    bankAccountId: account.id,
    bankAccountMask: account.mask,
    ...(loaded === null ? {} : { profile: loaded.profile }),
  });

  if (hasFatal(parsed.issues)) {
    throw new ImportError(
      'import.blocked',
      `This file cannot be imported: ${parsed.issues
        .filter((issue) => issue.severity === 'fatal')
        .map((issue) => issue.message)
        .join(' ')}`,
    );
  }

  const decisions = new Map((input.decisions ?? []).map((d) => [d.rowIndex, d]));
  const summary = importer.preview(parsed.rows, parsed.header, parsed);

  const { withActor } = await import('@/db/client');
  let written: Omit<CommitResult, 'ai'>;
  try {
    written = await withActor(input.userId, async (tx) => {
      const dates = parsed.rows
        .filter((row) => row.usable && row.date !== '')
        .map((row) => row.date as CalendarDate);
      const existing = await loadExistingByDate(account.id, dates, tx);
      const { classified, issues: dedupeIssues } = classifyRows(
        parsed.rows,
        existing,
        account.id,
        (row, occurrence) =>
          importerFingerprint(importer, row, occurrence, account.id, loaded?.profile),
      );

      const issues: Issue[] = [...parsed.issues, ...dedupeIssues];

      const insertable = classified.filter(
        (entry) =>
          entry.class === 'new' && (decisions.get(entry.row.rowIndex)?.action ?? 'import') !== 'skip',
      );

      // Recomputed against the ledger as it is now, inside the transaction.
      const returns = await scanLedgerForReturns(insertable, account.id, tx);
      if (hasFatal(returns.issues)) {
        throw new ImportError(
          'import.blocked',
          `This file cannot be imported: ${returns.issues
            .filter((issue) => issue.severity === 'fatal')
            .map((issue) => issue.message)
            .join(' ')}`,
        );
      }
      const undecided = [...returns.decisionsRequired].filter(
        ([rowIndex]) => decisions.get(rowIndex)?.status === undefined,
      );
      if (undecided.length > 0) {
        throw new ImportError(
          'import.decision_required',
          `${undecided.length} row${undecided.length === 1 ? ' needs' : 's need'} an explicit decision before this file can be imported: ${undecided
            .map(([rowIndex, reason]) => `row ${rowIndex + 1}: ${reason}`)
            .join(' ')}`,
          'Give each of these rows a status (usually "excluded" once you have confirmed the money never moved) or skip it, then commit again.',
        );
      }
      issues.push(...returns.issues);

      const { engine, byRowIndex, companyMasks } = await runSuggestions(
        insertable,
        account.id,
        summary.dateRange,
        tx,
      );

      const values = insertable.map((entry) => {
        const decision = decisions.get(entry.row.rowIndex);
        const suggestion = byRowIndex.get(entry.row.rowIndex) ?? null;
        const link = returns.links.get(entry.row.rowIndex) ?? null;
        const status =
          decision?.status ?? proposedStatus(entry.row, suggestion, companyMasks, link);

        return {
          bankAccountId: account.id,
          importBatchId: batch.id,
          txnDate: entry.row.date as CalendarDate,
          description: entry.row.description,
          descriptionNormalized: entry.row.descriptionNormalized,
          counterparty: entry.row.counterparty,
          amountCents: entry.row.amountCents,
          balanceCents: entry.row.balanceCents,
          reference: entry.row.reference,
          externalId: entry.row.externalId,
          fingerprint: entry.fingerprint,
          status,
          suggestedAccountId: decision?.accountId ?? suggestion?.accountId ?? null,
          suggestedVendorId: decision?.vendorId ?? suggestion?.vendorId ?? null,
          suggestedCustomerId: decision?.customerId ?? suggestion?.customerId ?? null,
          suggestedChannelId: decision?.channelId ?? suggestion?.channelId ?? null,
          suggestedMemo: decision?.memo ?? suggestion?.memo ?? null,
          suggestionSource: suggestion === null ? null : toDbSuggestionSource(suggestion.source),
          suggestionConfidence: suggestion === null ? null : suggestion.confidence.toFixed(3),
          suggestionReasoning: suggestion?.reasoning ?? null,
          ruleId: suggestion?.ruleId ?? null,
          // A charge already in the ledger; one in this same file is linked after insert.
          refundOfTxnId:
            suggestion?.cardRefundOfTxnId != null && !suggestion.cardRefundOfTxnId.startsWith('pending:')
              ? suggestion.cardRefundOfTxnId
              : null,
          notes: decision?.notes ?? null,
        };
      });

      // The unique index is the backstop, not the plan. `on conflict do nothing`
      // means a row the classification believed new but which the index already
      // holds is counted and dropped, rather than aborting an import of 40 others.
      const inserted =
        values.length === 0
          ? []
          : await tx
              .insert(bankTransactions)
              .values(values)
              .onConflictDoNothing({
                target: [bankTransactions.bankAccountId, bankTransactions.fingerprint],
              })
              .returning({ id: bankTransactions.id, fingerprint: bankTransactions.fingerprint });

      const idByFingerprint = new Map(inserted.map((row) => [row.fingerprint, row.id]));
      const conflicts = values.length - inserted.length;
      if (conflicts > 0) {
        issues.push({
          severity: 'info',
          code: 'dedupe.index_caught',
          message: `${conflicts} row${conflicts === 1 ? '' : 's'} were already in the ledger under the same fingerprint and were counted as duplicates rather than inserted. This is the unique index doing its job, not a problem.`,
        });
      }

      const idByRowIndex = new Map<number, string>();
      for (const entry of insertable) {
        const id = idByFingerprint.get(entry.fingerprint);
        if (id !== undefined) idByRowIndex.set(entry.row.rowIndex, id);
      }
      for (const entry of classified) {
        if (entry.class === 'duplicate' && entry.existingTxnId !== null) {
          idByRowIndex.set(entry.row.rowIndex, entry.existingTxnId);
        }
      }

      const returnedPairsLinked =
        (await linkReturnedPairs(tx, classified, idByRowIndex)) +
        (await linkReturnsToLedger(tx, returns.links, idByRowIndex));
      const transferPairsLinked = await linkTransferPairs(tx, insertable, byRowIndex, idByRowIndex);
      await linkPendingRefunds(tx, insertable, byRowIndex, idByRowIndex);

      const duplicates =
        classified.filter((entry) => entry.class === 'duplicate').length + conflicts;
      const skipped =
        classified.filter((entry) => entry.class === 'skipped').length +
        (classified.filter((entry) => entry.class === 'new').length - insertable.length);

      await tx
        .update(importBatches)
        .set({
          status: 'imported',
          rowCount: classified.length,
          importedCount: inserted.length,
          duplicateCount: duplicates,
          skippedCount: skipped,
          periodStart: summary.dateRange?.min ?? parsed.header.periodStart,
          periodEnd: summary.dateRange?.max ?? parsed.header.periodEnd,
          warnings: issues.map(toImportIssue),
          importedBy: input.userId,
          ...(batch.profileId === null ? {} : { profileId: batch.profileId }),
        })
        .where(eq(importBatches.id, batch.id));

      if (batch.profileId !== null) {
        await tx
          .update(importProfiles)
          .set({ timesUsed: sqlTag`${importProfiles.timesUsed} + 1` })
          .where(eq(importProfiles.id, batch.profileId));
      }

      await recordRuleHits(engine.hits(), { userId: input.userId, tx });

      return {
        batchId: batch.id,
        bankAccountId: account.id,
        status: 'imported' as const,
        inserted: inserted.length,
        duplicates,
        skipped,
        rowCount: classified.length,
        conflicts,
        transferPairsLinked,
        returnedPairsLinked,
        issues,
        txnIds: inserted.map((row) => row.id),
      };
    });
  } catch (error) {
    if (isUniqueViolation(error, 'import_batches_hash_idx')) {
      throw new ImportError(
        'batch.file_already_imported',
        `Another import of these exact bytes into ${account.name} completed first. Nothing was written twice.`,
        'Nothing to do: the file is already in the ledger.',
        { cause: postgresErrorOf(error) },
      );
    }
    throw sanitizeDatabaseError(error, `The import of "${batch.filename}"`);
  }

  if (input.ai === false || written.txnIds.length === 0) return { ...written, ai: null };
  return runAiTierAfterCommit(written, input.userId, input.ai ?? {});
}

/**
 * The AI tier over a committed batch. Never throws: whatever happens here, the
 * transactions are already safely in the ledger with their deterministic
 * suggestions, and the report says what the model did or why it did not.
 */
async function runAiTierAfterCommit(
  written: Omit<CommitResult, 'ai'>,
  userId: string | null,
  ai: AiTierOptions,
): Promise<CommitResult> {
  const issues: Issue[] = [...written.issues];
  let report: AiTierReport | null = null;

  try {
    report = await applyAiSuggestions(written.txnIds, { userId, ai });
    if (report.skippedReason !== null) {
      issues.push({ severity: 'info', code: 'ai.skipped', message: `AI suggestions were not run: ${report.skippedReason}.` });
    } else {
      issues.push({
        severity: 'info',
        code: 'ai.ran',
        message: `${report.attempted} row${report.attempted === 1 ? ' was' : 's were'} offered to ${report.modelId ?? 'the model'}; ${report.written} now carry an AI suggestion for review, ${report.discarded} answer${report.discarded === 1 ? ' was' : 's were'} discarded by the guardrails${report.unanswered > 0 ? `, and ${report.unanswered} came back unanswered and still need a category` : ''}.`,
      });
      for (const failure of report.failures) {
        issues.push({
          severity: 'warn',
          code: 'ai.call_failed',
          message: `An AI call failed and its rows keep the suggestion they had: ${failure}`,
        });
      }
    }
  } catch (error) {
    const detail = sanitizeDatabaseError(error, 'The AI suggestions');
    issues.push({
      severity: 'warn',
      code: 'ai.failed',
      message: `AI suggestions could not be saved, so every row keeps its deterministic suggestion: ${detail instanceof Error ? detail.message : String(detail)}`,
    });
  }

  // The batch record carries the full report, AI outcome included.
  const { withActor } = await import('@/db/client');
  await withActor(userId, async (tx) => {
    await tx
      .update(importBatches)
      .set({ warnings: issues.map(toImportIssue) })
      .where(eq(importBatches.id, written.batchId));
  }).catch(() => {
    // The warnings column is a report, not the import. The result below still says
    // everything it would have said.
  });

  return { ...written, issues, ai: report };
}

/** Marks a batch as a whole-file duplicate without writing a single transaction. */
async function cancelAsDuplicateFile(
  batch: BatchRow,
  prior: NonNullable<ImportPreview['priorImport']>,
  userId: string | null,
): Promise<CommitResult> {
  const issue: Issue = {
    severity: 'warn',
    code: 'file.already_imported',
    message: `These exact bytes were imported on ${prior.importedAt.slice(0, 10)} as "${prior.filename}" (batch ${prior.batchId}, ${prior.importedCount} transactions). Nothing was imported again.`,
    remedy:
      'Nothing to do. To pick up transactions added since, download the statement again — the file will differ and the new rows will import.',
  };

  const { withActor } = await import('@/db/client');
  await withActor(userId, async (tx) => {
    await tx
      .update(importBatches)
      .set({
        status: 'cancelled',
        error: issue.message,
        warnings: [toImportIssue(issue)],
        importedBy: userId,
      })
      .where(eq(importBatches.id, batch.id));
  });

  return {
    batchId: batch.id,
    bankAccountId: batch.bankAccountId,
    status: 'cancelled',
    inserted: 0,
    duplicates: 0,
    skipped: 0,
    rowCount: 0,
    conflicts: 0,
    transferPairsLinked: 0,
    returnedPairsLinked: 0,
    issues: [issue],
    txnIds: [],
    ai: null,
  };
}

async function recoverBytes(batch: BatchRow, input: CommitImportInput): Promise<Uint8Array> {
  if (input.bytes !== undefined) {
    return input.bytes instanceof ArrayBuffer ? new Uint8Array(input.bytes) : input.bytes;
  }

  const storage = input.storage === undefined ? createStatementStorage() : input.storage;
  if (storage === null || batch.storagePath === null) {
    throw new ImportError(
      'batch.bytes_unavailable',
      `The file for batch ${batch.id} is not available: it was not archived${storage === null ? ' and this process has no storage credentials' : ''}, and no bytes were passed to commit.`,
      'Upload the statement again to start a fresh preview.',
    );
  }

  return storage.get(batch.storagePath);
}

/**
 * Links each returned ACH to the settled row that cancels it.
 *
 * Both sides are already written with status `excluded`; this is what lets the
 * review queue show them as the pair they are rather than as two unexplained
 * opposite amounts on the same day.
 */
async function linkReturnedPairs(
  tx: Tx,
  classified: readonly Classified[],
  idByRowIndex: ReadonlyMap<number, string>,
): Promise<number> {
  let linked = 0;
  for (const entry of classified) {
    const pairRowIndex = (entry.row as Partial<{ returnedPairRowIndex: number | null }>)
      .returnedPairRowIndex;
    if (pairRowIndex == null) continue;

    const self = idByRowIndex.get(entry.row.rowIndex);
    const other = idByRowIndex.get(pairRowIndex);
    if (self === undefined || other === undefined) continue;

    await tx
      .update(bankTransactions)
      .set({ transferPairId: other })
      .where(eq(bankTransactions.id, self));
    linked += 1;
  }
  return linked;
}

/**
 * Links rows to the returned-ACH counterparts `scanLedgerForReturns` found in the
 * ledger, and excludes the ledger side when it is the settled original.
 *
 * The update on the ledger row is guarded: it must still be unposted, unreconciled
 * and unpaired. If something changed it since the scan, the whole import is rolled
 * back rather than left half-linked.
 */
async function linkReturnsToLedger(
  tx: Tx,
  links: ReadonlyMap<number, ReturnedLink>,
  idByRowIndex: ReadonlyMap<number, string>,
): Promise<number> {
  let linked = 0;
  for (const [rowIndex, link] of links) {
    const self = idByRowIndex.get(rowIndex);
    if (self === undefined) continue;

    await tx
      .update(bankTransactions)
      .set({ transferPairId: link.ledgerTxnId })
      .where(eq(bankTransactions.id, self));

    const note =
      link.ledgerRole === 'original'
        ? 'Excluded: reversed by a returned ACH imported later; no money moved.'
        : 'Linked to the settled debit this returned ACH reverses.';
    const updated = await tx
      .update(bankTransactions)
      .set({
        transferPairId: self,
        ...(link.ledgerRole === 'original' ? { status: 'excluded' as const } : {}),
        suggestionReasoning: sqlTag`concat_ws(' ', ${bankTransactions.suggestionReasoning}, ${note}::text)`,
      })
      .where(
        and(
          eq(bankTransactions.id, link.ledgerTxnId),
          isNull(bankTransactions.transferPairId),
          isNull(bankTransactions.journalEntryId),
          isNull(bankTransactions.reconciliationId),
        ),
      )
      .returning({ id: bankTransactions.id });

    if (updated.length === 0) {
      throw new ImportError(
        'relay.returned_original_changed',
        `The ${link.ledgerTxnDate} transaction this file's returned ACH reverses was posted, reconciled or paired while the import was running. Nothing was written.`,
        'Preview the file again.',
      );
    }
    linked += 2;
  }
  return linked;
}

/**
 * Applies the transfer pairings the suggestion pipeline is certain of.
 *
 * Only `transfer`-sourced suggestions, which means the bank itself labelled the
 * row `Spend-transfer` or `Receive-transfer`. An amount-and-date guess is a
 * proposal and stays in the review queue where a human can reject it.
 */
async function linkTransferPairs(
  tx: Tx,
  insertable: readonly Classified[],
  suggestions: ReadonlyMap<number, Suggestion>,
  idByRowIndex: ReadonlyMap<number, string>,
): Promise<number> {
  let linked = 0;
  for (const entry of insertable) {
    const suggestion = suggestions.get(entry.row.rowIndex);
    if (suggestion === undefined || suggestion.source !== 'transfer') continue;
    if (suggestion.transferPairTxnId === null) continue;
    // An inferred pair is a proposal: it is shown, never written.
    if (!isBankLabelledTransfer(entry.row)) continue;

    const self = idByRowIndex.get(entry.row.rowIndex);
    if (self === undefined) continue;

    const pendingTarget = suggestion.transferPairTxnId.startsWith('pending:');
    const target = pendingTarget
      ? idByRowIndex.get(Number(suggestion.transferPairTxnId.slice('pending:'.length)))
      : suggestion.transferPairTxnId;
    if (target === undefined) continue;

    await tx
      .update(bankTransactions)
      .set({ transferPairId: target })
      .where(eq(bankTransactions.id, self));
    linked += 1;

    // The other leg is already in the ledger, imported from another account's
    // statement. It is not in this file, so no later iteration links it: point it
    // back here, or the pair is one-sided and the earlier leg still reads as
    // "pair by hand". Never over an existing link, never on a reconciled row.
    if (!pendingTarget) {
      await tx
        .update(bankTransactions)
        .set({
          transferPairId: self,
          suggestionConfidence: suggestion.confidence.toFixed(3),
          suggestionReasoning: suggestion.reasoning,
        })
        .where(
          and(
            eq(bankTransactions.id, target),
            isNull(bankTransactions.transferPairId),
            isNull(bankTransactions.reconciliationId),
          ),
        );
    }
  }
  return linked;
}

/**
 * Links card refunds to charges from the same file, which had no database id when the
 * rows were written. Approving the refund then defaults to the charge's account.
 */
async function linkPendingRefunds(
  tx: Tx,
  insertable: readonly Classified[],
  suggestions: ReadonlyMap<number, Suggestion>,
  idByRowIndex: ReadonlyMap<number, string>,
): Promise<void> {
  for (const entry of insertable) {
    const original = suggestions.get(entry.row.rowIndex)?.cardRefundOfTxnId ?? null;
    if (original === null || !original.startsWith('pending:')) continue;
    const self = idByRowIndex.get(entry.row.rowIndex);
    const target = idByRowIndex.get(Number(original.slice('pending:'.length)));
    if (self === undefined || target === undefined || self === target) continue;
    await tx.update(bankTransactions).set({ refundOfTxnId: target }).where(eq(bankTransactions.id, self));
  }
}

// ---------------------------------------------------------------------------
// Housekeeping
// ---------------------------------------------------------------------------

/**
 * Abandons a preview.
 *
 * Deliberately cheap and always safe: a preview owns no transactions, and the
 * file-hash unique index is partial, so an abandoned batch leaves nothing that
 * stops the same file being previewed again a minute later.
 */
export async function cancelPreview(batchId: string, userId: string | null): Promise<void> {
  const { withActor } = await import('@/db/client');
  await withActor(userId, async (tx) => {
    await tx
      .update(importBatches)
      .set({ status: 'cancelled' })
      .where(and(eq(importBatches.id, batchId), eq(importBatches.status, 'preview')));
  });
}


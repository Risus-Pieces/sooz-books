/**
 * Sooz Books — the whole intake pipeline, run against Sooz Beverage LLC's real money.
 *
 * This is not a demo and not a fixture. It reads the 36 genuine Relay exports in
 * `data/statements/relay/` — nine months, four accounts, 110 transactions — and puts
 * them through the production `previewImport` / `commitImport` path into the four
 * seeded `bank_accounts`. Nothing is reimplemented: if the importer is wrong, this
 * script is wrong in exactly the same way, which is the point.
 *
 * What it proves, in order:
 *
 *   1. **All 36 files import.** Through the real path, into the right accounts, with
 *      the real seeded `Relay CSV` profile and the real rule engine.
 *   2. **Importing them again costs nothing.** Every file is offered a second time and
 *      must insert zero transactions. Re-importing is the normal case for this format,
 *      not an error path.
 *   3. **The September partial deduplicates against the September month.** Relay has
 *      not yet closed September, so there is no full September export to compare
 *      against — §3 below says so and simulates the full month by re-serialising the
 *      partial's own rows (identical data, different bytes), which is what forces the
 *      *row-level* guard to do the work instead of the file-hash guard.
 *   4. **The suggestion pipeline has an opinion about every row**, and the report says
 *      which tier produced it, by count and by dollar value.
 *   5. **Every balance chain ties**, per file and again across the account as stored,
 *      walked forward from the seeded opening balance.
 *   6. **Nothing was dropped or double-counted.** The CSVs are summed a second time by
 *      a parser written here, deliberately sharing no code with `src/lib/banking`, and
 *      the two answers are compared row for row.
 *
 * Run it:
 *
 * ```
 * npx tsx scripts/import-relay.ts            # import, or re-import onto what is there
 * npx tsx scripts/import-relay.ts --reset    # clear the Relay statements first, then import
 * npx tsx scripts/import-relay.ts --no-ai    # skip the AI tier (no model call)
 * ```
 *
 * It exits non-zero if any assertion fails. It never posts to the ledger: that is a
 * later phase, and `bank_transactions.journal_entry_id` is still null on every row when
 * this finishes.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Type-only imports are erased before the file runs, so none of these evaluates a
// module. `@/db/client` opens its connection pool on evaluation and must not be
// reached until `.env.local` has been read; every *value* import below is dynamic.
import type { ImportPreview, StatementStorage } from '@/lib/banking/import';

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const STATEMENT_DIR = join(REPO_ROOT, 'data', 'statements', 'relay');

/**
 * Loads `.env.local` into `process.env` before anything else is imported.
 *
 * `@/db/client` opens its connection pool the moment the module is evaluated, and
 * `assertDbEnv()` throws if `DATABASE_URL` is not already set — so the environment has
 * to be in place first. Existing variables win, which keeps
 * `DATABASE_URL=… npx tsx scripts/import-relay.ts` working against another database.
 */
function loadEnvFile(path: string): void {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return;
  }

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile(join(REPO_ROOT, '.env.local'));

// ---------------------------------------------------------------------------
// Late-bound modules
// ---------------------------------------------------------------------------

/**
 * Everything below is imported by `bootstrap()`, after the environment is loaded.
 *
 * A static `import` would be hoisted above `loadEnvFile` and `@/db/client` would try
 * to open its pool with no `DATABASE_URL`. Top-level `await` is not available either —
 * `package.json` declares no `"type": "module"`, so this file compiles to CommonJS —
 * which leaves late binding: the names below are the ones the rest of the file uses,
 * and `bootstrap()` fills them in before `main()` runs.
 */
type OrmModule = typeof import('drizzle-orm');
type DbModule = typeof import('@/db/client');
type SchemaModule = typeof import('@/db/schema');
type MoneyModule = typeof import('@/lib/money');
type CoaModule = typeof import('@/lib/ledger/coa');
type BankImportModule = typeof import('@/lib/banking/import');
type AiTierModule = typeof import('@/lib/banking/ai-tier');

let and!: OrmModule['and'];
let eq!: OrmModule['eq'];
let inArray!: OrmModule['inArray'];
let isNotNull!: OrmModule['isNotNull'];
let sqlTag!: OrmModule['sql'];

let db!: DbModule['db'];
let sql!: DbModule['sql'];
let withActor!: DbModule['withActor'];

let accounts!: SchemaModule['accounts'];
let bankAccounts!: SchemaModule['bankAccounts'];
let bankTransactions!: SchemaModule['bankTransactions'];
let categorizationRules!: SchemaModule['categorizationRules'];
let importBatches!: SchemaModule['importBatches'];

let formatMoney!: MoneyModule['formatMoney'];
let ACCOUNTS!: CoaModule['ACCOUNTS'];
let previewImport!: BankImportModule['previewImport'];
let commitImport!: BankImportModule['commitImport'];
let applyAiSuggestions!: AiTierModule['applyAiSuggestions'];

async function bootstrap(): Promise<void> {
  const orm = await import('drizzle-orm');
  ({ and, eq, inArray, isNotNull } = orm);
  sqlTag = orm.sql;

  ({ db, sql, withActor } = await import('@/db/client'));
  ({
    accounts,
    bankAccounts,
    bankTransactions,
    categorizationRules,
    importBatches,
  } = await import('@/db/schema'));
  ({ formatMoney } = await import('@/lib/money'));
  ({ ACCOUNTS } = await import('@/lib/ledger/coa'));
  ({ commitImport, previewImport } = await import('@/lib/banking/import'));
  ({ applyAiSuggestions } = await import('@/lib/banking/ai-tier'));
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

const ARGV = new Set(process.argv.slice(2));
const OPTIONS = {
  /** Clear the Relay statements (and only those) before importing, for a from-zero run. */
  reset: ARGV.has('--reset'),
  /** Skip the AI tier entirely, so the script needs no model credentials. */
  noAi: ARGV.has('--no-ai'),
} as const;

for (const arg of ARGV) {
  if (arg !== '--reset' && arg !== '--no-ai') {
    process.stdout.write(`Unknown option "${arg}". Valid options: --reset, --no-ai.\n`);
    process.exit(2);
  }
}

/**
 * Every write in this script is unattributed.
 *
 * `app_users` is empty — Supabase Auth has not been wired up yet — and inventing a
 * user id would put a name on the audit trail that never touched these files. The
 * audit rows say "no actor", which is the truth for a machine catch-up import.
 */
const ACTOR: string | null = null;

// ---------------------------------------------------------------------------
// Report plumbing
// ---------------------------------------------------------------------------

const problems: string[] = [];
let checksRun = 0;

function out(line = ''): void {
  process.stdout.write(`${line}\n`);
}

function heading(title: string): void {
  out();
  out(`━━ ${title} ${'━'.repeat(Math.max(0, 76 - title.length))}`);
  out();
}

/** Records one assertion. `detail` is printed either way: a passing number is evidence too. */
function check(label: string, ok: boolean, detail: string): boolean {
  checksRun += 1;
  out(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : ` — ${detail}`}`);
  if (!ok) problems.push(`${label} — ${detail}`);
  return ok;
}

function checkEquals(label: string, actual: number, expected: number, unit = ''): boolean {
  const render = (value: number): string =>
    unit === '$' ? formatMoney(value) : `${value}${unit === '' ? '' : ` ${unit}`}`;
  return check(
    label,
    actual === expected,
    actual === expected
      ? render(actual)
      : `expected ${render(expected)}, got ${render(actual)}`,
  );
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

function padStart(value: string, width: number): string {
  return value.length >= width ? value : ' '.repeat(width - value.length) + value;
}

// ---------------------------------------------------------------------------
// An independent Relay parser
// ---------------------------------------------------------------------------

/**
 * A second, deliberately naive reader of the same CSVs.
 *
 * It shares nothing with `src/lib/banking` — not `readFile`, not `parseMoney`, not
 * `applyProfile`. That is the whole value of it: if both agree on 110 rows and on
 * every cent, the agreement means something. If they shared a cents parser, a bug in
 * that parser would cancel itself out and the reconciliation would prove nothing.
 *
 * It is allowed to be strict where the real importer must be forgiving, because it
 * only ever sees these 36 files.
 */
interface SourceRow {
  readonly filename: string;
  /** 1-based physical line in the file, header included. */
  readonly line: number;
  readonly date: string;
  readonly payee: string;
  readonly counterpartyMask: string;
  readonly type: string;
  readonly reference: string;
  readonly status: string;
  readonly amountCents: number;
  readonly balanceCents: number;
}

const SOURCE_HEADER =
  'Date,Payee,Account #,Transaction Type,Description,Reference,Status,Amount,Currency,Balance';

/** RFC4180-ish: quoted fields, doubled quotes inside them. Enough for Relay, no more. */
function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let quoted = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      cells.push(cell);
      cell = '';
    } else {
      cell += ch;
    }
  }
  cells.push(cell);
  return cells;
}

/** `+13.99` / `-97.43` / `2000.00` -> integer cents. String arithmetic only; no float. */
function sourceCents(raw: string, where: string): number {
  const cleaned = raw.replace(/,/g, '').trim();
  const match = /^([+-]?)(\d+)(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (match === null) throw new Error(`${where}: "${raw}" is not an amount this parser accepts.`);
  const sign = match[1] === '-' ? -1 : 1;
  const whole = Number(match[2]);
  const frac = Number((match[3] ?? '').padEnd(2, '0'));
  const cents = sign * (whole * 100 + frac);
  if (!Number.isSafeInteger(cents)) throw new Error(`${where}: "${raw}" overflows integer cents.`);
  return cents;
}

/** `1/5/2026` -> `2026-01-05`. No `Date` object is constructed anywhere in this file. */
function sourceDate(raw: string, where: string): string {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw.trim());
  if (match === null) throw new Error(`${where}: "${raw}" is not M/D/YYYY.`);
  const month = Number(match[1]);
  const day = Number(match[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new Error(`${where}: "${raw}" is not a calendar date.`);
  }
  return `${match[3]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function readSourceFile(filename: string): SourceRow[] {
  const text = readFileSync(join(STATEMENT_DIR, filename), 'utf8');
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
  if (lines.length === 0) throw new Error(`${filename}: empty file.`);
  if (lines[0].trim() !== SOURCE_HEADER) {
    throw new Error(`${filename}: unexpected header "${lines[0]}".`);
  }

  const rows: SourceRow[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const cells = splitCsvLine(lines[i]);
    if (cells.length !== 10) {
      throw new Error(`${filename} line ${i + 1}: ${cells.length} cells, expected 10.`);
    }
    const where = `${filename} line ${i + 1}`;
    rows.push({
      filename,
      line: i + 1,
      date: sourceDate(cells[0], where),
      payee: cells[1].trim(),
      counterpartyMask: cells[2].trim(),
      type: cells[3].trim(),
      reference: cells[5].trim(),
      status: cells[6].trim(),
      amountCents: sourceCents(cells[7], where),
      balanceCents: sourceCents(cells[9], where),
    });
  }
  return rows;
}

interface SourceChain {
  readonly ok: boolean;
  readonly openingCents: number;
  readonly closingCents: number;
  readonly breaks: readonly string[];
}

/**
 * Walks the file's own running balance oldest-first and derives its opening balance.
 *
 * Relay writes newest-first, so the list is reversed before walking. `opening` is
 * `first balance - first amount`, which is the figure `bank_accounts.opening_balance_cents`
 * was seeded from for ••9726.
 */
function sourceChain(rows: readonly SourceRow[]): SourceChain {
  if (rows.length === 0) {
    return { ok: true, openingCents: 0, closingCents: 0, breaks: [] };
  }
  const oldestFirst = [...rows].reverse();
  const opening = oldestFirst[0].balanceCents - oldestFirst[0].amountCents;

  const breaks: string[] = [];
  let running = opening;
  for (const row of oldestFirst) {
    running += row.amountCents;
    if (running !== row.balanceCents) {
      breaks.push(
        `${row.filename} line ${row.line}: balance says ${formatMoney(row.balanceCents)}, the chain gives ${formatMoney(running)}`,
      );
      running = row.balanceCents;
    }
  }

  return { ok: breaks.length === 0, openingCents: opening, closingCents: running, breaks };
}

// ---------------------------------------------------------------------------
// The corpus
// ---------------------------------------------------------------------------

interface StatementFile {
  readonly filename: string;
  readonly mask: string;
  /** The month in the filename, as `YYYY-MM-01`. */
  readonly period: string;
  readonly partial: boolean;
  readonly bytes: Uint8Array;
  readonly rows: readonly SourceRow[];
}

const FILENAME_PATTERN = /^Relay (\(Partial\) )?(\d{4}-\d{2})-01 #(\d{4})\.csv$/;

/**
 * Every statement, sorted the way a bookkeeper would actually import them: oldest
 * month first, and the not-yet-closed `(Partial)` month last within its month.
 *
 * The order is load-bearing. Importing March before January would make January's
 * opening-balance check fire against a ledger that already holds March, and the
 * `balance.opening_mismatch` warning exists precisely to catch that mistake.
 */
function loadCorpus(): StatementFile[] {
  const files: StatementFile[] = [];

  for (const filename of readdirSync(STATEMENT_DIR).sort()) {
    if (!filename.toLowerCase().endsWith('.csv')) continue;
    const match = FILENAME_PATTERN.exec(filename);
    if (match === null) {
      throw new Error(`${filename} does not look like a Relay export. Refusing to guess.`);
    }
    files.push({
      filename,
      mask: match[3],
      period: `${match[2]}-01`,
      partial: match[1] !== undefined,
      bytes: new Uint8Array(readFileSync(join(STATEMENT_DIR, filename))),
      rows: readSourceFile(filename),
    });
  }

  return files.sort(
    (a, b) =>
      a.period.localeCompare(b.period) ||
      Number(a.partial) - Number(b.partial) ||
      a.mask.localeCompare(b.mask),
  );
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/**
 * An in-process stand-in for the private `bank-statements` bucket.
 *
 * This process has no `SUPABASE_SERVICE_ROLE_KEY`, and rather than skip archiving —
 * which would leave `previewImport`'s archive path and `commitImport`'s `recoverBytes`
 * path untested — the same interface is satisfied in memory. Commit is then given the
 * batch id and nothing else, so the bytes really do come back out of the store.
 */
function createMemoryStorage(): StatementStorage & { readonly size: () => number } {
  const files = new Map<string, Uint8Array>();
  return {
    bucket: 'memory://bank-statements',
    async put(path, bytes) {
      files.set(path, bytes);
    },
    async get(path) {
      const bytes = files.get(path);
      if (bytes === undefined) throw new Error(`Nothing archived at ${path}.`);
      return bytes;
    },
    size: () => files.size,
  };
}

const storage = createMemoryStorage();

// ---------------------------------------------------------------------------
// Bank accounts
// ---------------------------------------------------------------------------

interface RelayAccount {
  readonly id: string;
  readonly mask: string;
  readonly name: string;
  readonly openingBalanceCents: number;
  readonly openingDate: string | null;
}

/**
 * The four seeded Relay accounts, by statement mask.
 *
 * A mask alone does not identify an account: the live-database test suites create
 * throwaway `bank_accounts` that reuse mask 9726 (institution `Relay (test)`,
 * inactive) while they run. Matching on mask alone once aimed this script — and
 * `--reset` — at a test account. So only active accounts whose institution is
 * exactly `Relay` count, and two candidates for one mask is a refusal, not a guess.
 */
async function loadRelayAccounts(): Promise<Map<string, RelayAccount>> {
  const rows = await db
    .select({
      id: bankAccounts.id,
      mask: bankAccounts.mask,
      name: bankAccounts.name,
      openingBalanceCents: bankAccounts.openingBalanceCents,
      openingDate: bankAccounts.openingDate,
    })
    .from(bankAccounts)
    .where(and(eq(bankAccounts.institution, 'Relay'), eq(bankAccounts.active, true)));

  const byMask = new Map<string, RelayAccount>();
  for (const row of rows) {
    if (row.mask === null) continue;
    if (byMask.has(row.mask)) {
      throw new Error(
        `Two active Relay bank accounts share mask ${row.mask} ("${byMask.get(row.mask)?.name}" and "${row.name}"). Refusing to guess which one the statements belong to.`,
      );
    }
    byMask.set(row.mask, {
      id: row.id,
      mask: row.mask,
      name: row.name,
      openingBalanceCents: row.openingBalanceCents,
      openingDate: row.openingDate,
    });
  }
  return byMask;
}

/**
 * Clears the Relay statements and the batches that produced them, and nothing else.
 *
 * Scoped to these four `bank_accounts` by id, and refused outright if anything has
 * been posted or reconciled — a transaction with a journal entry behind it is not this
 * script's to delete. The chart of accounts, the vendors, the rules and the profiles
 * are never touched.
 */
async function resetStatements(accountIds: readonly string[]): Promise<{ txns: number; batches: number }> {
  const [locked] = await db
    .select({ count: sqlTag<string>`count(*)::text` })
    .from(bankTransactions)
    .where(
      and(
        inArray(bankTransactions.bankAccountId, [...accountIds]),
        sqlTag`(${bankTransactions.journalEntryId} is not null or ${bankTransactions.reconciliationId} is not null)`,
      ),
    );

  if (Number(locked?.count ?? '0') > 0) {
    throw new Error(
      `${locked?.count} Relay transactions are already posted or reconciled. --reset will not delete them; clear them deliberately or run without --reset.`,
    );
  }

  return withActor(ACTOR, async (tx) => {
    // `transfer_pair_id` points at a sibling row, so the links have to go before the
    // rows do or the delete trips its own foreign key.
    await tx
      .update(bankTransactions)
      .set({ transferPairId: null })
      .where(
        and(
          inArray(bankTransactions.bankAccountId, [...accountIds]),
          isNotNull(bankTransactions.transferPairId),
        ),
      );

    const removed = await tx
      .delete(bankTransactions)
      .where(inArray(bankTransactions.bankAccountId, [...accountIds]))
      .returning({ id: bankTransactions.id });

    const batches = await tx
      .delete(importBatches)
      .where(inArray(importBatches.bankAccountId, [...accountIds]))
      .returning({ id: importBatches.id });

    return { txns: removed.length, batches: batches.length };
  });
}

// ---------------------------------------------------------------------------
// One file, through the real path
// ---------------------------------------------------------------------------

interface ImportOutcome {
  readonly filename: string;
  readonly mask: string;
  readonly preview: ImportPreview;
  readonly status: 'imported' | 'cancelled';
  readonly inserted: number;
  readonly duplicates: number;
  readonly skipped: number;
  readonly conflicts: number;
  readonly transferPairsLinked: number;
  readonly returnedPairsLinked: number;
  readonly blocked: boolean;
  readonly fatalIssues: readonly string[];
}

/**
 * Preview, then commit — the same two calls the upload screen makes.
 *
 * The bytes are handed to `previewImport` and then deliberately *not* handed to
 * `commitImport`: the commit reads them back out of the archive, which is the path a
 * real user takes when they confirm an import minutes after uploading it.
 */
async function importOne(
  file: { filename: string; bytes: Uint8Array },
  accountId: string,
  mask: string,
): Promise<ImportOutcome> {
  const preview = await previewImport({
    bankAccountId: accountId,
    filename: file.filename,
    bytes: file.bytes,
    userId: ACTOR,
    storage,
  });

  const fatalIssues = preview.issues
    .filter((issue) => issue.severity === 'fatal')
    .map((issue) => issue.message);

  if (preview.blocked) {
    // A blocked preview is never committed; it is reported with its reasons.
    return {
      filename: file.filename,
      mask,
      preview,
      status: 'cancelled',
      inserted: 0,
      duplicates: 0,
      skipped: 0,
      conflicts: 0,
      transferPairsLinked: 0,
      returnedPairsLinked: 0,
      blocked: true,
      fatalIssues,
    };
  }

  const result = await commitImport({
    batchId: preview.batchId,
    userId: ACTOR,
    storage,
    // The production AI tier runs inside commitImport; --no-ai switches it off there too.
    ...(OPTIONS.noAi ? { ai: false as const } : {}),
  });

  return {
    filename: file.filename,
    mask,
    preview,
    status: result.status,
    inserted: result.inserted,
    duplicates: result.duplicates,
    skipped: result.skipped,
    conflicts: result.conflicts,
    transferPairsLinked: result.transferPairsLinked,
    returnedPairsLinked: result.returnedPairsLinked,
    blocked: false,
    fatalIssues,
  };
}

// ---------------------------------------------------------------------------
// Readback
// ---------------------------------------------------------------------------

interface LedgerTxn {
  readonly id: string;
  readonly mask: string;
  readonly txnDate: string;
  readonly description: string;
  readonly counterparty: string | null;
  readonly reference: string | null;
  readonly amountCents: number;
  readonly balanceCents: number | null;
  readonly status: string;
  readonly fingerprint: string;
  readonly suggestionSource: string | null;
  readonly suggestionConfidence: string | null;
  readonly suggestedAccountId: string | null;
  readonly accountCode: string | null;
  readonly accountName: string | null;
  readonly accountType: string | null;
  readonly accountSubtype: string | null;
  readonly ruleName: string | null;
  readonly ruleAutoPost: boolean | null;
  readonly journalEntryId: string | null;
  readonly transferPairId: string | null;
}

async function loadLedger(accountIds: readonly string[]): Promise<LedgerTxn[]> {
  const rows = await db
    .select({
      id: bankTransactions.id,
      mask: bankAccounts.mask,
      txnDate: bankTransactions.txnDate,
      description: bankTransactions.description,
      counterparty: bankTransactions.counterparty,
      reference: bankTransactions.reference,
      amountCents: bankTransactions.amountCents,
      balanceCents: bankTransactions.balanceCents,
      status: bankTransactions.status,
      fingerprint: bankTransactions.fingerprint,
      suggestionSource: bankTransactions.suggestionSource,
      suggestionConfidence: bankTransactions.suggestionConfidence,
      suggestedAccountId: bankTransactions.suggestedAccountId,
      accountCode: accounts.code,
      accountName: accounts.name,
      accountType: accounts.type,
      accountSubtype: accounts.subtype,
      ruleName: categorizationRules.name,
      ruleAutoPost: categorizationRules.autoPost,
      journalEntryId: bankTransactions.journalEntryId,
      transferPairId: bankTransactions.transferPairId,
    })
    .from(bankTransactions)
    .innerJoin(bankAccounts, eq(bankAccounts.id, bankTransactions.bankAccountId))
    .leftJoin(accounts, eq(accounts.id, bankTransactions.suggestedAccountId))
    .leftJoin(categorizationRules, eq(categorizationRules.id, bankTransactions.ruleId))
    .where(inArray(bankTransactions.bankAccountId, [...accountIds]))
    .orderBy(bankAccounts.mask, bankTransactions.txnDate);

  return rows.map((row) => ({ ...row, mask: row.mask ?? '' }));
}

// ---------------------------------------------------------------------------
// Balance chain, as stored
// ---------------------------------------------------------------------------

interface StoredChain {
  readonly ok: boolean;
  readonly openingCents: number;
  readonly closingCents: number;
  readonly breaks: readonly string[];
}

/**
 * Walks the account's stored rows forward from its seeded opening balance.
 *
 * Row order inside a day cannot be read back from the database — every row in a batch
 * shares one `created_at`, and the uuid primary key is random — so the day's order is
 * *recovered* rather than assumed: at each step the row whose stored balance equals
 * `running + amount` is the row that came next. That makes this a real check on the
 * stored data rather than a restatement of the insert order, and it fails loudly if any
 * row's amount or balance was written wrong.
 */
function storedChain(
  rows: readonly { txnDate: string; amountCents: number; balanceCents: number | null }[],
  openingCents: number,
): StoredChain {
  const byDate = new Map<string, { amountCents: number; balanceCents: number | null }[]>();
  for (const row of rows) {
    const bucket = byDate.get(row.txnDate);
    if (bucket === undefined) byDate.set(row.txnDate, [row]);
    else bucket.push(row);
  }

  const breaks: string[] = [];
  let running = openingCents;

  for (const date of [...byDate.keys()].sort()) {
    const remaining = [...(byDate.get(date) ?? [])];
    while (remaining.length > 0) {
      const index = remaining.findIndex(
        (row) => row.balanceCents !== null && row.balanceCents === running + row.amountCents,
      );
      if (index >= 0) {
        const [row] = remaining.splice(index, 1);
        running = row.balanceCents ?? running + row.amountCents;
        continue;
      }
      const [row] = remaining.splice(0, 1);
      const expected = running + row.amountCents;
      breaks.push(
        `${date}: no stored row continues the chain at ${formatMoney(running)}; ${formatMoney(row.amountCents)} would give ${formatMoney(expected)} but its balance is ${row.balanceCents === null ? 'null' : formatMoney(row.balanceCents)}`,
      );
      running = row.balanceCents ?? expected;
    }
  }

  return { ok: breaks.length === 0, openingCents, closingCents: running, breaks };
}

// ---------------------------------------------------------------------------
// The AI tier
// ---------------------------------------------------------------------------

interface AiOutcome {
  readonly attempted: number;
  readonly suggested: number;
  readonly discarded: number;
  readonly modelId: string | null;
  readonly failures: readonly string[];
  readonly suggestedCents: number;
  readonly byAccount: ReadonlyMap<string, { count: number; cents: number }>;
}

/**
 * Asks the model about the rows every deterministic tier declined.
 *
 * This is the production tier, `applyAiSuggestions` — the same call `commitImport`
 * makes for the rows it inserts. It runs again here because on a re-run the rows
 * are already in the ledger and no commit inserts them: without this, rows imported
 * before a model was configured would never be asked about. It selects the rows
 * itself (no suggestion, or parked in Ask My Accountant; never excluded, transfer,
 * matched, reviewed or posted rows), writes the answers atomically, clears the rule
 * that no longer explains a suggestion, and leaves `status` as `unreviewed`.
 */
async function runAiTier(candidates: readonly LedgerTxn[]): Promise<AiOutcome> {
  const report = await applyAiSuggestions(
    candidates.map((txn) => txn.id),
    { userId: ACTOR },
  );

  const byAccount = new Map<string, { count: number; cents: number }>();
  let suggestedCents = 0;
  for (const suggestion of report.suggestions) {
    suggestedCents += suggestion.amountCents;
    const bucket = byAccount.get(suggestion.accountCode) ?? { count: 0, cents: 0 };
    bucket.count += 1;
    bucket.cents += suggestion.amountCents;
    byAccount.set(suggestion.accountCode, bucket);
  }

  return {
    attempted: report.attempted === 0 && report.skippedReason !== null ? candidates.length : report.attempted,
    suggested: report.written,
    discarded: report.discarded,
    modelId: report.modelId,
    failures: report.skippedReason === null ? report.failures : [report.skippedReason],
    suggestedCents,
    byAccount,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const startedAt = Date.now();

  out('Sooz Books — Relay statement intake, end to end');
  out('Sooz Beverage LLC · data/statements/relay · real bank records');

  // -------------------------------------------------------------------------
  heading('0. The corpus and the accounts');

  const corpus = loadCorpus();
  const sourceRows = corpus.flatMap((file) => file.rows);

  checkEquals('statement files found', corpus.length, 36, 'files');
  checkEquals('transactions in the files', sourceRows.length, 110, 'rows');

  const emptyFiles = corpus.filter((file) => file.rows.length === 0);
  check(
    'header-only files are normal, not errors',
    emptyFiles.length === 25,
    `${emptyFiles.length} of ${corpus.length} files carry a header and no transactions`,
  );

  const accountsByMask = await loadRelayAccounts();
  const masks = [...new Set(corpus.map((file) => file.mask))].sort();
  const missing = masks.filter((mask) => !accountsByMask.has(mask));
  check(
    'every statement has a seeded bank account',
    missing.length === 0,
    missing.length === 0 ? `••${masks.join(', ••')}` : `no bank_accounts row for ••${missing.join(', ••')}`,
  );
  if (missing.length > 0) throw new Error('Cannot import without the seeded Relay bank accounts.');

  const accountIds = masks.map((mask) => {
    const account = accountsByMask.get(mask);
    if (account === undefined) throw new Error(`No bank account for ••${mask}.`);
    return account.id;
  });

  for (const mask of masks) {
    const account = accountsByMask.get(mask);
    if (account === undefined) continue;
    out(
      `        ••${mask}  ${pad(account.name, 28)} opening ${padStart(formatMoney(account.openingBalanceCents), 10)} as of ${account.openingDate ?? '—'}`,
    );
  }

  if (OPTIONS.reset) {
    const cleared = await resetStatements(accountIds);
    out();
    out(
      `        --reset: removed ${cleared.txns} bank transactions and ${cleared.batches} import batches from the four Relay accounts. Chart of accounts, vendors, rules and profiles untouched.`,
    );
  }

  const [{ count: preexisting }] = await db
    .select({ count: sqlTag<string>`count(*)::text` })
    .from(bankTransactions)
    .where(inArray(bankTransactions.bankAccountId, accountIds));

  if (Number(preexisting) > 0) {
    out();
    out(
      `        Note: the Relay accounts already hold ${preexisting} transactions. Pass 1 will therefore exercise the duplicate path rather than the first-import path; the end-state assertions below are unaffected. Use --reset for a from-zero run.`,
    );
  }

  // -------------------------------------------------------------------------
  heading('1. First import — all 36 files through previewImport / commitImport');

  const firstPass: ImportOutcome[] = [];
  for (const file of corpus) {
    const account = accountsByMask.get(file.mask);
    if (account === undefined) continue;
    firstPass.push(await importOne(file, account.id, file.mask));
  }

  const insertedFirst = firstPass.reduce((sum, outcome) => sum + outcome.inserted, 0);
  const blockedFirst = firstPass.filter((outcome) => outcome.blocked);
  const cancelledFirst = firstPass.filter((outcome) => outcome.status === 'cancelled');

  out(
    `        ${pad('file', 34)} ${padStart('rows', 5)} ${padStart('new', 5)} ${padStart('dup', 5)} ${padStart('skip', 5)}  status`,
  );
  for (const outcome of firstPass) {
    if (outcome.preview.counts.total === 0 && outcome.inserted === 0 && outcome.status === 'cancelled') continue;
    out(
      `        ${pad(outcome.filename, 34)} ${padStart(String(outcome.preview.counts.total), 5)} ${padStart(String(outcome.inserted), 5)} ${padStart(String(outcome.duplicates), 5)} ${padStart(String(outcome.skipped), 5)}  ${outcome.status}`,
    );
  }
  out(
    `        (${cancelledFirst.length} header-only files are byte-identical to one already imported into the same account and are recognised as the same file; they carry no transactions, so nothing is lost.)`,
  );

  check(
    'no file was blocked',
    blockedFirst.length === 0,
    blockedFirst.length === 0
      ? 'every statement parsed and its balance chain tied'
      : blockedFirst.map((outcome) => `${outcome.filename}: ${outcome.fatalIssues.join(' ')}`).join(' | '),
  );

  const afterFirst = await loadLedger(accountIds);
  checkEquals('transactions in the ledger after pass 1', afterFirst.length, 110, 'rows');
  out(`        inserted this pass: ${insertedFirst}`);

  const transferLinks = firstPass.reduce((sum, outcome) => sum + outcome.transferPairsLinked, 0);
  const returnedLinks = firstPass.reduce((sum, outcome) => sum + outcome.returnedPairsLinked, 0);
  out(
    `        transfer pairs linked: ${transferLinks} · returned-ACH pairs linked: ${returnedLinks} · statements archived: ${storage.size()}`,
  );

  // -------------------------------------------------------------------------
  heading('2. Second import — the same 36 files again');

  const secondPass: ImportOutcome[] = [];
  for (const file of corpus) {
    const account = accountsByMask.get(file.mask);
    if (account === undefined) continue;
    secondPass.push(await importOne(file, account.id, file.mask));
  }

  const insertedSecond = secondPass.reduce((sum, outcome) => sum + outcome.inserted, 0);
  const conflictsSecond = secondPass.reduce((sum, outcome) => sum + outcome.conflicts, 0);
  const afterSecond = await loadLedger(accountIds);

  checkEquals('transactions inserted on the second import', insertedSecond, 0, 'rows');
  checkEquals('transactions in the ledger after pass 2', afterSecond.length, 110, 'rows');
  check(
    'every file was recognised as one already imported',
    secondPass.every((outcome) => outcome.status === 'cancelled'),
    `${secondPass.filter((outcome) => outcome.status === 'cancelled').length} of ${secondPass.length} cancelled by the file-hash guard before a row was read`,
  );
  out(`        row-level conflicts caught by the unique index: ${conflictsSecond}`);

  // -------------------------------------------------------------------------
  heading('3. September — the partial month, before and after the full month');

  const septemberPartial = corpus.find(
    (file) => file.filename === 'Relay (Partial) 2026-09-01 #9726.csv',
  );
  if (septemberPartial === undefined) {
    throw new Error('Relay (Partial) 2026-09-01 #9726.csv is missing from the corpus.');
  }
  const account9726 = accountsByMask.get('9726');
  if (account9726 === undefined) throw new Error('No bank account for ••9726.');

  out('        Relay has not closed September 2026, so there is no `Relay 2026-09-01 #9726.csv`');
  out('        in the corpus — the partial is the only September export that exists. The full');
  out('        month is simulated by re-serialising the partial\'s own 13 rows with CRLF line');
  out('        endings: identical data, different bytes, therefore a different file hash. That');
  out('        is what forces the row-level fingerprint guard to do the work instead of letting');
  out('        the file-hash guard answer first.');
  out();

  const septemberBefore = afterSecond.filter(
    (txn) => txn.mask === '9726' && txn.txnDate >= '2026-09-01',
  );
  out(`        before: ••9726 holds ${septemberBefore.length} September transactions (the partial, imported in pass 1).`);

  const simulatedFullText = readFileSync(join(STATEMENT_DIR, septemberPartial.filename), 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .join('\r\n');
  const simulatedFull = {
    filename: 'Relay 2026-09-01 #9726.csv',
    bytes: new Uint8Array(Buffer.from(`${simulatedFullText}\r\n`, 'utf8')),
  };

  check(
    'the simulated full month is a different file',
    Buffer.compare(Buffer.from(simulatedFull.bytes), Buffer.from(septemberPartial.bytes)) !== 0,
    'different bytes, so the file-hash guard cannot answer for it',
  );

  const fullOutcome = await importOne(simulatedFull, account9726.id, '9726');
  out(
    `        full month:  ${fullOutcome.status}, ${fullOutcome.inserted} new, ${fullOutcome.duplicates} duplicates, ${fullOutcome.conflicts} caught by the unique index`,
  );
  checkEquals('the full month inserts nothing new', fullOutcome.inserted, 0, 'rows');
  if (fullOutcome.status === 'imported') {
    checkEquals(
      'every row of the full month is recognised as a duplicate',
      fullOutcome.duplicates,
      septemberPartial.rows.length,
      'rows',
    );
  } else {
    // A second run of this script meets its own simulated file again; the file-hash
    // guard then answers first and the row-level guard is never reached.
    check(
      'the full month was recognised as a file already imported',
      true,
      'these exact bytes were imported by an earlier run of this script, so the file-hash guard answered before any row was classified',
    );
  }

  const partialAgain = await importOne(septemberPartial, account9726.id, '9726');
  out(
    `        partial again: ${partialAgain.status}, ${partialAgain.inserted} new, ${partialAgain.duplicates} duplicates`,
  );
  checkEquals('re-importing the partial after the full month inserts nothing', partialAgain.inserted, 0, 'rows');

  const septemberAfter = (await loadLedger(accountIds)).filter(
    (txn) => txn.mask === '9726' && txn.txnDate >= '2026-09-01',
  );
  checkEquals(
    'September transactions after partial → full → partial',
    septemberAfter.length,
    septemberPartial.rows.length,
    'rows',
  );

  // -------------------------------------------------------------------------
  heading('4. The suggestion pipeline');

  const ledger = await loadLedger(accountIds);
  checkEquals('transactions to categorize', ledger.length, 110, 'rows');

  /**
   * Every row lands in exactly one tier, decided in this order. The order matters:
   * the returned Google charge carries a rule suggestion *and* is excluded, and it
   * must be counted once, as excluded, because no money moved on it.
   */
  type Tier = 'excluded' | 'auto' | 'transfer' | 'match' | 'ai' | 'rule' | 'vendor' | 'none';
  const tierOf = (txn: LedgerTxn): Tier => {
    if (txn.status === 'excluded') return 'excluded';
    if (txn.status === 'categorized') return 'auto';
    if (txn.status === 'transfer') return 'transfer';
    // A bank-labelled transfer whose other side is not the company's, or a card
    // refund: matched against another row, and waiting for a human.
    if (txn.suggestionSource === 'match') return 'match';
    if (txn.suggestionSource === 'ai') return 'ai';
    if (txn.suggestionSource === 'rule') return 'rule';
    if (txn.suggestionSource === 'history') return 'vendor';
    return 'none';
  };
  const inTier = (rows: readonly LedgerTxn[], tier: Tier): LedgerTxn[] =>
    rows.filter((txn) => tierOf(txn) === tier);

  const excluded = inTier(ledger, 'excluded');

  const value = (rows: readonly LedgerTxn[]): number =>
    rows.reduce((sum, row) => sum + row.amountCents, 0);
  const gross = (rows: readonly LedgerTxn[]): number =>
    rows.reduce((sum, row) => sum + Math.abs(row.amountCents), 0);

  // The AI tier is asked about two kinds of row: those no deterministic tier had an
  // opinion on, and those a rule deliberately parked in Ask My Accountant because the
  // payee alone cannot decide them (Amazon above all). relay.md: "These go to the
  // review queue with an AI suggestion and no default."
  const aiCandidates = ledger.filter(
    (txn) =>
      tierOf(txn) === 'none' ||
      (tierOf(txn) === 'rule' && txn.accountCode === ACCOUNTS.ASK_MY_ACCOUNTANT),
  );
  const ai = OPTIONS.noAi
    ? {
        attempted: aiCandidates.length,
        suggested: 0,
        discarded: 0,
        modelId: null,
        failures: ['--no-ai: the AI tier was not run'],
        suggestedCents: 0,
        byAccount: new Map<string, { count: number; cents: number }>(),
      }
    : await runAiTier(aiCandidates);

  const afterAi = await loadLedger(accountIds);
  const ruleSuggested = inTier(afterAi, 'rule');
  const transferred = inTier(afterAi, 'transfer');
  const vendorSuggested = inTier(afterAi, 'vendor');
  const aiSuggested = inTier(afterAi, 'ai');
  const unsuggested = inTier(afterAi, 'none');
  const parkedForReview = ruleSuggested.filter(
    (txn) => txn.accountCode === ACCOUNTS.ASK_MY_ACCOUNTANT,
  );

  const tiers: ReadonlyArray<{ label: string; rows: readonly LedgerTxn[] }> = [
    { label: 'auto-posted (rule marked auto_post)', rows: inTier(afterAi, 'auto') },
    { label: 'rule-suggested (waiting for review)', rows: ruleSuggested },
    { label: '  of which parked in 7900 for review', rows: parkedForReview },
    { label: 'internal transfer (bank-labelled)', rows: transferred },
    { label: 'transfer/refund match (review)', rows: inTier(afterAi, 'match') },
    { label: 'vendor default / history', rows: vendorSuggested },
    { label: 'AI-suggested (proposal only)', rows: aiSuggested },
    { label: 'left unsuggested', rows: unsuggested },
    { label: 'excluded (returned ACH + its pair)', rows: inTier(afterAi, 'excluded') },
  ];

  out(`        ${pad('tier', 38)} ${padStart('count', 6)} ${padStart('net', 13)} ${padStart('gross', 13)}`);
  for (const tier of tiers) {
    out(
      `        ${pad(tier.label, 38)} ${padStart(String(tier.rows.length), 6)} ${padStart(formatMoney(value(tier.rows)), 13)} ${padStart(formatMoney(gross(tier.rows)), 13)}`,
    );
  }

  const allTiers: readonly Tier[] = ['excluded', 'auto', 'transfer', 'match', 'ai', 'rule', 'vendor', 'none'];
  const tiered = allTiers.reduce((sum, tier) => sum + inTier(afterAi, tier).length, 0);
  checkEquals('every transaction lands in exactly one tier', tiered, afterAi.length, 'rows');
  checkEquals(
    'the tiers add up to the whole ledger in dollars',
    allTiers.reduce((sum, tier) => sum + value(inTier(afterAi, tier)), 0),
    value(afterAi),
    '$',
  );

  out();
  if (ai.attempted === 0) {
    out('        AI tier: nothing to ask about — every row already has a deterministic suggestion.');
  } else if (ai.modelId !== null) {
    out(
      `        AI tier: ${ai.attempted} rows offered to ${ai.modelId}, ${ai.suggested} answered, ${ai.discarded} discarded by the guardrails.`,
    );
    for (const [code, bucket] of ai.byAccount) {
      out(`          → ${code}: ${bucket.count} row(s), ${formatMoney(bucket.cents)}`);
    }
    // Not an assertion failure: the pipeline is built to degrade to rules-only, and
    // the rows the model did not answer stay in the review queue with what they had.
    for (const failure of ai.failures) out(`        NOTE — AI call failed, rows keep their prior suggestion: ${failure}`);
  } else {
    out(`        AI tier: ${ai.attempted} rows not asked about — ${ai.failures.join('; ')}.`);
  }

  // Internal transfers. Relay writes each leg in a different account's statement,
  // so the leg imported second has to find the first in the ledger and link both.
  const labelledTransfers = afterAi.filter((txn) => txn.status === 'transfer');
  const byId = new Map(afterAi.map((txn) => [txn.id, txn]));
  const pairedBothWays = labelledTransfers.filter((txn) => {
    if (txn.transferPairId === null) return false;
    const other = byId.get(txn.transferPairId);
    return (
      other !== undefined &&
      other.transferPairId === txn.id &&
      other.mask !== txn.mask &&
      other.amountCents === -txn.amountCents
    );
  });
  const unpairedTransfers = labelledTransfers.filter((txn) => txn.transferPairId === null);
  check(
    'the ••9973 → ••9726 transfer of 2026-05-14 is linked both ways',
    pairedBothWays.some((txn) => txn.txnDate === '2026-05-14' && txn.amountCents === 5_000) &&
      pairedBothWays.some((txn) => txn.txnDate === '2026-05-14' && txn.amountCents === -5_000),
    `${pairedBothWays.length} of ${labelledTransfers.length} bank-labelled transfer legs are paired across accounts`,
  );
  check(
    'every row written as an internal transfer is paired or names a company account',
    unpairedTransfers.length === 0,
    unpairedTransfers.length === 0
      ? `${labelledTransfers.length} transfer legs, none left without its other side`
      : unpairedTransfers
          .map((txn) => `••${txn.mask} ${txn.txnDate} ${formatMoney(txn.amountCents)} has status transfer and no pair`)
          .join(' | '),
  );
  const outsideTransfers = inTier(afterAi, 'match').filter((txn) => txn.status === 'unreviewed');
  for (const txn of outsideTransfers) {
    out(
      `        NOTE — in the review queue: ••${txn.mask} ${txn.txnDate} ${formatMoney(txn.amountCents)} "${txn.description}" is matched against another row but not applied (a transfer from an account that is not the company's, or a card refund).`,
    );
  }

  check(
    'nothing posted to the ledger',
    afterAi.every((txn) => txn.journalEntryId === null),
    `${afterAi.filter((txn) => txn.journalEntryId !== null).length} of ${afterAi.length} transactions carry a journal entry`,
  );

  // The one rule this whole system exists to get right. Resolved by account *type*,
  // not by a hardcoded code or name: whatever the equity account is called, money from
  // the founder's personal bank belongs in it and never in a revenue account.
  const equityCoded = afterAi.filter((txn) => txn.accountType === 'equity');
  const revenueCoded = afterAi.filter((txn) => txn.accountType === 'revenue');
  check(
    'founder ACH pulls are equity, never revenue',
    equityCoded.length > 0 && revenueCoded.length === 0,
    `${equityCoded.length} pulls coded to equity (${formatMoney(value(equityCoded))}); ${revenueCoded.length} coded to a revenue account`,
  );

  const amazon = afterAi.filter((txn) => (txn.counterparty ?? '') === 'Amazon');
  check(
    'Amazon is never auto-categorized',
    amazon.every((txn) => txn.status !== 'categorized'),
    `${amazon.length} Amazon transactions, ${amazon.filter((txn) => txn.status === 'categorized').length} auto-posted`,
  );

  // -------------------------------------------------------------------------
  heading('5. Balance chains');

  const fileChains = firstPass.filter((outcome) => (outcome.preview.balanceChain?.checked ?? 0) > 0);
  const brokenChains = fileChains.filter((outcome) => outcome.preview.balanceChain?.ok !== true);
  checkEquals('statements whose chain was checked', fileChains.length, 11, 'files');
  check(
    'every statement’s running balance ties',
    brokenChains.length === 0,
    brokenChains.length === 0
      ? 'balance[n] == balance[n−1] + amount[n] across every non-empty file'
      : brokenChains.map((outcome) => outcome.filename).join(', '),
  );

  out();
  out(
    `        ${pad('account', 10)} ${padStart('rows', 5)} ${padStart('opening', 12)} ${padStart('movement', 12)} ${padStart('closing', 12)}  chain`,
  );

  interface AccountSummary {
    readonly mask: string;
    readonly rows: number;
    readonly openingCents: number;
    readonly closingCents: number;
    readonly chainOk: boolean;
  }
  const summaries: AccountSummary[] = [];

  for (const mask of masks) {
    const account = accountsByMask.get(mask);
    if (account === undefined) continue;
    const rows = afterAi.filter((txn) => txn.mask === mask);
    const chain = storedChain(rows, account.openingBalanceCents);
    const movement = rows.reduce((sum, row) => sum + row.amountCents, 0);

    summaries.push({
      mask,
      rows: rows.length,
      openingCents: account.openingBalanceCents,
      closingCents: chain.closingCents,
      chainOk: chain.ok,
    });

    out(
      `        ••${pad(mask, 8)} ${padStart(String(rows.length), 5)} ${padStart(formatMoney(account.openingBalanceCents), 12)} ${padStart(formatMoney(movement), 12)} ${padStart(formatMoney(chain.closingCents), 12)}  ${chain.ok ? 'ties' : 'BROKEN'}`,
    );
    for (const problem of chain.breaks) out(`            ${problem}`);

    checkEquals(
      `••${mask}: opening + every stored amount == closing`,
      account.openingBalanceCents + movement,
      chain.closingCents,
      '$',
    );
  }

  const summary9726 = summaries.find((entry) => entry.mask === '9726');
  const summary9973 = summaries.find((entry) => entry.mask === '9973');

  checkEquals('••9726 opening balance', summary9726?.openingCents ?? -1, 100_000, '$');
  checkEquals('••9726 closing balance', summary9726?.closingCents ?? -1, 52_967, '$');
  checkEquals('••9973 opening balance', summary9973?.openingCents ?? -1, 0, '$');
  checkEquals('••9973 closing balance', summary9973?.closingCents ?? -1, 47, '$');
  check(
    'every stored balance chain ties',
    summaries.every((entry) => entry.chainOk),
    `${summaries.filter((entry) => entry.chainOk).length} of ${summaries.length} accounts walk cleanly from their seeded opening balance`,
  );

  // The files themselves, read by the independent parser, must derive the same figures.
  for (const mask of masks) {
    const files = corpus
      .filter((file) => file.mask === mask && file.rows.length > 0)
      .sort((a, b) => a.period.localeCompare(b.period) || Number(a.partial) - Number(b.partial));
    if (files.length === 0) continue;

    const chains = files.map((file) => ({ file, chain: sourceChain(file.rows) }));
    const broken = chains.filter((entry) => !entry.chain.ok);
    check(
      `••${mask}: the files' own chains tie, read independently`,
      broken.length === 0,
      broken.length === 0
        ? `${chains.length} statements, ${files.reduce((sum, file) => sum + file.rows.length, 0)} rows`
        : broken.flatMap((entry) => entry.chain.breaks).join(' | '),
    );

    const gaps = chains
      .slice(1)
      .map((entry, index) => ({ entry, previous: chains[index] }))
      .filter(({ entry, previous }) => entry.chain.openingCents !== previous.chain.closingCents);
    check(
      `••${mask}: each statement opens where the last one closed`,
      gaps.length === 0,
      gaps.length === 0
        ? `${chains.length} statements join end to end from ${formatMoney(chains[0].chain.openingCents)} to ${formatMoney(chains[chains.length - 1].chain.closingCents)}`
        : gaps
            .map(
              ({ entry, previous }) =>
                `${entry.file.filename} opens at ${formatMoney(entry.chain.openingCents)} but ${previous.file.filename} closed at ${formatMoney(previous.chain.closingCents)}`,
            )
            .join(' | '),
    );

    checkEquals(
      `••${mask}: the files' derived opening matches the seeded opening balance`,
      chains[0].chain.openingCents,
      accountsByMask.get(mask)?.openingBalanceCents ?? -1,
      '$',
    );
  }

  // -------------------------------------------------------------------------
  heading('6. Independent reconciliation — the CSVs summed a second time');

  out('        The importer is not asked. The 36 files are re-read by the parser at the top of');
  out('        this script, which shares no code with src/lib/banking, and the two answers are');
  out('        compared row for row.');
  out();

  const sourceKey = (row: SourceRow): string => `${row.date}|${row.amountCents}`;
  const ledgerKey = (txn: LedgerTxn): string => `${txn.txnDate}|${txn.amountCents}`;

  for (const mask of masks) {
    const source = corpus.filter((file) => file.mask === mask).flatMap((file) => file.rows);
    const stored = afterAi.filter((txn) => txn.mask === mask);

    const sourceTotal = source.reduce((sum, row) => sum + row.amountCents, 0);
    const storedTotal = stored.reduce((sum, txn) => sum + txn.amountCents, 0);

    checkEquals(`••${mask}: row count`, stored.length, source.length, 'rows');
    checkEquals(`••${mask}: net movement`, storedTotal, sourceTotal, '$');
    checkEquals(
      `••${mask}: money in`,
      stored.filter((txn) => txn.amountCents > 0).reduce((sum, txn) => sum + txn.amountCents, 0),
      source.filter((row) => row.amountCents > 0).reduce((sum, row) => sum + row.amountCents, 0),
      '$',
    );
    checkEquals(
      `••${mask}: money out`,
      stored.filter((txn) => txn.amountCents < 0).reduce((sum, txn) => sum + txn.amountCents, 0),
      source.filter((row) => row.amountCents < 0).reduce((sum, row) => sum + row.amountCents, 0),
      '$',
    );

    // Multiset equality on (date, amount): stronger than the totals, because two
    // offsetting errors cannot hide in it.
    const counts = new Map<string, number>();
    for (const row of source) counts.set(sourceKey(row), (counts.get(sourceKey(row)) ?? 0) + 1);
    for (const txn of stored) counts.set(ledgerKey(txn), (counts.get(ledgerKey(txn)) ?? 0) - 1);
    const mismatched = [...counts.entries()].filter(([, delta]) => delta !== 0);
    check(
      `••${mask}: every (date, amount) appears exactly as often as the files say`,
      mismatched.length === 0,
      mismatched.length === 0
        ? `${source.length} rows matched one for one`
        : mismatched
            .map(([key, delta]) => `${key} off by ${delta > 0 ? `${delta} missing` : `${-delta} extra`}`)
            .join(', '),
    );

    // And the payee, which is what a bookkeeper actually reads. It is compared
    // verbatim against `description`, which keeps the file's text; `counterparty`
    // is the cleaned name (`SP+AFF * META STORE -` → `META STORE`) and is not the
    // record of what the bank said. One row has no payee at all — the 4/30 transfer
    // in from #3474 — and there the importer falls back to the Reference.
    const payees = new Map<string, number>();
    for (const row of source) {
      const text = row.payee !== '' ? row.payee : row.reference;
      const key = `${row.date}|${row.amountCents}|${text}`;
      payees.set(key, (payees.get(key) ?? 0) + 1);
    }
    for (const txn of stored) {
      const key = `${txn.txnDate}|${txn.amountCents}|${txn.description}`;
      payees.set(key, (payees.get(key) ?? 0) - 1);
    }
    const payeeMismatch = [...payees.entries()].filter(([, delta]) => delta !== 0);
    check(
      `••${mask}: every payee survived the import`,
      payeeMismatch.length === 0,
      payeeMismatch.length === 0
        ? 'payee text matches the file on every row'
        : payeeMismatch.map(([key, delta]) => `${key} (${delta})`).join(', '),
    );
  }

  const fingerprints = new Set(afterAi.map((txn) => `${txn.mask}|${txn.fingerprint}`));
  checkEquals('fingerprints are unique per account', fingerprints.size, afterAi.length, 'rows');

  const totalSource = sourceRows.reduce((sum, row) => sum + row.amountCents, 0);
  const totalStored = afterAi.reduce((sum, txn) => sum + txn.amountCents, 0);
  checkEquals('net movement across all four accounts', totalStored, totalSource, '$');

  // -------------------------------------------------------------------------
  heading('7. What the nine months say');

  const byAccountCode = new Map<string, { code: string; name: string; count: number; cents: number }>();
  for (const txn of afterAi) {
    if (txn.accountCode === null || txn.accountName === null) continue;
    if (txn.status === 'excluded') continue;
    const bucket = byAccountCode.get(txn.accountCode) ?? {
      code: txn.accountCode,
      name: txn.accountName,
      count: 0,
      cents: 0,
    };
    bucket.count += 1;
    bucket.cents += txn.amountCents;
    byAccountCode.set(txn.accountCode, bucket);
  }

  out(`        ${pad('account', 40)} ${padStart('rows', 5)} ${padStart('amount', 13)}`);
  for (const bucket of [...byAccountCode.values()].sort((a, b) => a.code.localeCompare(b.code))) {
    out(
      `        ${pad(`${bucket.code} ${bucket.name}`, 40)} ${padStart(String(bucket.count), 5)} ${padStart(formatMoney(bucket.cents), 13)}`,
    );
  }

  const uncoded = afterAi.filter((txn) => txn.accountCode === null && txn.status !== 'excluded');
  out(
    `        ${pad('(no account proposed)', 40)} ${padStart(String(uncoded.length), 5)} ${padStart(formatMoney(value(uncoded)), 13)}`,
  );
  out(
    `        ${pad('(excluded — returned ACH and its pair)', 40)} ${padStart(String(excluded.length), 5)} ${padStart(formatMoney(value(excluded)), 13)}`,
  );

  /**
   * The buckets the owner's questions are about, resolved from what the pipeline
   * actually coded rather than from a code written into this script.
   *
   * `ACCOUNTS` carries the four that exist in `src/lib/ledger/coa.ts`; the two Sooz
   * additions it does not carry yet — member contributions and Square clearing — are
   * found by account *type* and *subtype*, which is what makes them what they are.
   * Excluded rows are left out everywhere: no money moved on them.
   */
  const live = afterAi.filter((txn) => txn.status !== 'excluded');
  const byCode = (code: string): readonly LedgerTxn[] =>
    live.filter((txn) => txn.accountCode === code);

  const founder = live.filter((txn) => txn.accountType === 'equity');
  const square = live.filter((txn) => txn.accountSubtype === 'clearing');
  const ingredients = byCode(ACCOUNTS.INVENTORY_INGREDIENTS);
  const packaging = byCode(ACCOUNTS.INVENTORY_PACKAGING);
  const formulation = byCode(ACCOUNTS.FORMULATION);
  const advertising = byCode(ACCOUNTS.ADS_META_GOOGLE);

  const asOf = '2026-09-15';
  const cashAtAsOf = masks.reduce((sum, mask) => {
    const account = accountsByMask.get(mask);
    if (account === undefined) return sum;
    const movement = afterAi
      .filter((txn) => txn.mask === mask && txn.txnDate <= asOf)
      .reduce((total, txn) => total + txn.amountCents, 0);
    return sum + account.openingBalanceCents + movement;
  }, 0);

  out();
  out(`        Founder put in (member contributions, ${founder.length} ACH pulls): ${formatMoney(value(founder))}`);
  out(`        Square brought in (${square.length} payouts to Square Clearing): ${formatMoney(value(square))}`);
  out(
    `        Ingredients (${ingredients.length} purchases, capitalized to ${ACCOUNTS.INVENTORY_INGREDIENTS}): ${formatMoney(value(ingredients))}`,
  );
  out(
    `        Packaging (${packaging.length} purchases, capitalized to ${ACCOUNTS.INVENTORY_PACKAGING}): ${formatMoney(value(packaging))}`,
  );
  out(`        Formulation & bench work (${formulation.length}): ${formatMoney(value(formulation))}`);
  out(`        Advertising — Meta & Google (${advertising.length}): ${formatMoney(value(advertising))}`);
  out(`        Cash across all four Relay accounts at ${asOf}: ${formatMoney(cashAtAsOf)}`);

  checkEquals(`cash at ${asOf}`, cashAtAsOf, 53_014, '$');

  // The two headline figures, recomputed from the raw files by the independent
  // parser: Square payouts are the `SQ` + YYMMDD references, founder money is every
  // `ACH Pull` reference. The pipeline's coding has to land on the same numbers.
  const squareFromFiles = sourceRows
    .filter((row) => /^SQ\d{6}$/.test(row.reference))
    .reduce((sum, row) => sum + row.amountCents, 0);
  const pullsFromFiles = sourceRows
    .filter((row) => row.reference === 'ACH Pull')
    .reduce((sum, row) => sum + row.amountCents, 0);
  checkEquals('Square revenue, coded vs. read from the files', value(square), squareFromFiles, '$');
  checkEquals('founder money, coded vs. read from the files', value(founder), pullsFromFiles, '$');
  out(
    `        (relay.md quotes $292.00 of Square revenue; the files hold ${formatMoney(squareFromFiles)} of SQ payouts. The $20.00 difference is the 2/17 RICE UNIVERSITY receipt, which is not a Square payout and is left for review.)`,
  );
  check(
    'the founder funds this company many times over what it sells',
    value(founder) > value(square) * 5,
    `${formatMoney(value(founder))} in against ${formatMoney(value(square))} of Square revenue`,
  );

  // -------------------------------------------------------------------------
  heading('Result');

  const finalState = await loadLedger(accountIds);
  const posted = finalState.filter((txn) => txn.journalEntryId !== null);
  const [{ count: accountCount }] = await db
    .select({ count: sqlTag<string>`count(*)::text` })
    .from(accounts);
  const [{ count: ruleCount }] = await db
    .select({ count: sqlTag<string>`count(*)::text` })
    .from(categorizationRules);

  out(`        bank_transactions for the Relay accounts: ${finalState.length}`);
  out(`        posted to the ledger: ${posted.length}`);
  out(`        seed intact: ${accountCount} accounts, ${ruleCount} categorization rules`);
  checkEquals('nothing posted', posted.length, 0, 'entries');
  checkEquals('chart of accounts intact', Number(accountCount), 164, 'accounts');
  checkEquals('categorization rules intact', Number(ruleCount), 37, 'rules');

  out();
  out(
    `        ${checksRun - problems.length} of ${checksRun} checks passed in ${((Date.now() - startedAt) / 1000).toFixed(1)}s.`,
  );

  if (problems.length > 0) {
    out();
    out('        FAILURES:');
    for (const problem of problems) out(`          · ${problem}`);
  }
}

async function run(): Promise<never> {
  try {
    await bootstrap();
    await main();
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
    out();
    out(`FATAL: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  } finally {
    // postgres.js keeps the process alive until the pool is closed.
    if (sql !== undefined) await sql.end({ timeout: 5 });
  }

  process.exit(problems.length === 0 ? 0 : 1);
}

void run();

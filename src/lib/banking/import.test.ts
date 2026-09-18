/**
 * Import orchestration, against the live database.
 *
 * These tests write real rows, because everything worth protecting here lives in
 * the database: the partial unique index that lets a preview be abandoned, the
 * unique index on `(bank_account_id, fingerprint)` that is the last word on
 * duplicates, the audit triggers, and the seeded rules that decide a founder's
 * ACH pull is equity rather than revenue.
 *
 * Everything inserted is cleaned up. The suite creates **one** throwaway bank
 * account bound to the seeded `1030 Petty Cash` GL account, imports into that,
 * and deletes its own transactions and batches after every test. It never writes
 * to `accounts`, never touches the four real Relay bank accounts, and never
 * modifies a seeded rule, vendor or profile.
 *
 * The headline is `the (Partial) problem`. Sooz will hit it every single month:
 * a month is downloaded while it is still open, then downloaded again once it
 * closes, and the overlap has to cost exactly nothing.
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

/**
 * Vitest does not run through Next.js, so nothing else reads `.env.local`. This
 * has to happen in the module body, before anything reaches for `@/db/client` —
 * which is why every database handle below is behind a dynamic import.
 */
function loadEnvLocal(): void {
  if (process.env.DATABASE_URL) return;
  const path = fileURLToPath(new URL('../../../.env.local', import.meta.url));
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const value = match[2].trim().replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[match[1]] === undefined) process.env[match[1]] = value;
  }
}

loadEnvLocal();

// These tests never call a real model. The AI tier is exercised with an injected
// stub below; with no key in the environment, every other commit records that AI
// was skipped and carries on on rules alone — which is itself behaviour under test.
delete process.env.ANTHROPIC_API_KEY;
delete process.env.AI_GATEWAY_API_KEY;

import { APICallError } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';

import { GENERIC_IMPORTER_ID } from '@/lib/importers/generic';
import { RELAY_HEADER } from '@/lib/importers/relay';

import { RELAY_DIR, fixtureBytes } from './__fixtures__/support';
import {
  ImportError,
  cancelPreview,
  commitImport,
  isUniqueViolation,
  previewImport,
  saveImportProfile,
  statementStoragePath,
  type ImportDecision,
  type ImportPreview,
  type StatementStorage,
} from './import';

// ---------------------------------------------------------------------------
// Scaffolding
// ---------------------------------------------------------------------------

/** Names the throwaway account unmistakably, so a leaked row is obvious and easy to find. */
const TEST_ACCOUNT_NAME = 'TEST — import.test.ts throwaway (safe to delete)';
/** The GL account the throwaway binds to. Seeded, unused by any real bank account, never written to. */
const PETTY_CASH = '1030';

let bankAccountId = '';

/**
 * `commitImport` records which rules fired, which is the behaviour being tested
 * and also the one thing here that touches seeded data. The counters are
 * snapshotted before the suite and put back afterwards, so a test run leaves the
 * owner's rule statistics exactly as it found them.
 */
interface RuleHits {
  readonly id: string;
  readonly hit_count: number;
  readonly last_hit_at: string | null;
}
let ruleHitsBefore: RuleHits[] = [];

type DbClient = typeof import('@/db/client');
let clientPromise: Promise<DbClient> | undefined;
function client(): Promise<DbClient> {
  clientPromise ??= import('@/db/client');
  return clientPromise;
}

/** A storage adapter that keeps the bytes in this process. */
function memoryStorage(): StatementStorage & { readonly files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>();
  return {
    bucket: 'memory',
    files,
    async put(path, bytes) {
      files.set(path, Uint8Array.from(bytes));
    },
    async get(path) {
      const bytes = files.get(path);
      if (bytes === undefined) throw new Error(`nothing stored at ${path}`);
      return bytes;
    },
  };
}

function relayBytes(filename: string): Buffer {
  return readFileSync(`${RELAY_DIR}/${filename}`);
}

const SEPT_PARTIAL = 'Relay (Partial) 2026-09-01 #9726.csv';

/**
 * Timeouts, because the database is a real one across the network.
 *
 * One preview-and-commit is roughly a dozen round trips to Supabase's pooler.
 * Vitest's 5 s default is generous for a pure function and far too tight for a
 * test that imports nine months of statements, and a timeout here would look
 * like a bug in the importer rather than what it is.
 */
const ONE_IMPORT = 30_000;
const MANY_IMPORTS = 240_000;

/**
 * A synthetic complete September for ••9726, built on the real partial export.
 *
 * This is the file Relay will actually produce once the month closes: the same
 * thirteen rows, plus everything that happened after the 15th, with the running
 * balance carried on from 529.67. It is synthetic only because today is the 17th
 * and September has not closed yet.
 */
function septemberFullMonth(): { filename: string; bytes: Buffer } {
  const partial = relayBytes(SEPT_PARTIAL).toString('utf8').replace(/\r\n/g, '\n').trimEnd();
  const [header, ...body] = partial.split('\n');

  const later = [
    '9/28/2026,Relay,,Spend,,"Banking Fees",SETTLED,-8.00,USD,538.77',
    '9/22/2026,Square Inc,,Receive,,"SQ260922",SETTLED,+42.10,USD,546.77',
    '9/18/2026,Amazon,,Spend,Unknown,"Corporate Card - 1892 (Business Card)",SETTLED,-25.00,USD,504.67',
  ];

  return {
    filename: 'Relay 2026-09-01 #9726.csv',
    bytes: Buffer.from([header, ...later, ...body].join('\n') + '\n', 'utf8'),
  };
}

function csv(filename: string, rows: readonly string[]): { filename: string; bytes: Buffer } {
  return {
    filename,
    bytes: Buffer.from([RELAY_HEADER.join(','), ...rows].join('\n') + '\n', 'utf8'),
  };
}

async function preview(
  file: { filename: string; bytes: Buffer },
  storage: StatementStorage | null = null,
): Promise<ImportPreview> {
  return previewImport({
    bankAccountId,
    filename: file.filename,
    bytes: file.bytes,
    userId: null,
    storage,
  });
}

async function importFile(
  file: { filename: string; bytes: Buffer },
  decisions?: readonly ImportDecision[],
) {
  const previewed = await preview(file);
  const committed = await commitImport({
    batchId: previewed.batchId,
    userId: null,
    bytes: file.bytes,
    ...(decisions === undefined ? {} : { decisions }),
  });
  return { preview: previewed, commit: committed };
}

interface StoredTxn {
  readonly id: string;
  readonly txn_date: string;
  readonly description: string;
  readonly amount_cents: string;
  readonly fingerprint: string;
  readonly status: string;
  readonly transfer_pair_id: string | null;
  readonly suggested_account_code: string | null;
  readonly suggestion_source: string | null;
  readonly suggestion_confidence: string | null;
  readonly rule_name: string | null;
}

async function storedTransactions(): Promise<StoredTxn[]> {
  const { sql } = await client();
  return sql<StoredTxn[]>`
    select t.id, t.txn_date::text, t.description, t.amount_cents::text, t.fingerprint,
           t.status::text, t.transfer_pair_id,
           a.code as suggested_account_code,
           t.suggestion_source::text, t.suggestion_confidence::text,
           r.name as rule_name
      from bank_transactions t
      left join accounts a on a.id = t.suggested_account_id
      left join categorization_rules r on r.id = t.rule_id
     where t.bank_account_id = ${bankAccountId}
     order by t.txn_date, t.amount_cents, t.id`;
}

async function storedBatches(): Promise<
  Array<{
    id: string;
    status: string;
    filename: string;
    row_count: number;
    imported_count: number;
    duplicate_count: number;
    skipped_count: number;
    storage_path: string | null;
    period_start: string | null;
    period_end: string | null;
  }>
> {
  const { sql } = await client();
  return sql`
    select id, status::text, filename, row_count, imported_count, duplicate_count,
           skipped_count, storage_path, period_start::text, period_end::text
      from import_batches
     where bank_account_id = ${bankAccountId}
     order by created_at`;
}

beforeAll(async () => {
  expect(
    process.env.DATABASE_URL,
    'these tests run against the live database; DATABASE_URL must be set',
  ).toBeTruthy();

  const { sql } = await client();

  // A previous crashed run could have left one behind. Clear it first so the
  // unique key on bank_accounts.account_id never turns a retry into a failure.
  await sql`delete from bank_transactions
             where bank_account_id in (select id from bank_accounts where name = ${TEST_ACCOUNT_NAME})`;
  await sql`delete from import_batches
             where bank_account_id in (select id from bank_accounts where name = ${TEST_ACCOUNT_NAME})`;
  await sql`delete from bank_accounts where name = ${TEST_ACCOUNT_NAME}`;

  const [created] = await sql<Array<{ id: string }>>`
    insert into bank_accounts (account_id, name, institution, kind, mask,
                               statement_sign, opening_balance_cents, opening_date, active)
    select id, ${TEST_ACCOUNT_NAME}, 'Relay (test)', 'checking', '9726',
           1, 0, '2026-01-01', false
      from accounts where code = ${PETTY_CASH}
    returning id`;

  expect(created, `the seeded GL account ${PETTY_CASH} must exist`).toBeDefined();
  bankAccountId = created.id;

  ruleHitsBefore = await sql<RuleHits[]>`
    select id, hit_count, last_hit_at::text from categorization_rules`;
});

afterEach(async () => {
  const { sql } = await client();
  await sql`delete from bank_transactions where bank_account_id = ${bankAccountId}`;
  await sql`delete from import_batches where bank_account_id = ${bankAccountId}`;
});

afterAll(async () => {
  if (clientPromise === undefined) return;
  const { sql } = await clientPromise;

  if (bankAccountId !== '') {
    await sql`delete from bank_transactions where bank_account_id = ${bankAccountId}`;
    await sql`delete from import_batches where bank_account_id = ${bankAccountId}`;
    await sql`delete from bank_accounts where id = ${bankAccountId}`;
  }

  if (ruleHitsBefore.length > 0) {
    await sql`
      update categorization_rules r
         set hit_count   = v.hit_count,
             last_hit_at = v.last_hit_at
        from (select * from unnest(
                ${sql.array(ruleHitsBefore.map((row) => row.id))}::uuid[],
                ${sql.array(ruleHitsBefore.map((row) => row.hit_count))}::integer[],
                ${sql.array(ruleHitsBefore.map((row) => row.last_hit_at))}::timestamptz[]
              ) as t(id, hit_count, last_hit_at)) v
       where r.id = v.id
         and (r.hit_count, r.last_hit_at) is distinct from (v.hit_count, v.last_hit_at)`;
  }

  await sql.end({ timeout: 5 });
});

// ---------------------------------------------------------------------------
// The (Partial) problem
// ---------------------------------------------------------------------------

describe('the (Partial) problem', () => {
  it('imports a partial month, then the full month, and creates zero duplicates', async () => {
    // --- 1. the month as it stands on the 15th ------------------------------
    const partial = { filename: SEPT_PARTIAL, bytes: relayBytes(SEPT_PARTIAL) };
    const first = await importFile(partial);

    expect(first.preview.counts.total).toBe(13);
    expect(first.preview.counts.new).toBe(13);
    expect(first.preview.counts.duplicate).toBe(0);
    expect(first.preview.balanceChain?.ok).toBe(true);
    expect(first.commit.status).toBe('imported');
    expect(first.commit.inserted).toBe(13);
    expect(first.commit.conflicts).toBe(0);
    expect(await storedTransactions()).toHaveLength(13);

    // --- 2. the same month, downloaded again once it closed -----------------
    const full = septemberFullMonth();
    const second = await preview(full);

    expect(second.counts.total).toBe(16);
    // Every row the partial already contributed is recognised, and only the
    // three that happened after the 15th are new.
    expect(second.counts.duplicate).toBe(13);
    expect(second.counts.new).toBe(3);
    expect(second.blocked).toBe(false);
    expect(second.balanceChain?.ok).toBe(true);

    const duplicated = second.rows.filter((row) => row.class === 'duplicate');
    expect(duplicated).toHaveLength(13);
    // Each one is pointed at the transaction it duplicates, not merely counted.
    expect(duplicated.every((row) => row.existingTxnId !== null)).toBe(true);

    const committed = await commitImport({
      batchId: second.batchId,
      userId: null,
      bytes: full.bytes,
    });

    expect(committed.inserted).toBe(3);
    expect(committed.duplicates).toBe(13);
    expect(committed.conflicts).toBe(0);

    // --- 3. the ledger holds sixteen transactions, not twenty-nine ----------
    const rows = await storedTransactions();
    expect(rows).toHaveLength(16);
    expect(new Set(rows.map((row) => row.fingerprint)).size).toBe(16);

    // And the three genuinely new ones are exactly the post-15th rows.
    const added = rows.filter((row) => row.txn_date > '2026-09-15');
    expect(added.map((row) => `${row.txn_date} ${row.description}`).sort()).toEqual([
      '2026-09-18 Amazon',
      '2026-09-22 Square Inc',
      '2026-09-28 Relay',
    ]);
  }, ONE_IMPORT);

  it('re-importing the identical file writes nothing and does not raise', async () => {
    const partial = { filename: SEPT_PARTIAL, bytes: relayBytes(SEPT_PARTIAL) };
    await importFile(partial);

    const again = await preview(partial);
    expect(again.counts.new).toBe(0);
    expect(again.counts.duplicate).toBe(13);
    // The file hash is the cheapest layer and it fires first.
    expect(again.priorImport).not.toBeNull();
    expect(again.priorImport?.importedCount).toBe(13);

    const committed = await commitImport({
      batchId: again.batchId,
      userId: null,
      bytes: partial.bytes,
    });

    // A whole-file duplicate is an outcome, not an exception.
    expect(committed.status).toBe('cancelled');
    expect(committed.inserted).toBe(0);
    expect(committed.issues[0].code).toBe('file.already_imported');
    expect(await storedTransactions()).toHaveLength(13);
  }, ONE_IMPORT);

  it('inserts only the missing occurrence when a day gains a second identical charge', async () => {
    const day = [
      '1/28/2026,Target,,Spend,Unknown,"Corporate Card - 1892 (Business Card)",SETTLED,-8.19,USD,91.81',
      '1/27/2026,Square Inc,,Receive,,"SQ260127",SETTLED,+13.81,USD,100.00',
    ];
    const bothCharges = [
      '1/28/2026,Target,,Spend,Unknown,"Corporate Card - 1892 (Business Card)",SETTLED,-8.19,USD,83.62',
      ...day,
    ];

    const first = await importFile(csv('Relay (Partial) 2026-01-01 #9726.csv', day));
    expect(first.commit.inserted).toBe(2);

    // The full month has both Target charges. One is already in the ledger; the
    // other is a genuine second transaction, not a duplicate of the first.
    const second = await importFile(csv('Relay 2026-01-01 #9726.csv', bothCharges));
    expect(second.preview.counts.duplicate).toBe(2);
    expect(second.preview.counts.new).toBe(1);
    expect(second.commit.inserted).toBe(1);

    const targets = (await storedTransactions()).filter((row) => row.description === 'Target');
    expect(targets).toHaveLength(2);
    expect(new Set(targets.map((row) => row.fingerprint)).size).toBe(2);
  }, ONE_IMPORT);

  it('counts a row the unique index catches rather than failing the import', async () => {
    const file = csv('Relay 2026-01-01 #9726.csv', [
      '1/27/2026,Square Inc,,Receive,,"SQ260127",SETTLED,+13.81,USD,100.00',
    ]);

    // Two previews of the same file, then commit both. The second one's
    // classification believes its row is new — it was, when the preview ran — and
    // the unique index is what makes the truth stick.
    const a = await preview(file);
    const b = await preview(file);

    await commitImport({ batchId: a.batchId, userId: null, bytes: file.bytes });

    const second = await commitImport({ batchId: b.batchId, userId: null, bytes: file.bytes });
    // The file hash layer catches this one first, which is the cheaper answer.
    expect(second.status).toBe('cancelled');
    expect(second.inserted).toBe(0);
    expect(await storedTransactions()).toHaveLength(1);
  }, ONE_IMPORT);
});

// ---------------------------------------------------------------------------
// Previews write nothing
// ---------------------------------------------------------------------------

describe('a preview', () => {
  it('writes only its own batch row', async () => {
    const previewed = await preview({ filename: SEPT_PARTIAL, bytes: relayBytes(SEPT_PARTIAL) });

    expect(await storedTransactions()).toHaveLength(0);
    const batches = await storedBatches();
    expect(batches).toHaveLength(1);
    expect(batches[0].id).toBe(previewed.batchId);
    expect(batches[0].status).toBe('preview');
    expect(batches[0].row_count).toBe(13);
    expect(batches[0].period_start).toBe('2026-09-01');
    expect(batches[0].period_end).toBe('2026-09-15');
  }, ONE_IMPORT);

  it('can be abandoned and the same file previewed again', async () => {
    const file = { filename: SEPT_PARTIAL, bytes: relayBytes(SEPT_PARTIAL) };

    const first = await preview(file);
    const second = await preview(file);
    const third = await preview(file);

    // The file-hash unique index is partial — `where status = 'imported'` — so
    // three abandoned previews of one file coexist without complaint.
    expect(new Set([first.batchId, second.batchId, third.batchId]).size).toBe(3);
    expect((await storedBatches()).every((batch) => batch.status === 'preview')).toBe(true);

    await cancelPreview(first.batchId, null);
    await cancelPreview(second.batchId, null);

    const committed = await commitImport({
      batchId: third.batchId,
      userId: null,
      bytes: file.bytes,
    });
    expect(committed.inserted).toBe(13);

    const batches = await storedBatches();
    expect(batches.filter((b) => b.status === 'cancelled')).toHaveLength(2);
    expect(batches.filter((b) => b.status === 'imported')).toHaveLength(1);
  }, ONE_IMPORT);

  it('refuses to commit a batch twice', async () => {
    const file = { filename: SEPT_PARTIAL, bytes: relayBytes(SEPT_PARTIAL) };
    const previewed = await preview(file);
    await commitImport({ batchId: previewed.batchId, userId: null, bytes: file.bytes });

    await expect(
      commitImport({ batchId: previewed.batchId, userId: null, bytes: file.bytes }),
    ).rejects.toThrow(/already been imported/);
  }, ONE_IMPORT);

  it('refuses bytes that are not the bytes it previewed', async () => {
    const file = { filename: SEPT_PARTIAL, bytes: relayBytes(SEPT_PARTIAL) };
    const previewed = await preview(file);

    await expect(
      commitImport({
        batchId: previewed.batchId,
        userId: null,
        bytes: septemberFullMonth().bytes,
      }),
    ).rejects.toThrow(/not the file that was previewed/);
  }, ONE_IMPORT);
});

// ---------------------------------------------------------------------------
// Header-only files
// ---------------------------------------------------------------------------

describe('a header-only statement', () => {
  it('is a valid import of zero rows', async () => {
    const file = csv('Relay 2026-06-01 #9726.csv', []);
    const { preview: previewed, commit } = await importFile(file);

    expect(previewed.counts.total).toBe(0);
    expect(previewed.blocked).toBe(false);
    expect(previewed.dateRange).toBeNull();
    expect(previewed.issues.some((issue) => issue.code === 'file.no_data_rows')).toBe(true);
    expect(previewed.issues.every((issue) => issue.severity !== 'fatal')).toBe(true);
    expect(previewed.issueCounts.fatal).toBe(0);
    expect(previewed.issueCounts.error).toBe(0);

    expect(commit.status).toBe('imported');
    expect(commit.inserted).toBe(0);
    expect(await storedTransactions()).toHaveLength(0);
    expect((await storedBatches())[0].status).toBe('imported');
  }, ONE_IMPORT);
});

// ---------------------------------------------------------------------------
// Categorization
// ---------------------------------------------------------------------------

describe('what the review queue is handed', () => {
  it('books the founder’s ACH pulls to Member Contributions, never to revenue', async () => {
    await importFile({ filename: SEPT_PARTIAL, bytes: relayBytes(SEPT_PARTIAL) });

    const pulls = (await storedTransactions()).filter(
      (row) =>
        row.description === 'CHASE COLLEGE' || row.description === 'Adv SafeBalance Banking',
    );

    expect(pulls).toHaveLength(3);
    expect(pulls.map((row) => Number(row.amount_cents)).sort((a, b) => a - b)).toEqual([
      10000, 100000, 200000,
    ]);
    // 3015 Member Contributions. Booking these as income would overstate a
    // pre-launch company's revenue by roughly twenty times.
    expect(pulls.every((row) => row.suggested_account_code === '3015')).toBe(true);
    expect(pulls.every((row) => row.suggestion_source === 'rule')).toBe(true);
    expect(pulls.every((row) => row.status === 'categorized')).toBe(true);
  }, ONE_IMPORT);

  it('routes ingredients and packaging to inventory, and freight to its own account', async () => {
    await importFile({ filename: SEPT_PARTIAL, bytes: relayBytes(SEPT_PARTIAL) });
    const byPayee = new Map((await storedTransactions()).map((row) => [row.description, row]));

    for (const payee of [
      'Blue Pacific Flavors',
      'Jedwards International Inc.',
      'LAB ALLEY LLC',
      'Bulk Supplement',
      'SP PURIVA NUTRITION',
      'INGREDI COMPANY LLC',
      'AMCO',
    ]) {
      expect(byPayee.get(payee)?.suggested_account_code, payee).toBe('1320');
      // Suggested, never applied: an ingredient bought pre-launch may be
      // inventory or may be bench work, and only a human knows which.
      expect(byPayee.get(payee)?.status, payee).toBe('unreviewed');
    }

    expect(byPayee.get('FEDEX533300619')?.suggested_account_code).toBe('5510');
  }, ONE_IMPORT);

  it('auto-posts only what the owner marked auto_post', async () => {
    const { preview: previewed } = await importFile({
      filename: SEPT_PARTIAL,
      bytes: relayBytes(SEPT_PARTIAL),
    });

    // Two Relay banking-fee rows and three ACH pulls: five rules the owner
    // explicitly trusted. Nothing else in the month may skip the queue.
    expect(previewed.counts.autoPost).toBe(5);

    const rows = await storedTransactions();
    const categorized = rows.filter((row) => row.status === 'categorized');
    expect(categorized).toHaveLength(5);
    expect(new Set(categorized.map((row) => row.suggested_account_code))).toEqual(
      new Set(['6710', '3015']),
    );
    expect(rows.filter((row) => row.status === 'unreviewed')).toHaveLength(8);

    // Nothing reached the ledger: that is a later phase's job and it needs a human.
    const { sql } = await client();
    const [{ count }] = await sql<Array<{ count: string }>>`
      select count(*)::text as count from bank_transactions
       where bank_account_id = ${bankAccountId} and journal_entry_id is not null`;
    expect(count).toBe('0');
  }, ONE_IMPORT);

  it('parks Amazon for a per-transaction AI business default and a human, never auto-posting it', async () => {
    const file = septemberFullMonth();
    await importFile(file);

    const amazon = (await storedTransactions()).find((row) => row.description === 'Amazon');
    expect(amazon).toBeDefined();
    // The rule parks the row in 7900 so the AI tier, which sees the amount and the date,
    // proposes a business account per transaction. With no model it stays parked.
    expect(amazon?.suggested_account_code).toBe('7900');
    expect(amazon?.status).toBe('unreviewed');
    expect(amazon?.rule_name).toBe('Amazon — business default via AI, always review');
  }, ONE_IMPORT);

  it('records the confidence and the reasoning behind every suggestion', async () => {
    await importFile({ filename: SEPT_PARTIAL, bytes: relayBytes(SEPT_PARTIAL) });
    const rows = await storedTransactions();

    for (const row of rows) {
      expect(row.suggestion_confidence, row.description).not.toBeNull();
      const confidence = Number(row.suggestion_confidence);
      expect(confidence, row.description).toBeGreaterThan(0);
      expect(confidence, row.description).toBeLessThanOrEqual(1);
    }

    const { sql } = await client();
    const reasoned = await sql<Array<{ suggestion_reasoning: string }>>`
      select suggestion_reasoning from bank_transactions
       where bank_account_id = ${bankAccountId} and suggestion_reasoning is not null`;
    expect(reasoned).toHaveLength(rows.length);
  }, ONE_IMPORT);
});

// ---------------------------------------------------------------------------
// Returned ACH
// ---------------------------------------------------------------------------

describe('a returned ACH', () => {
  it('is imported, excluded from posting and linked to the row that cancels it', async () => {
    const file = { filename: 'Relay 2026-05-01 #9726.csv', bytes: relayBytes('Relay 2026-05-01 #9726.csv') };
    const { preview: previewed, commit } = await importFile(file);

    expect(previewed.counts.excluded).toBe(2);
    expect(commit.returnedPairsLinked).toBe(2);

    const google = (await storedTransactions()).filter(
      (row) => row.description === 'GOOGLE' && row.txn_date === '2026-05-15',
    );

    expect(google).toHaveLength(2);
    expect(google.every((row) => row.status === 'excluded')).toBe(true);
    expect(google.map((row) => Number(row.amount_cents)).sort((a, b) => a - b)).toEqual([
      -1000, 1000,
    ]);

    // Each points at the other: the pair nets to zero and no money moved.
    const [out, back] = [google[0], google[1]];
    expect(out.transfer_pair_id).toBe(back.id);
    expect(back.transfer_pair_id).toBe(out.id);
  }, ONE_IMPORT);
});

// ---------------------------------------------------------------------------
// Internal transfers across two statements
// ---------------------------------------------------------------------------

describe('an internal transfer between two Relay accounts', () => {
  /**
   * Relay writes each leg of a transfer in a different account's statement, so the
   * leg imported second has to find the first one in the ledger. These rows are
   * synthetic and dated October 2026, after every real statement, with an amount no
   * real transaction has, so the pairing can only ever find its own other leg.
   */
  const OTHER_ACCOUNT_NAME = 'TEST — import.test.ts transfer counterpart (safe to delete)';
  const OTHER_GL = '1020';

  async function withCounterpartAccount(
    run: (otherId: string) => Promise<void>,
  ): Promise<void> {
    const { sql } = await client();
    await sql`delete from bank_transactions
               where bank_account_id in (select id from bank_accounts where name = ${OTHER_ACCOUNT_NAME})`;
    await sql`delete from import_batches
               where bank_account_id in (select id from bank_accounts where name = ${OTHER_ACCOUNT_NAME})`;
    await sql`delete from bank_accounts where name = ${OTHER_ACCOUNT_NAME}`;

    const [other] = await sql<Array<{ id: string }>>`
      insert into bank_accounts (account_id, name, institution, kind, mask,
                                 statement_sign, opening_balance_cents, opening_date, active)
      select id, ${OTHER_ACCOUNT_NAME}, 'Relay (test)', 'checking', '9973',
             1, 0, '2026-01-01', false
        from accounts where code = ${OTHER_GL}
      returning id`;
    expect(other, `the seeded GL account ${OTHER_GL} must exist`).toBeDefined();

    try {
      await run(other.id);
    } finally {
      // The two legs point at each other across accounts; unlink before deleting.
      await sql`update bank_transactions set transfer_pair_id = null
                 where bank_account_id in (${bankAccountId}, ${other.id})`;
      await sql`delete from bank_transactions where bank_account_id = ${other.id}`;
      await sql`delete from import_batches where bank_account_id = ${other.id}`;
      await sql`delete from bank_accounts where id = ${other.id}`;
    }
  }

  async function importInto(accountId: string, file: { filename: string; bytes: Buffer }) {
    const previewed = await previewImport({
      bankAccountId: accountId,
      filename: file.filename,
      bytes: file.bytes,
      userId: null,
      storage: null,
    });
    expect(previewed.blocked, file.filename).toBe(false);
    return commitImport({ batchId: previewed.batchId, userId: null, bytes: file.bytes });
  }

  it('links the second leg to the first leg already in the ledger, both ways', async () => {
    await withCounterpartAccount(async (otherId) => {
      // ••9726 receives first; its statement is imported before ••9973's.
      const first = await importInto(
        bankAccountId,
        csv('Relay 2026-10-01 #9726.csv', [
          '10/6/2026,Owner\'s Comp,9973,Receive-transfer,,"Transfer",SETTLED,+12.34,USD,12.34',
        ]),
      );
      expect(first.inserted).toBe(1);
      expect(first.transferPairsLinked).toBe(0);

      const second = await importInto(
        otherId,
        csv('Relay 2026-10-01 #9973.csv', [
          '10/6/2026,Operating Expenses,9726,Spend-transfer,,"Transfer",SETTLED,-12.34,USD,0.00',
          '10/5/2026,Adv SafeBalance Banking,,Receive,,"ACH Pull",SETTLED,+12.34,USD,12.34',
        ]),
      );
      expect(second.inserted).toBe(2);
      expect(second.transferPairsLinked).toBe(1);

      const { sql } = await client();
      const legs = await sql<Array<{ id: string; amount_cents: string; status: string; transfer_pair_id: string | null }>>`
        select id, amount_cents::text, status::text, transfer_pair_id
          from bank_transactions
         where bank_account_id in (${bankAccountId}, ${otherId})
           and txn_date = '2026-10-06'
         order by amount_cents`;

      expect(legs).toHaveLength(2);
      const [out, into] = legs;
      expect(Number(out.amount_cents)).toBe(-1234);
      expect(Number(into.amount_cents)).toBe(1234);
      expect(legs.every((leg) => leg.status === 'transfer')).toBe(true);
      expect(out.transfer_pair_id).toBe(into.id);
      expect(into.transfer_pair_id).toBe(out.id);
    });
  }, ONE_IMPORT * 2);

  it('never writes an unlabelled look-alike as a transfer', async () => {
    await withCounterpartAccount(async (otherId) => {
      // Equal, opposite, same day, two accounts — and neither labelled a transfer.
      // The payee matches no rule and no vendor, so the amount-and-date guess is
      // the only suggestion the outgoing leg gets: shown, never applied.
      await importInto(
        bankAccountId,
        csv('Relay 2026-10-01 #9726.csv', [
          '10/7/2026,Adv SafeBalance Banking,,Receive,,"ACH Pull",SETTLED,+43.21,USD,43.21',
        ]),
      );
      const second = await importInto(
        otherId,
        csv('Relay 2026-10-01 #9973.csv', [
          '10/7/2026,Zqx Test Payee,,Spend,,"Zqx test reference",SETTLED,-43.21,USD,0.00',
          '10/6/2026,Adv SafeBalance Banking,,Receive,,"ACH Pull",SETTLED,+43.21,USD,43.21',
        ]),
      );
      expect(second.transferPairsLinked).toBe(0);

      const { sql } = await client();
      const rows = await sql<Array<{ status: string; transfer_pair_id: string | null }>>`
        select status::text, transfer_pair_id
          from bank_transactions
         where bank_account_id in (${bankAccountId}, ${otherId})`;
      expect(rows.some((row) => row.status === 'transfer')).toBe(false);
      expect(rows.every((row) => row.transfer_pair_id === null)).toBe(true);
    });
  }, ONE_IMPORT * 2);
});

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

describe('the decisions a human makes', () => {
  it('leaves a skipped row out of the ledger and counts it', async () => {
    const previewed = await preview({ filename: SEPT_PARTIAL, bytes: relayBytes(SEPT_PARTIAL) });
    const amco = previewed.rows.find((row) => row.description === 'AMCO');
    expect(amco).toBeDefined();

    const committed = await commitImport({
      batchId: previewed.batchId,
      userId: null,
      bytes: relayBytes(SEPT_PARTIAL),
      decisions: [{ rowIndex: amco!.rowIndex, action: 'skip' }],
    });

    expect(committed.inserted).toBe(12);
    expect(committed.skipped).toBe(1);
    const rows = await storedTransactions();
    expect(rows).toHaveLength(12);
    expect(rows.some((row) => row.description === 'AMCO')).toBe(false);
  }, ONE_IMPORT);

  it('applies an override in place of the suggestion', async () => {
    const previewed = await preview({ filename: SEPT_PARTIAL, bytes: relayBytes(SEPT_PARTIAL) });
    const blue = previewed.rows.find((row) => row.description === 'Blue Pacific Flavors');
    expect(blue?.suggestion?.accountId).toBeTruthy();

    const { sql } = await client();
    const [formulation] = await sql<Array<{ id: string }>>`
      select id from accounts where code = '6310'`;

    await commitImport({
      batchId: previewed.batchId,
      userId: null,
      bytes: relayBytes(SEPT_PARTIAL),
      decisions: [
        {
          rowIndex: blue!.rowIndex,
          accountId: formulation.id,
          memo: 'Consumed in bench work, not held for sale',
          status: 'categorized',
        },
      ],
    });

    const stored = (await storedTransactions()).find(
      (row) => row.description === 'Blue Pacific Flavors',
    );
    // 6310 Formulation & Bench Work, not the rule's 1320 Raw Ingredients.
    expect(stored?.suggested_account_code).toBe('6310');
    expect(stored?.status).toBe('categorized');
  }, ONE_IMPORT);
});

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

describe('what the orchestrator refuses', () => {
  it('blocks a file whose balance chain does not tie, at preview and at commit', async () => {
    const file = csv('Relay 2026-01-01 #9726.csv', [
      '1/28/2026,Target,,Spend,Unknown,"Corporate Card - 1892 (Business Card)",SETTLED,-8.19,USD,83.62',
      '1/26/2026,Square Inc,,Receive,,"SQ260126",SETTLED,+13.81,USD,100.00',
    ]);

    const previewed = await preview(file);
    expect(previewed.blocked).toBe(true);
    expect(previewed.balanceChain?.ok).toBe(false);
    expect(previewed.issues.some((issue) => issue.code === 'balance.chain_broken')).toBe(true);
    // The whole file is still shown, so the bookkeeper can see what broke.
    expect(previewed.rows).toHaveLength(2);

    await expect(
      commitImport({ batchId: previewed.batchId, userId: null, bytes: file.bytes }),
    ).rejects.toThrow(/cannot be imported/);
    expect(await storedTransactions()).toHaveLength(0);
  }, ONE_IMPORT);

  it('blocks one Relay account’s statement imported into another', async () => {
    const other = 'Relay 2026-02-01 #9973.csv';
    const previewed = await preview({ filename: other, bytes: relayBytes(other) });

    expect(previewed.blocked).toBe(true);
    const issue = previewed.issues.find((i) => i.code === 'relay.account_mismatch');
    expect(issue?.severity).toBe('fatal');

    await expect(
      commitImport({ batchId: previewed.batchId, userId: null, bytes: relayBytes(other) }),
    ).rejects.toThrow(ImportError);
    expect(await storedTransactions()).toHaveLength(0);
  }, ONE_IMPORT);

  it('refuses a file it does not recognise, without creating a batch', async () => {
    await expect(
      previewImport({
        bankAccountId,
        filename: 'ledger.csv',
        bytes: Buffer.from('a,b,c\n1,2,3\n', 'utf8'),
        userId: null,
        storage: null,
      }),
    ).rejects.toThrow(ImportError);

    expect(await storedBatches()).toHaveLength(0);
  }, ONE_IMPORT);

  it('refuses a Relay file that has been through Excel', async () => {
    await expect(
      previewImport({
        bankAccountId,
        filename: 'Relay 2026-01-01 #9726.csv',
        bytes: Buffer.from('Date,Payee,Amount\n1/2/2026,Target,-8.19\n', 'utf8'),
        userId: null,
        storage: null,
      }),
    ).rejects.toThrow(/columns are not Relay/);
  }, ONE_IMPORT);

  it('names an unknown bank account rather than failing obscurely', async () => {
    await expect(
      previewImport({
        bankAccountId: '00000000-0000-4000-8000-000000000000',
        filename: SEPT_PARTIAL,
        bytes: relayBytes(SEPT_PARTIAL),
        userId: null,
        storage: null,
      }),
    ).rejects.toThrow(/No bank account with id/);
  }, ONE_IMPORT);
});

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

describe('the statement archive', () => {
  it('stores the upload, records the path, and commits from it without the bytes', async () => {
    const storage = memoryStorage();
    const file = { filename: SEPT_PARTIAL, bytes: relayBytes(SEPT_PARTIAL) };

    const previewed = await preview(file, storage);
    const expectedPath = statementStoragePath(bankAccountId, previewed.fileHash, SEPT_PARTIAL);

    expect(previewed.storagePath).toBe(expectedPath);
    expect(storage.files.get(expectedPath)).toEqual(Uint8Array.from(file.bytes));
    expect((await storedBatches())[0].storage_path).toBe(expectedPath);

    // No bytes passed: the archive is the source of truth from here on.
    const committed = await commitImport({
      batchId: previewed.batchId,
      userId: null,
      storage,
    });
    expect(committed.inserted).toBe(13);
  }, ONE_IMPORT);

  it('warns rather than failing when there is nowhere to archive to', async () => {
    const previewed = await preview({ filename: SEPT_PARTIAL, bytes: relayBytes(SEPT_PARTIAL) });

    expect(previewed.storagePath).toBeNull();
    const warning = previewed.issues.find((issue) => issue.code === 'storage.unavailable');
    expect(warning?.severity).toBe('warn');
    // The import itself is unaffected.
    expect(previewed.counts.new).toBe(13);
  }, ONE_IMPORT);

  it('says so plainly when commit has neither bytes nor an archive', async () => {
    const previewed = await preview({ filename: SEPT_PARTIAL, bytes: relayBytes(SEPT_PARTIAL) });

    await expect(
      commitImport({ batchId: previewed.batchId, userId: null, storage: null }),
    ).rejects.toThrow(/not available/);
  }, ONE_IMPORT);
});

// ---------------------------------------------------------------------------
// The whole corpus, end to end
// ---------------------------------------------------------------------------

describe('nine months of ••9726, imported in order', () => {
  it('lands all 106 transactions and bridges the opening balance to the closing one', async () => {
    const months = [
      'Relay 2026-01-01 #9726.csv',
      'Relay 2026-02-01 #9726.csv',
      'Relay 2026-03-01 #9726.csv',
      'Relay 2026-04-01 #9726.csv',
      'Relay 2026-05-01 #9726.csv',
      'Relay 2026-06-01 #9726.csv',
      'Relay 2026-07-01 #9726.csv',
      'Relay 2026-08-01 #9726.csv',
      SEPT_PARTIAL,
    ];

    let inserted = 0;
    let closing = 0;

    for (const filename of months) {
      const file = { filename, bytes: relayBytes(filename) };
      const { preview: previewed, commit } = await importFile(file);

      expect(previewed.blocked, filename).toBe(false);
      expect(previewed.balanceChain?.ok, filename).toBe(true);
      expect(commit.conflicts, filename).toBe(0);
      inserted += commit.inserted;
      if (previewed.balanceChain?.closingBalanceCents != null) {
        closing = previewed.balanceChain.closingBalanceCents;
      }
    }

    const rows = await storedTransactions();
    // 106 of the corpus's 110 transactions belong to ••9726; the other four are
    // ••9973's, and ••9727 and ••9972 had no activity at all in nine months.
    expect(rows).toHaveLength(106);
    expect(inserted).toBe(106);
    expect(new Set(rows.map((row) => row.fingerprint)).size).toBe(106);

    // The account opened at $1,000.00 on 2026-01-14 and the September partial
    // ends at $529.67; the sum of everything imported has to bridge exactly that.
    const net = rows.reduce((sum, row) => sum + Number(row.amount_cents), 0);
    expect(closing).toBe(52967);
    expect(net + 100000).toBe(closing);

    // The real 4/30 +$4.55 "transfer" from #3474 — not a Sooz account — is outside
    // money waiting for a human, never an internal transfer with no other leg.
    const outside = rows.find((row) => row.txn_date === '2026-04-30' && Number(row.amount_cents) === 455);
    expect(outside?.status).toBe('unreviewed');
    expect(outside?.transfer_pair_id).toBeNull();
    expect(rows.filter((row) => row.status === 'transfer' && row.transfer_pair_id === null)).toHaveLength(
      // The 5/14 leg into ••9726 names ••9973, a company account whose statement is
      // not part of this test: legitimately a transfer awaiting its other leg.
      1,
    );
  }, MANY_IMPORTS);

  it('is idempotent: importing all nine months again inserts nothing', async () => {
    const months = [
      'Relay 2026-01-01 #9726.csv',
      'Relay 2026-02-01 #9726.csv',
      SEPT_PARTIAL,
    ];

    for (const filename of months) {
      await importFile({ filename, bytes: relayBytes(filename) });
    }
    const before = await storedTransactions();

    for (const filename of months) {
      const file = { filename, bytes: relayBytes(filename) };
      const previewed = await preview(file);
      expect(previewed.counts.new, filename).toBe(0);
      expect(previewed.counts.duplicate, filename).toBe(previewed.counts.total);

      const committed = await commitImport({
        batchId: previewed.batchId,
        userId: null,
        bytes: file.bytes,
      });
      expect(committed.inserted, filename).toBe(0);
    }

    const after = await storedTransactions();
    expect(after).toHaveLength(before.length);
    expect(after.map((row) => row.id).sort()).toEqual(before.map((row) => row.id).sort());
  }, MANY_IMPORTS);
});

// ---------------------------------------------------------------------------
// Transfers from outside the company
// ---------------------------------------------------------------------------

describe('a bank-labelled transfer from an account that is not the company’s', () => {
  it('stays in the review queue instead of being written as an internal transfer', async () => {
    // Shape-identical to the real 2026-04-30 row: Relay labels a receipt from
    // account #3474 — nobody's account at Sooz — `Receive-transfer`. Written as
    // `transfer` it left the review queue with no other leg to post against.
    const file = csv('Relay 2026-11-01 #9726.csv', [
      '11/3/2026,,3474,Receive-transfer,,"TRANSFER",SETTLED,+4.55,USD,4.55',
    ]);
    const previewed = await preview(file);
    const row = previewed.rows[0];
    expect(row.suggestion?.source).toBe('transfer');
    expect(row.suggestion?.transferPairTxnId).toBeNull();
    expect(row.proposedStatus).toBe('unreviewed');
    expect(previewed.counts.needsReview).toBe(1);

    await commitImport({ batchId: previewed.batchId, userId: null, bytes: file.bytes });

    const { sql } = await client();
    const [stored] = await sql<Array<{ status: string; transfer_pair_id: string | null; suggestion_reasoning: string }>>`
      select status::text, transfer_pair_id, suggestion_reasoning
        from bank_transactions where bank_account_id = ${bankAccountId}`;
    expect(stored.status).toBe('unreviewed');
    expect(stored.transfer_pair_id).toBeNull();
    expect(stored.suggestion_reasoning).toMatch(/#3474, which is not one of the company's bank accounts/);
  }, ONE_IMPORT);

  it('still writes a labelled transfer to a company account as a transfer before its other leg arrives', async () => {
    const file = csv('Relay 2026-11-01 #9726.csv', [
      '11/4/2026,Operating Expenses,9973,Receive-transfer,,"Transfer",SETTLED,+7.77,USD,7.77',
    ]);
    const previewed = await preview(file);
    expect(previewed.rows[0].proposedStatus).toBe('transfer');
    await commitImport({ batchId: previewed.batchId, userId: null, bytes: file.bytes });
    expect((await storedTransactions())[0].status).toBe('transfer');
  }, ONE_IMPORT);
});

// ---------------------------------------------------------------------------
// Returned ACH across statements
// ---------------------------------------------------------------------------

describe('a returned ACH whose original is in an earlier statement', () => {
  const MAY = csv('Relay 2026-05-01 #9726.csv', [
    '5/29/2026,GOOGLE,,Spend,Unknown,"GOOGLE  |  PURCHASE |  GG4DR9NAQMW4 - Initiated By Unknown Payee",SETTLED,-10.00,USD,90.00',
    '5/20/2026,Square Inc,,Receive,,"SQ260520",SETTLED,+100.00,USD,100.00',
  ]);
  const JUNE = csv('Relay 2026-06-01 #9726.csv', [
    '6/2/2026,GOOGLE,,Receive,,"Returned received ACH transaction #417940311 due to: Account has insufficient funds - Initiated By Unknown Payee",RETURNED,+10.00,USD,100.00',
  ]);

  async function googleRows() {
    return (await storedTransactions()).filter((row) => row.description === 'GOOGLE');
  }

  it('excludes the debit already imported and links the two, both ways', async () => {
    await importFile(MAY);
    const before = await googleRows();
    expect(before).toHaveLength(1);
    // On its own the debit is an ordinary ad charge in the review queue.
    expect(before[0].status).toBe('unreviewed');

    const previewed = await preview(JUNE);
    const returned = previewed.rows[0];
    expect(returned.returnedLedgerTxnId).toBe(before[0].id);
    expect(returned.proposedStatus).toBe('excluded');
    expect(previewed.decisionsRequired).toEqual([]);

    const committed = await commitImport({ batchId: previewed.batchId, userId: null, bytes: JUNE.bytes });
    expect(committed.returnedPairsLinked).toBe(2);

    const rows = await googleRows();
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.status === 'excluded')).toBe(true);
    const [out, back] = [...rows].sort((a, b) => Number(a.amount_cents) - Number(b.amount_cents));
    expect(out.transfer_pair_id).toBe(back.id);
    expect(back.transfer_pair_id).toBe(out.id);
  }, ONE_IMPORT * 2);

  it('needs an explicit decision when the original is nowhere to be found', async () => {
    const previewed = await preview(JUNE);
    expect(previewed.decisionsRequired).toEqual([0]);
    expect(previewed.rows[0].decisionRequired).toMatch(/no settled/);
    expect(previewed.issues.find((issue) => issue.code === 'relay.returned_unpaired')?.severity).toBe('error');

    await expect(
      commitImport({ batchId: previewed.batchId, userId: null, bytes: JUNE.bytes }),
    ).rejects.toMatchObject({ code: 'import.decision_required' });
    expect(await storedTransactions()).toHaveLength(0);

    const decided = await commitImport({
      batchId: previewed.batchId,
      userId: null,
      bytes: JUNE.bytes,
      decisions: [{ rowIndex: 0, status: 'excluded', notes: 'Confirmed with Relay: returned for NSF.' }],
    });
    expect(decided.inserted).toBe(1);
    expect((await googleRows())[0].status).toBe('excluded');
  }, ONE_IMPORT * 2);

  it('excludes a debit imported after its return and links it to the return', async () => {
    const june = await preview(JUNE);
    await commitImport({
      batchId: june.batchId,
      userId: null,
      bytes: JUNE.bytes,
      decisions: [{ rowIndex: 0, status: 'excluded' }],
    });

    const { preview: may, commit } = await importFile(MAY);
    const debit = may.rows.find((row) => row.description === 'GOOGLE');
    expect(debit?.proposedStatus).toBe('excluded');
    expect(commit.returnedPairsLinked).toBe(2);

    const rows = await googleRows();
    expect(rows.every((row) => row.status === 'excluded')).toBe(true);
    expect(rows.every((row) => row.transfer_pair_id !== null)).toBe(true);
  }, ONE_IMPORT * 2);
});

// ---------------------------------------------------------------------------
// Any other bank
// ---------------------------------------------------------------------------

describe('a statement from a bank with no dedicated importer', () => {
  async function clearProfiles(): Promise<void> {
    const { sql } = await client();
    await sql`delete from bank_transactions where bank_account_id = ${bankAccountId}`;
    await sql`delete from import_batches where bank_account_id = ${bankAccountId}`;
    await sql`update bank_accounts set default_profile_id = null where id = ${bankAccountId}`;
    await sql`delete from import_profiles where bank_account_id = ${bankAccountId}`;
  }

  it('proposes a mapping, refuses to commit it unconfirmed, and imports once it is saved', async () => {
    const file = { filename: 'Chase1234_Activity.CSV', bytes: fixtureBytes('debit-credit.csv') };
    try {
      const first = await preview(file);
      expect(first.importerId).toBe(GENERIC_IMPORTER_ID);
      expect(first.profileConfirmationRequired).toBe(true);
      expect(first.profileId).toBeNull();
      expect(first.columnMapping.mode).toBe('debit_credit');
      expect(first.columnMapping.debit_column).toBe('Debit');
      expect(first.columnMapping.balance_column).toBe('Balance');
      expect(first.balanceChain?.ok).toBe(true);
      expect(first.issues.some((issue) => issue.code === 'profile.unconfirmed')).toBe(true);

      await expect(
        commitImport({ batchId: first.batchId, userId: null, bytes: file.bytes }),
      ).rejects.toMatchObject({ code: 'profile.unconfirmed' });
      expect(await storedTransactions()).toHaveLength(0);

      const saved = await saveImportProfile(
        { bankAccountId, profile: first.columnMapping, name: 'Chase checking (test)' },
        { userId: null },
      );
      expect(saved.isDefault).toBe(true);

      const { sql } = await client();
      const [account] = await sql<Array<{ default_profile_id: string | null }>>`
        select default_profile_id from bank_accounts where id = ${bankAccountId}`;
      expect(account.default_profile_id).toBe(saved.id);

      const second = await preview(file);
      expect(second.profileConfirmationRequired).toBe(false);
      expect(second.profileId).toBe(saved.id);
      const committed = await commitImport({ batchId: second.batchId, userId: null, bytes: file.bytes });
      expect(committed.inserted).toBe(5);

      const rows = await storedTransactions();
      const byDescription = new Map(rows.map((row) => [row.description, Number(row.amount_cents)]));
      // Credits are money in, debits money out, whatever the bank calls them.
      expect(byDescription.get('Opening deposit')).toBe(100000);
      expect(byDescription.get('BANK FEE')).toBe(-1500);
      expect(rows.reduce((sum, row) => sum + Number(row.amount_cents), 0)).toBe(80000);

      const [profile] = await sql<Array<{ times_used: number; name: string }>>`
        select times_used, name from import_profiles where id = ${saved.id}`;
      expect(profile).toEqual({ times_used: 1, name: 'Chase checking (test)' });

      // The saved Chase mapping does not fit a Relay export, so it is not applied to one.
      const relay = await preview({ filename: SEPT_PARTIAL, bytes: relayBytes(SEPT_PARTIAL) });
      expect(relay.importerId).not.toBe(GENERIC_IMPORTER_ID);
      expect(relay.profileId).toBeNull();
      expect(relay.issues.some((issue) => issue.code === 'profile.default_not_applicable')).toBe(true);
      expect(relay.blocked).toBe(false);
      expect(relay.counts.new).toBe(13);
    } finally {
      await clearProfiles();
    }
  }, ONE_IMPORT * 3);

  it('reads an XLSX statement the same way', async () => {
    try {
      const file = { filename: 'statement.xlsx', bytes: fixtureBytes('date-serials.xlsx') };
      const first = await preview(file);
      expect(first.importerId).toBe(GENERIC_IMPORTER_ID);
      const saved = await saveImportProfile({ bankAccountId, profile: first.columnMapping }, { userId: null });
      const second = await preview(file);
      expect(second.profileId).toBe(saved.id);
      expect(second.blocked).toBe(false);
      const committed = await commitImport({ batchId: second.batchId, userId: null, bytes: file.bytes });
      expect(committed.inserted).toBe(second.counts.new);
      expect(committed.inserted).toBeGreaterThan(0);
    } finally {
      await clearProfiles();
    }
  }, ONE_IMPORT * 2);

  it('refuses to save a mapping with no amount column, in words', async () => {
    await expect(
      saveImportProfile(
        { bankAccountId, profile: { date_column: 'Date', mode: 'signed', amount_column: null } },
        { userId: null },
      ),
    ).rejects.toThrow(/choose the amount column/);
    const { sql } = await client();
    const profiles = await sql`select id from import_profiles where bank_account_id = ${bankAccountId}`;
    expect(profiles).toHaveLength(0);
  }, ONE_IMPORT);
});

// ---------------------------------------------------------------------------
// Database errors
// ---------------------------------------------------------------------------

describe('a database refusal', () => {
  it('is recognised as a unique violation through drizzle’s DrizzleQueryError wrapper', async () => {
    const { withActor } = await client();
    const { sql: sqlTag } = await import('drizzle-orm');

    let caught: unknown = null;
    await withActor(null, async (tx) => {
      await tx.execute(sqlTag`create temp table zz_import_unique (a int unique) on commit drop`);
      await tx.execute(sqlTag`insert into zz_import_unique values (1)`);
      await tx.execute(sqlTag`insert into zz_import_unique values (1)`);
    }).catch((error: unknown) => {
      caught = error;
    });

    // The wrapper's own `code` is undefined; the SQLSTATE is on `.cause`.
    expect((caught as { code?: unknown }).code).toBeUndefined();
    expect(isUniqueViolation(caught, 'zz_import_unique_a_key')).toBe(true);
    expect(isUniqueViolation(caught, 'some_other_index')).toBe(false);
  }, ONE_IMPORT);

  it('turns two concurrent commits of one file into one import and a handled duplicate, never a raw query error', async () => {
    const file = csv('Relay 2026-12-01 #9726.csv', [
      '12/2/2026,Square Inc,,Receive,,"SQ261202",SETTLED,+13.81,USD,13.81',
    ]);
    const a = await preview(file);
    const b = await preview(file);

    const outcomes = await Promise.allSettled([
      commitImport({ batchId: a.batchId, userId: null, bytes: file.bytes }),
      commitImport({ batchId: b.batchId, userId: null, bytes: file.bytes }),
    ]);

    const imported = outcomes.filter(
      (outcome) => outcome.status === 'fulfilled' && outcome.value.status === 'imported',
    );
    expect(imported).toHaveLength(1);
    for (const outcome of outcomes) {
      if (outcome.status === 'fulfilled') continue;
      expect(outcome.reason).toBeInstanceOf(ImportError);
      expect((outcome.reason as ImportError).code).toBe('batch.file_already_imported');
      // The bound parameters — payees, amounts, raw rows — never reach the message.
      expect((outcome.reason as Error).message).not.toMatch(/Failed query|params:/);
    }
    expect(await storedTransactions()).toHaveLength(1);
  }, ONE_IMPORT * 2);
});

// ---------------------------------------------------------------------------
// The AI tier, inside the import
// ---------------------------------------------------------------------------

describe('the AI tier', () => {
  function objectResult(payload: unknown) {
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
      finishReason: { unified: 'stop' as const, raw: 'end_turn' },
      usage: {
        inputTokens: { total: 100, noCache: 100, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 20, text: 20, reasoning: undefined },
      },
      warnings: [],
    };
  }

  it('runs in commitImport over the rows the deterministic tiers parked, and supersedes the rule', async () => {
    let offered = 0;
    const model = new MockLanguageModelV4({
      modelId: 'stub-model',
      doGenerate: async (options) => {
        const prompt = JSON.stringify(options.prompt);
        offered = (prompt.match(/Amazon/g) ?? []).length;
        return objectResult({
          suggestions: [
            {
              rowIndex: 0,
              accountCode: '6740',
              vendorName: 'Amazon',
              confidence: 0.55,
              reasoning: 'Corporate card purchase from Amazon; most likely office supplies.',
              needsHuman: true,
            },
          ],
        });
      },
    });

    const file = septemberFullMonth();
    const previewed = await preview(file);
    const committed = await commitImport({
      batchId: previewed.batchId,
      userId: null,
      bytes: file.bytes,
      ai: { model },
    });

    expect(offered).toBeGreaterThan(0);
    expect(committed.ai?.attempted).toBe(1);
    expect(committed.ai?.written).toBe(1);
    expect(committed.issues.some((issue) => issue.code === 'ai.ran')).toBe(true);

    const amazon = (await storedTransactions()).find((row) => row.description === 'Amazon');
    expect(amazon?.suggestion_source).toBe('ai');
    expect(amazon?.suggested_account_code).toBe('6740');
    // The Amazon rule no longer explains this suggestion, so it is not named as its origin.
    expect(amazon?.rule_name).toBeNull();
    // A proposal: nothing an AI says leaves the review queue on its own.
    expect(amazon?.status).toBe('unreviewed');

    // Every row a rule, vendor or history already explained kept its suggestion.
    const others = (await storedTransactions()).filter((row) => row.description !== 'Amazon');
    expect(others.every((row) => row.suggestion_source !== 'ai')).toBe(true);
  }, ONE_IMPORT);

  it('never costs the import when the model fails', async () => {
    const model = new MockLanguageModelV4({
      modelId: 'stub-model',
      doGenerate: async () => {
        throw new APICallError({
          message: 'stub 500',
          url: 'https://example.invalid/v1/messages',
          requestBodyValues: {},
          statusCode: 500,
          isRetryable: true,
        });
      },
    });

    const file = septemberFullMonth();
    const previewed = await preview(file);
    const committed = await commitImport({
      batchId: previewed.batchId,
      userId: null,
      bytes: file.bytes,
      ai: { model, retryDelayMs: 0 },
    });

    expect(committed.status).toBe('imported');
    expect(committed.inserted).toBe(16);
    expect(committed.ai?.written).toBe(0);
    expect(committed.ai?.failures.length).toBeGreaterThan(0);
    expect(committed.issues.some((issue) => issue.code === 'ai.call_failed')).toBe(true);

    const amazon = (await storedTransactions()).find((row) => row.description === 'Amazon');
    expect(amazon?.suggested_account_code).toBe('7900');
    expect(amazon?.rule_name).toBe('Amazon — business default via AI, always review');
  }, ONE_IMPORT);

  it('records that it was skipped when no model is configured', async () => {
    const { commit } = await importFile(septemberFullMonth());
    expect(commit.ai?.skippedReason).toMatch(/no model is configured/);
    expect(commit.issues.some((issue) => issue.code === 'ai.skipped')).toBe(true);
  }, ONE_IMPORT);
});

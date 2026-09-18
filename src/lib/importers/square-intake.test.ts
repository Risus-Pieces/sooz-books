/**
 * Square settlement intake, against the live database.
 *
 * The settlements are synthetic and dated March 2027, after every real statement,
 * and the deposits they clear live in a throwaway bank account bound to the seeded
 * `1040 Undeposited Funds` GL account — so nothing here can match, or be matched
 * by, one of Sooz's seven real Square deposits. Everything written is removed.
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

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

import { SquareImportError, importSquareSettlements } from './square-intake';

const TEST_ACCOUNT_NAME = 'TEST — square-intake.test.ts throwaway (safe to delete)';
const GL_CODE = '1040';
const FILENAME = 'TEST square-intake settlements.csv';
const TIMEOUT = 60_000;

const HEADER =
  'Settlement Date,Settlement Type,Settlement Description,Gross Sales,Returns,Discounts & Comps,Service Charges,Net Sales,Gift Card Sales,Tax,Tip,Partial Refunds,Total Collected,Fees,Net Total,Currency';

/** Three settlements. The first clears three deposits, the second one a day late, the third none. */
const SETTLEMENTS = [
  HEADER,
  '2027-03-08,Transfer,Automatic transfer,100.00,0.00,0.00,0.00,100.00,0.00,6.00,0.00,0.00,106.00,-3.00,103.00,USD',
  '2027-03-15,Transfer,Automatic transfer,50.00,0.00,0.00,0.00,50.00,0.00,1.50,0.00,0.00,51.50,-1.50,50.00,USD',
  '2027-03-22,Transfer,Automatic transfer,20.00,0.00,0.00,0.00,20.00,0.00,0.00,0.00,0.00,20.00,-0.60,19.40,USD',
].join('\n');

/** The same file, with the first settlement's net total off by a cent. */
const UNTIED = SETTLEMENTS.replace('-3.00,103.00,USD', '-3.00,103.01,USD');

type DbClient = typeof import('@/db/client');
let clientPromise: Promise<DbClient> | undefined;
function client(): Promise<DbClient> {
  clientPromise ??= import('@/db/client');
  return clientPromise;
}

let bankAccountId = '';
const depositIds = new Map<string, string>();

async function clearPayouts(): Promise<void> {
  const { sql } = await client();
  await sql`update bank_transactions set matched_type = null, matched_id = null
             where bank_account_id = ${bankAccountId}`;
  await sql`delete from payout_imports where provider = 'square' and filename = ${FILENAME}`;
}

beforeAll(async () => {
  expect(process.env.DATABASE_URL, 'DATABASE_URL must be set').toBeTruthy();
  const { sql } = await client();

  await sql`delete from payout_imports where provider = 'square' and filename = ${FILENAME}`;
  await sql`delete from bank_transactions
             where bank_account_id in (select id from bank_accounts where name = ${TEST_ACCOUNT_NAME})`;
  await sql`delete from bank_accounts where name = ${TEST_ACCOUNT_NAME}`;

  const [created] = await sql<Array<{ id: string }>>`
    insert into bank_accounts (account_id, name, institution, kind, mask,
                               statement_sign, opening_balance_cents, opening_date, active)
    select id, ${TEST_ACCOUNT_NAME}, 'Relay (test)', 'checking', '0001', 1, 0, '2027-01-01', false
      from accounts where code = ${GL_CODE}
    returning id`;
  expect(created, `the seeded GL account ${GL_CODE} must exist`).toBeDefined();
  bankAccountId = created.id;

  const deposits: Array<[string, string, number, string]> = [
    ['a', '2027-03-08', 10000, 'SQ270308'],
    ['b', '2027-03-08', 250, 'SQ270308'],
    ['c', '2027-03-08', 50, 'SQ270308'],
    ['d', '2027-03-16', 5000, 'SQ270316'],
  ];
  for (const [tag, date, cents, reference] of deposits) {
    const [row] = await sql<Array<{ id: string }>>`
      insert into bank_transactions (bank_account_id, txn_date, description, description_normalized,
                                     counterparty, amount_cents, reference, fingerprint, status)
      values (${bankAccountId}, ${date}, 'Square Inc', 'SQUARE INC', 'Square Inc', ${cents},
              ${reference}, ${`square-intake-test-${tag}`}, 'unreviewed')
      returning id`;
    depositIds.set(tag, row.id);
  }
});

afterEach(clearPayouts);

afterAll(async () => {
  if (clientPromise === undefined) return;
  const { sql } = await clientPromise;
  if (bankAccountId !== '') {
    await clearPayouts();
    await sql`delete from bank_transactions where bank_account_id = ${bankAccountId}`;
    await sql`delete from bank_accounts where id = ${bankAccountId}`;
  }
  await sql.end({ timeout: 5 });
});

async function storedPayouts() {
  const { sql } = await client();
  return sql<
    Array<{
      id: string;
      external_id: string;
      status: string;
      gross_cents: string;
      fees_cents: string;
      net_cents: string;
      bank_transaction_id: string | null;
      deposit_date: string | null;
      channel_code: string;
      lines: number;
    }>
  >`
    select p.id, p.external_id, p.status::text, p.gross_cents::text, p.fees_cents::text,
           p.net_cents::text, p.bank_transaction_id, p.deposit_date::text, c.code as channel_code,
           (select count(*)::int from payout_lines l where l.payout_import_id = p.id) as lines
      from payout_imports p join channels c on c.id = p.channel_id
     where p.provider = 'square' and p.filename = ${FILENAME}
     order by p.period_start`;
}

async function linkedDeposits() {
  const { sql } = await client();
  return sql<Array<{ id: string; matched_type: string | null; matched_id: string | null }>>`
    select id, matched_type, matched_id from bank_transactions
     where bank_account_id = ${bankAccountId} order by txn_date, amount_cents desc`;
}

describe('importSquareSettlements', () => {
  it('writes nothing on a dry run, but says what it would match', async () => {
    const result = await importSquareSettlements({
      filename: FILENAME,
      bytes: Buffer.from(SETTLEMENTS),
      userId: null,
      dryRun: true,
    });

    expect(result.written).toBe(false);
    expect(result.preview.ok).toBe(true);
    expect(result.settlements.map((s) => s.match?.status)).toEqual(['matched', 'matched', 'unmatched']);
    expect(await storedPayouts()).toHaveLength(0);
    expect((await linkedDeposits()).every((row) => row.matched_id === null)).toBe(true);
  }, TIMEOUT);

  it('records every settlement with its gross decomposition and links the deposits that clear it', async () => {
    const result = await importSquareSettlements({
      filename: FILENAME,
      bytes: Buffer.from(SETTLEMENTS),
      userId: null,
    });

    expect(result.inserted).toBe(3);
    expect(result.depositsLinked).toBe(4);

    const payouts = await storedPayouts();
    expect(payouts).toHaveLength(3);
    expect(payouts.map((p) => p.channel_code)).toEqual(['DTC', 'DTC', 'DTC']);
    expect(payouts.map((p) => [p.gross_cents, p.fees_cents, p.net_cents])).toEqual([
      ['10000', '-300', '10300'],
      ['5000', '-150', '5000'],
      ['2000', '-60', '1940'],
    ]);
    expect(payouts.map((p) => p.status)).toEqual(['deposited', 'deposited', 'imported']);
    // Gross sales, tax and fees for the first two; gross and fees for the third.
    expect(payouts.map((p) => p.lines)).toEqual([3, 3, 2]);

    // Three deposits clear the first payout, so no single bank row is "the" deposit;
    // each of them points at the payout instead.
    expect(payouts[0].bank_transaction_id).toBeNull();
    expect(payouts[1].bank_transaction_id).toBe(depositIds.get('d'));
    expect(payouts[1].deposit_date).toBe('2027-03-16');

    const deposits = await linkedDeposits();
    const byId = new Map(deposits.map((row) => [row.id, row]));
    for (const tag of ['a', 'b', 'c']) {
      expect(byId.get(depositIds.get(tag) ?? '')?.matched_type).toBe('payout');
      expect(byId.get(depositIds.get(tag) ?? '')?.matched_id).toBe(payouts[0].id);
    }
    expect(byId.get(depositIds.get('d') ?? '')?.matched_id).toBe(payouts[1].id);
  }, TIMEOUT);

  it('is free to run again: settlements already imported are recognised, not duplicated', async () => {
    await importSquareSettlements({ filename: FILENAME, bytes: Buffer.from(SETTLEMENTS), userId: null });
    const again = await importSquareSettlements({
      filename: FILENAME,
      bytes: Buffer.from(SETTLEMENTS),
      userId: null,
    });

    expect(again.inserted).toBe(0);
    expect(again.alreadyImported).toBe(3);
    expect(again.depositsLinked).toBe(0);
    expect(await storedPayouts()).toHaveLength(3);
  }, TIMEOUT);

  it('refuses a file whose settlement does not tie, and writes none of it', async () => {
    await expect(
      importSquareSettlements({ filename: FILENAME, bytes: Buffer.from(UNTIED), userId: null }),
    ).rejects.toBeInstanceOf(SquareImportError);
    expect(await storedPayouts()).toHaveLength(0);
    expect((await linkedDeposits()).every((row) => row.matched_id === null)).toBe(true);
  }, TIMEOUT);

  it('refuses a file that is not a settlement export', async () => {
    await expect(
      importSquareSettlements({
        filename: FILENAME,
        bytes: Buffer.from('Date,Description,Amount\n2027-03-08,Coffee,-4.50\n'),
        userId: null,
      }),
    ).rejects.toBeInstanceOf(SquareImportError);
  }, TIMEOUT);
});

/**
 * Shared scaffolding for the banking tests: fixture loading, the Relay corpus,
 * the seeded Relay profile, and a Postgres client for the parity assertions.
 *
 * This file is not a test. It lives under `__fixtures__` so vitest's
 * `src/**\/*.test.ts` include pattern never picks it up as one.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import postgres from 'postgres';

import { readFile } from '../read-file';
import type { ImportProfile, ParsedFile } from '../types';

const FIXTURES = __dirname;
const REPO_ROOT = join(__dirname, '../../../..');

/** The real Relay statements. Gitignored — they are this company's actual bank data. */
export const RELAY_DIR = join(REPO_ROOT, 'data/statements/relay');

export function fixtureBytes(name: string): Buffer {
  return readFileSync(join(FIXTURES, name));
}

export function readFixture(name: string, filename = name): Promise<ParsedFile> {
  return readFile(fixtureBytes(name), filename);
}

/** A CSV assembled in the test itself, for one-off shapes not worth a file. */
export function readInline(text: string, filename = 'inline.csv'): Promise<ParsedFile> {
  return readFile(Buffer.from(text, 'utf8'), filename);
}

/** The 36 real statement filenames, sorted. */
export function relayFilenames(): string[] {
  return readdirSync(RELAY_DIR)
    .filter((name) => name.toLowerCase().endsWith('.csv'))
    .sort();
}

export function readRelay(name: string): Promise<ParsedFile> {
  return readFile(readFileSync(join(RELAY_DIR, name)), name);
}

/** Last four of the account, from the statement filename. */
export function relayAccountMask(filename: string): string {
  return /#(\d{4})/.exec(filename)?.[1] ?? 'unknown';
}

/**
 * The `Relay CSV` profile exactly as it is seeded in `import_profiles`, including
 * the `flag` (not `skip`) action on a RETURNED row — a returned ACH still moves
 * the running balance, so dropping it would break the chain.
 */
const RELAY_PROFILE_SOURCE: ImportProfile = {
  name: 'Relay CSV',
  file_type: 'csv',
  delimiter: ',',
  encoding: 'utf-8',
  skip_rows: 0,
  header_row: 0,
  date_column: 'Date',
  date_format: 'M/D/YYYY',
  description_columns: ['Payee'],
  counterparty_column: 'Payee',
  mode: 'signed',
  amount_column: 'Amount',
  type_column: 'Transaction Type',
  balance_column: 'Balance',
  reference_column: 'Reference',
  invert_sign: false,
  skip_row_rules: [
    {
      field: 'Status',
      op: 'exact',
      value: 'RETURNED',
      action: 'flag',
      reason: 'Returned ACH — did not settle',
    },
  ],
};

export const RELAY_PROFILE: ImportProfile = Object.freeze(RELAY_PROFILE_SOURCE);

// ---------------------------------------------------------------------------
// Postgres
// ---------------------------------------------------------------------------

let envLoaded = false;

/**
 * Reads `.env.local` into `process.env`. Vitest does not run through Next.js, so
 * nothing else loads it, and the parity tests need `DATABASE_URL`.
 */
function loadEnv(): void {
  if (envLoaded) return;
  envLoaded = true;
  if (process.env.DATABASE_URL) return;

  let text: string;
  try {
    text = readFileSync(join(REPO_ROOT, '.env.local'), 'utf8');
  } catch {
    return;
  }

  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const value = match[2].trim().replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[match[1]] === undefined) process.env[match[1]] = value;
  }
}

/**
 * A dedicated single-connection client for the parity tests.
 *
 * Deliberately not `sql` from `@/db/client`: that pool is a process-wide
 * singleton cached on `globalThis`, and a test closing it would take the app's
 * pool with it.
 */
export function parityClient(): postgres.Sql {
  loadEnv();
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set and .env.local could not be read. The Postgres parity tests compare this module against the live `normalize_description` and `bank_txn_fingerprint` functions and cannot run without it.',
    );
  }
  return postgres(url, { max: 1, idle_timeout: 5, connect_timeout: 30 });
}

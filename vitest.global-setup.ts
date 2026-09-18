/**
 * Runs once before the unit suite: starts a private local Postgres and rebuilds a database from
 * supabase/migrations/, so no test ever writes to the real books.
 *
 * Before this, the suite ran against the live Supabase project. Every run advanced the real
 * journal-entry number sequence (the first real entry was #92,434) and appended thousands of rows
 * about throwaway fixtures to an audit log that is, by design, permanent. It was also ~150ms per
 * round trip instead of microseconds.
 *
 * The cluster, port and database differ from the e2e suite's, so the two can run side by side
 * without one stopping the other's Postgres. The URL the tests connect to is set in
 * vitest.config.mts from the same three values.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const UNIT_PG_PORT = '54330';
export const UNIT_PG_DB = 'sooz_unit';
export const UNIT_PG_DIR = join(tmpdir(), 'sooz-books-unit-pg');

export default async function setup(): Promise<() => Promise<void>> {
  // local-db.ts reads these at import time.
  process.env.E2E_PG_PORT = UNIT_PG_PORT;
  process.env.LOCAL_PG_DB = UNIT_PG_DB;
  process.env.LOCAL_PG_DIR = UNIT_PG_DIR;

  const { startCluster, rebuildDatabase, stopCluster } = await import('./e2e/support/local-db');
  startCluster();
  // Every real deployment has an owner, and owner-only paths (reopening a period, managing
  // users) need one to test against. A local-only identity: never the founder's account,
  // never read from the live project.
  rebuildDatabase({
    id: '00000000-0000-4000-8000-000000000001',
    email: 'unit-owner@sooz-books.invalid',
    fullName: 'Unit Test Owner',
  });

  return async () => {
    stopCluster();
  };
}

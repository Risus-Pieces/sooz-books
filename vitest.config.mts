import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defineConfig } from 'vitest/config';

// The test helpers read .env.local but only fill variables that are still unset, so
// blanking the model keys here keeps every import-path test off the network: a funded
// key would otherwise turn each test import into a real, billed, nondeterministic model
// call (import.test.ts went from seconds to 5.5 minutes when the key was funded).
// The one live-model integration test runs only with RUN_AI_INTEGRATION=1.
const liveAi = process.env.RUN_AI_INTEGRATION === '1';

// Tests run against a disposable local Postgres rebuilt from supabase/migrations/ by
// vitest.global-setup.ts — never the real books. These must match the values there.
// Setting DATABASE_URL here also stops every test helper from reading the live one out of
// .env.local, because they only fill variables that are unset.
const UNIT_PG_PORT = '54330';
const UNIT_PG_DB = 'sooz_unit';
const UNIT_DATABASE_URL = `postgres://sooz_app:sooz-e2e-local@127.0.0.1:${UNIT_PG_PORT}/${UNIT_PG_DB}`;

export default defineConfig({
  // Resolves the "@/*" -> src/* alias straight from tsconfig.json.
  resolve: { tsconfigPaths: true },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // Playwright owns e2e/; vitest must not try to run those specs.
    exclude: ['node_modules/**', '.next/**', 'e2e/**'],
    globalSetup: ['./vitest.global-setup.ts'],
    // The local cluster allows 60 connections; four workers of three each is well inside it.
    maxWorkers: 4,
    env: {
      DATABASE_URL: UNIT_DATABASE_URL,
      E2E_PG_PORT: UNIT_PG_PORT,
      LOCAL_PG_DB: UNIT_PG_DB,
      LOCAL_PG_DIR: join(tmpdir(), 'sooz-books-unit-pg'),
      DB_POOL_MAX: '3',
      ...(liveAi ? {} : { ANTHROPIC_API_KEY: '', AI_GATEWAY_API_KEY: '' }),
    },
  },
});

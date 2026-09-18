import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end flows of Sooz Books, run against a dev server on a disposable local database.
 *
 *   npx playwright test                 # rebuilds the e2e database, starts the server, runs every flow
 *   npx playwright test e2e/banking     # one file
 *
 * `e2e/support/serve.ts` rebuilds the database from `supabase/migrations/` and starts
 * `next dev` on port 3111 against it, so the flows can post, reconcile and close months
 * without leaving a single row in the real books. Sign-in is the real Supabase project,
 * as the E2E account in `.env.local`.
 *
 * One worker, in file order: the flows share one ledger, and the close flow reads it.
 * E2E_REUSE_SERVER=1 reuses a server already running on the port (only ever start that
 * server with `npx tsx e2e/support/serve.ts`: the setup refuses any other).
 */
const PORT = Number(process.env.E2E_PORT ?? 3111);
const baseURL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  outputDir: './test-results/e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  // The first visit to each route compiles it in the dev server.
  timeout: 180_000,
  expect: { timeout: 20_000 },
  reporter: [['list']],
  globalTeardown: './e2e/support/teardown.ts',
  use: {
    baseURL,
    viewport: { width: 1440, height: 900 },
    actionTimeout: 20_000,
    navigationTimeout: 90_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    timezoneId: 'America/Chicago',
  },
  projects: [
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    {
      name: 'flows',
      testMatch: /.*\.spec\.ts/,
      testIgnore: /invite-only\.spec\.ts/,
      dependencies: ['setup'],
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 }, storageState: 'e2e/.auth/owner.json' },
    },
    {
      // Signed out on purpose: this is what a stranger sees.
      name: 'signed-out',
      testMatch: /invite-only\.spec\.ts/,
      dependencies: ['setup'],
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
  ],
  webServer: {
    command: 'npx tsx e2e/support/serve.ts',
    url: `${baseURL}/login`,
    timeout: 240_000,
    reuseExistingServer: process.env.E2E_REUSE_SERVER === '1',
    stdout: 'ignore',
    stderr: 'pipe',
    env: { E2E_PORT: String(PORT) },
  },
});

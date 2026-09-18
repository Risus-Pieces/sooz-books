/**
 * The web server the Playwright suite runs against: rebuilds the disposable e2e database, then
 * runs `next dev` pointed at it. Playwright starts this through `webServer` and stops it when
 * the run ends; the local Postgres is stopped with it.
 *
 * The dev server reads `.env.local` for the Supabase project (sign-in is real), but its
 * DATABASE_URL is the local copy and the model keys are blanked, so a run never writes to the
 * real books and never calls the model.
 */
import { spawn } from 'node:child_process';

import { config } from 'dotenv';

import { E2E_DATABASE_URL, readE2eUser, rebuildDatabase, startCluster, stopCluster } from './local-db';

config({ path: '.env.local', override: false, quiet: true });

const PORT = process.env.E2E_PORT ?? '3111';

async function main(): Promise<void> {
  const liveUrl = process.env.DATABASE_URL;
  const email = process.env.E2E_EMAIL;
  if (!liveUrl || !email) throw new Error('DATABASE_URL and E2E_EMAIL must be set in .env.local.');

  const user = await readE2eUser(liveUrl, email);
  startCluster();
  rebuildDatabase(user);
  process.stdout.write(`e2e database rebuilt; starting next dev on ${PORT}\n`);

  const child = spawn('npx', ['next', 'dev', '-p', PORT], {
    stdio: 'inherit',
    env: {
      ...process.env,
      DATABASE_URL: E2E_DATABASE_URL,
      DB_POOL_MAX: '3',
      // Its own build directory: `next dev` locks the default one, and another dev server
      // may already be running in this checkout.
      NEXT_DIST_DIR: '.next/e2e',
      ANTHROPIC_API_KEY: '',
      AI_GATEWAY_API_KEY: '',
      SUPABASE_SERVICE_ROLE_KEY: '',
    },
  });

  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    child.kill('SIGTERM');
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  child.on('exit', (code) => {
    try {
      stopCluster();
    } finally {
      process.exit(code ?? 0);
    }
  });
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exit(1);
});

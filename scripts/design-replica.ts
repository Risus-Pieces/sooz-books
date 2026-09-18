/**
 * Build a local replica of the books for design and UI work: a disposable Postgres rebuilt from
 * supabase/migrations/, with the real Relay statements imported and the owner-authorised entries
 * posted, exactly as production was set up. Nothing touches the live project except one read of
 * the end-to-end account's id, so that account can sign in to the replica.
 *
 *   npx tsx scripts/design-replica.ts
 *   DATABASE_URL=<printed url> DB_POOL_MAX=3 npx next dev -p 3130
 *   npx tsx scripts/shoot.ts http://localhost:3130 /dashboard /banking/review --mobile
 *
 * The end-to-end account is switched off in production, so screenshots of real-looking pages
 * come from here.
 */
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { config } from 'dotenv';

const PORT = '54331';
const DB = 'sooz_design';

async function main(): Promise<void> {
  config({ path: '.env.local', override: false, quiet: true });
  const liveUrl = process.env.DATABASE_URL;
  const email = process.env.E2E_EMAIL;
  if (!liveUrl || !email) throw new Error('DATABASE_URL and E2E_EMAIL must be set in .env.local.');

  // local-db.ts reads these at import time.
  process.env.E2E_PG_PORT = PORT;
  process.env.LOCAL_PG_DB = DB;
  process.env.LOCAL_PG_DIR = join(tmpdir(), 'sooz-books-design-pg');
  const { E2E_DATABASE_URL, readE2eUser, rebuildDatabase, startCluster } = await import('../e2e/support/local-db');

  const user = await readE2eUser(liveUrl, email);
  startCluster();
  rebuildDatabase(user);
  process.stdout.write(`replica database rebuilt at ${E2E_DATABASE_URL}\n`);

  // The child scripts see only the replica: DATABASE_URL is set explicitly, and both load
  // .env.local with override: false, so the live URL cannot win.
  const env = { ...process.env, DATABASE_URL: E2E_DATABASE_URL, DB_POOL_MAX: '3' };
  for (const script of ['scripts/import-relay.ts', 'scripts/post-authorized.ts']) {
    process.stdout.write(`\n=== ${script} ===\n`);
    const run = spawnSync('npx', ['tsx', script], { stdio: 'inherit', env });
    if (run.status !== 0) throw new Error(`${script} exited ${run.status}`);
  }

  process.stdout.write(
    `\nReplica ready. Start the app against it with:\n` +
      `  DATABASE_URL='${E2E_DATABASE_URL}' DB_POOL_MAX=3 npx next dev -p 3130\n`,
  );
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

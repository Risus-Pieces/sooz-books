/**
 * Signs in once as the E2E owner and saves the session for every flow, then proves the server
 * under test reads the disposable e2e database — not the real books — before any flow writes.
 */
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

import { config } from 'dotenv';
import { expect, test as setup } from '@playwright/test';

import { connect } from './support/db';

config({ path: '.env.local', override: false, quiet: true });

const STATE = 'e2e/.auth/owner.json';

setup('sign in as the E2E owner, on the e2e database', async ({ page }) => {
  const email = process.env.E2E_EMAIL;
  const password = process.env.E2E_PASSWORD;
  if (!email || !password) throw new Error('E2E_EMAIL and E2E_PASSWORD must be set in .env.local');

  // The same steps scripts/shoot.ts takes.
  await page.goto('/login', { waitUntil: 'networkidle' });
  await page.getByLabel(/email/i).first().fill(email);
  await page.getByLabel(/password/i).first().fill(password);
  await Promise.all([
    page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 60_000 }),
    page.getByRole('button', { name: /sign in|log in|continue/i }).first().click(),
  ]);

  // A vendor that exists only in the e2e database. If the page cannot see it, the server on
  // this port is reading some other database, and nothing below may run against it.
  const sql = connect();
  const sentinel = `E2E sentinel ${randomUUID().slice(0, 8)}`;
  try {
    await sql`insert into vendors (name) values (${sentinel})`;
    await page.goto('/purchases/vendors');
    // The vendor's row in the list: a button that selects it, its name leading its label.
    await expect(
      page.getByRole('button', { name: new RegExp(`^${sentinel}`) }),
      'The server under test is not reading the e2e database. Start it with `npx tsx e2e/support/serve.ts`.',
    ).toBeVisible();
  } finally {
    await sql`delete from vendors where name = ${sentinel}`;
    await sql.end({ timeout: 5 });
  }

  mkdirSync('e2e/.auth', { recursive: true });
  await page.context().storageState({ path: STATE });
});

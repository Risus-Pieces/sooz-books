/**
 * Flow 7 — a member drops a receipt into the Assistant, checks the proposed entry, and posts it.
 *
 * The receipt reader and the file store are fixtures (`RECEIPT_FIXTURES=1` in the end-to-end
 * server's environment), so the run never calls the model. What is real: the upload route, the
 * proposal, the posting through the ledger, the duplicate check, and the receipt link on the entry.
 */
import { expect, test } from './support/test';

import { connect, type Sql } from './support/db';
import { toast } from './support/ui';

const VENDOR = 'E2E Packaging Supply';

let sql: Sql;
let userId: string;
let memberAccountCode: string;

test.beforeAll(async () => {
  sql = connect();
  const [user] = await sql<{ id: string }[]>`select id from app_users where email = ${process.env.E2E_EMAIL ?? ''}`;
  userId = user.id;

  // The seeded owner is the only member, and members have accounts of their own in production.
  memberAccountCode = `E2E-M${Date.now() % 1_000_000}`;
  const [parent] = await sql<{ id: string }[]>`select id from accounts where code = '3015'`;
  const [account] = await sql<{ id: string }[]>`
    insert into accounts (code, name, type, subtype, parent_id)
    values (${memberAccountCode}, 'E2E contributions', 'equity', 'equity', ${parent.id})
    returning id`;
  await sql`update app_users set contributions_account_id = ${account.id} where id = ${userId}`;
});

test.afterAll(async () => {
  await sql`update app_users set contributions_account_id = null where id = ${userId}`;
  await sql.end({ timeout: 5 });
});

/** Valid PDF bytes that differ by `tag`, so each has its own hash. */
const pdf = (tag: string) => Buffer.from(`%PDF-1.4 e2e ${tag} ${Date.now()}`);

test('flow 7: a receipt becomes a posted entry with the receipt attached, and a repeat is caught', async ({ page }) => {
  const first = pdf('first');

  // --- Open the Assistant and drop a receipt ---------------------------------------------------
  await page.goto('/dashboard', { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Assistant' }).click();
  await expect(page.getByRole('dialog', { name: 'Receipts' })).toBeVisible();
  await page.getByLabel('Choose receipts').setInputFiles({ name: 'sugar-run.pdf', mimeType: 'application/pdf', buffer: first });

  // --- The proposal ------------------------------------------------------------------------------
  const card = page.getByRole('region', { name: VENDOR }).first();
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card.locator('header')).toContainText('$42.10');
  await expect(card.getByText('Packaging Materials (1330)')).toBeVisible();
  await expect(card.getByLabel('Paid by')).not.toHaveValue('');

  // --- Post it -------------------------------------------------------------------------------------
  await card.getByRole('button', { name: 'Post', exact: true }).click();
  await toast(page, /Posted entry #\d+/);
  await expect(card.getByText('Posted', { exact: true })).toBeVisible();

  // The entry: packaging debited, the paying member credited, the same cents, source recorded.
  const rows = await sql<{ id: string; code: string; debit: string; credit: string }[]>`
    select e.id, a.code, l.debit_cents::text as debit, l.credit_cents::text as credit
      from journal_entries e
      join journal_lines l on l.entry_id = e.id
      join accounts a on a.id = l.account_id
     where e.source_type = 'purchase_receipt' and e.memo = ${`Receipt — ${VENDOR}`}
     order by l.line_no`;
  expect(rows).toHaveLength(2);
  expect(rows.find((r) => r.code === '1330')).toMatchObject({ debit: '4210', credit: '0' });
  expect(rows.find((r) => r.code === memberAccountCode)).toMatchObject({ debit: '0', credit: '4210' });
  const entryId = rows[0].id;

  // --- The same file again is recognised, not filed twice ----------------------------------------
  await page.getByLabel('Choose receipts').setInputFiles({ name: 'renamed.pdf', mimeType: 'application/pdf', buffer: first });
  await toast(page, /Already posted as entry #\d+/);
  await expect(page.getByRole('region', { name: VENDOR })).toHaveCount(1);

  // --- A different receipt that repeats the vendor, date and total is flagged --------------------
  await page.getByLabel('Choose receipts').setInputFiles({ name: 'again.pdf', mimeType: 'application/pdf', buffer: pdf('second') });
  const second = page.getByRole('region', { name: VENDOR }).first();
  await expect(second).toContainText('already posted as entry', { timeout: 30_000 });
  await expect(second.getByRole('button', { name: 'Post anyway' })).toBeVisible();

  // --- Typed corrections degrade gracefully with no model, and the controls still work ----------
  await page.getByLabel('Tell me what to change').fill('the sugar is ingredients');
  await page.getByRole('button', { name: 'Send' }).click();
  await toast(page, /No AI model is set up/);

  await second.getByRole('button', { name: 'Skip' }).click();
  await expect(second.getByText('Skipped', { exact: true })).toBeVisible();

  // --- The receipt opens from the entry ------------------------------------------------------------
  await page.goto(`/ledger/${entryId}`, { waitUntil: 'networkidle' });
  await expect(page.getByRole('link', { name: /sugar-run\.pdf/ })).toBeVisible();
});

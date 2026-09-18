/**
 * Flow 4 — payables: a vendor bill with an ingredient line capitalized to inventory and a
 * supplies line expensed, approved, checked in the AP aging and in inventory, then paid.
 */
import { randomUUID } from 'node:crypto';

import { expect, test } from './support/test';
import type { Page } from '@playwright/test';

import { connect, type Sql } from './support/db';
import { booksToday, centsFromText, pickAccount, pickOption, pickParty, toast } from './support/ui';

let sql: Sql;

test.beforeAll(() => {
  sql = connect();
});

test.afterAll(async () => {
  await sql.end({ timeout: 5 });
});

async function apAgingTotal(page: Page, vendor: string): Promise<number | null> {
  await page.goto('/purchases/aging');
  await expect(page.getByRole('heading', { level: 1, name: 'Payables aging' })).toBeVisible();
  const row = page.locator('tbody tr').filter({ hasText: vendor });
  if ((await row.count()) === 0) return null;
  return centsFromText(await row.first().locator('td').last().innerText());
}

/** The account picker on one bill line. */
function lineAccount(page: Page, line: number) {
  return page
    .getByRole('row')
    .filter({ has: page.getByLabel(`Description, line ${line}`) })
    .locator('button[aria-haspopup="dialog"]');
}

/** The Materials station on the inventory overview: what the ledger carries in 1320 and 1330. */
async function materialsCents(page: Page): Promise<number> {
  await page.goto('/inventory');
  const station = page.locator('ol > li').filter({ hasText: '1320 · 1330' });
  await expect(station).toBeVisible();
  return centsFromText(await station.locator('[data-slot="station-value"]').innerText());
}

test('flow 4: vendor bill with an inventory line, AP aging, inventory, paid', async ({ page }) => {
  const vendor = `E2E Botanicals ${randomUUID().slice(0, 6)}`;
  const billNo = `E2E-${randomUUID().slice(0, 8).toUpperCase()}`;

  const materialsBefore = await materialsCents(page);

  // --- A new ingredient supplier ---------------------------------------------------------------
  await page.goto('/purchases/vendors', { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'New vendor' }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.locator('#v-name').fill(vendor);
  await dialog.getByRole('button', { name: 'Add vendor' }).click();
  await toast(page, `${vendor} added`);

  // --- The bill: 5 kg of hibiscus capitalized to 1320, and shipping supplies expensed ----------
  await page.goto('/purchases/bills/new', { waitUntil: 'networkidle' });
  await pickParty(page, page.locator('#bill-vendor'), vendor);
  await page.locator('#bill-no').fill(billNo);
  await expect(page.locator('#bill-date')).toHaveValue(booksToday());

  await page.getByLabel('Description, line 1').fill('Hibiscus flower, 5 kg');
  const capitalize = page.getByRole('checkbox', { name: 'Capitalize line 1 to inventory' });
  if ((await capitalize.getAttribute('aria-checked')) !== 'true') await capitalize.click();
  await pickAccount(page, lineAccount(page, 1), '1320');
  await page.getByLabel('Quantity, line 1').fill('5');
  await page.getByLabel('Unit cost, line 1').fill('40.00');

  await page.getByRole('button', { name: /Add line/ }).click();
  await page.getByLabel('Description, line 2').fill('Shipping boxes');
  await pickAccount(page, lineAccount(page, 2), '6740');
  await page.getByLabel('Amount, line 2').fill('25.00');

  const summary = page.locator('dl').filter({ hasText: 'Inventory' }).filter({ hasText: 'Expense' });
  await expect(summary).toContainText('200.00');
  await expect(summary).toContainText('25.00');
  await expect(summary).toContainText('$225.00');

  await page.getByRole('button', { name: 'Approve bill' }).click();
  const approved = await toast(page, /Bill .+ approved/);
  expect(approved).toContain(billNo);
  await expect(page).toHaveURL(/\/purchases\/bills\/[0-9a-f-]{36}$/);
  const billUrl = page.url();
  await expect(page.getByRole('link', { name: /Entry #\d+/ })).toBeVisible();

  const lines = await sql<{ is_inventory: boolean; code: string; amount_cents: string }[]>`
    select l.is_inventory, a.code, l.amount_cents::text
      from bill_lines l join bills b on b.id = l.bill_id join accounts a on a.id = l.account_id
     where b.bill_no = ${billNo} order by l.line_no`;
  expect(lines.map((l) => [l.is_inventory, l.code, Number(l.amount_cents)])).toEqual([
    [true, '1320', 20_000],
    [false, '6740', 2_500],
  ]);

  // --- AP aging and inventory ---------------------------------------------------------------------
  expect(await apAgingTotal(page, vendor)).toBe(22_500);
  expect(await materialsCents(page)).toBe(materialsBefore + 20_000);

  // --- Paid in full from the operating account ------------------------------------------------------
  await page.goto(billUrl, { waitUntil: 'networkidle' });
  await page.getByRole('link', { name: 'Pay bill' }).click();
  await expect(page).toHaveURL(/\/purchases\/payments\/new/);
  await expect(page.getByRole('checkbox', { name: new RegExp(`Apply to ${billNo}`) })).toBeChecked();
  await pickOption(page, page.locator('#md-account'), /1011/);
  await page.getByRole('button', { name: 'Record payment' }).click();
  await toast(page, /Payment .+ recorded/);
  await expect(page).toHaveURL(/\/purchases\/payments\/[0-9a-f-]{36}$/);

  await page.goto(billUrl, { waitUntil: 'networkidle' });
  await expect(page.locator('[data-slot="badge"]', { hasText: /^Paid$/ })).toBeVisible();
  const [bill] = await sql<{ status: string; paid_cents: string }[]>`
    select status, paid_cents::text from bills where bill_no = ${billNo}`;
  expect(bill.status).toBe('paid');
  expect(Number(bill.paid_cents)).toBe(22_500);

  expect(await apAgingTotal(page, vendor)).toBeNull();
  // Paying the bill moves cash and AP; the hibiscus stays in inventory.
  expect(await materialsCents(page)).toBe(materialsBefore + 20_000);
});

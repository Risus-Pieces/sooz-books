/**
 * Flow 3 — receivables: a new customer, an invoice drafted and issued, a partial payment,
 * the aging, and the balance paid off.
 */
import { randomUUID } from 'node:crypto';

import { expect, test } from './support/test';
import type { Page } from '@playwright/test';

import { connect, type Sql } from './support/db';
import { booksToday, centsFromText, pickOption, pickParty, toast } from './support/ui';

let sql: Sql;

test.beforeAll(() => {
  sql = connect();
});

test.afterAll(async () => {
  await sql.end({ timeout: 5 });
});

/** The customer's row in the aging table, and its total (the last column). */
async function agingTotal(page: Page, customer: string): Promise<number | null> {
  await page.goto('/sales/aging');
  await expect(page.getByRole('heading', { level: 1, name: 'Receivables aging' })).toBeVisible();
  const row = page.locator('tbody tr').filter({ hasText: customer });
  if ((await row.count()) === 0) return null;
  return centsFromText(await row.first().locator('td').last().innerText());
}

async function recordReceipt(page: Page, invoiceNo: string, amount: string): Promise<string> {
  await page.getByRole('link', { name: 'Record payment' }).click();
  await expect(page).toHaveURL(/\/sales\/receipts\/new/);
  const applied = page.getByLabel(`Amount applied to ${invoiceNo}`);
  await expect(applied).toBeVisible();
  await applied.fill(amount);
  await pickOption(page, page.locator('#md-account'), /1040/);
  await page.locator('#md-ref').fill(`CHK-${randomUUID().slice(0, 6)}`);
  await page.getByRole('button', { name: 'Record receipt' }).click();
  const message = await toast(page, /Receipt .+ recorded/);
  await expect(page).toHaveURL(/\/sales\/receipts\/[0-9a-f-]{36}$/);
  return message;
}

test('flow 3: customer, invoice, partial receipt, aging, paid off', async ({ page }) => {
  const customer = `E2E Café ${randomUUID().slice(0, 6)}`;

  // --- A customer on net 30 -------------------------------------------------------------
  await page.goto('/sales/customers', { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'New customer' }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.locator('#c-name').fill(customer);
  await dialog.locator('#c-email').fill('ap@e2e-cafe.invalid');
  await dialog.getByRole('button', { name: 'Net 30', exact: true }).click();
  await dialog.getByRole('button', { name: 'Add customer' }).click();
  await toast(page, `${customer} added`);
  await expect(page.getByText(customer)).toBeVisible();

  // --- An invoice: drafted first, then issued --------------------------------------------
  await page.goto('/sales/invoices/new', { waitUntil: 'networkidle' });
  await pickParty(page, page.locator('#inv-customer'), customer);
  await expect(page.locator('#inv-date')).toHaveValue(booksToday());
  await page.getByLabel('Description, line 1').fill('Hibiscus ginger, case of 12');
  await page.getByLabel('Quantity, line 1').fill('10');
  await page.getByLabel('Unit price, line 1').fill('36.00');
  await expect(page.getByText('$360.00').first()).toBeVisible();
  await page.getByRole('button', { name: 'Save draft' }).click();
  const drafted = await toast(page, /saved as a draft/);
  const invoiceNo = drafted.replace(/ saved as a draft[\s\S]*/, '').trim();
  await expect(page).toHaveURL(/\/sales\/invoices\/[0-9a-f-]{36}$/);
  const invoiceUrl = page.url();
  await expect(page.getByRole('heading', { level: 1, name: invoiceNo })).toBeVisible();

  page.once('dialog', (confirm) => void confirm.accept());
  await page.getByRole('button', { name: 'Issue invoice' }).click();
  await toast(page, `${invoiceNo} issued`);
  await expect(page.getByRole('link', { name: /Entry #\d+/ })).toBeVisible();

  const [issued] = await sql<{ status: string; total_cents: string; journal_entry_id: string | null }[]>`
    select i.status, i.total_cents::text, i.journal_entry_id
      from invoices i join customers c on c.id = i.customer_id
     where c.name = ${customer}`;
  expect(issued.status).toBe('open');
  expect(Number(issued.total_cents)).toBe(36_000);
  expect(issued.journal_entry_id).not.toBeNull();

  expect(await agingTotal(page, customer)).toBe(36_000);

  // --- A partial payment ----------------------------------------------------------------------
  await page.goto(invoiceUrl, { waitUntil: 'networkidle' });
  await recordReceipt(page, invoiceNo, '150.00');
  await page.goto(invoiceUrl, { waitUntil: 'networkidle' });
  await expect(page.locator('[data-slot="badge"]', { hasText: /^Part paid$/ })).toBeVisible();
  await expect(page.getByText('Balance due').locator('..')).toContainText('$210.00');

  // --- The aging now shows what is still owed ------------------------------------------------
  expect(await agingTotal(page, customer)).toBe(21_000);

  // --- Paid off ---------------------------------------------------------------------------------
  await page.goto(invoiceUrl, { waitUntil: 'networkidle' });
  await recordReceipt(page, invoiceNo, '210.00');
  await page.goto(invoiceUrl, { waitUntil: 'networkidle' });
  await expect(page.locator('[data-slot="badge"]', { hasText: /^Paid$/ })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Record payment' })).toHaveCount(0);

  const [paid] = await sql<{ status: string; open_cents: string }[]>`
    select i.status,
           (i.total_cents - coalesce((select sum(a.amount_cents + a.discount_cents) from receipt_applications a
                                       where a.invoice_id = i.id), 0))::text as open_cents
      from invoices i join customers c on c.id = i.customer_id
     where c.name = ${customer}`;
  expect(paid.status).toBe('paid');
  expect(Number(paid.open_cents)).toBe(0);
  expect(await agingTotal(page, customer)).toBeNull();
});

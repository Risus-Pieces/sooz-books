/**
 * Flow 6 — the month-end close refuses while a draft entry sits in the month, and closes once
 * the draft is resolved. The month is a throwaway past one no other flow posts into, and it is
 * reopened at the end: nothing here leaves a month closed.
 */
import { expect, test } from './support/test';
import type { Page } from '@playwright/test';

import { connect, type Sql } from './support/db';
import { day, monthFromNow, pickAccount, toast } from './support/ui';

const MONTH = monthFromNow(-2);
const DRAFT_TASK = 'No draft entries in the month';

let sql: Sql;

test.beforeAll(() => {
  sql = connect();
});

test.afterAll(async () => {
  // Whatever happened above, the month is left open and without the test's draft.
  await sql`update periods set status = 'open', closed_at = null, closed_by = null
             where year = ${MONTH.year} and month = ${MONTH.month}`;
  await sql`delete from journal_entries where status = 'draft' and memo like 'E2E close-flow draft%'`;
  await sql.end({ timeout: 5 });
});

async function periodStatus(): Promise<string> {
  const rows = await sql<{ status: string }[]>`select status from periods where year = ${MONTH.year} and month = ${MONTH.month}`;
  return rows[0]?.status ?? 'open';
}

function task(page: Page, label: string) {
  return page.locator('ol > li').filter({ has: page.getByText(label, { exact: true }) });
}

test('flow 6: a draft in the month blocks the close; resolved, the month closes and reopens', async ({ page }) => {
  const memo = `E2E close-flow draft ${Date.now()}`;

  // --- A draft entry dated in the month --------------------------------------------------------
  // Wait for hydration: a value typed into a controlled input before React takes over the page
  // is silently replaced by the component's own default.
  await page.goto('/ledger/new', { waitUntil: 'networkidle' });
  await page.locator('#entry-date').fill(day(MONTH, 10));
  await page.locator('#entry-memo').fill(memo);
  const rows = page.locator('table').filter({ has: page.locator('caption', { hasText: 'Journal entry lines' }) }).locator('tbody tr');
  await pickAccount(page, rows.nth(0).locator('button[aria-haspopup="dialog"]'), '6740');
  await rows.nth(0).getByLabel('Debit').fill('12.34');
  await pickAccount(page, rows.nth(1).locator('button[aria-haspopup="dialog"]'), '1040');
  await rows.nth(1).getByLabel('Credit').fill('12.34');
  await expect(page.locator('#entry-date')).toHaveValue(day(MONTH, 10));
  await page.getByRole('button', { name: 'Save draft' }).click();
  await toast(page, /Draft #\d+ saved/);
  await expect(page).toHaveURL(/\/ledger\/[0-9a-f-]{36}$/);
  const draftUrl = page.url();

  // --- Start the close for that month ------------------------------------------------------------
  await page.goto(`/close?month=${MONTH.key}`, { waitUntil: 'networkidle' });
  const title = page.getByText(/^Checklist · /);
  await expect(title).toBeVisible();
  const monthLabel = (await title.innerText()).replace(/^Checklist · /, '').trim();
  const start = page.getByRole('button', { name: 'Start the close' });
  const rerun = page.getByRole('button', { name: 'Re-run checks' });
  await expect(start.or(rerun)).toBeVisible();
  if (await start.isVisible()) {
    await start.click();
    await toast(page, `${monthLabel} close started`);
  } else {
    // A checklist from an earlier run of the suite on this database: record the checks afresh.
    await rerun.click();
    await toast(page, 'Checks recorded');
  }
  await expect(rerun).toBeVisible();

  // The draft check names what is wrong.
  await expect(task(page, DRAFT_TASK)).toContainText(/draft/i);
  await expect(task(page, DRAFT_TASK).locator('p.text-negative')).toBeVisible();

  // Every other blocking task still outstanding is skipped with a reason, so the draft is the
  // only thing standing in the way.
  const standing = page.locator('p.eyebrow', { hasText: 'Standing in the way' }).locator('..').locator('li');
  for (let guard = 0; guard < 20; guard += 1) {
    const labels = (await standing.allInnerTexts()).map((text) => text.trim()).filter((text) => text !== DRAFT_TASK);
    if (labels.length === 0) break;
    await task(page, labels[0]).getByRole('button', { name: 'Skip' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('#close-note').fill('Throwaway month in the end-to-end suite.');
    await dialog.getByRole('button', { name: 'Skip task' }).click();
    await toast(page, `${labels[0]}: skipped`);
    await expect(dialog).toBeHidden();
    await expect(standing.filter({ hasText: labels[0] })).toHaveCount(0);
  }
  await expect(standing).toHaveText([DRAFT_TASK]);

  // --- The close is refused while the draft is there ---------------------------------------------
  await page.getByRole('button', { name: `Close ${monthLabel}` }).click();
  await toast(page, 'Not done');
  const refusal = page.getByText('The close was refused').locator('..');
  await expect(refusal).toBeVisible();
  await expect(refusal).toContainText(DRAFT_TASK);
  expect(await periodStatus()).toBe('open');

  // --- Resolve it: the draft is deleted ------------------------------------------------------------
  await page.goto(draftUrl, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Delete draft' }).click();
  await toast(page, 'Draft deleted');

  // --- Now it closes -------------------------------------------------------------------------------
  await page.goto(`/close?month=${MONTH.key}`, { waitUntil: 'networkidle' });
  await rerun.click();
  await toast(page, 'Checks recorded');
  await expect(page.getByText('Every blocking task is done or skipped with a reason.')).toBeVisible();
  await page.getByRole('button', { name: `Close ${monthLabel}` }).click();
  await toast(page, `${monthLabel} closed`);
  await expect(page.getByText(`${monthLabel} is closed`)).toBeVisible();
  expect(await periodStatus()).toBe('closed');

  // Nothing posts into a closed month.
  await page.goto('/ledger/new', { waitUntil: 'networkidle' });
  await page.locator('#entry-date').fill(day(MONTH, 12));
  await expect(page.getByText(new RegExp(`${MONTH.key} is closed`)).first()).toBeVisible();

  // --- Reopen it: this was a throwaway month --------------------------------------------------------
  await page.goto(`/close?month=${MONTH.key}`, { waitUntil: 'networkidle' });
  const history = page.locator('tr').filter({ hasText: monthLabel });
  await history.getByRole('button', { name: /Reopen/ }).click();
  const reopen = page.getByRole('dialog');
  await reopen.locator('#reopen-month').fill(MONTH.key);
  await reopen.getByRole('button', { name: 'Reopen the month' }).click();
  await toast(page, `${monthLabel} reopened`);
  expect(await periodStatus()).toBe('open');
});

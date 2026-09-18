/**
 * Flows 1 and 2 — a month of bank activity from statement to reconciled books.
 *
 *   1. Import a synthetic Relay statement into a throwaway account (and the other leg of a
 *      transfer into a second one); the review queue shows every row with its suggestion;
 *      accept one, split one, mark one personal, confirm the transfer pair, post the
 *      auto-post rule's match; the journal holds the entries; the P&L and balance sheet
 *      reflect them; the trial balance ties.
 *   2. Reconcile the account for that month to a $0.00 difference and complete it; a
 *      reconciled row can no longer be unposted.
 *
 * The statement is last month's, so it shares a period with nothing the other flows post.
 */
import { expect, test } from './support/test';
import type { Page } from '@playwright/test';

import { connect, createThrowawayBank, postedBalance, type Sql, type ThrowawayBank } from './support/db';
import {
  centsFromText,
  day,
  monthFromNow,
  noErrorToast,
  pickAccount,
  relayDate,
  reportFigure,
  reportFigureOrZero,
  toast,
} from './support/ui';

const MONTH = monthFromNow(-1);

interface StatementRow {
  date: string;
  payee: string;
  accountNo: string;
  type: string;
  description: string;
  reference: string;
  amountCents: number;
}

/** A Relay export: newest first, a running balance on every row, signed amounts. */
function relayCsv(rows: readonly StatementRow[], openingCents: number): Buffer {
  const chronological = [...rows].sort((a, b) => a.date.localeCompare(b.date));
  let balance = openingCents;
  const lines = chronological.map((row) => {
    balance += row.amountCents;
    const amount = `${row.amountCents < 0 ? '-' : '+'}${(Math.abs(row.amountCents) / 100).toFixed(2)}`;
    const quote = (value: string) => `"${value.replace(/"/g, '""')}"`;
    return [
      relayDate(row.date),
      row.payee,
      row.accountNo,
      row.type,
      row.description,
      quote(row.reference),
      'SETTLED',
      amount,
      'USD',
      (balance / 100).toFixed(2),
    ].join(',');
  });
  const header = 'Date,Payee,Account #,Transaction Type,Description,Reference,Status,Amount,Currency,Balance';
  return Buffer.from([header, ...lines.reverse()].join('\n') + '\n', 'utf8');
}

// Shared by the serial steps below.
let sql: Sql;
let bankA: ThrowawayBank;
let bankB: ThrowawayBank;
const posted: Record<string, number> = {};

/** The queue row for one statement line on one of this run's accounts. */
function queueRow(page: Page, payee: string, bank: ThrowawayBank) {
  return page.locator(`[data-row-id][data-bank-mask="${bank.mask}"]`).filter({ hasText: payee });
}

/** The selected transaction's detail pane, beside the list. */
function detail(page: Page) {
  return page.locator('[data-slot="detail-pane"]');
}

/** The Mail-style toolbar over the detail pane. */
function actions(page: Page) {
  return page.getByRole('toolbar', { name: 'Transaction' });
}

async function openRow(page: Page, payee: string, bank: ThrowawayBank): Promise<void> {
  const row = queueRow(page, payee, bank);
  await expect(row).toHaveCount(1);
  // A click on a row shows it in the detail pane beside the list.
  await row.click();
  await expect(row).toHaveAttribute('aria-current', 'true');
  // The pane shows that row: its payee (a heading, or the statement line for a transfer leg) and bank.
  await expect(detail(page).getByRole('heading', { level: 2 })).toBeVisible();
  await expect(detail(page)).toContainText(payee);
  await expect(detail(page)).toContainText(`••${bank.mask}`);
}

async function importStatement(page: Page, bank: ThrowawayBank, csv: Buffer, expectNew: number) {
  await page.goto('/banking/import', { waitUntil: 'networkidle' });
  await page.locator('input[type="file"]').setInputFiles({
    name: `Relay ${MONTH.first} #${bank.mask}.csv`,
    mimeType: 'text/csv',
    buffer: csv,
  });
  // Relay names the account in the filename; the wizard reads it from there.
  await expect(page.locator('#import-account')).toContainText(bank.name);
  await page.getByRole('button', { name: 'Preview import' }).click();

  const commit = page.getByRole('button', { name: `Import ${expectNew} new` });
  await expect(commit).toBeEnabled();
  await expect(page.getByText('Relay', { exact: false }).first()).toBeVisible();
  await commit.click();
  await toast(page, `Imported ${expectNew} transaction${expectNew === 1 ? '' : 's'}`);
}

test.describe.serial('bank statement to reconciled month', () => {
  test.beforeAll(async () => {
    sql = connect();
    bankA = await createThrowawayBank(sql, 'Operating');
    bankB = await createThrowawayBank(sql, 'Reserve');
  });

  test.afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  test('flow 1: import, review, post, and read the statements', async ({ page }) => {
    const statementA: StatementRow[] = [
      {
        date: day(MONTH, 2),
        payee: 'Adv SafeBalance Banking',
        accountNo: '',
        type: 'Receive',
        description: '',
        reference: 'ACH Pull',
        amountCents: 200_000,
      },
      {
        date: day(MONTH, 5),
        payee: bankB.name,
        accountNo: bankB.mask,
        type: 'Spend-transfer',
        description: '',
        reference: 'Transfer',
        amountCents: -10_000,
      },
      {
        date: day(MONTH, 8),
        payee: 'Blue Pacific Flavors',
        accountNo: '',
        type: 'Spend',
        description: '',
        reference: 'PO SOOZ-E2E / hibiscus and bottles - Sent By Boxuan Zhao',
        amountCents: -50_000,
      },
      {
        date: day(MONTH, 12),
        payee: 'Andrew Firestone',
        accountNo: '',
        type: 'Spend',
        description: '',
        reference: 'Sooz Beverage Formulation Work - Sent By Boxuan Zhao',
        amountCents: -30_000,
      },
      {
        date: day(MONTH, 15),
        payee: 'Target',
        accountNo: '',
        type: 'Spend',
        description: 'Unknown',
        reference: 'Corporate Card - 1892 (Business Card)',
        amountCents: -2_345,
      },
    ];
    const statementB: StatementRow[] = [
      {
        date: day(MONTH, 5),
        payee: bankA.name,
        accountNo: bankA.mask,
        type: 'Receive-transfer',
        description: '',
        reference: 'Transfer',
        amountCents: 10_000,
      },
    ];

    const pnlUrl = `/reports/profit-loss?from=${MONTH.first}&to=${MONTH.last}`;
    await page.goto(pnlUrl);
    const formulationBefore = await reportFigureOrZero(page, 'Formulation');
    const netIncomeBefore = await reportFigure(page, /^Net income/i);
    const bsUrl = `/reports/balance-sheet?from=${MONTH.first}&to=${MONTH.last}`;
    await page.goto(bsUrl);
    const bsBefore = {
      raw: await reportFigureOrZero(page, 'Raw Ingredients'),
      packaging: await reportFigureOrZero(page, 'Packaging Materials'),
      contributions: await reportFigureOrZero(page, 'Member Contributions'),
      draws: await reportFigureOrZero(page, 'Owner Draws'),
    };

    // --- Import -----------------------------------------------------------------------
    await importStatement(page, bankA, relayCsv(statementA, 0), 5);
    await importStatement(page, bankB, relayCsv(statementB, 0), 1);
    await expect(page.getByText('Transfers paired').locator('..')).toContainText('1');

    // --- The queue shows every row with what proposed its account ------------------------
    await page.goto('/banking/review', { waitUntil: 'networkidle' });
    // Each row names the account its suggestion posts to (6310, 1320, 6740).
    await expect(queueRow(page, 'Andrew Firestone', bankA)).toContainText('Formulation & Bench Work');
    await expect(queueRow(page, 'Blue Pacific Flavors', bankA)).toContainText('Raw Ingredients');
    await expect(queueRow(page, 'Target', bankA)).toContainText('Office Supplies & Postage');
    await expect(queueRow(page, bankB.name, bankA)).toContainText(/Transfer to/);
    await expect(queueRow(page, bankA.name, bankB)).toContainText(/Transfer from/);
    for (const payee of ['Andrew Firestone', 'Blue Pacific Flavors', 'Target']) {
      await expect(queueRow(page, payee, bankA)).toContainText(/Rule/i);
    }
    // The ACH pull from the founder's account matched an owner-marked auto-post rule, so it
    // waits in "Ready to post" rather than in review.
    await expect(queueRow(page, 'Adv SafeBalance Banking', bankA)).toHaveCount(0);

    // --- Accept one, as suggested -------------------------------------------------------
    await openRow(page, 'Andrew Firestone', bankA);
    await detail(page).getByRole('button', { name: /^Accept/ }).click();
    posted.accept = Number((await toast(page, /Posted as entry #\d+/)).match(/#(\d+)/)?.[1]);
    await expect(queueRow(page, 'Andrew Firestone', bankA)).toHaveCount(0);

    // --- Keys on a focused button belong to the button, never to the queue -------------------
    // Enter on the "Flagged" segment chooses it; "x" there excludes nothing. Enter on "All" returns.
    const flagged = page.getByRole('radio', { name: /^Flagged/ });
    const all = page.getByRole('radio', { name: 'All', exact: true });
    await flagged.focus();
    await page.keyboard.press('x');
    await page.keyboard.press('Enter');
    await expect(flagged).toHaveAttribute('aria-checked', 'true');
    await all.focus();
    await page.keyboard.press('x');
    await page.keyboard.press('Enter');
    await expect(flagged).toHaveAttribute('aria-checked', 'false');
    await expect(queueRow(page, 'Blue Pacific Flavors', bankA)).toHaveCount(1);

    // --- Split one: ingredients and packaging, both capitalized ---------------------------
    // Enter on the focused Split button opens the split; it does not post the row as suggested.
    await openRow(page, 'Blue Pacific Flavors', bankA);
    await actions(page).getByRole('button', { name: /^Split/ }).focus();
    await page.keyboard.press('Enter');
    const split = page.getByRole('dialog');
    await expect(split.getByRole('heading', { name: 'Split Blue Pacific Flavors' })).toBeVisible();
    await split.getByLabel('Amount for line 1').fill('350.00');
    await pickAccount(page, split.getByRole('button', { name: /Account for line 2/ }), '1330');
    await split.getByLabel('Amount for line 2').fill('150.00');
    await split.getByLabel('Memo for line 2').fill('Bottles');
    await expect(split.getByText('Fully allocated')).toBeVisible();
    await split.getByRole('button', { name: 'Post split' }).click();
    posted.split = Number((await toast(page, /Split posted as entry #\d+/)).match(/#(\d+)/)?.[1]);

    // --- Mark one personal: a mixed-use payee the owner re-tags to Owner Draws -------------
    await openRow(page, 'Target', bankA);
    await actions(page).getByRole('button', { name: /^Personal/ }).click();
    posted.personal = Number((await toast(page, /Posted to Owner Draws as entry #\d+/)).match(/#(\d+)/)?.[1]);

    // --- Confirm the transfer pair ---------------------------------------------------------
    await openRow(page, bankB.name, bankA);
    await detail(page).getByRole('button', { name: /^Post transfer/ }).click();
    posted.transfer = Number((await toast(page, /Transfer posted as entry #\d+/)).match(/#(\d+)/)?.[1]);
    await expect(queueRow(page, bankA.name, bankB)).toHaveCount(0);
    await noErrorToast(page);

    // --- Post what the owner's auto-post rule coded ------------------------------------------
    await page.goto('/banking/review?stage=ready', { waitUntil: 'networkidle' });
    await expect(queueRow(page, 'Adv SafeBalance Banking', bankA)).toContainText('Member Contributions');
    await page.getByRole('button', { name: /Post .*auto-post/i }).click();
    const confirmAuto = page.getByRole('dialog');
    await expect(confirmAuto).toContainText('your auto-post rules coded');
    await confirmAuto.getByRole('button', { name: /^Post \d+$/ }).click();
    await toast(page, /Posted \d+ auto-post transaction/);
    await expect(queueRow(page, 'Adv SafeBalance Banking', bankA)).toHaveCount(0);

    // --- The ledger holds exactly what was decided -------------------------------------------
    for (const [what, entryNo] of Object.entries(posted)) {
      expect(Number.isSafeInteger(entryNo) && entryNo > 0, `${what} produced an entry number`).toBe(true);
    }
    expect(await postedBalance(sql, bankA.glCode, MONTH.first, MONTH.last)).toBe(200_000 - 10_000 - 50_000 - 30_000 - 2_345);
    expect(await postedBalance(sql, bankB.glCode, MONTH.first, MONTH.last)).toBe(10_000);

    await page.goto(`/ledger?from=${MONTH.first}&to=${MONTH.last}`);
    // Each journal row is a link carrying its entry number; choosing one shows it beside the list.
    const journalRow = (entryNo: number) => page.getByRole('link', { name: new RegExp(`#${entryNo}(?!\\d)`) });
    for (const entryNo of Object.values(posted)) {
      await expect(journalRow(entryNo)).toBeVisible();
    }
    await journalRow(posted.split).click();
    await expect(journalRow(posted.split)).toHaveAttribute('aria-current', 'true');
    await page.getByRole('link', { name: 'Open entry', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: `Entry #${posted.split}` })).toBeVisible();
    const lines = page.locator('table').filter({ hasText: 'Debit' }).last();
    await expect(lines).toContainText('1320');
    await expect(lines).toContainText('1330');
    await expect(lines).toContainText(bankA.glCode);

    // --- P&L: the consultant is an expense; inventory, draws and transfers are not -----------
    await page.goto(pnlUrl);
    expect(await reportFigure(page, 'Formulation')).toBe(formulationBefore + 30_000);
    expect(await reportFigure(page, /^Net income/i)).toBe(netIncomeBefore - 30_000);

    // --- Balance sheet: this account, inventory, and the founder's equity --------------------
    await page.goto(bsUrl);
    expect(await reportFigure(page, bankA.name)).toBe(107_655);
    // Ingredients and packaging capitalized, not expensed.
    expect(await reportFigure(page, 'Raw Ingredients')).toBe(bsBefore.raw + 35_000);
    expect(await reportFigure(page, 'Packaging Materials')).toBe(bsBefore.packaging + 15_000);
    // The founder's ACH pull is a member contribution, never revenue; the personal purchase a draw.
    expect(await reportFigure(page, 'Member Contributions')).toBe(bsBefore.contributions + 200_000);
    expect(await reportFigure(page, 'Owner Draws')).toBe(bsBefore.draws - 2_345);
    expect(await reportFigure(page, bankB.name)).toBe(10_000);
    expect(await reportFigure(page, 'TOTAL ASSETS')).toBe(await reportFigure(page, 'TOTAL LIABILITIES & EQUITY'));
    await expect(page.locator('table tr').filter({ hasText: 'OUT OF BALANCE' })).toHaveCount(0);

    // --- Trial balance ties --------------------------------------------------------------------
    await page.goto(`/reports/trial-balance?from=${MONTH.first}&to=${MONTH.last}`);
    const totals = page.locator('table tr').filter({ has: page.locator('th[scope="row"]', { hasText: /^Total/i }) }).last();
    await expect(totals).toBeVisible();
    const cells = await totals.locator('td').allInnerTexts();
    const figures = cells.map(centsFromText).filter((cents) => cents !== 0);
    expect(figures.length).toBeGreaterThanOrEqual(2);
    expect(figures[0]).toBe(figures[1]);
  });

  test('flow 2: reconcile the month to $0.00, then the rows are locked', async ({ page }) => {
    await page.goto(`/banking/reconcile?account=${bankA.id}&month=${MONTH.key}`, { waitUntil: 'networkidle' });
    await expect(page.getByText(`Statement for`)).toBeVisible();
    await expect(page.locator('#recon-opening')).toHaveValue('0.00');
    await expect(page.locator('#recon-closing')).toHaveValue('1,076.55');
    await page.getByRole('button', { name: 'Start reconciliation' }).click();
    await toast(page, 'Reconciliation started');

    const difference = page.locator('[aria-live="polite"]').filter({ hasText: 'Difference' });
    const complete = page.getByRole('button', { name: /Complete and lock|Difference must be/ });

    // Tick every line the statement shows.
    const uncleared = page.locator('li label').filter({ has: page.getByRole('checkbox', { checked: false }) });
    await expect(page.getByText('Not yet cleared')).toBeVisible();
    for (let guard = 0; guard < 10 && (await uncleared.count()) > 0; guard += 1) {
      await uncleared.first().getByRole('checkbox').click();
    }
    await expect(difference).toContainText('$0.00');

    // Untick one: the difference moves and completing is refused until it is back.
    const firstCleared = page.locator('li label').filter({ has: page.getByRole('checkbox', { checked: true }) }).first();
    await firstCleared.getByRole('checkbox').click();
    await expect(difference).not.toContainText('$0.00');
    await expect(complete).toBeDisabled();
    await page.locator('li label').filter({ has: page.getByRole('checkbox', { checked: false }) }).first().getByRole('checkbox').click();
    await expect(difference).toContainText('$0.00');

    await expect(complete).toHaveText(/Complete and lock/);
    await complete.click();
    await toast(page, `Reconciled through ${MONTH.last}`);
    await expect(page.getByText(`Reconciled through ${MONTH.last}`).first()).toBeVisible();

    const [recon] = await sql<{ status: string; difference_cents: string }[]>`
      select status, difference_cents::text from reconciliations where bank_account_id = ${bankA.id}`;
    expect(recon.status).toBe('completed');
    expect(Number(recon.difference_cents)).toBe(0);

    // A reconciled row cannot be unposted: the books would no longer agree with the bank.
    await page.goto('/banking/review?stage=posted', { waitUntil: 'networkidle' });
    await openRow(page, 'Andrew Firestone', bankA);
    await actions(page).getByRole('button', { name: /^Unpost/ }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Unpost' }).click();
    await toast(page, /is reconciled and locked\. Undo the reconciliation before unposting it\./);
    await expect(queueRow(page, 'Andrew Firestone', bankA)).toHaveCount(1);
    const [row] = await sql<{ journal_entry_id: string | null; reconciliation_id: string | null }[]>`
      select journal_entry_id, reconciliation_id from bank_transactions
       where bank_account_id = ${bankA.id} and counterparty = 'Andrew Firestone'`;
    expect(row.journal_entry_id).not.toBeNull();
    expect(row.reconciliation_id).not.toBeNull();
    const reversals = await sql`select 1 from journal_entries where reverses_id = ${row.journal_entry_id}`;
    expect(reversals).toHaveLength(0);
  });
});

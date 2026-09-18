/**
 * The handful of gestures every flow repeats, written once so each spec reads as the steps a
 * bookkeeper takes rather than as selectors.
 */
import { expect, type Locator, type Page } from '@playwright/test';

// ---------------------------------------------------------------------------
// Dates — 'YYYY-MM-DD' strings in the books' time zone, never a local Date.
// ---------------------------------------------------------------------------

const BOOKS_TZ = 'America/Chicago';

/** Today in the books' time zone. */
export function booksToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: BOOKS_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date(),
  );
}

export interface Month {
  /** 'YYYY-MM' */
  key: string;
  year: number;
  month: number;
  first: string;
  last: string;
}

export function monthOf(year: number, month: number): Month {
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const mm = String(month).padStart(2, '0');
  return { key: `${year}-${mm}`, year, month, first: `${year}-${mm}-01`, last: `${year}-${mm}-${String(days).padStart(2, '0')}` };
}

/** The month `offset` months from the current one (-1 is last month). */
export function monthFromNow(offset: number): Month {
  const [y, m] = booksToday().split('-').map(Number);
  const index = y * 12 + (m - 1) + offset;
  return monthOf(Math.floor(index / 12), (index % 12) + 1);
}

/** A day of the month as 'YYYY-MM-DD'. */
export function day(month: Month, d: number): string {
  return `${month.key}-${String(d).padStart(2, '0')}`;
}

/** Relay prints dates as M/D/YYYY. */
export function relayDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return `${m}/${d}/${y}`;
}

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

/** "$1,076.55", "(23.45)", "−23.45", "+50.00", "—" → cents. */
export function centsFromText(text: string): number {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  if (trimmed === '' || trimmed === '—') return 0;
  const negative = /^\(.*\)$/.test(trimmed) || /^[−-]/.test(trimmed);
  const digits = trimmed.replace(/[^0-9.]/g, '');
  const [whole, fraction = '00'] = digits.split('.');
  const cents = Number(whole || '0') * 100 + Number(fraction.padEnd(2, '0').slice(0, 2));
  return negative ? -cents : cents;
}

// ---------------------------------------------------------------------------
// Pickers
// ---------------------------------------------------------------------------

/** Opens an account combobox and chooses the account with this code. */
export async function pickAccount(page: Page, trigger: Locator, code: string): Promise<void> {
  await trigger.click();
  const search = page.getByPlaceholder('Search by code or name');
  await search.fill(code);
  const option = page.getByRole('option').filter({ hasText: code }).first();
  await expect(option).toBeVisible();
  await option.click();
  await expect(search).toBeHidden();
}

/** Opens a customer or vendor combobox and chooses the party with this name. */
export async function pickParty(page: Page, trigger: Locator, name: string): Promise<void> {
  await trigger.click();
  const search = page.getByPlaceholder('Search by name');
  await search.fill(name);
  const option = page.getByRole('option').filter({ hasText: name }).first();
  await expect(option).toBeVisible();
  await option.click();
  await expect(search).toBeHidden();
}

/** Chooses an option of a Radix select by its visible text. */
export async function pickOption(page: Page, trigger: Locator, text: string | RegExp): Promise<void> {
  await trigger.click();
  await page.getByRole('option', { name: text }).first().click();
}

// ---------------------------------------------------------------------------
// Feedback
// ---------------------------------------------------------------------------

/** Waits for a toast whose text matches, and returns its full text. */
export async function toast(page: Page, text: string | RegExp): Promise<string> {
  const item = page.locator('[data-sonner-toast]').filter({ hasText: text }).last();
  await expect(item).toBeVisible();
  return (await item.innerText()).trim();
}

/** Fails fast when an action answered with an error toast instead. */
export async function noErrorToast(page: Page): Promise<void> {
  await expect(page.locator('[data-sonner-toast][data-type="error"]')).toHaveCount(0);
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

/** The figure in the last column of the report row whose label contains `label`. */
export async function reportFigure(page: Page, label: string | RegExp): Promise<number> {
  const row = page.locator('table tr').filter({ has: page.locator('th[scope="row"]', { hasText: label }) }).first();
  await expect(row).toBeVisible();
  const text = await row.locator('td').last().innerText();
  return centsFromText(text);
}

/** Same as reportFigure, but zero when the report has no such row (an account with no activity). */
export async function reportFigureOrZero(page: Page, label: string | RegExp): Promise<number> {
  const row = page.locator('table tr').filter({ has: page.locator('th[scope="row"]', { hasText: label }) });
  if ((await row.count()) === 0) return 0;
  return centsFromText(await row.first().locator('td').last().innerText());
}

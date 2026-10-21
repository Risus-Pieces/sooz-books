'use server';

/**
 * Every change the Bank Feeds pane can make.
 *
 * Each one checks `settings.manage`, hands the work to `@/lib/feeds`, turns a failure into the
 * `{ ok: false, error }` the pane shows as a toast, and revalidates Settings. Plaid's own messages
 * are written for people and are shown as they are; the text of a failed query never is.
 */

import { revalidatePath } from 'next/cache';
import { unstable_rethrow } from 'next/navigation';

import { isForbiddenError } from '@/lib/auth/roles';
import { requireCapability } from '@/lib/auth/session';
import { isQueryError, isUniqueViolation, postgresErrorOf } from '@/lib/db-errors';
import { connectItem, disconnectItem, feedsConfigured, mapAccount, startLink } from '@/lib/feeds/connect';
import { PlaidError } from '@/lib/feeds/plaid-client';
import { syncAllFeeds } from '@/lib/feeds/sync';
import type { ActionFailure, ActionResult } from '@/components/ledger/types';

import { type SyncSummary, isUuid, syncSummary } from '../_components/feeds-format';

export interface ConnectSummary {
  institution: string | null;
  accounts: number;
  /** Accounts matched to a bank account by their last four digits. */
  mapped: number;
}

function failure(error: unknown): ActionFailure {
  if (error instanceof PlaidError) return { code: error.code, message: error.message };
  if (isForbiddenError(error)) return { code: 'forbidden', message: error.message };
  if (isUniqueViolation(error, 'plaid_accounts_bank_account_id_key')) {
    return { code: 'taken', message: 'Another bank connection already feeds that account. Choose a different one.' };
  }
  if (isUniqueViolation(error, 'plaid_items_item_id_key')) {
    return { code: 'taken', message: 'This bank login is already connected.' };
  }
  const pg = postgresErrorOf(error);
  if (pg !== null) return { code: 'unexpected', message: `The database refused this change: ${pg.message}` };
  if (isQueryError(error)) return { code: 'unexpected', message: 'The database could not complete this request.' };
  if (error instanceof Error) return { code: 'unexpected', message: error.message };
  return { code: 'unexpected', message: 'Something went wrong.' };
}

function ok<T>(value: T): ActionResult<T> {
  return { ok: true, value };
}

function fail<T>(error: unknown): ActionResult<T> {
  // A redirect thrown by `requireUser` (an expired session) must reach Next, not become a toast.
  unstable_rethrow(error);
  return { ok: false, error: failure(error) };
}

function invalid<T>(message: string): ActionResult<T> {
  return { ok: false, error: { code: 'invalid', message } };
}

function notSetUp<T>(): ActionResult<T> {
  return { ok: false, error: { code: 'not_configured', message: 'The bank feed is not set up on this server yet.' } };
}

/** Settings, and the banking screens a new or re-pointed feed fills. */
function refreshFeeds(): void {
  revalidatePath('/settings/feeds');
  revalidatePath('/settings');
  revalidatePath('/banking');
}

/** A link token for Plaid Link, which the browser opens to sign in to the bank. */
export async function beginBankConnect(): Promise<ActionResult<{ linkToken: string }>> {
  try {
    const actor = await requireCapability('settings.manage');
    if (!feedsConfigured()) return notSetUp();
    return ok({ linkToken: await startLink(actor) });
  } catch (error) {
    return fail(error);
  }
}

/** Keeps the connection Plaid Link just made, and maps its accounts it can match. */
export async function finishBankConnect(publicToken: string): Promise<ActionResult<ConnectSummary>> {
  try {
    const actor = await requireCapability('settings.manage');
    if (!feedsConfigured()) return notSetUp();
    if (typeof publicToken !== 'string' || !/^public-[A-Za-z0-9-]{8,200}$/.test(publicToken)) {
      return invalid('Plaid did not hand back a usable sign-in. Try connecting again.');
    }
    const item = await connectItem(actor, publicToken);
    refreshFeeds();
    return ok({
      institution: item.institution,
      accounts: item.accounts.length,
      mapped: item.accounts.filter((a) => a.bankAccountName !== null).length,
    });
  } catch (error) {
    return fail(error);
  }
}

/**
 * Points one Plaid account at a bank account, or at none. The start date is left to the library:
 * the day after the last line the books already hold, so nothing comes in twice.
 */
export async function chooseFeedAccount(plaidAccountRowId: string, bankAccountId: string | null): Promise<ActionResult<null>> {
  try {
    const actor = await requireCapability('settings.manage');
    if (!isUuid(plaidAccountRowId)) return invalid('That bank feed account is not valid.');
    if (bankAccountId !== null && !isUuid(bankAccountId)) return invalid('That bank account is not valid.');
    await mapAccount(actor, { plaidAccountRowId, bankAccountId });
    refreshFeeds();
    return ok(null);
  } catch (error) {
    return fail(error);
  }
}

/** Stops a connection syncing and revokes it at Plaid. What it already brought in stays. */
export async function disconnectBank(plaidItemId: string): Promise<ActionResult<null>> {
  try {
    const actor = await requireCapability('settings.manage');
    if (!isUuid(plaidItemId)) return invalid('That bank connection is not valid.');
    await disconnectItem(actor, plaidItemId);
    refreshFeeds();
    return ok(null);
  } catch (error) {
    return fail(error);
  }
}

/** The nightly sync, now, run by the person who pressed the button. */
export async function syncBankFeedsNow(): Promise<ActionResult<SyncSummary>> {
  try {
    await requireCapability('settings.manage');
    if (!feedsConfigured()) return notSetUp();
    const run = await syncAllFeeds();
    refreshFeeds();
    revalidatePath('/banking/review');
    revalidatePath('/ledger');
    revalidatePath('/dashboard');
    return ok(syncSummary(run));
  } catch (error) {
    return fail(error);
  }
}

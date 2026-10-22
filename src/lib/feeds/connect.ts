/**
 * Connecting a bank through Plaid, and which of its accounts feed which bank account.
 *
 * The person signs in to the bank inside Plaid Link, Plaid's own window; this app only ever sees the
 * public token Link hands back, exchanges it for an access token, and stores that encrypted. Each of
 * the item's accounts is mapped to the bank account with the same last four digits (an owner can
 * change or remove the mapping in Settings), and syncs from the day after the latest transaction the
 * books already hold for it, so the CSV history and the feed never cover the same day twice.
 */
import { and, desc, eq, max } from 'drizzle-orm';

import { db, withActor } from '@/db/client';
import { bankAccounts, bankTransactions, plaidAccounts, plaidItems } from '@/db/schema';
import { requireCapability } from '@/lib/auth/roles';
import { type CalendarDate, isCalendarDate, today } from '@/lib/dates';
import type { LedgerDb } from '@/lib/ledger/post';
import type { AppRole } from '@/lib/types';

import { decryptToken, encryptToken } from './crypto';
import { type PlaidClient, PlaidError, createPlaidClient, plaidConfig } from './plaid-client';

export interface Actor {
  id: string;
  role: AppRole;
}

export interface ConnectDeps {
  client?: PlaidClient;
  env?: Readonly<Record<string, string | undefined>>;
  tx?: LedgerDb;
}

function clientFor(deps: ConnectDeps): PlaidClient {
  if (deps.client !== undefined) return deps.client;
  const config = plaidConfig(deps.env);
  if (config === null) throw new PlaidError('not_configured', 'The bank feed is not set up yet: PLAID_CLIENT_ID and PLAID_SECRET are missing.');
  return createPlaidClient(config);
}

export function feedsConfigured(env?: Readonly<Record<string, string | undefined>>): boolean {
  return plaidConfig(env) !== null && Boolean((env ?? process.env).PLAID_TOKEN_KEY);
}

export async function startLink(actor: Actor, deps: ConnectDeps = {}): Promise<string> {
  requireCapability(actor.role, 'settings.manage');
  return clientFor(deps).createLinkToken(actor.id);
}

/**
 * The first day the feed may bring in for this bank account: the last day the books already hold.
 *
 * That day itself is included because a statement exported mid-day misses whatever the bank posted
 * later that day. Its lines that the statement already brought in are recognised as duplicates by the
 * import (by date, amount and payee against the statement's rows), and the rest are flagged for a look.
 */
export async function firstFeedDay(exec: LedgerDb, bankAccountId: string): Promise<CalendarDate> {
  const [row] = await exec
    .select({ last: max(bankTransactions.txnDate) })
    .from(bankTransactions)
    .where(eq(bankTransactions.bankAccountId, bankAccountId));
  return row?.last ?? today();
}

export interface ConnectedItem {
  plaidItemId: string;
  institution: string | null;
  /** `confirmed` is false for every account until an owner confirms its mapping in Settings. */
  accounts: { name: string; mask: string | null; bankAccountName: string | null; syncFrom: string | null; confirmed: boolean }[];
}

export async function connectItem(actor: Actor, publicToken: string, deps: ConnectDeps = {}): Promise<ConnectedItem> {
  requireCapability(actor.role, 'settings.manage');
  const client = clientFor(deps);
  const { accessToken, itemId } = await client.exchangePublicToken(publicToken);
  const { accounts, institutionName } = await client.getAccounts(accessToken);

  const work = async (tx: LedgerDb): Promise<ConnectedItem> => {
    const [item] = await tx
      .insert(plaidItems)
      .values({ itemId, institutionName, accessTokenEnc: encryptToken(accessToken, deps.env), createdBy: actor.id })
      .returning({ id: plaidItems.id });

    const ours = await tx
      .select({ id: bankAccounts.id, name: bankAccounts.name, mask: bankAccounts.mask })
      .from(bankAccounts)
      .where(eq(bankAccounts.active, true));
    const taken = new Set(
      (await tx.select({ id: plaidAccounts.bankAccountId }).from(plaidAccounts)).map((row) => row.id).filter(Boolean),
    );

    const out: ConnectedItem = { plaidItemId: item.id, institution: institutionName, accounts: [] };
    for (const account of accounts) {
      const match = account.mask === null ? undefined : ours.filter((b) => b.mask === account.mask && !taken.has(b.id));
      // Only an unambiguous match by the last four digits is proposed, and even that feeds nothing until
      // an owner confirms it: another bank's account can share the same four digits.
      const bank = match !== undefined && match.length === 1 ? match[0] : null;
      const syncFrom = bank === null ? null : await firstFeedDay(tx, bank.id);
      if (bank !== null) taken.add(bank.id);
      await tx.insert(plaidAccounts).values({
        plaidItemId: item.id,
        plaidAccountId: account.account_id,
        bankAccountId: bank?.id ?? null,
        name: account.official_name ?? account.name,
        mask: account.mask,
        syncFrom,
      });
      out.accounts.push({ name: account.official_name ?? account.name, mask: account.mask, bankAccountName: bank?.name ?? null, syncFrom, confirmed: false });
    }
    return out;
  };
  try {
    return deps.tx ? await work(deps.tx) : await withActor(actor.id, work);
  } catch (error) {
    // Nothing was kept, so the connection Plaid made must not linger either.
    await client.removeItem(accessToken).catch(() => undefined);
    throw error;
  }
}

/** Points a Plaid account at a bank account (or at none). The start date defaults to the day after the books' last line. */
export async function mapAccount(
  actor: Actor,
  input: { plaidAccountRowId: string; bankAccountId: string | null; syncFrom?: string },
  deps: ConnectDeps = {},
): Promise<void> {
  requireCapability(actor.role, 'settings.manage');
  if (input.syncFrom !== undefined && !isCalendarDate(input.syncFrom)) throw new PlaidError('invalid', 'The start date must be YYYY-MM-DD.');
  const work = async (tx: LedgerDb) => {
    const [feed] = await tx
      .select({ status: plaidItems.status })
      .from(plaidAccounts)
      .innerJoin(plaidItems, eq(plaidItems.id, plaidAccounts.plaidItemId))
      .where(eq(plaidAccounts.id, input.plaidAccountRowId));
    if (feed === undefined || feed.status !== 'active') throw new PlaidError('invalid', 'That bank connection is not active.');
    if (input.bankAccountId !== null) {
      const [target] = await tx.select({ active: bankAccounts.active }).from(bankAccounts).where(eq(bankAccounts.id, input.bankAccountId));
      if (target === undefined || !target.active) throw new PlaidError('invalid', 'Choose an active bank account.');
    }
    const syncFrom =
      input.bankAccountId === null ? null : (input.syncFrom ?? (await firstFeedDay(tx, input.bankAccountId)));
    if (input.bankAccountId !== null && input.syncFrom !== undefined) {
      const earliest = await firstFeedDay(tx, input.bankAccountId);
      if (input.syncFrom < earliest) {
        throw new PlaidError('overlap', `The books already hold this account up to ${earliest}. Start on ${earliest} or later, or the same money would come in twice.`);
      }
    }
    const [mapping] = await tx
      .update(plaidAccounts)
      .set({ bankAccountId: input.bankAccountId, syncFrom, confirmedAt: input.bankAccountId === null ? null : new Date() })
      .where(eq(plaidAccounts.id, input.plaidAccountRowId))
      .returning({ plaidItemId: plaidAccounts.plaidItemId });
    // Read the bank's history again from the start: lines that arrived while this account was not
    // mapped, or was mapped elsewhere, were passed over and would otherwise never come back. A re-read
    // costs nothing — a line already in the books is the same row.
    await tx.update(plaidItems).set({ cursor: null }).where(eq(plaidItems.id, mapping.plaidItemId));
  };
  if (deps.tx) await work(deps.tx);
  else await withActor(actor.id, work);
}

export async function disconnectItem(actor: Actor, plaidItemId: string, deps: ConnectDeps = {}): Promise<void> {
  requireCapability(actor.role, 'settings.manage');
  const exec = deps.tx ?? db;
  const [item] = await exec.select().from(plaidItems).where(eq(plaidItems.id, plaidItemId));
  if (item === undefined || item.status !== 'active') return;
  try {
    await clientFor(deps).removeItem(decryptToken(item.accessTokenEnc, deps.env));
  } catch {
    // Revoked at Plaid or not, it stops syncing here.
  }
  // Release its bank accounts too: one bank account takes one feed, and a reconnected bank must be
  // able to feed the same accounts again.
  const work = async (tx: LedgerDb) => {
    await tx.update(plaidAccounts).set({ bankAccountId: null, syncFrom: null, confirmedAt: null }).where(eq(plaidAccounts.plaidItemId, plaidItemId));
    await tx.update(plaidItems).set({ status: 'disconnected', disconnectedAt: new Date() }).where(eq(plaidItems.id, plaidItemId));
  };
  if (deps.tx) await work(deps.tx);
  else await withActor(actor.id, work);
}

export interface FeedView {
  id: string;
  institution: string | null;
  lastSyncedAt: Date | null;
  lastError: string | null;
  accounts: { id: string; name: string; mask: string | null; bankAccountId: string | null; syncFrom: string | null; confirmed: boolean }[];
}

export async function listFeeds(exec: LedgerDb = db): Promise<FeedView[]> {
  const items = await exec
    .select()
    .from(plaidItems)
    .where(eq(plaidItems.status, 'active'))
    .orderBy(desc(plaidItems.createdAt));
  const out: FeedView[] = [];
  for (const item of items) {
    const accounts = await exec
      .select({ id: plaidAccounts.id, name: plaidAccounts.name, mask: plaidAccounts.mask, bankAccountId: plaidAccounts.bankAccountId, syncFrom: plaidAccounts.syncFrom, confirmedAt: plaidAccounts.confirmedAt })
      .from(plaidAccounts)
      .where(and(eq(plaidAccounts.plaidItemId, item.id)));
    out.push({
      id: item.id,
      institution: item.institutionName,
      lastSyncedAt: item.lastSyncedAt,
      lastError: item.lastError,
      accounts: accounts.map(({ confirmedAt, ...rest }) => ({ ...rest, confirmed: confirmedAt !== null })),
    });
  }
  return out;
}

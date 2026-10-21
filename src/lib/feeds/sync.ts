/**
 * The nightly bank sync: Plaid → the review queue → the owner-approved auto-post rules.
 *
 * Each connected Plaid item is read from its saved cursor with `/transactions/sync`. The new, posted
 * transactions on accounts an owner has mapped become one import per bank account through the
 * ordinary `previewImport` / `commitImport`, so they are de-duplicated, paired, ruled and suggested
 * exactly like an uploaded statement. Only then is the cursor saved, so a night that fails part-way
 * is simply read again the next time. After the import, the rules an owner marked auto-post run over
 * the synced accounts; everything else waits in the review queue for a person.
 *
 * Transactions Plaid later changes or withdraws are never applied silently: the row they produced
 * gets a note, and the report counts them, for a person to look at.
 */
import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm';

import { db, withActor } from '@/db/client';
import { bankAccounts, bankTransactions, plaidAccounts, plaidItems } from '@/db/schema';
import type { AiTierOptions } from '@/lib/banking/ai-tier';
import { type StatementStorage, commitImport, previewImport } from '@/lib/banking/import';
import { type AutoPostReport, postAutoPostMatches } from '@/lib/banking/post';
import { PLAID_IMPORTER_ID, type PlaidFeedLine, toPlaidCsv } from '@/lib/importers/plaid';
import type { LedgerDb } from '@/lib/ledger/post';
import { formatMoneyPlain, parseMoney } from '@/lib/money';

import { decryptToken } from './crypto';
import {
  type PlaidClient,
  type PlaidTransaction,
  PlaidError,
  createPlaidClient,
  plaidConfig,
} from './plaid-client';

export interface SyncDeps {
  client?: PlaidClient;
  /** `undefined` archives to Supabase Storage as an upload does; `null` archives nothing. */
  storage?: StatementStorage | null;
  ai?: AiTierOptions | false;
  env?: Readonly<Record<string, string | undefined>>;
}

export interface AccountSyncResult {
  bankAccountId: string;
  bankAccountName: string;
  inserted: number;
  duplicates: number;
}

export interface ItemSyncReport {
  plaidItemId: string;
  institution: string | null;
  accounts: AccountSyncResult[];
  /** Lines read but not imported, by reason. */
  ignored: { pending: number; unmapped: number; beforeStart: number; notUsd: number };
  /** Transactions Plaid changed or withdrew after we had them; noted, never applied. */
  changedLater: number;
  error: string | null;
}

export interface SyncRunReport {
  items: ItemSyncReport[];
  autoPost: AutoPostReport;
}

function clientFor(deps: SyncDeps): PlaidClient {
  if (deps.client !== undefined) return deps.client;
  const config = plaidConfig(deps.env);
  if (config === null) throw new PlaidError('not_configured', 'The bank feed is not set up: PLAID_CLIENT_ID and PLAID_SECRET are missing.');
  return createPlaidClient(config);
}

/** Plaid says positive is money out of the account; the books say positive is money in. */
export function companyAmount(plaidAmount: string): string {
  return formatMoneyPlain(-parseMoney(plaidAmount));
}

interface Pages {
  added: PlaidTransaction[];
  changed: string[];
  cursor: string;
}

/** Reads every page from `cursor`. Plaid asks for a restart if the data moves while paging. */
async function readAll(client: PlaidClient, accessToken: string, cursor: string | null): Promise<Pages> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const out: Pages = { added: [], changed: [], cursor: cursor ?? '' };
    let next = cursor;
    try {
      for (;;) {
        const page = await client.syncTransactions(accessToken, next);
        out.added.push(...page.added);
        out.changed.push(...page.modified.map((t) => t.transaction_id), ...page.removed.map((t) => t.transaction_id));
        next = page.next_cursor;
        out.cursor = page.next_cursor;
        if (!page.has_more) return out;
      }
    } catch (error) {
      if (error instanceof PlaidError && error.code === 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION') continue;
      throw error;
    }
  }
  throw new PlaidError('TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION', 'Plaid kept changing while it was read. It will be read again next time.');
}

async function noteChanged(exec: LedgerDb, actorId: string, transactionIds: readonly string[]): Promise<number> {
  if (transactionIds.length === 0) return 0;
  const fingerprints = transactionIds.map((id) => `x:${id}`);
  const rows = await exec
    .select({ id: bankTransactions.id, notes: bankTransactions.notes })
    .from(bankTransactions)
    .where(inArray(bankTransactions.fingerprint, fingerprints));
  if (rows.length === 0) return 0;
  const note = 'The bank feed later changed or withdrew this transaction. Check it against the statement.';
  await withActor(actorId, async (tx) => {
    for (const row of rows) {
      if ((row.notes ?? '').includes(note)) continue;
      await tx
        .update(bankTransactions)
        .set({ notes: row.notes === null || row.notes === '' ? note : `${row.notes}\n${note}` })
        .where(eq(bankTransactions.id, row.id));
    }
  });
  return rows.length;
}

/** Syncs one Plaid item. Never throws: a failure is reported and recorded on the item. */
export async function syncItem(plaidItemId: string, deps: SyncDeps = {}): Promise<ItemSyncReport> {
  const [item] = await db.select().from(plaidItems).where(eq(plaidItems.id, plaidItemId));
  const report: ItemSyncReport = {
    plaidItemId,
    institution: item?.institutionName ?? null,
    accounts: [],
    ignored: { pending: 0, unmapped: 0, beforeStart: 0, notUsd: 0 },
    changedLater: 0,
    error: null,
  };
  if (item === undefined || item.status !== 'active') {
    report.error = 'This bank connection is not active.';
    return report;
  }

  try {
    const client = clientFor(deps);
    const mapped = await db
      .select({
        plaidAccountId: plaidAccounts.plaidAccountId,
        bankAccountId: plaidAccounts.bankAccountId,
        syncFrom: plaidAccounts.syncFrom,
        mask: plaidAccounts.mask,
        name: bankAccounts.name,
      })
      .from(plaidAccounts)
      .innerJoin(bankAccounts, eq(bankAccounts.id, plaidAccounts.bankAccountId))
      .where(and(eq(plaidAccounts.plaidItemId, item.id), isNotNull(plaidAccounts.bankAccountId)));
    const byPlaidId = new Map(mapped.map((row) => [row.plaidAccountId, row]));

    const pages = await readAll(client, decryptToken(item.accessTokenEnc, deps.env), item.cursor);

    const lines = new Map<string, PlaidFeedLine[]>();
    for (const txn of pages.added) {
      const account = byPlaidId.get(txn.account_id);
      if (account === undefined || account.bankAccountId === null) report.ignored.unmapped += 1;
      else if (txn.pending) report.ignored.pending += 1;
      else if (account.syncFrom === null || txn.date < account.syncFrom) report.ignored.beforeStart += 1;
      else if (txn.iso_currency_code !== null && txn.iso_currency_code !== 'USD') report.ignored.notUsd += 1;
      else {
        const list = lines.get(account.bankAccountId) ?? [];
        list.push({
          date: txn.date,
          description: (txn.original_description ?? '').trim() || txn.name,
          payee: txn.merchant_name,
          amount: companyAmount(txn.amount),
          transactionId: txn.transaction_id,
        });
        lines.set(account.bankAccountId, list);
      }
    }

    for (const [bankAccountId, accountLines] of lines) {
      const account = mapped.find((row) => row.bankAccountId === bankAccountId)!;
      const bytes = Buffer.from(toPlaidCsv(accountLines), 'utf8');
      const dates = accountLines.map((line) => line.date).sort();
      const previewed = await previewImport({
        bankAccountId,
        filename: `plaid-${account.mask ?? 'account'}-${dates[0]}-to-${dates[dates.length - 1]}.csv`,
        bytes,
        userId: item.createdBy,
        importerId: PLAID_IMPORTER_ID,
        delivery: 'api',
        ...(deps.storage === undefined ? {} : { storage: deps.storage }),
      });
      if (previewed.blocked) {
        throw new Error(`The feed for ${account.name} could not be imported: ${previewed.issues.filter((i) => i.severity === 'fatal').map((i) => i.message).join(' ')}`);
      }
      const committed = await commitImport({
        batchId: previewed.batchId,
        userId: item.createdBy,
        bytes,
        ...(deps.storage === undefined ? {} : { storage: deps.storage }),
        ...(deps.ai === undefined ? {} : { ai: deps.ai }),
      });
      report.accounts.push({ bankAccountId, bankAccountName: account.name, inserted: committed.inserted, duplicates: committed.duplicates });
    }

    report.changedLater = await noteChanged(db, item.createdBy, pages.changed);

    // Only now: every line read has been written, so the next run may start after them.
    await withActor(item.createdBy, (tx) =>
      tx.update(plaidItems).set({ cursor: pages.cursor, lastSyncedAt: new Date(), lastError: null }).where(eq(plaidItems.id, item.id)),
    );
  } catch (error) {
    report.error = error instanceof Error ? error.message : 'The bank feed failed.';
    await withActor(item.createdBy, (tx) =>
      tx.update(plaidItems).set({ lastError: report.error }).where(eq(plaidItems.id, item.id)),
    );
  }
  return report;
}

/**
 * Syncs every active connection, then runs the owner-approved auto-post rules over the accounts the
 * feed fills. Each item's writes are made as the owner who connected it.
 */
export async function syncAllFeeds(deps: SyncDeps = {}): Promise<SyncRunReport> {
  const items = await db
    .select({ id: plaidItems.id, createdBy: plaidItems.createdBy })
    .from(plaidItems)
    .where(and(eq(plaidItems.status, 'active'), isNull(plaidItems.disconnectedAt)));

  const run: SyncRunReport = { items: [], autoPost: { posted: [], failed: [] } };
  for (const item of items) {
    const report = await syncItem(item.id, deps);
    run.items.push(report);

    const fed = await db
      .select({ bankAccountId: plaidAccounts.bankAccountId })
      .from(plaidAccounts)
      .where(and(eq(plaidAccounts.plaidItemId, item.id), isNotNull(plaidAccounts.bankAccountId)));
    for (const { bankAccountId } of fed) {
      if (bankAccountId === null) continue;
      const posted = await postAutoPostMatches({ userId: item.createdBy }, { bankAccountId });
      run.autoPost.posted.push(...posted.posted);
      run.autoPost.failed.push(...posted.failed);
    }
  }
  return run;
}

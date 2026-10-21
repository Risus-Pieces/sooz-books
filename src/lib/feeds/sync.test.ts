/**
 * The bank sync against the throwaway local database, with a fake Plaid.
 *
 * These write real rows (the import pipeline runs its own transactions), into a bank account of the
 * suite's own bound to a GL account of its own. Rows are bound to rules scoped to that bank account,
 * so nothing here can match another suite's data.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// First: loads .env.local before '@/db/client' is imported anywhere below.
import { closeTestDb, hasDatabase } from '@/lib/ledger/test-support';

import { randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';

import type { PlaidClient, PlaidTransaction, TransactionsSyncPage } from './plaid-client';

const ENV = { PLAID_TOKEN_KEY: Buffer.alloc(32, 3).toString('base64') };

type DbClient = typeof import('@/db/client');
type Schema = typeof import('@/db/schema');
let client: DbClient;
let schema: Schema;
let ownerId = '';
let bankAccountId = '';
let itemRowId = '';

function txn(id: string, date: string, amount: string, extra: Partial<PlaidTransaction> = {}): PlaidTransaction {
  return { transaction_id: id, account_id: 'plaid-acct-1', amount, iso_currency_code: 'USD', date, name: `ZZFEED ${id}`, merchant_name: null, pending: false, ...extra };
}

/** A Plaid that serves `pages` in order, from whatever cursor. */
function fakePlaid(pages: TransactionsSyncPage[], seen: (string | null)[] = []): PlaidClient {
  let call = 0;
  return {
    createLinkToken: async () => 'link',
    exchangePublicToken: async () => ({ accessToken: 'tok', itemId: 'item' }),
    getAccounts: async () => ({ accounts: [], institutionName: null }),
    removeItem: async () => undefined,
    syncTransactions: async (_token, cursor) => {
      seen.push(cursor);
      const page = pages[Math.min(call, pages.length - 1)];
      call += 1;
      return page;
    },
  };
}

function page(added: PlaidTransaction[], cursor: string, extra: Partial<TransactionsSyncPage> = {}): TransactionsSyncPage {
  return { added, modified: [], removed: [], next_cursor: cursor, has_more: false, ...extra };
}

async function rows() {
  return client.db
    .select({ amount: schema.bankTransactions.amountCents, fingerprint: schema.bankTransactions.fingerprint, status: schema.bankTransactions.status, entry: schema.bankTransactions.journalEntryId, notes: schema.bankTransactions.notes, date: schema.bankTransactions.txnDate })
    .from(schema.bankTransactions)
    .where(eq(schema.bankTransactions.bankAccountId, bankAccountId))
    .orderBy(schema.bankTransactions.txnDate);
}

async function item() {
  const [row] = await client.db.select().from(schema.plaidItems).where(eq(schema.plaidItems.id, itemRowId));
  return row;
}

beforeAll(async () => {
  if (!hasDatabase) return;
  client = await import('@/db/client');
  schema = await import('@/db/schema');
  const { encryptToken } = await import('./crypto');
  const tag = randomUUID().slice(0, 8);
  const [owner] = await client.db.select({ id: schema.appUsers.id }).from(schema.appUsers).where(eq(schema.appUsers.role, 'owner')).orderBy(schema.appUsers.id).limit(1);
  ownerId = owner.id;
  await client.withActor(ownerId, async (tx) => {
    const [gl] = await tx.insert(schema.accounts).values({ code: `TF-${tag}`, name: `Feed test bank ${tag}`, type: 'asset', subtype: 'bank', isBank: true }).returning({ id: schema.accounts.id });
    const [bank] = await tx.insert(schema.bankAccounts).values({ accountId: gl.id, name: `TEST feed ${tag}`, kind: 'checking', mask: '4242' }).returning({ id: schema.bankAccounts.id });
    bankAccountId = bank.id;
    const [it] = await tx.insert(schema.plaidItems).values({ itemId: `item-${tag}`, institutionName: 'Relay', accessTokenEnc: encryptToken('access-sandbox-x', ENV), createdBy: ownerId }).returning({ id: schema.plaidItems.id });
    itemRowId = it.id;
    await tx.insert(schema.plaidAccounts).values({ plaidItemId: it.id, plaidAccountId: 'plaid-acct-1', bankAccountId: bank.id, name: 'Checking', mask: '4242', syncFrom: '2031-05-01' });
    const [fees] = await tx.select({ id: schema.accounts.id }).from(schema.accounts).where(eq(schema.accounts.code, '6710'));
    const [office] = await tx.select({ id: schema.accounts.id }).from(schema.accounts).where(eq(schema.accounts.code, '6740'));
    await tx.insert(schema.categorizationRules).values([
      { name: `ZZ auto ${tag}`, bankAccountId: bank.id, conditions: [{ field: 'description', op: 'contains', value: 'ZZFEED FEE' }], accountId: fees.id, autoPost: true, priority: 1 },
      { name: `ZZ manual ${tag}`, bankAccountId: bank.id, conditions: [{ field: 'description', op: 'contains', value: 'ZZFEED PAPER' }], accountId: office.id, autoPost: false, priority: 1 },
    ]);
  });
});

afterAll(closeTestDb);

describe.skipIf(!hasDatabase)('the bank sync', () => {
  it('imports posted, mapped lines from the start date, money-in positive, keyed on the Plaid id', async () => {
    const { syncItem } = await import('./sync');
    const seen: (string | null)[] = [];
    const report = await syncItem(itemRowId, {
      env: ENV,
      storage: null,
      ai: false,
      client: fakePlaid(
        [
          page([txn('t1', '2031-05-02', '12.50'), txn('t2', '2031-05-03', '-300.00'), txn('old', '2031-04-30', '5.00')], 'c1', { has_more: true }),
          page([txn('pend', '2031-05-04', '1.00', { pending: true }), txn('other', '2031-05-04', '1.00', { account_id: 'unmapped' }), txn('eur', '2031-05-04', '1.00', { iso_currency_code: 'EUR' })], 'c2'),
        ],
        seen,
      ),
    });

    expect(report.error).toBeNull();
    expect(seen).toEqual([null, 'c1']);
    expect(report.accounts).toEqual([expect.objectContaining({ bankAccountId, inserted: 2, duplicates: 0 })]);
    expect(report.ignored).toEqual({ pending: 1, unmapped: 1, beforeStart: 1, notUsd: 1 });
    expect((await rows()).map((r) => [r.date, r.amount, r.fingerprint])).toEqual([
      ['2031-05-02', -1_250, 'x:t1'],
      ['2031-05-03', 30_000, 'x:t2'],
    ]);
    expect((await item()).cursor).toBe('c2');
  });

  it('never duplicates a line Plaid sends again', async () => {
    const { syncItem } = await import('./sync');
    const report = await syncItem(itemRowId, { env: ENV, storage: null, ai: false, client: fakePlaid([page([txn('t1', '2031-05-02', '12.50'), txn('t3', '2031-05-05', '7.00')], 'c3')]) });
    expect(report.error).toBeNull();
    expect(report.accounts[0]).toMatchObject({ inserted: 1, duplicates: 1 });
    expect(await rows()).toHaveLength(3);
  });

  it('keeps the cursor when a night fails, so the next run reads the same lines again', async () => {
    const { syncItem } = await import('./sync');
    const before = (await item()).cursor;
    const failing: PlaidClient = { ...fakePlaid([]), syncTransactions: async () => { throw new Error('Plaid is down'); } };
    const report = await syncItem(itemRowId, { env: ENV, storage: null, ai: false, client: failing });
    expect(report.error).toMatch(/Plaid is down/);
    const after = await item();
    expect(after.cursor).toBe(before);
    expect(after.lastError).toMatch(/Plaid is down/);
  });

  it('notes a line Plaid later changes or withdraws, and changes nothing else', async () => {
    const { syncItem } = await import('./sync');
    const report = await syncItem(itemRowId, {
      env: ENV,
      storage: null,
      ai: false,
      client: fakePlaid([page([], 'c4', { modified: [txn('t1', '2031-05-02', '99.99')], removed: [{ transaction_id: 't3' }] })]),
    });
    expect(report.changedLater).toBe(2);
    const all = await rows();
    expect(all.find((r) => r.fingerprint === 'x:t1')).toMatchObject({ amount: -1_250, notes: expect.stringContaining('changed or withdrew') });
    expect(all.find((r) => r.fingerprint === 'x:t3')?.notes).toMatch(/changed or withdrew/);
    expect((await item()).lastError).toBeNull();
  });

  it("posts what an auto-post rule matches, and leaves an ordinary rule's match for a person", async () => {
    const { syncAllFeeds } = await import('./sync');
    const run = await syncAllFeeds({
      env: ENV,
      storage: null,
      ai: false,
      client: fakePlaid([page([txn('fee', '2031-05-10', '8.00', { name: 'ZZFEED FEE MONTHLY' }), txn('paper', '2031-05-10', '42.00', { name: 'ZZFEED PAPER CO' })], 'c5')]),
    });
    const mine = run.items.find((r) => r.plaidItemId === itemRowId);
    expect(mine?.error).toBeNull();
    const all = await rows();
    const fee = all.find((r) => r.fingerprint === 'x:fee');
    const paper = all.find((r) => r.fingerprint === 'x:paper');
    expect(fee?.entry).not.toBeNull();
    expect(paper?.entry).toBeNull();
    expect(run.autoPost.posted.some((p) => p.entryId === fee?.entry)).toBe(true);
  });

  it('records the sync and its postings as made by the cron, in the audit log', async () => {
    const { actingVia } = await import('@/db/client');
    const { syncItem } = await import('./sync');
    await actingVia('cron:bank-sync', () =>
      syncItem(itemRowId, { env: ENV, storage: null, ai: false, client: fakePlaid([page([txn('audited', '2031-05-11', '3.00')], 'c6')]) }),
    );
    const [row] = await client.db
      .select({ id: schema.bankTransactions.id })
      .from(schema.bankTransactions)
      .where(and(eq(schema.bankTransactions.bankAccountId, bankAccountId), eq(schema.bankTransactions.fingerprint, 'x:audited')));
    const events = await client.db
      .select({ via: schema.auditLog.via, actor: schema.auditLog.actorId })
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.tableName, 'bank_transactions'), eq(schema.auditLog.rowId, row.id)));
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((event) => event.via === 'cron:bank-sync' && event.actor === ownerId)).toBe(true);
  });
});

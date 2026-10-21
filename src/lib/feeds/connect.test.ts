import { afterAll, describe, expect, it } from 'vitest';

// First: loads .env.local before '@/db/client' is imported anywhere below.
import { closeTestDb, hasDatabase, withRollback } from '@/lib/ledger/test-support';

import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';

import { accounts, bankAccounts, bankTransactions, plaidAccounts, plaidItems } from '@/db/schema';
import { ForbiddenError } from '@/lib/auth/roles';
import type { LedgerDb } from '@/lib/ledger/post';
import { seededUserId } from '@/lib/receipts/test-support';

import { connectItem, disconnectItem, firstFeedDay, mapAccount } from './connect';
import { decryptToken } from './crypto';
import type { PlaidAccountInfo, PlaidClient } from './plaid-client';

afterAll(closeTestDb);

const ENV = { PLAID_TOKEN_KEY: Buffer.alloc(32, 9).toString('base64') };

async function bank(tx: LedgerDb, mask: string): Promise<string> {
  const tag = randomUUID().slice(0, 8);
  const [gl] = await tx.insert(accounts).values({ code: `TC-${tag}`, name: `Connect test ${tag}`, type: 'asset', subtype: 'bank', isBank: true }).returning({ id: accounts.id });
  const [row] = await tx.insert(bankAccounts).values({ accountId: gl.id, name: `TEST connect ${tag}`, kind: 'checking', mask }).returning({ id: bankAccounts.id });
  return row.id;
}

function plaid(accountsList: PlaidAccountInfo[], removed: string[] = []): PlaidClient {
  return {
    createLinkToken: async () => 'link-token',
    exchangePublicToken: async () => ({ accessToken: 'access-sandbox-abc', itemId: `item-${randomUUID()}` }),
    getAccounts: async () => ({ accounts: accountsList, institutionName: 'Relay' }),
    syncTransactions: async () => ({ added: [], modified: [], removed: [], next_cursor: '', has_more: false }),
    removeItem: async (token) => {
      removed.push(token);
    },
  };
}

function account(id: string, mask: string | null): PlaidAccountInfo {
  return { account_id: id, name: `Checking ${mask}`, official_name: null, mask, type: 'depository', subtype: 'checking' };
}

describe.skipIf(!hasDatabase)('connecting a bank', () => {
  it('stores the token encrypted and maps each account by its last four digits, starting after the books', async () => {
    await withRollback(async (tx) => {
      const id = await seededUserId(tx);
      const mine = await bank(tx, '7311');
      await tx.insert(bankTransactions).values({ bankAccountId: mine, txnDate: '2031-06-14', description: 'X', descriptionNormalized: 'X', amountCents: -100, fingerprint: randomUUID() });

      const connected = await connectItem({ id, role: 'owner' }, 'public-token', { client: plaid([account('p1', '7311'), account('p2', '0000')]), env: ENV, tx });

      expect(connected.accounts).toEqual([
        expect.objectContaining({ mask: '7311', syncFrom: '2031-06-15' }),
        expect.objectContaining({ mask: '0000', bankAccountName: null, syncFrom: null }),
      ]);
      const [item] = await tx.select().from(plaidItems).where(eq(plaidItems.id, connected.plaidItemId));
      expect(item.accessTokenEnc).not.toContain('access-sandbox-abc');
      expect(decryptToken(item.accessTokenEnc, ENV)).toBe('access-sandbox-abc');
      const mapped = await tx.select().from(plaidAccounts).where(eq(plaidAccounts.plaidItemId, item.id));
      expect(mapped.find((a) => a.plaidAccountId === 'p1')?.bankAccountId).toBe(mine);
    });
  });

  it('leaves an ambiguous last-four for an owner to map', async () => {
    await withRollback(async (tx) => {
      const id = await seededUserId(tx);
      await bank(tx, '5555');
      await bank(tx, '5555');
      const connected = await connectItem({ id, role: 'owner' }, 'pt', { client: plaid([account('p1', '5555')]), env: ENV, tx });
      expect(connected.accounts[0].bankAccountName).toBeNull();
    });
  });

  it('refuses a start date that would bring in days the books already hold', async () => {
    await withRollback(async (tx) => {
      const id = await seededUserId(tx);
      const mine = await bank(tx, '8181');
      await tx.insert(bankTransactions).values({ bankAccountId: mine, txnDate: '2031-07-01', description: 'X', descriptionNormalized: 'X', amountCents: -100, fingerprint: randomUUID() });
      const connected = await connectItem({ id, role: 'owner' }, 'pt', { client: plaid([account('p9', null)]), env: ENV, tx });
      const [row] = await tx.select({ id: plaidAccounts.id }).from(plaidAccounts).where(eq(plaidAccounts.plaidItemId, connected.plaidItemId));

      await expect(mapAccount({ id, role: 'owner' }, { plaidAccountRowId: row.id, bankAccountId: mine, syncFrom: '2031-06-01' }, { tx })).rejects.toThrow(/twice/);
      await mapAccount({ id, role: 'owner' }, { plaidAccountRowId: row.id, bankAccountId: mine }, { tx });
      const [after] = await tx.select().from(plaidAccounts).where(eq(plaidAccounts.id, row.id));
      expect(after.syncFrom).toBe('2031-07-02');
      expect(await firstFeedDay(tx, mine)).toBe('2031-07-02');
    });
  });

  it('disconnects at Plaid and stops syncing', async () => {
    await withRollback(async (tx) => {
      const id = await seededUserId(tx);
      const removed: string[] = [];
      const client = plaid([account('p1', null)], removed);
      const connected = await connectItem({ id, role: 'owner' }, 'pt', { client, env: ENV, tx });
      await disconnectItem({ id, role: 'owner' }, connected.plaidItemId, { client, env: ENV, tx });
      expect(removed).toEqual(['access-sandbox-abc']);
      const [item] = await tx.select().from(plaidItems).where(eq(plaidItems.id, connected.plaidItemId));
      expect(item.status).toBe('disconnected');
    });
  });

  it('releases its bank accounts on disconnect, so a reconnect can feed them again', async () => {
    await withRollback(async (tx) => {
      const id = await seededUserId(tx);
      const mine = await bank(tx, '6262');
      const first = await connectItem({ id, role: 'owner' }, 'pt', { client: plaid([account('a1', '6262')]), env: ENV, tx });
      await disconnectItem({ id, role: 'owner' }, first.plaidItemId, { client: plaid([]), env: ENV, tx });
      const again = await connectItem({ id, role: 'owner' }, 'pt', { client: plaid([account('a2', '6262')]), env: ENV, tx });
      expect(again.accounts[0].bankAccountName).not.toBeNull();
      const rows = await tx.select({ bank: plaidAccounts.bankAccountId }).from(plaidAccounts).where(eq(plaidAccounts.plaidItemId, again.plaidItemId));
      expect(rows[0].bank).toBe(mine);
    });
  });

  it('will not map onto an inactive bank account or for a disconnected bank', async () => {
    await withRollback(async (tx) => {
      const id = await seededUserId(tx);
      const mine = await bank(tx, '7272');
      await tx.update(bankAccounts).set({ active: false }).where(eq(bankAccounts.id, mine));
      const connected = await connectItem({ id, role: 'owner' }, 'pt', { client: plaid([account('b1', null)]), env: ENV, tx });
      const [row] = await tx.select({ id: plaidAccounts.id }).from(plaidAccounts).where(eq(plaidAccounts.plaidItemId, connected.plaidItemId));
      await expect(mapAccount({ id, role: 'owner' }, { plaidAccountRowId: row.id, bankAccountId: mine }, { tx })).rejects.toThrow(/active bank account/);
      await disconnectItem({ id, role: 'owner' }, connected.plaidItemId, { client: plaid([]), env: ENV, tx });
      await expect(mapAccount({ id, role: 'owner' }, { plaidAccountRowId: row.id, bankAccountId: null }, { tx })).rejects.toThrow(/not active/);
    });
  });

  it('is for someone who manages settings', async () => {
    await withRollback(async (tx) => {
      const id = await seededUserId(tx);
      await expect(connectItem({ id, role: 'bookkeeper' }, 'pt', { client: plaid([]), env: ENV, tx })).rejects.toBeInstanceOf(ForbiddenError);
    });
  });
});

import { afterAll, describe, expect, it } from 'vitest';

// First: loads .env.local before '@/db/client' is imported anywhere below.
import { closeTestDb, hasDatabase, withRollback } from '@/lib/ledger/test-support';

import { eq } from 'drizzle-orm';

import { apiKeys, appUsers } from '@/db/schema';
import { ForbiddenError } from '@/lib/auth/roles';
import { seededUserId } from '@/lib/receipts/test-support';

import { authenticateKey, createApiKey, hashKey, revokeApiKey } from './keys';

afterAll(closeTestDb);

describe.skipIf(!hasDatabase)('scoped keys', () => {
  it('stores only a hash, and shows the token once', async () => {
    await withRollback(async (tx) => {
      const id = await seededUserId(tx);
      const created = await createApiKey({ id, role: 'owner' }, { name: "Mo's nightly sync", userId: id }, { tx });
      expect(created.token).toMatch(/^sbk_/);
      const [row] = await tx.select().from(apiKeys).where(eq(apiKeys.id, created.id));
      expect(row.tokenHash).toBe(hashKey(created.token));
      expect(JSON.stringify(row)).not.toContain(created.token);
      expect(row.scopes).toEqual(['read', 'bank.sync', 'bank.autopost', 'stage']);
    });
  });

  it('authenticates a live key for an active user and refuses everything else', async () => {
    await withRollback(async (tx) => {
      const id = await seededUserId(tx);
      const created = await createApiKey({ id, role: 'owner' }, { name: 'Night', userId: id }, { tx });
      await expect(authenticateKey(created.token, tx)).resolves.toMatchObject({ keyName: 'Night', user: { id } });
      await expect(authenticateKey(`${created.token}x`, tx)).resolves.toBeNull();
      await expect(authenticateKey('not-a-key', tx)).resolves.toBeNull();

      await tx.update(appUsers).set({ active: false }).where(eq(appUsers.id, id));
      await expect(authenticateKey(created.token, tx)).resolves.toBeNull();
      await tx.update(appUsers).set({ active: true }).where(eq(appUsers.id, id));

      await revokeApiKey({ id, role: 'owner' }, created.id, { tx });
      await expect(authenticateKey(created.token, tx)).resolves.toBeNull();
    });
  });

  it('can only be made or revoked by someone who manages users', async () => {
    await withRollback(async (tx) => {
      const id = await seededUserId(tx);
      await expect(createApiKey({ id, role: 'bookkeeper' }, { name: 'x', userId: id }, { tx })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(revokeApiKey({ id, role: 'approver' }, id, { tx })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(createApiKey({ id, role: 'owner' }, { name: '  ', userId: id }, { tx })).rejects.toThrow(/name/);
    });
  });
});

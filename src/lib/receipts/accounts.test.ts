import { afterAll, describe, expect, it } from 'vitest';

// First: loads .env.local before '@/db/client' is imported anywhere below.
import { closeTestDb, hasDatabase, withRollback } from '@/lib/ledger/test-support';

import { accounts } from '@/db/schema';
import { ACCOUNTS } from '@/lib/ledger/coa';

import { loadAllowedAccounts, vendorHistoryAccount } from './accounts';
import { accountIdOf, expenseLeaf, newVendor, postVendorSpend } from './test-support';

afterAll(closeTestDb);

describe.skipIf(!hasDatabase)('loadAllowedAccounts', () => {
  it('offers postable expense accounts and the two inventory accounts a receipt capitalizes to', async () => {
    await withRollback(async (tx) => {
      const codes = (await loadAllowedAccounts(tx)).map((a) => a.code);

      expect(codes).toContain(ACCOUNTS.INVENTORY_INGREDIENTS);
      expect(codes).toContain(ACCOUNTS.INVENTORY_PACKAGING);
      expect(codes).toContain('6740'); // Office Supplies & Postage
    });
  });

  it('never offers finished goods, cost of goods, a rollup, equity, or the receivable and payable controls', async () => {
    await withRollback(async (tx) => {
      const codes = new Set((await loadAllowedAccounts(tx)).map((a) => a.code));

      expect(codes.has(ACCOUNTS.INVENTORY_FINISHED)).toBe(false);
      expect(codes.has(ACCOUNTS.COGS_INGREDIENTS)).toBe(false);
      expect(codes.has('6700')).toBe(false); // the header 6740 sits under
      expect(codes.has(ACCOUNTS.MEMBER_CONTRIBUTIONS)).toBe(false);
      expect(codes.has(ACCOUNTS.AR)).toBe(false);
      expect(codes.has(ACCOUNTS.AP)).toBe(false);
    });
  });

  it('drops an account the moment something is nested under it, and one that is inactive', async () => {
    await withRollback(async (tx) => {
      const parent = await expenseLeaf(tx);
      expect((await loadAllowedAccounts(tx)).map((a) => a.code)).toContain(parent.code);

      await tx.insert(accounts).values({ code: `${parent.code}-c`, name: 'child', type: 'expense', subtype: 'general_admin', parentId: parent.id });
      const codes = (await loadAllowedAccounts(tx)).map((a) => a.code);
      expect(codes).not.toContain(parent.code);
      expect(codes).toContain(`${parent.code}-c`);

      await tx.insert(accounts).values({ code: `${parent.code}-x`, name: 'inactive', type: 'expense', subtype: 'general_admin', active: false });
      expect((await loadAllowedAccounts(tx)).map((a) => a.code)).not.toContain(`${parent.code}-x`);
    });
  });

  it('leaves out cost-of-goods and suspense expense accounts', async () => {
    await withRollback(async (tx) => {
      const cogs = await expenseLeaf(tx, 'cogs');
      const suspense = await expenseLeaf(tx, 'suspense');
      const codes = (await loadAllowedAccounts(tx)).map((a) => a.code);

      expect(codes).not.toContain(cogs.code);
      expect(codes).not.toContain(suspense.code);
    });
  });
});

describe.skipIf(!hasDatabase)('vendorHistoryAccount', () => {
  it("returns the account the vendor's most recent purchase went to", async () => {
    await withRollback(async (tx) => {
      const vendor = await newVendor(tx);
      const older = await expenseLeaf(tx);
      const newer = await expenseLeaf(tx);
      await postVendorSpend(tx, vendor.id, older.id, '2031-01-10');
      await postVendorSpend(tx, vendor.id, newer.id, '2031-02-10');

      expect(await vendorHistoryAccount(tx, vendor.id, [older.id, newer.id])).toBe(newer.id);
    });
  });

  it('ignores accounts a receipt may not post to, and other vendors', async () => {
    await withRollback(async (tx) => {
      const vendor = await newVendor(tx);
      const other = await newVendor(tx);
      const allowed = await expenseLeaf(tx);
      const notAllowed = await expenseLeaf(tx);
      await postVendorSpend(tx, vendor.id, allowed.id, '2031-01-10');
      await postVendorSpend(tx, vendor.id, notAllowed.id, '2031-03-10');
      await postVendorSpend(tx, other.id, notAllowed.id, '2031-04-10');

      expect(await vendorHistoryAccount(tx, vendor.id, [allowed.id])).toBe(allowed.id);
    });
  });

  it('returns null for a vendor with no history, and for an empty list', async () => {
    await withRollback(async (tx) => {
      const vendor = await newVendor(tx);
      const packaging = await accountIdOf(tx, ACCOUNTS.INVENTORY_PACKAGING);

      expect(await vendorHistoryAccount(tx, vendor.id, [packaging])).toBeNull();
      expect(await vendorHistoryAccount(tx, vendor.id, [])).toBeNull();
    });
  });
});

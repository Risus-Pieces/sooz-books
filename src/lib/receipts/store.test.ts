import { afterAll, describe, expect, it } from 'vitest';

// First: loads .env.local before '@/db/client' is imported anywhere below.
import { closeTestDb, hasDatabase, withRollback } from '@/lib/ledger/test-support';

import { eq } from 'drizzle-orm';

import { receiptProposals } from '@/db/schema';
import { ACCOUNTS } from '@/lib/ledger/coa';
import type { LedgerDb } from '@/lib/ledger/post';

import { applyProposalEdits } from './store';
import { accountIdOf, giveContributionsAccount, insertProposal, seededUserId } from './test-support';

afterAll(closeTestDb);

const TODAY = '2026-09-20';

/** A proposal with two lines, one of them without an account, for a member who can be credited. */
async function waiting(tx: LedgerDb, overrides: { payer?: boolean } = {}) {
  const userId = await seededUserId(tx);
  await giveContributionsAccount(tx, userId);
  const packaging = await accountIdOf(tx, ACCOUNTS.INVENTORY_PACKAGING);
  const { id } = await insertProposal(tx, userId, {
    payerId: overrides.payer === false ? null : userId,
    vendorName: 'Somewhere',
    receiptDate: '2026-09-15',
    totalCents: 4110,
    lines: [
      { description: 'Cartons', cents: 3000, accountId: packaging },
      { description: 'Sugar', cents: 1110, accountId: null },
    ],
    warnings: [{ code: 'no_account', message: 'Choose an account for every line.', blocking: true }],
  });
  return { id, userId, packaging };
}

const ctxFor = (tx: LedgerDb, userId: string) => ({ userId, tx, today: () => TODAY });

describe.skipIf(!hasDatabase)('applyProposalEdits', () => {
  it('applies an edit, saves it, and hands back the updated card', async () => {
    await withRollback(async (tx) => {
      const f = await waiting(tx);

      const result = await applyProposalEdits(f.id, [{ kind: 'set_account', line: 2, accountCode: ACCOUNTS.INVENTORY_INGREDIENTS }], ctxFor(tx, f.userId));

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.notes).toEqual([expect.stringContaining('Sugar')]);
      expect(result.view.canPost).toBe(true);
      expect(result.view.lines[1].accountLabel).toContain('1320');
      const [row] = await tx.select().from(receiptProposals).where(eq(receiptProposals.id, f.id));
      expect(row.lines[1].accountId).not.toBeNull();
      expect(row.warnings).toEqual([]);
    });
  });

  it('applies several edits in order', async () => {
    await withRollback(async (tx) => {
      const f = await waiting(tx);

      const result = await applyProposalEdits(
        f.id,
        [
          { kind: 'set_account', line: 'all', accountCode: ACCOUNTS.INVENTORY_PACKAGING },
          { kind: 'set_date', date: '2026-09-12' },
        ],
        ctxFor(tx, f.userId),
      );

      expect(result.ok && result.notes).toHaveLength(2);
      const [row] = await tx.select().from(receiptProposals).where(eq(receiptProposals.id, f.id));
      expect(row.receiptDate).toBe('2026-09-12');
      expect(row.lines.every((l) => l.accountId === f.packaging)).toBe(true);
    });
  });

  it('saves nothing when any one edit is refused', async () => {
    await withRollback(async (tx) => {
      const f = await waiting(tx);

      const result = await applyProposalEdits(
        f.id,
        [
          { kind: 'set_date', date: '2026-09-12' },
          { kind: 'set_account', line: 1, accountCode: '3015' },
        ],
        ctxFor(tx, f.userId),
      );

      expect(result).toEqual({ ok: false, message: '“3015” is not an account a receipt can post to.' });
      const [row] = await tx.select().from(receiptProposals).where(eq(receiptProposals.id, f.id));
      expect(row.receiptDate).toBe('2026-09-15');
    });
  });

  it('chooses the payer by name', async () => {
    await withRollback(async (tx) => {
      const f = await waiting(tx, { payer: false });

      const result = await applyProposalEdits(f.id, [{ kind: 'set_payer', who: 'unit' }], ctxFor(tx, f.userId));

      expect(result.ok).toBe(true);
      const [row] = await tx.select().from(receiptProposals).where(eq(receiptProposals.id, f.id));
      expect(row.payerId).toBe(f.userId);
    });
  });

  it('keeps an unknown vendor as a name, with no vendor id', async () => {
    await withRollback(async (tx) => {
      const f = await waiting(tx);

      await applyProposalEdits(f.id, [{ kind: 'set_vendor', name: 'Totally New Supplier LLC' }], ctxFor(tx, f.userId));

      const [row] = await tx.select().from(receiptProposals).where(eq(receiptProposals.id, f.id));
      expect(row).toMatchObject({ vendorName: 'Totally New Supplier LLC', vendorId: null });
    });
  });

  it('marks the proposal skipped on a skip edit', async () => {
    await withRollback(async (tx) => {
      const f = await waiting(tx);

      const result = await applyProposalEdits(f.id, [{ kind: 'skip' }], ctxFor(tx, f.userId));

      expect(result.ok && result.view.status).toBe('skipped');
    });
  });

  it('refuses to edit a proposal that is already posted or skipped, or missing', async () => {
    await withRollback(async (tx) => {
      const f = await waiting(tx);
      await tx.update(receiptProposals).set({ status: 'skipped' }).where(eq(receiptProposals.id, f.id));

      const done = await applyProposalEdits(f.id, [{ kind: 'set_date', date: '2026-09-12' }], ctxFor(tx, f.userId));
      const missing = await applyProposalEdits(
        '00000000-0000-4000-8000-00000000dead',
        [{ kind: 'set_date', date: '2026-09-12' }],
        ctxFor(tx, f.userId),
      );

      expect(done).toEqual({ ok: false, message: 'That receipt was skipped.' });
      expect(missing).toEqual({ ok: false, message: 'That receipt is no longer here.' });
    });
  });
});

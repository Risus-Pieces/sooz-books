import { afterAll, describe, expect, it } from 'vitest';

// First: loads .env.local before '@/db/client' is imported anywhere below.
import { closeTestDb, hasDatabase, withRollback } from '@/lib/ledger/test-support';

import { randomUUID } from 'node:crypto';

import { and, eq, sql } from 'drizzle-orm';

import { accounts, appUsers, bankAccounts, bankTransactions, categorizationRules } from '@/db/schema';
import { BankingError, approveBankTransaction, linkTransfer } from '@/lib/banking/post';
import { ACCOUNTS } from '@/lib/ledger/coa';
import type { LedgerDb } from '@/lib/ledger/post';

import type { RuleDraft } from '@/components/banking/types';

import { excludeTransactions, includeTransactions, previewRule, ruleDraftProblems, saveRule, setRuleActive } from './data';

// Every row below lives inside a transaction that is rolled back. Dates are in 2031 so
// nothing shares a period with the real books; the real Relay rows are never touched.

interface Fixture {
  tx: LedgerDb;
  userId: string | null;
  bankA: { id: string; glId: string };
  bankB: { id: string; glId: string };
  tag: string;
  code: (code: string) => Promise<string>;
}

async function makeBank(tx: LedgerDb, label: string) {
  const tag = randomUUID().slice(0, 8);
  const [gl] = await tx
    .insert(accounts)
    .values({ code: `TB-${tag}`, name: `Test bank ${label} ${tag}`, type: 'asset', subtype: 'bank', isBank: true })
    .returning({ id: accounts.id });
  const [bank] = await tx
    .insert(bankAccounts)
    .values({ accountId: gl.id, name: `TEST ${label} ${tag}`, kind: 'checking', mask: tag.slice(0, 4) })
    .returning({ id: bankAccounts.id });
  return { id: bank.id, glId: gl.id };
}

async function fixture(tx: LedgerDb): Promise<Fixture> {
  await tx.execute(sql`set constraints all immediate`);
  const [owner] = await tx
    .select({ id: appUsers.id })
    .from(appUsers)
    .where(and(eq(appUsers.role, 'owner'), eq(appUsers.active, true)))
    .limit(1);
  return {
    tx,
    userId: owner?.id ?? null,
    bankA: await makeBank(tx, 'A'),
    bankB: await makeBank(tx, 'B'),
    tag: `ZZDATATEST ${randomUUID().slice(0, 8).toUpperCase()}`,
    code: async (code) => {
      const [row] = await tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.code, code));
      return row.id;
    },
  };
}

async function txn(
  f: Fixture,
  bank: { id: string },
  amountCents: number,
  options: { payee?: string; suggestedAccountId?: string | null; date?: string } = {},
): Promise<string> {
  const payee = options.payee ?? f.tag;
  const [row] = await f.tx
    .insert(bankTransactions)
    .values({
      bankAccountId: bank.id,
      txnDate: options.date ?? '2031-05-10',
      description: payee,
      descriptionNormalized: payee.toUpperCase(),
      counterparty: payee,
      amountCents,
      fingerprint: randomUUID(),
      status: 'unreviewed',
      suggestedAccountId: options.suggestedAccountId ?? null,
      suggestionSource: options.suggestedAccountId ? 'rule' : null,
    })
    .returning({ id: bankTransactions.id });
  return row.id;
}

async function statusOf(f: Fixture, id: string): Promise<string> {
  const [row] = await f.tx.select({ status: bankTransactions.status }).from(bankTransactions).where(eq(bankTransactions.id, id));
  return row.status;
}

function draft(f: Fixture, overrides: Partial<RuleDraft> = {}): RuleDraft {
  return {
    id: null,
    name: '',
    priority: 500,
    bankAccountId: null,
    conditions: [{ field: 'payee', op: 'contains', value: f.tag }],
    direction: 'out',
    amountMinCents: null,
    amountMaxCents: null,
    accountId: null,
    vendorId: null,
    memoTemplate: null,
    autoPost: false,
    active: true,
    ...overrides,
  };
}

afterAll(async () => {
  await closeTestDb();
});

describe.skipIf(!hasDatabase)('excluding and including bank rows', { timeout: 60_000 }, () => {
  it('excludes an unposted row and brings it back to review', async () => {
    await withRollback(async (tx) => {
      const f = await fixture(tx);
      const id = await txn(f, f.bankA, -2500);
      expect(await excludeTransactions([id], { userId: f.userId, tx })).toBe(1);
      expect(await statusOf(f, id)).toBe('excluded');
      // Idempotent: excluding again changes nothing.
      expect(await excludeTransactions([id], { userId: f.userId, tx })).toBe(0);
      expect(await includeTransactions([id], { userId: f.userId, tx })).toBe(1);
      expect(await statusOf(f, id)).toBe('unreviewed');
    });
  });

  it('returns a linked pair to review only together', async () => {
    await withRollback(async (tx) => {
      const f = await fixture(tx);
      const charge = await txn(f, f.bankA, -1000);
      const returned = await txn(f, f.bankA, 1000);
      await tx.update(bankTransactions).set({ transferPairId: returned, status: 'excluded' }).where(eq(bankTransactions.id, charge));
      await tx.update(bankTransactions).set({ transferPairId: charge, status: 'excluded' }).where(eq(bankTransactions.id, returned));
      await expect(includeTransactions([returned], { userId: f.userId, tx })).rejects.toMatchObject({ code: 'wrong_status' });
      expect(await statusOf(f, returned)).toBe('excluded');
      expect(await includeTransactions([charge, returned], { userId: f.userId, tx })).toBe(2);
    });
  });

  it('refuses to exclude a posted row', async () => {
    await withRollback(async (tx) => {
      const f = await fixture(tx);
      const supplies = await f.code(ACCOUNTS.INVENTORY_PACKAGING);
      const id = await txn(f, f.bankA, -2500, { suggestedAccountId: supplies });
      await approveBankTransaction({ txnId: id }, { userId: f.userId, tx });
      await expect(excludeTransactions([id], { userId: f.userId, tx })).rejects.toMatchObject({ code: 'already_posted' });
    });
  });

  it('refuses to exclude one leg of a transfer pair', async () => {
    await withRollback(async (tx) => {
      const f = await fixture(tx);
      const out = await txn(f, f.bankA, -5000);
      const into = await txn(f, f.bankB, 5000);
      await linkTransfer(out, into, { userId: f.userId, tx });
      await expect(excludeTransactions([out], { userId: f.userId, tx })).rejects.toBeInstanceOf(BankingError);
      expect(await statusOf(f, out)).toBe('transfer');
    });
  });
});

describe('ruleDraftProblems', () => {
  const base: RuleDraft = {
    id: null,
    name: '',
    priority: 100,
    bankAccountId: null,
    conditions: [{ field: 'payee', op: 'contains', value: 'Amazon' }],
    direction: 'out',
    amountMinCents: null,
    amountMaxCents: null,
    accountId: null,
    vendorId: null,
    memoTemplate: null,
    autoPost: false,
    active: true,
  };

  it('accepts a well-formed draft', () => {
    expect(ruleDraftProblems(base)).toEqual([]);
  });

  it('names every problem in words', () => {
    const problems = ruleDraftProblems({
      ...base,
      conditions: [{ field: 'payee', op: 'regex', value: '(a)\\1' }, { field: 'reference', op: 'contains', value: ' ' }],
      amountMinCents: 500,
      amountMaxCents: 100,
      priority: 0,
    });
    expect(problems.some((p) => p.includes("condition 1's pattern cannot be used"))).toBe(true);
    expect(problems).toContain('condition 2 has nothing to match');
    expect(problems).toContain('the minimum amount is larger than the maximum');
    expect(problems).toContain('priority must be a whole number from 1 to 9999');
    expect(ruleDraftProblems({ ...base, conditions: [] })).toContain('add at least one condition');
  });
});

describe.skipIf(!hasDatabase)('saving rules', { timeout: 60_000 }, () => {
  it('creates a rule named after its first condition and its account', async () => {
    await withRollback(async (tx) => {
      const f = await fixture(tx);
      const packaging = await f.code(ACCOUNTS.INVENTORY_PACKAGING);
      const saved = await saveRule(draft(f, { accountId: packaging }), { userId: f.userId, tx, mayAutoPost: false });
      expect(saved.name.startsWith(`${f.tag} → ${ACCOUNTS.INVENTORY_PACKAGING} `)).toBe(true);
      const [row] = await tx.select().from(categorizationRules).where(eq(categorizationRules.id, saved.id));
      expect(row.accountId).toBe(packaging);
      expect(row.autoPost).toBe(false);
      expect(row.conditions).toEqual([{ field: 'payee', op: 'contains', value: f.tag }]);
    });
  });

  it('refuses auto-post unless the caller may grant it', async () => {
    await withRollback(async (tx) => {
      const f = await fixture(tx);
      const packaging = await f.code(ACCOUNTS.INVENTORY_PACKAGING);
      await expect(
        saveRule(draft(f, { accountId: packaging, autoPost: true }), { userId: f.userId, tx, mayAutoPost: false }),
      ).rejects.toMatchObject({ code: 'not_permitted' });

      const saved = await saveRule(draft(f, { accountId: packaging, autoPost: true }), { userId: f.userId, tx, mayAutoPost: true });
      // Once a rule posts on its own, nobody without the power can edit or switch it off.
      await expect(
        saveRule(draft(f, { id: saved.id, accountId: packaging, autoPost: false }), { userId: f.userId, tx, mayAutoPost: false }),
      ).rejects.toMatchObject({ code: 'not_permitted' });
      await expect(setRuleActive(saved.id, false, { userId: f.userId, tx, mayAutoPost: false })).rejects.toMatchObject({
        code: 'not_permitted',
      });
      await setRuleActive(saved.id, false, { userId: f.userId, tx, mayAutoPost: true });
      const [row] = await tx.select({ active: categorizationRules.active }).from(categorizationRules).where(eq(categorizationRules.id, saved.id));
      expect(row.active).toBe(false);
    });
  });

  it('refuses a bank account, a rollup or a sub-ledger control account as the target', async () => {
    await withRollback(async (tx) => {
      const f = await fixture(tx);
      const ctx = { userId: f.userId, tx, mayAutoPost: true };
      await expect(saveRule(draft(f, { accountId: f.bankB.glId }), ctx)).rejects.toMatchObject({ code: 'rule_invalid' });
      await expect(saveRule(draft(f, { accountId: await f.code(ACCOUNTS.INVENTORY) }), ctx)).rejects.toMatchObject({
        code: 'rule_invalid',
      });
      await expect(saveRule(draft(f, { accountId: await f.code(ACCOUNTS.AP) }), ctx)).rejects.toMatchObject({
        code: 'rule_invalid',
      });
      await expect(saveRule(draft(f), ctx)).rejects.toMatchObject({ code: 'rule_invalid' });
    });
  });
});

describe.skipIf(!hasDatabase)('previewRule', { timeout: 60_000 }, () => {
  it('counts what the draft matches and how much of it it would win', async () => {
    await withRollback(async (tx) => {
      const f = await fixture(tx);
      const packaging = await f.code(ACCOUNTS.INVENTORY_PACKAGING);
      await txn(f, f.bankA, -1000);
      await txn(f, f.bankA, -2000);
      await txn(f, f.bankB, 3000); // money in: outside an "out" rule
      const excluded = await txn(f, f.bankA, -4000);
      await excludeTransactions([excluded], { userId: f.userId, tx });

      const preview = await previewRule(draft(f, { accountId: packaging }), tx);
      expect(preview.problems).toEqual([]);
      expect(preview.matched).toBe(2);
      expect(preview.wins).toBe(2);
      expect(preview.sample.map((row) => row.amountCents).sort((a, b) => a - b)).toEqual([-2000, -1000]);

      // An earlier rule that matches the same rows takes them.
      await saveRule(draft(f, { accountId: packaging, priority: 1, name: 'Earlier' }), { userId: f.userId, tx, mayAutoPost: false });
      const behind = await previewRule(draft(f, { accountId: packaging, priority: 900 }), tx);
      expect(behind.matched).toBe(2);
      expect(behind.wins).toBe(0);
      expect(behind.sample[0].wonBy).toBe('Earlier');

      const bounded = await previewRule(draft(f, { accountId: packaging, amountMinCents: 1500 }), tx);
      expect(bounded.matched).toBe(1);
    });
  });

  it('reports why a draft cannot run instead of matching', async () => {
    const preview = await previewRule({
      id: null,
      name: '',
      priority: 100,
      bankAccountId: null,
      conditions: [{ field: 'payee', op: 'contains', value: '' }],
      direction: 'any',
      amountMinCents: null,
      amountMaxCents: null,
      accountId: null,
      vendorId: null,
      memoTemplate: null,
      autoPost: false,
      active: true,
    });
    expect(preview.matched).toBe(0);
    expect(preview.problems).toContain('condition 1 has nothing to match');
  });
});

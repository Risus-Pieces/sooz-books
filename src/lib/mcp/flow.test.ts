import { afterAll, describe, expect, it } from 'vitest';

// First: loads .env.local before '@/db/client' is imported anywhere below.
import { closeTestDb, hasDatabase, withRollback } from '@/lib/ledger/test-support';

import { eq } from 'drizzle-orm';

import { accounts, bankTransactions, journalEntries, mcpStagings } from '@/db/schema';
import { ForbiddenError } from '@/lib/auth/roles';
import { ACCOUNTS } from '@/lib/ledger/coa';
import { ClosedPeriodError, UnbalancedEntryError } from '@/lib/ledger/errors';
import { closePeriod } from '@/lib/ledger/periods';
import { postJournalEntry } from '@/lib/ledger/post';

import { commitStaged } from './commit';
import { stageBankDecisions, stageJournalEntry, stageNewAccount } from './stage';
import { StagingError } from './staging';
import { accountIdOf, expenseLeaf, immediate, mcpUser, newBank, newTxn } from './test-support';

afterAll(closeTestDb);

const DAY = '2031-03-04';

describe.skipIf(!hasDatabase)('stage_bank_decisions', () => {
  it('shows the entry it would post, and writes nothing to the ledger', async () => {
    await withRollback(async (tx) => {
      await immediate(tx);
      const user = await mcpUser(tx);
      const bank = await newBank(tx);
      const txnId = await newTxn(tx, bank.id, DAY, -4_250, 'PAPER CO #12');
      const entriesBefore = await tx.select({ id: journalEntries.id }).from(journalEntries);

      const staged = await stageBankDecisions(user, { items: [{ txn_id: txnId, action: 'accept', account: ACCOUNTS.OFFICE_SUPPLIES }] }, { tx });

      expect(staged.stageId).not.toBeNull();
      expect(staged.preview.problems).toEqual([]);
      expect(staged.preview.entries).toHaveLength(1);
      const [entry] = staged.preview.entries;
      expect(entry).toMatchObject({ txnId, date: DAY, amountCents: -4_250, action: 'accept', description: 'PAPER CO #12' });
      expect(entry.lines).toEqual([
        { account: expect.stringContaining('6740'), debitCents: 4_250, creditCents: 0 },
        { account: expect.stringContaining(bank.name.replace('TEST bank', 'Test bank')), debitCents: 0, creditCents: 4_250 },
      ]);
      expect(await tx.select({ id: journalEntries.id }).from(journalEntries)).toHaveLength(entriesBefore.length);
      const [txn] = await tx.select({ status: bankTransactions.status, entry: bankTransactions.journalEntryId }).from(bankTransactions).where(eq(bankTransactions.id, txnId));
      expect(txn).toEqual({ status: 'unreviewed', entry: null });
    });
  });

  it('never falls back to the suggestion: an accept with no account is a problem, and nothing is staged', async () => {
    await withRollback(async (tx) => {
      const user = await mcpUser(tx);
      const bank = await newBank(tx);
      const txnId = await newTxn(tx, bank.id, DAY, -100);

      const staged = await stageBankDecisions(user, { items: [{ txn_id: txnId, action: 'accept' }] }, { tx });

      expect(staged.stageId).toBeNull();
      expect(staged.preview.problems).toEqual([{ txnId, reason: expect.stringContaining('Say which account') }]);
      expect(await tx.select({ id: mcpStagings.id }).from(mcpStagings)).toHaveLength(0);
    });
  });

  it('stages the good rows of a mixed batch and names the bad ones', async () => {
    await withRollback(async (tx) => {
      await immediate(tx);
      const user = await mcpUser(tx);
      const bank = await newBank(tx);
      const good = await newTxn(tx, bank.id, DAY, -500);
      const excluded = await newTxn(tx, bank.id, DAY, -600, 'X', { status: 'excluded' });

      const staged = await stageBankDecisions(
        user,
        {
          items: [
            { txn_id: good, action: 'accept', account: ACCOUNTS.OFFICE_SUPPLIES },
            { txn_id: excluded, action: 'accept', account: ACCOUNTS.OFFICE_SUPPLIES },
            { txn_id: good, action: 'accept', account: ACCOUNTS.OFFICE_SUPPLIES },
          ],
        },
        { tx },
      );

      expect(staged.preview.entries.map((e) => e.txnId)).toEqual([good]);
      expect(staged.preview.problems.map((p) => p.txnId).sort()).toEqual([excluded, good].sort());
      expect(staged.stageId).not.toBeNull();
    });
  });

  it('refuses an account that is a bank account, a header, or does not exist', async () => {
    await withRollback(async (tx) => {
      const user = await mcpUser(tx);
      const bank = await newBank(tx);
      const txnId = await newTxn(tx, bank.id, DAY, -100);
      const other = await newBank(tx);

      const reasons = [];
      for (const account of [other.glId, '6700', '9999']) {
        const staged = await stageBankDecisions(user, { items: [{ txn_id: txnId, action: 'accept', account }] }, { tx });
        expect(staged.stageId).toBeNull();
        reasons.push(staged.preview.problems[0].reason);
      }
      expect(reasons[0]).toMatch(/bank account|transfer/i);
      expect(reasons[1]).toMatch(/header|rollup|only totals/i);
      expect(reasons[2]).toMatch(/no account/i);
    });
  });

  it("puts a personal purchase on the member's draws account", async () => {
    await withRollback(async (tx) => {
      const user = await mcpUser(tx);
      const bank = await newBank(tx);
      const txnId = await newTxn(tx, bank.id, DAY, -2_000, 'MY COFFEE');

      const staged = await stageBankDecisions(user, { items: [{ txn_id: txnId, action: 'personal' }] }, { tx });

      expect(staged.preview.entries[0].action).toBe('personal');
      expect(staged.preview.entries[0].lines[0]).toMatchObject({ debitCents: 2_000 });
      expect(staged.preview.entries[0].lines[0].account).toContain('3020');
    });
  });

  it('is closed to a role without bank.approve', async () => {
    await withRollback(async (tx) => {
      const viewer = await mcpUser(tx, 'viewer');
      const bank = await newBank(tx);
      const txnId = await newTxn(tx, bank.id, DAY, -100);
      await expect(
        stageBankDecisions(viewer, { items: [{ txn_id: txnId, action: 'exclude' }] }, { tx }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });
  });

  it('refuses a date in a closed period', async () => {
    await withRollback(async (tx) => {
      await immediate(tx);
      const user = await mcpUser(tx);
      const bank = await newBank(tx);
      const txnId = await newTxn(tx, bank.id, '2031-07-10', -100);
      await closePeriod(2031, 7, user.id, { tx });

      const staged = await stageBankDecisions(user, { items: [{ txn_id: txnId, action: 'accept', account: ACCOUNTS.OFFICE_SUPPLIES }] }, { tx });
      expect(staged.stageId).toBeNull();
      expect(staged.preview.problems[0].reason).toMatch(/closed/i);
    });
  });
});

describe.skipIf(!hasDatabase)('commit_staged for bank decisions', () => {
  it('posts exactly what was staged, once', async () => {
    await withRollback(async (tx) => {
      await immediate(tx);
      const user = await mcpUser(tx);
      const bank = await newBank(tx);
      const txnId = await newTxn(tx, bank.id, DAY, -4_250);
      const staged = await stageBankDecisions(user, { items: [{ txn_id: txnId, action: 'accept', account: ACCOUNTS.OFFICE_SUPPLIES }] }, { tx });

      const done = await commitStaged(user, staged.stageId!, { tx });

      expect(done.kind).toBe('bank_decisions');
      if (done.kind !== 'bank_decisions') throw new Error('unreachable');
      expect(done.result.failed).toEqual([]);
      expect(done.result.posted).toHaveLength(1);
      const [txn] = await tx.select({ status: bankTransactions.status, entry: bankTransactions.journalEntryId }).from(bankTransactions).where(eq(bankTransactions.id, txnId));
      expect(txn.status).toBe('categorized');
      expect(txn.entry).not.toBeNull();
      const [row] = await tx.select({ committedAt: mcpStagings.committedAt }).from(mcpStagings).where(eq(mcpStagings.id, staged.stageId!));
      expect(row.committedAt).not.toBeNull();

      await expect(commitStaged(user, staged.stageId!, { tx })).rejects.toMatchObject({ code: 'used' });
    });
  });

  it('excludes what was staged for exclusion', async () => {
    await withRollback(async (tx) => {
      const user = await mcpUser(tx);
      const bank = await newBank(tx);
      const txnId = await newTxn(tx, bank.id, DAY, -300);
      const staged = await stageBankDecisions(user, { items: [{ txn_id: txnId, action: 'exclude' }] }, { tx });
      expect(staged.preview.exclusions).toHaveLength(1);

      const done = await commitStaged(user, staged.stageId!, { tx });

      expect(done.kind === 'bank_decisions' && done.result.excluded).toEqual([txnId]);
      const [txn] = await tx.select({ status: bankTransactions.status }).from(bankTransactions).where(eq(bankTransactions.id, txnId));
      expect(txn.status).toBe('excluded');
    });
  });

  it('reports a row that was posted by someone else in the meantime, and still spends the stage', async () => {
    await withRollback(async (tx) => {
      await immediate(tx);
      const user = await mcpUser(tx);
      const bank = await newBank(tx);
      const first = await newTxn(tx, bank.id, DAY, -100, 'A');
      const second = await newTxn(tx, bank.id, DAY, -200, 'B');
      const staged = await stageBankDecisions(
        user,
        { items: [
          { txn_id: first, action: 'accept', account: ACCOUNTS.OFFICE_SUPPLIES },
          { txn_id: second, action: 'accept', account: ACCOUNTS.OFFICE_SUPPLIES },
        ] },
        { tx },
      );
      // Somebody excludes the second row between staging and confirming.
      await tx.update(bankTransactions).set({ status: 'excluded' }).where(eq(bankTransactions.id, second));

      const done = await commitStaged(user, staged.stageId!, { tx });

      if (done.kind !== 'bank_decisions') throw new Error('unreachable');
      expect(done.result.posted).toHaveLength(1);
      expect(done.result.failed).toEqual([{ txnId: second, reason: expect.stringMatching(/excluded/i) }]);
      await expect(commitStaged(user, staged.stageId!, { tx })).rejects.toMatchObject({ code: 'used' });
    });
  });

  it("rechecks the role at confirmation, and leaves the stage unspent when it refuses", async () => {
    await withRollback(async (tx) => {
      await immediate(tx);
      const owner = await mcpUser(tx);
      const bank = await newBank(tx);
      const txnId = await newTxn(tx, bank.id, DAY, -100);
      const staged = await stageBankDecisions(owner, { items: [{ txn_id: txnId, action: 'accept', account: ACCOUNTS.OFFICE_SUPPLIES }] }, { tx });

      await expect(commitStaged({ ...owner, role: 'viewer' }, staged.stageId!, { tx })).rejects.toBeInstanceOf(ForbiddenError);

      const [row] = await tx.select({ committedAt: mcpStagings.committedAt }).from(mcpStagings).where(eq(mcpStagings.id, staged.stageId!));
      expect(row.committedAt).toBeNull();
      await expect(commitStaged(owner, staged.stageId!, { tx })).resolves.toMatchObject({ kind: 'bank_decisions' });
    });
  });

  it("will not confirm someone else's stage", async () => {
    await withRollback(async (tx) => {
      const owner = await mcpUser(tx);
      const bank = await newBank(tx);
      const txnId = await newTxn(tx, bank.id, DAY, -100);
      const staged = await stageBankDecisions(owner, { items: [{ txn_id: txnId, action: 'exclude' }] }, { tx });

      await expect(
        commitStaged({ ...owner, id: '00000000-0000-4000-8000-0000000000ff' }, staged.stageId!, { tx }),
      ).rejects.toBeInstanceOf(StagingError);
    });
  });
});

describe.skipIf(!hasDatabase)('journal entries', () => {
  it('stages and posts a balanced entry with its accounts named', async () => {
    await withRollback(async (tx) => {
      await immediate(tx);
      const user = await mcpUser(tx);
      const staged = await stageJournalEntry(
        user,
        { date: DAY, memo: 'Reclass', lines: [
          { account: ACCOUNTS.OFFICE_SUPPLIES, debit: '125.40' },
          { account: ACCOUNTS.INVENTORY_PACKAGING, credit: '125.40' },
        ] },
        { tx },
      );
      expect(staged.preview.totalCents).toBe(12_540);
      expect(staged.preview.lines.map((l) => l.account.slice(0, 4))).toEqual(['6740', '1330']);

      const done = await commitStaged(user, staged.stageId!, { tx });
      if (done.kind !== 'journal_entry') throw new Error('unreachable');
      const [entry] = await tx.select({ status: journalEntries.status, memo: journalEntries.memo }).from(journalEntries).where(eq(journalEntries.id, done.result.entryId));
      expect(entry).toEqual({ status: 'posted', memo: 'Reclass' });
    });
  });

  it('refuses an unbalanced entry at staging, before anything is stored', async () => {
    await withRollback(async (tx) => {
      const user = await mcpUser(tx);
      await expect(
        stageJournalEntry(user, { date: DAY, lines: [
          { account: ACCOUNTS.OFFICE_SUPPLIES, debit: '10.00' },
          { account: ACCOUNTS.INVENTORY_PACKAGING, credit: '9.99' },
        ] }, { tx }),
      ).rejects.toBeInstanceOf(UnbalancedEntryError);
      expect(await tx.select({ id: mcpStagings.id }).from(mcpStagings)).toHaveLength(0);
    });
  });

  it('refuses a closed period, a bad date, a bad amount and a header account', async () => {
    await withRollback(async (tx) => {
      await immediate(tx);
      const user = await mcpUser(tx);
      await closePeriod(2031, 8, user.id, { tx });
      const lines = [
        { account: ACCOUNTS.OFFICE_SUPPLIES, debit: '10.00' },
        { account: ACCOUNTS.INVENTORY_PACKAGING, credit: '10.00' },
      ];
      await expect(stageJournalEntry(user, { date: '2031-08-09', lines }, { tx })).rejects.toBeInstanceOf(ClosedPeriodError);
      await expect(stageJournalEntry(user, { date: 'yesterday', lines }, { tx })).rejects.toThrow(/YYYY-MM-DD/);
      await expect(
        stageJournalEntry(user, { date: DAY, lines: [{ account: ACCOUNTS.OFFICE_SUPPLIES, debit: 'ten' }, lines[1]] }, { tx }),
      ).rejects.toThrow(/not an amount/);
      await expect(
        stageJournalEntry(user, { date: DAY, lines: [{ account: '6700', debit: '10.00' }, lines[1]] }, { tx }),
      ).rejects.toThrow(/header|rollup|only totals/i);
    });
  });

  it('is closed to a role without ledger.post', async () => {
    await withRollback(async (tx) => {
      const viewer = await mcpUser(tx, 'viewer');
      await expect(
        stageJournalEntry(viewer, { date: DAY, lines: [{ account: '6740', debit: '1' }, { account: '1330', credit: '1' }] }, { tx }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });
  });
});

describe.skipIf(!hasDatabase)('new accounts', () => {
  it('stages and creates an account under a parent', async () => {
    await withRollback(async (tx) => {
      const user = await mcpUser(tx);
      const staged = await stageNewAccount(user, { code: '1451', name: 'Merch — Shirts', type: 'asset' }, { tx });
      expect(staged.preview).toMatchObject({ code: '1451', parent: null, warnings: [] });

      const done = await commitStaged(user, staged.stageId!, { tx });
      if (done.kind !== 'new_account') throw new Error('unreachable');
      const [row] = await tx.select({ name: accounts.name }).from(accounts).where(eq(accounts.id, done.result.accountId));
      expect(row.name).toBe('Merch — Shirts');
    });
  });

  it('refuses a duplicate code, a missing parent and a parent of another type', async () => {
    await withRollback(async (tx) => {
      const user = await mcpUser(tx);
      await expect(stageNewAccount(user, { code: '6740', name: 'x', type: 'expense' }, { tx })).rejects.toThrow(/already taken/);
      await expect(stageNewAccount(user, { code: '6741', name: 'x', type: 'expense', parent_code: '0000' }, { tx })).rejects.toThrow(/no parent/);
      await expect(stageNewAccount(user, { code: '6741', name: 'x', type: 'asset', parent_code: '6700' }, { tx })).rejects.toThrow(/same type/);
    });
  });

  it('warns when the parent already has postings and would stop accepting them', async () => {
    await withRollback(async (tx) => {
      await immediate(tx);
      const user = await mcpUser(tx);
      const leaf = await expenseLeaf(tx);
      await postJournalEntry(
        { date: DAY, sourceType: 'manual', lines: [
          { accountId: leaf.id, debitCents: 100 },
          { accountId: await accountIdOf(tx, ACCOUNTS.INVENTORY_PACKAGING), creditCents: 100 },
        ] },
        { userId: user.id, tx },
      );

      const staged = await stageNewAccount(user, { code: 'TE-child', name: 'Child', type: 'expense', parent_code: leaf.code }, { tx });
      expect(staged.preview.warnings[0]).toMatch(/already has 1 posted line/);
    });
  });

  it('is closed to a role without settings.manage', async () => {
    await withRollback(async (tx) => {
      const bookkeeper = await mcpUser(tx, 'bookkeeper');
      await expect(stageNewAccount(bookkeeper, { code: '1452', name: 'x', type: 'asset' }, { tx })).rejects.toBeInstanceOf(ForbiddenError);
    });
  });
});


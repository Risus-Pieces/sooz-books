import { afterAll, describe, expect, it } from 'vitest';

// First: loads .env.local before '@/db/client' is imported anywhere below.
import { closeTestDb, hasDatabase, withRollback } from '@/lib/ledger/test-support';

import { randomUUID } from 'node:crypto';

import { and, asc, eq, sql } from 'drizzle-orm';

import {
  accounts,
  appUsers,
  bankAccounts,
  bankTransactions,
  categorizationRules,
  journalEntries,
  journalLines,
  vendors,
} from '@/db/schema';
import { balancesByAccount } from '@/lib/ledger/balances';
import { ACCOUNTS } from '@/lib/ledger/coa';
import { ClosedPeriodError, ControlAccountError, RollupAccountError } from '@/lib/ledger/errors';
import { closePeriod } from '@/lib/ledger/periods';
import type { LedgerDb } from '@/lib/ledger/post';

import {
  BankingError,
  approveBankTransaction,
  approveMany,
  approveTransfer,
  createRuleFromTransaction,
  defaultRuleConditions,
  linkRefund,
  linkTransfer,
  markPersonal,
  postAutoPostMatches,
  unlinkTransfer,
  unpostBankTransaction,
} from './post';
import { bankRegister, listQueue, queueCounts } from './queue';

// ---------------------------------------------------------------------------
// Fixtures — every row below lives inside a transaction that is rolled back.
// Dates are in 2031 so nothing here shares a period with the real books.
// ---------------------------------------------------------------------------

interface TestBank {
  id: string;
  glId: string;
}

interface Fixture {
  tx: LedgerDb;
  userId: string | null;
  a: TestBank;
  b: TestBank;
  code: (code: string) => Promise<string>;
  vendorId: string;
}

async function makeBank(tx: LedgerDb, label: string): Promise<TestBank> {
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
  const [vendor] = await tx
    .insert(vendors)
    .values({ name: `TEST vendor ${randomUUID().slice(0, 8)}` })
    .returning({ id: vendors.id });
  const cache = new Map<string, string>();
  return {
    tx,
    userId: owner?.id ?? null,
    a: await makeBank(tx, 'A'),
    b: await makeBank(tx, 'B'),
    vendorId: vendor.id,
    code: async (code) => {
      const hit = cache.get(code);
      if (hit !== undefined) return hit;
      const [row] = await tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.code, code));
      cache.set(code, row.id);
      return row.id;
    },
  };
}

interface TxnOptions {
  counterparty?: string;
  status?: 'unreviewed' | 'categorized' | 'transfer' | 'excluded';
  suggestedAccountId?: string | null;
  suggestedVendorId?: string | null;
  ruleId?: string | null;
  balanceCents?: number | null;
  reference?: string | null;
}

async function txn(
  f: Fixture,
  bank: TestBank,
  date: string,
  amountCents: number,
  options: TxnOptions = {},
): Promise<string> {
  const payee = options.counterparty ?? 'TEST PAYEE';
  const [row] = await f.tx
    .insert(bankTransactions)
    .values({
      bankAccountId: bank.id,
      txnDate: date,
      description: payee,
      descriptionNormalized: payee.toUpperCase(),
      counterparty: payee,
      amountCents,
      balanceCents: options.balanceCents ?? null,
      reference: options.reference ?? null,
      fingerprint: randomUUID(),
      status: options.status ?? 'unreviewed',
      suggestedAccountId: options.suggestedAccountId ?? null,
      suggestedVendorId: options.suggestedVendorId ?? null,
      suggestionSource: options.suggestedAccountId ? 'rule' : null,
      suggestionConfidence: options.suggestedAccountId ? '0.850' : null,
      ruleId: options.ruleId ?? null,
    })
    .returning({ id: bankTransactions.id });
  return row.id;
}

async function row(tx: LedgerDb, id: string) {
  const [found] = await tx.select().from(bankTransactions).where(eq(bankTransactions.id, id));
  return found;
}

async function linesOf(tx: LedgerDb, entryId: string) {
  return tx
    .select()
    .from(journalLines)
    .where(eq(journalLines.entryId, entryId))
    .orderBy(asc(journalLines.lineNo));
}

afterAll(closeTestDb);

const T = 60_000;

describe.skipIf(!hasDatabase)('approveBankTransaction', () => {
  it(
    'posts money out as debit the account, credit the bank, and links the row atomically',
    async () => {
      await withRollback(async (tx) => {
        const f = await fixture(tx);
        const supplies = await f.code(ACCOUNTS.OFFICE_SUPPLIES);
        const id = await txn(f, f.a, '2031-03-05', -12_34, {
          counterparty: 'TEST STAPLES #123',
          suggestedAccountId: supplies,
          suggestedVendorId: f.vendorId,
        });

        const result = await approveBankTransaction({ txnId: id }, { userId: f.userId, tx });

        const lines = await linesOf(tx, result.entryId);
        expect(lines).toHaveLength(2);
        const expense = lines.find((l) => l.accountId === supplies);
        const bank = lines.find((l) => l.accountId === f.a.glId);
        expect(expense).toMatchObject({ debitCents: 12_34, creditCents: 0, vendorId: f.vendorId });
        expect(bank).toMatchObject({ debitCents: 0, creditCents: 12_34, vendorId: null, channelId: null });

        const [entry] = await tx.select().from(journalEntries).where(eq(journalEntries.id, result.entryId));
        expect(entry).toMatchObject({ status: 'posted', sourceType: 'bank', sourceId: id, entryDate: '2031-03-05' });

        const after = await row(tx, id);
        expect(after.status).toBe('categorized');
        expect(after.journalEntryId).toBe(result.entryId);
        expect(after.reviewedBy).toBe(f.userId);
        expect(after.reviewedAt).not.toBeNull();
        // The suggestion is untouched by the approval.
        expect(after.suggestedAccountId).toBe(supplies);

        // The bank's spelling of the vendor was learned.
        const aliases = (await tx.execute(
          sql`select alias from vendor_aliases where vendor_id = ${f.vendorId}::uuid`,
        )) as unknown as { alias: string }[];
        expect(aliases.map((a) => a.alias)).toContain('TEST STAPLES #123');
      });
    },
    T,
  );

  it(
    'posts money in as debit the bank, credit the account (a member contribution)',
    async () => {
      await withRollback(async (tx) => {
        const f = await fixture(tx);
        const contributions = await f.code(ACCOUNTS.MEMBER_CONTRIBUTIONS);
        const id = await txn(f, f.a, '2031-03-06', 500_00, { counterparty: 'CHASE COLLEGE' });

        const result = await approveBankTransaction(
          { txnId: id, accountId: contributions, memo: 'Founder ACH pull' },
          { userId: f.userId, tx },
        );
        const lines = await linesOf(tx, result.entryId);
        expect(lines.find((l) => l.accountId === f.a.glId)).toMatchObject({ debitCents: 500_00, creditCents: 0 });
        expect(lines.find((l) => l.accountId === contributions)).toMatchObject({ debitCents: 0, creditCents: 500_00 });
      });
    },
    T,
  );

  it(
    'splits a transaction across accounts, and refuses splits that do not add up with the difference',
    async () => {
      await withRollback(async (tx) => {
        const f = await fixture(tx);
        const ingredients = await f.code(ACCOUNTS.INVENTORY_INGREDIENTS);
        const packaging = await f.code(ACCOUNTS.INVENTORY_PACKAGING);
        const freight = await f.code(ACCOUNTS.COGS_FREIGHT_IN);
        const id = await txn(f, f.a, '2031-03-07', -1_000_00);

        const short = approveBankTransaction(
          {
            txnId: id,
            splits: [
              { accountId: ingredients, amountCents: 600_00 },
              { accountId: packaging, amountCents: 399_00 },
            ],
          },
          { userId: f.userId, tx },
        );
        await expect(short).rejects.toMatchObject({ code: 'split_mismatch' });
        await expect(short).rejects.toThrow(/\$1\.00 still to allocate/);

        const over = approveBankTransaction(
          { txnId: id, splits: [{ accountId: ingredients, amountCents: 1_000_01 }] },
          { userId: f.userId, tx },
        );
        await expect(over).rejects.toThrow(/\$0\.01 over/);

        const result = await approveBankTransaction(
          {
            txnId: id,
            splits: [
              { accountId: ingredients, amountCents: 600_00, memo: 'Flavors' },
              { accountId: packaging, amountCents: 350_00 },
              { accountId: freight, amountCents: 50_00 },
            ],
          },
          { userId: f.userId, tx },
        );
        const lines = await linesOf(tx, result.entryId);
        expect(lines).toHaveLength(4);
        expect(lines.reduce((s, l) => s + l.debitCents, 0)).toBe(1_000_00);
        expect(lines.reduce((s, l) => s + l.creditCents, 0)).toBe(1_000_00);
        expect(lines.find((l) => l.accountId === ingredients)?.memo).toBe('Flavors');
        expect(lines.find((l) => l.accountId === f.a.glId)?.creditCents).toBe(1_000_00);
      });
    },
    T,
  );

  it(
    'refuses excluded, already-posted and reconciled rows',
    async () => {
      await withRollback(async (tx) => {
        const f = await fixture(tx);
        const supplies = await f.code(ACCOUNTS.OFFICE_SUPPLIES);
        const ctx = { userId: f.userId, tx };

        const excluded = await txn(f, f.a, '2031-03-08', -5_00, { status: 'excluded' });
        await expect(approveBankTransaction({ txnId: excluded, accountId: supplies }, ctx)).rejects.toMatchObject({
          code: 'excluded',
        });

        const posted = await txn(f, f.a, '2031-03-08', -6_00);
        await approveBankTransaction({ txnId: posted, accountId: supplies }, ctx);
        await expect(approveBankTransaction({ txnId: posted, accountId: supplies }, ctx)).rejects.toMatchObject({
          code: 'already_posted',
        });

        const locked = await txn(f, f.a, '2031-03-08', -7_00);
        const [recon] = (await tx.execute(sql`
          insert into reconciliations (bank_account_id, statement_start_date, statement_date,
                                       opening_balance_cents, closing_balance_cents, status)
          values (${f.a.id}::uuid, '2031-03-01', '2031-03-31', 0, 0, 'completed')
          returning id`)) as unknown as { id: string }[];
        await tx
          .update(bankTransactions)
          .set({ reconciliationId: recon.id, reconciledAt: new Date() })
          .where(eq(bankTransactions.id, locked));
        await expect(approveBankTransaction({ txnId: locked, accountId: supplies }, ctx)).rejects.toMatchObject({
          code: 'reconciled',
        });
      });
    },
    T,
  );

  it(
    'refuses a bank, control or rollup account as the counter-account',
    async () => {
      await withRollback(async (tx) => {
        const f = await fixture(tx);
        const ctx = { userId: f.userId, tx };
        const id = await txn(f, f.a, '2031-03-09', -10_00);

        await expect(approveBankTransaction({ txnId: id, accountId: f.b.glId }, ctx)).rejects.toMatchObject({
          code: 'bank_account_as_category',
        });
        await expect(
          approveBankTransaction({ txnId: id, accountId: await f.code(ACCOUNTS.OPERATING_CHECKING) }, ctx),
        ).rejects.toMatchObject({ code: 'bank_account_as_category' });
        await expect(
          approveBankTransaction({ txnId: id, accountId: await f.code(ACCOUNTS.AP) }, ctx),
        ).rejects.toBeInstanceOf(ControlAccountError);
        await expect(
          approveBankTransaction({ txnId: id, accountId: await f.code(ACCOUNTS.INVENTORY) }, ctx),
        ).rejects.toBeInstanceOf(RollupAccountError);
        await expect(
          approveBankTransaction(
            { txnId: id, splits: [{ accountId: await f.code(ACCOUNTS.AR), amountCents: 10_00 }] },
            ctx,
          ),
        ).rejects.toBeInstanceOf(ControlAccountError);

        // Nothing posted along the way.
        expect((await row(tx, id)).journalEntryId).toBeNull();
      });
    },
    T,
  );

  it(
    'refuses a row in a closed period, naming the period',
    async () => {
      await withRollback(async (tx) => {
        const f = await fixture(tx);
        const id = await txn(f, f.a, '2031-02-14', -10_00);
        await closePeriod(2031, 2, f.userId, { tx });

        const attempt = approveBankTransaction(
          { txnId: id, accountId: await f.code(ACCOUNTS.OFFICE_SUPPLIES) },
          { userId: f.userId, tx },
        );
        await expect(attempt).rejects.toBeInstanceOf(ClosedPeriodError);
        await expect(attempt).rejects.toThrow(/2031-02/);
        expect((await row(tx, id)).journalEntryId).toBeNull();
      });
    },
    T,
  );

  it(
    'markPersonal posts to Owner Draws with no vendor',
    async () => {
      await withRollback(async (tx) => {
        const f = await fixture(tx);
        const id = await txn(f, f.a, '2031-03-10', -45_99, {
          counterparty: 'Amazon',
          suggestedAccountId: await f.code(ACCOUNTS.OFFICE_SUPPLIES),
          suggestedVendorId: f.vendorId,
        });
        const result = await markPersonal(id, { userId: f.userId, tx });
        const draws = await f.code(ACCOUNTS.OWNER_DRAWS);
        const lines = await linesOf(tx, result.entryId);
        expect(lines.find((l) => l.accountId === draws)).toMatchObject({ debitCents: 45_99, vendorId: null });
      });
    },
    T,
  );
});

describe.skipIf(!hasDatabase)('transfers', () => {
  it(
    'posts a transfer pair once, debit the receiving bank and credit the sending one, linking both legs',
    async () => {
      await withRollback(async (tx) => {
        const f = await fixture(tx);
        const ctx = { userId: f.userId, tx };
        const out = await txn(f, f.a, '2031-03-11', -50_00, { counterparty: 'Owner comp' });
        const inn = await txn(f, f.b, '2031-03-12', 50_00, { counterparty: 'Operating' });

        await expect(approveTransfer(out, ctx)).rejects.toMatchObject({ code: 'transfer_unpaired' });

        await linkTransfer(out, inn, ctx);
        const result = await approveTransfer(inn, ctx);
        expect(result.sendingTxnId).toBe(out);
        expect(result.receivingTxnId).toBe(inn);

        const lines = await linesOf(tx, result.entryId);
        expect(lines).toHaveLength(2);
        expect(lines.find((l) => l.accountId === f.b.glId)).toMatchObject({ debitCents: 50_00 });
        expect(lines.find((l) => l.accountId === f.a.glId)).toMatchObject({ creditCents: 50_00 });

        const [entry] = await tx.select().from(journalEntries).where(eq(journalEntries.id, result.entryId));
        expect(entry.entryDate).toBe('2031-03-11');

        for (const id of [out, inn]) {
          const leg = await row(tx, id);
          expect(leg.status).toBe('transfer');
          expect(leg.journalEntryId).toBe(result.entryId);
        }

        // A second approval of either leg posts nothing more.
        await expect(approveTransfer(out, ctx)).rejects.toMatchObject({ code: 'already_posted' });
        const entries = await tx
          .select({ id: journalEntries.id })
          .from(journalEntries)
          .where(and(eq(journalEntries.sourceType, 'bank'), eq(journalEntries.sourceId, out)));
        expect(entries).toHaveLength(1);

        // A transfer leg cannot be coded to an expense on its own.
        await expect(
          approveBankTransaction({ txnId: out, accountId: await f.code(ACCOUNTS.OFFICE_SUPPLIES) }, ctx),
        ).rejects.toMatchObject({ code: 'already_posted' });
      });
    },
    T,
  );

  it(
    'refuses to pair legs that are not equal and opposite, and unlinks back to review',
    async () => {
      await withRollback(async (tx) => {
        const f = await fixture(tx);
        const ctx = { userId: f.userId, tx };
        const out = await txn(f, f.a, '2031-03-11', -50_00);
        const wrong = await txn(f, f.b, '2031-03-11', 49_00);
        await expect(linkTransfer(out, wrong, ctx)).rejects.toMatchObject({ code: 'transfer_invalid' });

        const inn = await txn(f, f.b, '2031-03-11', 50_00);
        await linkTransfer(out, inn, ctx);
        await expect(
          approveBankTransaction({ txnId: out, accountId: await f.code(ACCOUNTS.OFFICE_SUPPLIES) }, ctx),
        ).rejects.toMatchObject({ code: 'wrong_status' });
        await unlinkTransfer(inn, ctx);
        const leg = await row(tx, out);
        expect(leg).toMatchObject({ status: 'unreviewed', transferPairId: null });
      });
    },
    T,
  );
});

describe.skipIf(!hasDatabase)('card refunds', () => {
  it(
    "defaults a linked refund to its charge's account, so the pair nets to zero",
    async () => {
      await withRollback(async (tx) => {
        const f = await fixture(tx);
        const ctx = { userId: f.userId, tx };
        const packaging = await f.code(ACCOUNTS.INVENTORY_PACKAGING);
        const charge = await txn(f, f.a, '2031-03-13', -80_00, {
          counterparty: 'Online Labels LLC',
          suggestedAccountId: await f.code(ACCOUNTS.OFFICE_SUPPLIES),
        });
        await approveBankTransaction({ txnId: charge, accountId: packaging }, ctx);

        const refund = await txn(f, f.a, '2031-03-20', 80_00, { counterparty: 'Online Labels LLC' });
        await expect(linkRefund(refund, refund, ctx)).rejects.toBeInstanceOf(BankingError);
        await linkRefund(refund, charge, ctx);

        const result = await approveBankTransaction({ txnId: refund }, ctx);
        expect(result.accountIds).toEqual([packaging]);

        const balances = await balancesByAccount({ from: '2031-03-01', to: '2031-03-31' }, tx);
        const lines = await tx
          .select({ debit: journalLines.debitCents, credit: journalLines.creditCents })
          .from(journalLines)
          .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
          .where(and(eq(journalLines.accountId, packaging), sql`${journalEntries.entryDate} >= '2031-01-01'`));
        expect(lines.reduce((s, l) => s + l.debit - l.credit, 0)).toBe(0);
        expect(balances.get(f.a.glId) ?? 0).toBe(0);
      });
    },
    T,
  );
});

describe.skipIf(!hasDatabase)('unpostBankTransaction', () => {
  it(
    'reverses the entry, nets to zero in the trial balance and returns the row to review with its suggestion',
    async () => {
      await withRollback(async (tx) => {
        const f = await fixture(tx);
        const ctx = { userId: f.userId, tx };
        const supplies = await f.code(ACCOUNTS.OFFICE_SUPPLIES);
        const meals = await f.code(ACCOUNTS.MEALS);
        const id = await txn(f, f.a, '2031-03-14', -23_45, { suggestedAccountId: supplies });

        const before = await balancesByAccount({}, tx);
        const posted = await approveBankTransaction({ txnId: id, accountId: meals }, ctx);
        const unposted = await unpostBankTransaction(id, ctx);
        expect(unposted.txnIds).toEqual([id]);

        const [reversal] = await tx.select().from(journalEntries).where(eq(journalEntries.id, unposted.reversalEntryId ?? randomUUID()));
        expect(reversal.reversesId).toBe(posted.entryId);

        const after = await balancesByAccount({}, tx);
        for (const accountId of [meals, f.a.glId, supplies]) {
          expect(after.get(accountId) ?? 0).toBe(before.get(accountId) ?? 0);
        }

        const back = await row(tx, id);
        expect(back).toMatchObject({
          status: 'unreviewed',
          journalEntryId: null,
          reviewedBy: null,
          suggestedAccountId: supplies,
          suggestionSource: 'rule',
        });

        await expect(unpostBankTransaction(id, ctx)).rejects.toMatchObject({ code: 'not_posted' });
        // And it can be approved again.
        await approveBankTransaction({ txnId: id }, ctx);
      });
    },
    T,
  );

  it(
    'unposts a transfer back to an unposted pair',
    async () => {
      await withRollback(async (tx) => {
        const f = await fixture(tx);
        const ctx = { userId: f.userId, tx };
        const out = await txn(f, f.a, '2031-03-11', -50_00);
        const inn = await txn(f, f.b, '2031-03-11', 50_00);
        await linkTransfer(out, inn, ctx);
        await approveTransfer(out, ctx);
        const result = await unpostBankTransaction(inn, ctx);
        expect(result.txnIds.sort()).toEqual([out, inn].sort());
        for (const id of [out, inn]) {
          expect(await row(tx, id)).toMatchObject({ status: 'transfer', journalEntryId: null });
        }
        const balances = await balancesByAccount({}, tx);
        expect(balances.get(f.a.glId) ?? 0).toBe(0);
        expect(balances.get(f.b.glId) ?? 0).toBe(0);
      });
    },
    T,
  );
});

describe.skipIf(!hasDatabase)('approveMany', () => {
  it(
    'posts each item on its own; one refusal does not roll back the others',
    async () => {
      await withRollback(async (tx) => {
        const f = await fixture(tx);
        const supplies = await f.code(ACCOUNTS.OFFICE_SUPPLIES);
        const one = await txn(f, f.a, '2031-03-15', -1_00);
        const bad = await txn(f, f.a, '2031-03-15', -2_00, { status: 'excluded' });
        const three = await txn(f, f.a, '2031-03-15', -3_00);

        const results = await approveMany(
          [
            { txnId: one, accountId: supplies },
            { txnId: bad, accountId: supplies },
            { txnId: three, accountId: supplies },
          ],
          { userId: f.userId, tx },
        );
        expect(results.map((r) => r.ok)).toEqual([true, false, true]);
        expect(results[1]).toMatchObject({ ok: false, txnId: bad, code: 'excluded' });
        expect((await row(tx, one)).journalEntryId).not.toBeNull();
        expect((await row(tx, three)).journalEntryId).not.toBeNull();
        expect((await row(tx, bad)).journalEntryId).toBeNull();
      });
    },
    T,
  );
});

describe.skipIf(!hasDatabase)('postAutoPostMatches', () => {
  it(
    'posts categorized rows of auto-post rules once, records no reviewer, and is idempotent',
    async () => {
      await withRollback(async (tx) => {
        const f = await fixture(tx);
        const ctx = { userId: f.userId, tx };
        const fees = await f.code(ACCOUNTS.BANK_FEES);
        const [auto] = await tx
          .insert(categorizationRules)
          .values({
            name: `TEST auto ${randomUUID().slice(0, 6)}`,
            conditions: [{ field: 'payee', op: 'exact', value: 'TEST BANK' }],
            direction: 'out',
            accountId: fees,
            bankAccountId: f.a.id,
            autoPost: true,
          })
          .returning({ id: categorizationRules.id });
        const [manual] = await tx
          .insert(categorizationRules)
          .values({
            name: `TEST manual ${randomUUID().slice(0, 6)}`,
            conditions: [{ field: 'payee', op: 'exact', value: 'OTHER' }],
            accountId: fees,
            bankAccountId: f.a.id,
            autoPost: false,
          })
          .returning({ id: categorizationRules.id });

        const hit = await txn(f, f.a, '2031-03-16', -15_00, {
          status: 'categorized',
          suggestedAccountId: fees,
          ruleId: auto.id,
        });
        const notAuto = await txn(f, f.a, '2031-03-16', -16_00, {
          status: 'categorized',
          suggestedAccountId: fees,
          ruleId: manual.id,
        });
        const unreviewed = await txn(f, f.a, '2031-03-16', -17_00, { suggestedAccountId: fees, ruleId: auto.id });

        const first = await postAutoPostMatches(ctx, { bankAccountId: f.a.id });
        expect(first.failed).toEqual([]);
        expect(first.posted.map((p) => p.txnId)).toEqual([hit]);
        const posted = await row(tx, hit);
        expect(posted.journalEntryId).toBe(first.posted[0].entryId);
        expect(posted.reviewedBy).toBeNull();
        expect((await row(tx, notAuto)).journalEntryId).toBeNull();
        expect((await row(tx, unreviewed)).journalEntryId).toBeNull();

        const second = await postAutoPostMatches(ctx, { bankAccountId: f.a.id });
        expect(second.posted).toEqual([]);
        expect(second.failed).toEqual([]);
      });
    },
    T,
  );
});

describe.skipIf(!hasDatabase)('createRuleFromTransaction', () => {
  it(
    'builds a cleaned-payee, direction-aware rule that never auto-posts by default',
    async () => {
      await withRollback(async (tx) => {
        const f = await fixture(tx);
        const ingredients = await f.code(ACCOUNTS.INVENTORY_INGREDIENTS);
        const id = await txn(f, f.a, '2031-03-17', -210_00, { counterparty: 'SQ *BLUE PACIFIC 4411' });

        expect(defaultRuleConditions({ counterparty: 'SQ *BLUE PACIFIC 4411', description: null })[0]).toMatchObject({
          field: 'payee',
          op: 'contains',
        });

        const rule = await createRuleFromTransaction(
          id,
          { accountId: ingredients, vendorId: f.vendorId },
          { userId: f.userId, tx },
        );
        expect(rule.direction).toBe('out');
        expect(rule.autoPost).toBe(false);
        expect(rule.conditions).toHaveLength(1);
        expect(rule.conditions[0].value).not.toMatch(/SQ \*|4411/);
        const [stored] = await tx.select().from(categorizationRules).where(eq(categorizationRules.id, rule.id));
        expect(stored).toMatchObject({ accountId: ingredients, vendorId: f.vendorId, autoPost: false, direction: 'out' });

        await expect(
          createRuleFromTransaction(
            id,
            { accountId: ingredients, conditions: [{ field: 'payee', op: 'regex', value: '(a)\\1' }] },
            { userId: f.userId, tx },
          ),
        ).rejects.toMatchObject({ code: 'rule_invalid' });
        await expect(
          createRuleFromTransaction(id, { accountId: f.b.glId }, { userId: f.userId, tx }),
        ).rejects.toMatchObject({ code: 'bank_account_as_category' });
      });
    },
    T,
  );
});

describe.skipIf(!hasDatabase)('queue read model', () => {
  it(
    'returns suggestion, rule, partner, refund original and posted account in one page, with counts and a register',
    async () => {
      await withRollback(async (tx) => {
        const f = await fixture(tx);
        const ctx = { userId: f.userId, tx };
        const supplies = await f.code(ACCOUNTS.OFFICE_SUPPLIES);
        const ask = await f.code(ACCOUNTS.ASK_MY_ACCOUNTANT);

        const charge = await txn(f, f.a, '2031-04-01', -40_00, { counterparty: 'Target', suggestedAccountId: supplies });
        const refund = await txn(f, f.a, '2031-04-03', 40_00, { counterparty: 'Target' });
        await linkRefund(refund, charge, ctx);
        const out = await txn(f, f.a, '2031-04-04', -25_00);
        const inn = await txn(f, f.b, '2031-04-04', 25_00);
        await linkTransfer(out, inn, ctx);
        const unknown = await txn(f, f.a, '2031-04-05', -9_00, { counterparty: 'Mystery' });
        const suspense = await txn(f, f.a, '2031-04-06', -8_00, { suggestedAccountId: ask });
        await approveBankTransaction({ txnId: charge }, ctx);

        const page = await listQueue({ bankAccountId: f.a.id, limit: 3 }, tx);
        expect(page.rows).toHaveLength(3);
        expect(page.nextCursor).not.toBeNull();
        const rest = await listQueue({ bankAccountId: f.a.id, cursor: page.nextCursor, limit: 10 }, tx);
        const all = [...page.rows, ...rest.rows];
        expect(all.map((r) => r.id)).toEqual([suspense, unknown, out, refund, charge]);

        const byId = new Map(all.map((r) => [r.id, r]));
        expect(byId.get(charge)).toMatchObject({
          stage: 'posted',
          postedAccount: { code: ACCOUNTS.OFFICE_SUPPLIES },
          suggestion: { account: { code: ACCOUNTS.OFFICE_SUPPLIES }, source: 'rule' },
        });
        expect(byId.get(refund)?.refundOriginal).toMatchObject({
          id: charge,
          amountCents: -40_00,
          account: { code: ACCOUNTS.OFFICE_SUPPLIES },
        });
        expect(byId.get(out)?.transferPartner).toMatchObject({ id: inn, bankAccountId: f.b.id, amountCents: 25_00 });
        expect(byId.get(unknown)?.flags).toContain('no_suggestion');
        expect(byId.get(suspense)?.flags).toContain('ask_accountant');

        const flagged = await listQueue({ bankAccountId: f.a.id, flaggedOnly: true }, tx);
        expect(flagged.rows.map((r) => r.id).sort()).toEqual([unknown, suspense].sort());
        const posted = await listQueue({ bankAccountId: f.a.id, status: 'posted' }, tx);
        expect(posted.rows.map((r) => r.id)).toEqual([charge]);
        const found = await listQueue({ bankAccountId: f.a.id, search: '$9.00' }, tx);
        expect(found.rows.map((r) => r.id)).toEqual([unknown]);
        const byText = await listQueue({ bankAccountId: f.a.id, search: 'myster' }, tx);
        expect(byText.rows.map((r) => r.id)).toEqual([unknown]);

        const counts = await queueCounts({ bankAccountId: f.a.id }, tx);
        expect(counts.total).toBe(5);
        expect(counts.byStage).toEqual({ review: 4, ready: 0, posted: 1, excluded: 0 });
        expect(counts.byStatus.transfer).toBe(1);
        expect(counts.flagged).toBe(2);

        await approveBankTransaction({ txnId: refund }, ctx);
        const register = await bankRegister({ bankAccountId: f.a.id, from: '2031-04-01', to: '2031-04-30' }, tx);
        expect(register.openingBalanceCents).toBe(0);
        expect(register.rows.map((r) => r.runningBalanceCents)).toEqual([-40_00, 0]);
        expect(register.rows[0]).toMatchObject({ bankTransactionId: charge, counterAccount: { code: ACCOUNTS.OFFICE_SUPPLIES } });
        expect(register.closingBalanceCents).toBe(0);
      });
    },
    T,
  );
});

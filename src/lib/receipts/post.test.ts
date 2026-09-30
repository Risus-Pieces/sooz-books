import { afterAll, describe, expect, it } from 'vitest';

// First: loads .env.local before '@/db/client' is imported anywhere below.
import { closeTestDb, hasDatabase, withRollback } from '@/lib/ledger/test-support';

import { randomUUID } from 'node:crypto';

import { eq, sql } from 'drizzle-orm';

import { accounts, appUsers, attachments, receiptProposals } from '@/db/schema';
import { ACCOUNTS } from '@/lib/ledger/coa';
import { closePeriod } from '@/lib/ledger/periods';
import type { LedgerDb } from '@/lib/ledger/post';

import type { ReceiptExtractor } from './extractor';
import { ingestReceipt } from './ingest';
import {
  type PostOptions,
  ReceiptError,
  postAllReceiptProposals,
  postReceiptProposal,
  receiptFailureMessage,
  skipReceiptProposal,
} from './post';
import { MemoryReceiptStorage } from './storage';
import { accountIdOf, giveContributionsAccount, insertProposal, newVendor, seededUserId } from './test-support';
import type { ExtractedReceipt, ProposalLine, ReceiptWarning } from './types';

afterAll(closeTestDb);

const NOW = '2031-03-20';

const ctxFor = (tx: LedgerDb, userId: string, extra: Partial<PostOptions> = {}): PostOptions => ({
  userId,
  tx,
  today: () => NOW,
  ...extra,
});

interface Ready {
  id: string;
  attachmentId: string;
  userId: string;
  member: { id: string; code: string };
  packaging: string;
}

/** A member with an account, and a proposal for them that could be posted right now. */
async function ready(
  tx: LedgerDb,
  overrides: {
    vendorName?: string | null;
    vendorId?: string | null;
    lines?: ProposalLine[];
    totalCents?: number;
    date?: string;
    warnings?: ReceiptWarning[];
  } = {},
): Promise<Ready> {
  const userId = await seededUserId(tx);
  const [current] = await tx.select({ account: appUsers.contributionsAccountId }).from(appUsers).where(eq(appUsers.id, userId));
  const member =
    current?.account != null
      ? { id: current.account, code: '' }
      : await giveContributionsAccount(tx, userId);
  const packaging = await accountIdOf(tx, ACCOUNTS.INVENTORY_PACKAGING);
  const totalCents = overrides.totalCents ?? 4110;
  const { id, attachmentId } = await insertProposal(tx, userId, {
    payerId: userId,
    vendorName: overrides.vendorName === undefined ? `ZZ Post Vendor ${randomUUID().slice(0, 8)}` : overrides.vendorName,
    vendorId: overrides.vendorId ?? null,
    receiptDate: overrides.date ?? '2031-03-10',
    totalCents,
    lines: overrides.lines ?? [{ description: 'Shipper cartons', cents: totalCents, accountId: packaging }],
    warnings: overrides.warnings ?? [],
  });
  return { id, attachmentId, userId, member, packaging };
}

async function entryLines(tx: LedgerDb, entryId: string) {
  const rows = await tx.execute<{
    account_id: string;
    debit_cents: string;
    credit_cents: string;
    vendor_id: string | null;
  }>(sql`select account_id, debit_cents, credit_cents, vendor_id from journal_lines where entry_id = ${entryId} order by line_no`);
  return rows.map((r) => ({
    account: r.account_id,
    debit: Number(r.debit_cents),
    credit: Number(r.credit_cents),
    vendorId: r.vendor_id,
  }));
}

async function statusOf(tx: LedgerDb, id: string): Promise<string> {
  const [row] = await tx.select({ status: receiptProposals.status }).from(receiptProposals).where(eq(receiptProposals.id, id));
  return row.status;
}

describe.skipIf(!hasDatabase)('postReceiptProposal', () => {
  it('debits what was bought and credits the paying member, balanced, and links everything', async () => {
    await withRollback(async (tx) => {
      const f = await ready(tx);

      const posted = await postReceiptProposal(f.id, ctxFor(tx, f.userId));

      const lines = await entryLines(tx, posted.entryId);
      expect(lines).toHaveLength(2);
      expect(lines).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ account: f.packaging, debit: 4110, credit: 0 }),
          expect.objectContaining({ account: f.member.id, debit: 0, credit: 4110 }),
        ]),
      );

      const [entry] = await tx.execute<{ entry_date: string; memo: string; source_type: string; source_id: string; status: string }>(
        sql`select entry_date::text as entry_date, memo, source_type, source_id, status from journal_entries where id = ${posted.entryId}`,
      );
      expect(entry).toMatchObject({ entry_date: '2031-03-10', source_type: 'purchase_receipt', source_id: f.id, status: 'posted' });
      expect(entry.memo).toMatch(/^Receipt — /);

      const [proposal] = await tx.select().from(receiptProposals).where(eq(receiptProposals.id, f.id));
      expect(proposal).toMatchObject({ status: 'posted', entryId: posted.entryId });

      // The stored file now belongs to the entry, so it opens from there.
      const [file] = await tx.select().from(attachments).where(eq(attachments.id, f.attachmentId));
      expect(file).toMatchObject({ entityType: 'journal_entry', entityId: posted.entryId });
    });
  });

  it('creates the vendor when it is new, and puts it on the expense line', async () => {
    await withRollback(async (tx) => {
      const name = `ZZ Brand New ${randomUUID().slice(0, 8)}`;
      const f = await ready(tx, { vendorName: name });

      const posted = await postReceiptProposal(f.id, ctxFor(tx, f.userId));

      const found = await tx.execute<{ id: string }>(sql`select id from vendors where lower(name) = lower(${name})`);
      expect(found).toHaveLength(1);
      const lines = await entryLines(tx, posted.entryId);
      expect(lines.find((l) => l.debit > 0)?.vendorId).toBe(found[0].id);
      const [proposal] = await tx.select().from(receiptProposals).where(eq(receiptProposals.id, f.id));
      expect(proposal.vendorId).toBe(found[0].id);
    });
  });

  it('reuses an existing vendor of the same name rather than making a second', async () => {
    await withRollback(async (tx) => {
      const existing = await newVendor(tx);
      const f = await ready(tx, { vendorName: existing.name.toUpperCase() });

      await postReceiptProposal(f.id, ctxFor(tx, f.userId));

      const found = await tx.execute<{ id: string }>(sql`select id from vendors where lower(name) = lower(${existing.name})`);
      expect(found).toHaveLength(1);
    });
  });

  it('merges lines on one account, and posts a discount on another as a credit', async () => {
    await withRollback(async (tx) => {
      const base = await ready(tx);
      const ingredients = await accountIdOf(tx, ACCOUNTS.INVENTORY_INGREDIENTS);
      const f = await ready(tx, {
        totalCents: 4860,
        lines: [
          { description: 'Cartons', cents: 3000, accountId: base.packaging },
          { description: 'Tape', cents: 2360, accountId: base.packaging },
          { description: 'Coupon', cents: -500, accountId: ingredients },
        ],
      });

      const posted = await postReceiptProposal(f.id, ctxFor(tx, f.userId));

      const lines = await entryLines(tx, posted.entryId);
      expect(lines).toHaveLength(3);
      expect(lines).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ account: f.packaging, debit: 5360, credit: 0 }),
          expect.objectContaining({ account: ingredients, debit: 0, credit: 500 }),
          expect.objectContaining({ account: f.member.id, debit: 0, credit: 4860 }),
        ]),
      );
      const debits = lines.reduce((sum, l) => sum + l.debit, 0);
      const credits = lines.reduce((sum, l) => sum + l.credit, 0);
      expect(debits).toBe(credits);
    });
  });

  it('refuses a proposal that is blocked, and posts nothing', async () => {
    await withRollback(async (tx) => {
      const f = await ready(tx, { lines: [{ description: 'x', cents: 4110, accountId: null }] });

      await expect(postReceiptProposal(f.id, ctxFor(tx, f.userId))).rejects.toMatchObject({ code: 'blocked' });
      expect(await statusOf(tx, f.id)).toBe('proposed');
    });
  });

  it('will not post the same proposal twice', async () => {
    await withRollback(async (tx) => {
      const f = await ready(tx);
      await postReceiptProposal(f.id, ctxFor(tx, f.userId));

      await expect(postReceiptProposal(f.id, ctxFor(tx, f.userId))).rejects.toMatchObject({ code: 'not_proposed' });
    });
  });

  it('will not post one that does not exist', async () => {
    await withRollback(async (tx) => {
      const userId = await seededUserId(tx);

      await expect(
        postReceiptProposal('00000000-0000-4000-8000-00000000dead', ctxFor(tx, userId)),
      ).rejects.toMatchObject({ code: 'not_found' });
    });
  });

  it('asks before posting a possible duplicate, and posts once told it is a different purchase', async () => {
    await withRollback(async (tx) => {
      const f = await ready(tx, {
        warnings: [{ code: 'possible_duplicate', message: 'Looks like entry #7.', blocking: false }],
      });

      await expect(postReceiptProposal(f.id, ctxFor(tx, f.userId))).rejects.toMatchObject({ code: 'duplicate' });
      expect(await statusOf(tx, f.id)).toBe('proposed');

      await postReceiptProposal(f.id, ctxFor(tx, f.userId, { confirmedNew: true }));
      expect(await statusOf(tx, f.id)).toBe('posted');
    });
  });

  it('refuses when the member who paid no longer has a contributions account', async () => {
    await withRollback(async (tx) => {
      const f = await ready(tx);
      await tx.update(appUsers).set({ contributionsAccountId: null }).where(eq(appUsers.id, f.userId));

      await expect(postReceiptProposal(f.id, ctxFor(tx, f.userId))).rejects.toMatchObject({ code: 'payer' });
    });
  });

  it('refuses a line whose account has since become a rollup', async () => {
    await withRollback(async (tx) => {
      const f = await ready(tx);
      await tx.insert(accounts).values({
        code: `TC-${randomUUID().slice(0, 8)}`,
        name: 'now nested',
        type: 'asset',
        subtype: 'inventory',
        parentId: f.packaging,
      });

      await expect(postReceiptProposal(f.id, ctxFor(tx, f.userId))).rejects.toMatchObject({ code: 'accounts' });
    });
  });

  it('is refused by a closed period, with the ledger’s own words, and stays waiting', async () => {
    await withRollback(async (tx) => {
      const f = await ready(tx, { date: '2031-03-10' });
      await closePeriod(2031, 3, null, { tx });

      const error = await postReceiptProposal(f.id, ctxFor(tx, f.userId)).catch((e: unknown) => e);

      expect(receiptFailureMessage(error)).toMatch(/closed/i);
      expect(await statusOf(tx, f.id)).toBe('proposed');
    });
  });
});

describe.skipIf(!hasDatabase)('the duplicate rule, end to end', () => {
  const extractorFor = (receipt: ExtractedReceipt): ReceiptExtractor => ({ extract: async () => receipt });

  it('warns on a second receipt with the same vendor, date and total as a posted one', async () => {
    await withRollback(async (tx) => {
      const f = await ready(tx, { vendorName: `ZZ Twice Bought ${randomUUID().slice(0, 8)}` });
      const [first] = await tx.select().from(receiptProposals).where(eq(receiptProposals.id, f.id));
      await postReceiptProposal(f.id, ctxFor(tx, f.userId));

      const again = await ingestReceipt(
        { userId: f.userId, filename: 'again.pdf', bytes: new TextEncoder().encode('%PDF-1.4 the other copy') },
        {
          storage: new MemoryReceiptStorage(new Map()),
          extractor: extractorFor({
            legible: true,
            vendorName: first.vendorName,
            date: '2031-03-10',
            subtotalCents: null,
            taxCents: 0,
            tipCents: 0,
            totalCents: 4110,
            cardLast4: null,
            items: [],
          }),
          tx,
          today: () => NOW,
        },
      );

      expect(again.ok).toBe(true);
      if (!again.ok) return;
      expect(again.proposal.needsConfirmation).toBe(true);
      expect(again.proposal.warnings.map((w) => w.code)).toContain('possible_duplicate');
    });
  });

  it('does not warn when the total differs', async () => {
    await withRollback(async (tx) => {
      const f = await ready(tx, { vendorName: `ZZ Other Total ${randomUUID().slice(0, 8)}` });
      const [first] = await tx.select().from(receiptProposals).where(eq(receiptProposals.id, f.id));
      await postReceiptProposal(f.id, ctxFor(tx, f.userId));

      const other = await ingestReceipt(
        { userId: f.userId, filename: 'other.pdf', bytes: new TextEncoder().encode('%PDF-1.4 a different receipt') },
        {
          storage: new MemoryReceiptStorage(new Map()),
          extractor: extractorFor({
            legible: true,
            vendorName: first.vendorName,
            date: '2031-03-10',
            subtotalCents: null,
            taxCents: 0,
            tipCents: 0,
            totalCents: 4111,
            cardLast4: null,
            items: [],
          }),
          tx,
          today: () => NOW,
        },
      );

      expect(other.ok && other.proposal.needsConfirmation).toBe(false);
    });
  });
});

describe.skipIf(!hasDatabase)('postAllReceiptProposals', () => {
  it('posts the clean ones, skips those needing a look, and reports a refusal without stopping', async () => {
    await withRollback(async (tx) => {
      const clean = await ready(tx);
      const needsLook = await ready(tx, { lines: [{ description: 'x', cents: 4110, accountId: null }] });
      const inClosedMonth = await ready(tx, { date: '2031-05-10' });
      await closePeriod(2031, 5, null, { tx });

      const result = await postAllReceiptProposals(
        [clean.id, needsLook.id, inClosedMonth.id],
        ctxFor(tx, clean.userId),
      );

      expect(result.posted.map((p) => p.id)).toEqual([clean.id]);
      expect(result.skipped.map((s) => s.id)).toEqual([needsLook.id]);
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0].id).toBe(inClosedMonth.id);
      expect(result.failed[0].message).toMatch(/closed/i);
      expect(await statusOf(tx, clean.id)).toBe('posted');
      expect(await statusOf(tx, needsLook.id)).toBe('proposed');
      expect(await statusOf(tx, inClosedMonth.id)).toBe('proposed');
    });
  });

  it('leaves a proposal with any warning at all for a person, even a non-blocking one', async () => {
    await withRollback(async (tx) => {
      const f = await ready(tx, {
        warnings: [{ code: 'total_mismatch', message: 'Items do not add up.', blocking: false }],
      });

      const result = await postAllReceiptProposals([f.id], ctxFor(tx, f.userId));

      expect(result.posted).toEqual([]);
      expect(result.skipped).toEqual([expect.objectContaining({ id: f.id, reason: 'Items do not add up.' })]);
    });
  });
});

describe.skipIf(!hasDatabase)('skipReceiptProposal', () => {
  it('marks a waiting proposal skipped, once', async () => {
    await withRollback(async (tx) => {
      const f = await ready(tx);

      await skipReceiptProposal(f.id, { userId: f.userId, tx });
      expect(await statusOf(tx, f.id)).toBe('skipped');

      await expect(skipReceiptProposal(f.id, { userId: f.userId, tx })).rejects.toMatchObject({ code: 'not_proposed' });
    });
  });
});

describe('receiptFailureMessage', () => {
  it('shows the words of a refusal made to be read', () => {
    expect(receiptFailureMessage(new ReceiptError('blocked', 'Choose which member paid.'))).toBe(
      'Choose which member paid.',
    );
  });

  it('says something plain for anything else, and never leaks a database error', () => {
    expect(receiptFailureMessage(new Error('duplicate key value violates constraint "x"'))).toBe(
      'Could not post this receipt. Try again.',
    );
    expect(receiptFailureMessage('weird')).toBe('Could not post this receipt. Try again.');
  });
});

import { createHash } from 'node:crypto';

import { afterAll, describe, expect, it } from 'vitest';

// First: loads .env.local before '@/db/client' is imported anywhere below.
import { closeTestDb, hasDatabase, withRollback } from '@/lib/ledger/test-support';

import { ACCOUNTS } from '@/lib/ledger/coa';
import type { LedgerDb } from '@/lib/ledger/post';

import { ExtractionError, type ReceiptExtractor } from './extractor';
import { ingestReceipt } from './ingest';
import { MemoryReceiptStorage } from './storage';
import { expenseLeaf, giveContributionsAccount, newVendor, postVendorSpend, seededUserId } from './test-support';
import type { ExtractedReceipt } from './types';

afterAll(closeTestDb);

const TODAY = '2026-09-20';

function receipt(vendorName: string, overrides: Partial<ExtractedReceipt> = {}): ExtractedReceipt {
  return {
    legible: true,
    vendorName,
    date: '2026-09-15',
    subtotalCents: 3800,
    taxCents: 310,
    tipCents: 0,
    totalCents: 4110,
    cardLast4: '4242',
    items: [{ description: 'Shipper cartons', cents: 3800, accountCode: ACCOUNTS.INVENTORY_PACKAGING }],
    ...overrides,
  };
}

function fakeExtractor(result: ExtractedReceipt | ExtractionError): ReceiptExtractor & { calls: number } {
  const fake = {
    calls: 0,
    async extract() {
      fake.calls += 1;
      if (result instanceof ExtractionError) throw result;
      return result;
    },
  };
  return fake;
}

/** Valid PDF bytes that differ by `tag`, so each has its own hash. */
const pdf = (tag: string): Uint8Array => new TextEncoder().encode(`%PDF-1.4 ${tag}`);
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

async function setup(tx: LedgerDb) {
  const userId = await seededUserId(tx);
  await giveContributionsAccount(tx, userId);
  return { userId, storage: new MemoryReceiptStorage(new Map()) };
}

describe.skipIf(!hasDatabase)('ingestReceipt', () => {
  it('stores the file, reads it, and proposes an entry for a vendor it has never seen', async () => {
    await withRollback(async (tx) => {
      const { userId, storage } = await setup(tx);
      const vendorName = `ZZ New Vendor ${Date.now()}`;
      const bytes = pdf('a');

      const result = await ingestReceipt(
        { userId, filename: 'IMG 1.pdf', bytes },
        { storage, extractor: fakeExtractor(receipt(vendorName)), tx, today: () => TODAY },
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.alreadyFiled).toBe(false);
      expect(result.proposal).toMatchObject({
        status: 'proposed',
        vendorName,
        vendorIsNew: true,
        date: '2026-09-15',
        totalCents: 4110,
        payerId: userId,
        canPost: true,
        warnings: [],
      });
      expect(result.proposal.lines).toEqual([
        expect.objectContaining({ cents: 4110, accountLabel: expect.stringContaining('1330') }),
      ]);
      // The file was kept, under its hash.
      await expect(storage.signedUrl(`${sha256(bytes)}/IMG_1.pdf`, 60)).resolves.toBeDefined();
    });
  });

  it('files the same receipt once: the second upload returns the first proposal and never reads it again', async () => {
    await withRollback(async (tx) => {
      const { userId, storage } = await setup(tx);
      const extractor = fakeExtractor(receipt(`ZZ Twice ${Date.now()}`));
      const deps = { storage, extractor, tx, today: () => TODAY };

      const first = await ingestReceipt({ userId, filename: 'a.pdf', bytes: pdf('same') }, deps);
      const second = await ingestReceipt({ userId, filename: 'renamed.pdf', bytes: pdf('same') }, deps);

      expect(first.ok && second.ok).toBe(true);
      if (first.ok && second.ok) {
        expect(second.alreadyFiled).toBe(true);
        expect(second.proposal.id).toBe(first.proposal.id);
      }
      expect(extractor.calls).toBe(1);
    });
  });

  it('turns away a file that is not a receipt, without storing or reading anything', async () => {
    await withRollback(async (tx) => {
      const { userId, storage } = await setup(tx);
      const extractor = fakeExtractor(receipt('x'));

      const result = await ingestReceipt(
        { userId, filename: 'notes.txt', bytes: new TextEncoder().encode('just some text') },
        { storage, extractor, tx, today: () => TODAY },
      );

      expect(result.ok).toBe(false);
      expect(extractor.calls).toBe(0);
    });
  });

  it('keeps the file and leaves a blocked proposal when the model cannot be used', async () => {
    await withRollback(async (tx) => {
      const { userId, storage } = await setup(tx);
      const extractor = fakeExtractor(new ExtractionError('no_model', 'No AI model is set up.'));
      const bytes = pdf('nomodel');

      const result = await ingestReceipt(
        { userId, filename: 'a.pdf', bytes },
        { storage, extractor, tx, today: () => TODAY },
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.proposal).toMatchObject({ error: 'No AI model is set up.', canPost: false, lines: [] });
      expect(result.proposal.warnings.map((w) => w.code)).toContain('no_model');
      await expect(storage.signedUrl(`${sha256(bytes)}/a.pdf`, 60)).resolves.toBeDefined();
    });
  });

  it("uses the vendor's own default account over the model's pick", async () => {
    await withRollback(async (tx) => {
      const { userId, storage } = await setup(tx);
      const office = await expenseLeaf(tx);
      const vendor = await newVendor(tx, { defaultExpenseAccountId: office.id });

      const result = await ingestReceipt(
        { userId, filename: 'a.pdf', bytes: pdf('default') },
        { storage, extractor: fakeExtractor(receipt(vendor.name)), tx, today: () => TODAY },
      );

      expect(result.ok && result.proposal.vendorIsNew).toBe(false);
      expect(result.ok && result.proposal.lines[0].accountId).toBe(office.id);
    });
  });

  it("falls back to where the vendor's last purchase went, when it has no default", async () => {
    await withRollback(async (tx) => {
      const { userId, storage } = await setup(tx);
      const usual = await expenseLeaf(tx);
      const vendor = await newVendor(tx);
      await postVendorSpend(tx, vendor.id, usual.id, '2031-01-10');

      const result = await ingestReceipt(
        { userId, filename: 'a.pdf', bytes: pdf('history') },
        { storage, extractor: fakeExtractor(receipt(vendor.name, { items: [] })), tx, today: () => TODAY },
      );

      expect(result.ok && result.proposal.lines[0].accountId).toBe(usual.id);
    });
  });

  it('warns, and proposes one line for the total, when the items do not explain it', async () => {
    await withRollback(async (tx) => {
      const { userId, storage } = await setup(tx);

      const result = await ingestReceipt(
        { userId, filename: 'a.pdf', bytes: pdf('mismatch') },
        {
          storage,
          extractor: fakeExtractor(receipt(`ZZ Mismatch ${Date.now()}`, { totalCents: 9999 })),
          tx,
          today: () => TODAY,
        },
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.proposal.lines).toHaveLength(1);
      expect(result.proposal.lines[0].cents).toBe(9999);
      expect(result.proposal.warnings.map((w) => w.code)).toEqual(['total_mismatch']);
    });
  });

  it('reads a receipt again when the last attempt failed, instead of calling it filed', async () => {
    await withRollback(async (tx) => {
      const { userId, storage } = await setup(tx);
      const bytes = pdf('retry');
      const first = await ingestReceipt(
        { userId, filename: 'a.pdf', bytes },
        { storage, extractor: fakeExtractor(new ExtractionError('timeout', 'Took too long.')), tx, today: () => TODAY },
      );
      expect(first.ok && first.proposal.error).toBe('Took too long.');

      const working = fakeExtractor(receipt(`ZZ Retry ${Date.now()}`));
      const second = await ingestReceipt(
        { userId, filename: 'a.pdf', bytes },
        { storage, extractor: working, tx, today: () => TODAY },
      );

      expect(first.ok && second.ok).toBe(true);
      if (!first.ok || !second.ok) return;
      expect(second.proposal.id).toBe(first.proposal.id);
      expect(second.alreadyFiled).toBe(false);
      expect(second.proposal).toMatchObject({ error: null, canPost: true });
      expect(working.calls).toBe(1);
    });
  });

  it('blocks on the payer when the uploader has no contributions account of their own', async () => {
    await withRollback(async (tx) => {
      const userId = await seededUserId(tx); // no giveContributionsAccount: not a member here
      const storage = new MemoryReceiptStorage(new Map());

      const result = await ingestReceipt(
        { userId, filename: 'a.pdf', bytes: pdf('nopayer') },
        { storage, extractor: fakeExtractor(receipt(`ZZ NoPayer ${Date.now()}`)), tx, today: () => TODAY },
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.proposal).toMatchObject({ payerId: null, canPost: false });
      expect(result.proposal.warnings.map((w) => w.code)).toContain('no_payer');
    });
  });
});

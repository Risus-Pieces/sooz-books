import { afterAll, describe, expect, it } from 'vitest';

// First: loads .env.local before '@/db/client' is imported anywhere below.
import { closeTestDb, hasDatabase, withRollback } from '@/lib/ledger/test-support';

import { asc, eq } from 'drizzle-orm';

import { billLines, invoiceLines } from '@/db/schema';
import { ACCOUNTS } from '@/lib/ledger/coa';
import type { LedgerDb } from '@/lib/ledger/post';

import { approveBill, createBill } from './bills';
import { updateCustomer, updateDraftBill, updateDraftInvoice, updateVendor } from './edits';
import { ArapError } from './errors';
import { createInvoice, issueInvoice } from './invoices';
import { accountId, channelId, makeCustomer, makeVendor } from './test-support';

afterAll(closeTestDb);

const ctx = (tx: LedgerDb) => ({ userId: null, tx });

async function refusal(tx: LedgerDb, work: (sp: LedgerDb) => Promise<unknown>): Promise<ArapError> {
  let caught: unknown = null;
  try {
    await tx.transaction(async (sp) => {
      await work(sp);
    });
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ArapError);
  return caught as ArapError;
}

describe.skipIf(!hasDatabase)('editing drafts and parties', { timeout: 120_000 }, () => {
  it('rewrites a draft invoice in place, keeping its number, and refuses once issued', async () => {
    await withRollback(async (tx) => {
      const customer = await makeCustomer(tx, { channelId: await channelId(tx, 'WHOLESALE') });
      const { invoice } = await createInvoice(
        {
          customerId: customer.id,
          invoiceDate: '2026-09-01',
          lines: [{ description: 'Case, 12 x 12oz', quantity: '2', unitPriceCents: 3_000 }],
        },
        ctx(tx),
      );

      const updated = await updateDraftInvoice(
        invoice.id,
        {
          customerId: customer.id,
          invoiceDate: '2026-09-02',
          shippingCents: 1_500,
          lines: [
            { description: 'Case, 12 x 12oz', quantity: '3', unitPriceCents: 3_000, discountCents: 500 },
            { description: 'Sample pack', quantity: '1', unitPriceCents: 1_250 },
          ],
        },
        ctx(tx),
      );
      expect(updated.id).toBe(invoice.id);
      expect(updated.invoiceNo).toBe(invoice.invoiceNo);
      expect(updated.invoiceDate).toBe('2026-09-02');
      expect(updated.dueDate).toBe('2026-10-02');
      expect(updated.subtotalCents).toBe(10_250);
      expect(updated.totalCents).toBe(10_250 - 500 + 1_500);

      const lines = await tx
        .select()
        .from(invoiceLines)
        .where(eq(invoiceLines.invoiceId, invoice.id))
        .orderBy(asc(invoiceLines.lineNo));
      expect(lines.map((l) => [l.lineNo, l.amountCents])).toEqual([
        [1, 9_000],
        [2, 1_250],
      ]);

      await issueInvoice(invoice.id, ctx(tx));
      const refused = await refusal(tx, (sp) =>
        updateDraftInvoice(
          invoice.id,
          { customerId: customer.id, invoiceDate: '2026-09-02', lines: [{ description: 'x', unitPriceCents: 1 }] },
          ctx(sp),
        ),
      );
      expect(refused.code).toBe('invalid_state');
    });
  });

  it('rewrites a draft bill, keeps the duplicate-number guard, and refuses once approved', async () => {
    await withRollback(async (tx) => {
      const ingredients = await accountId(tx, ACCOUNTS.INVENTORY_INGREDIENTS);
      const vendor = await makeVendor(tx, { defaultExpenseAccountId: ingredients });
      const { bill } = await createBill(
        { vendorId: vendor.id, billNo: 'A-1', billDate: '2026-09-01', lines: [{ description: 'Citric acid', amountCents: 4_000 }] },
        ctx(tx),
      );
      await createBill(
        { vendorId: vendor.id, billNo: 'A-2', billDate: '2026-09-01', lines: [{ description: 'Malic acid', amountCents: 2_000 }] },
        ctx(tx),
      );

      const duplicate = await refusal(tx, (sp) =>
        updateDraftBill(
          bill.id,
          { vendorId: vendor.id, billNo: 'A-2', billDate: '2026-09-01', lines: [{ description: 'x', amountCents: 1 }] },
          ctx(sp),
        ),
      );
      expect(duplicate.code).toBe('duplicate_document');

      const updated = await updateDraftBill(
        bill.id,
        {
          vendorId: vendor.id,
          billNo: 'A-1',
          billDate: '2026-09-03',
          lines: [
            { description: 'Citric acid 25 kg', quantity: '25', unitCostCents: 180 },
            { description: 'Inbound freight', accountId: await accountId(tx, ACCOUNTS.COGS_FREIGHT_IN), amountCents: 900 },
          ],
        },
        ctx(tx),
      );
      expect(updated.totalCents).toBe(4_500 + 900);
      const lines = await tx.select().from(billLines).where(eq(billLines.billId, bill.id)).orderBy(asc(billLines.lineNo));
      expect(lines.map((l) => l.isInventory)).toEqual([true, false]);

      await approveBill(bill.id, ctx(tx));
      const refused = await refusal(tx, (sp) =>
        updateDraftBill(
          bill.id,
          { vendorId: vendor.id, billNo: 'A-1', billDate: '2026-09-03', lines: [{ description: 'x', amountCents: 1 }] },
          ctx(sp),
        ),
      );
      expect(refused.code).toBe('invalid_state');
    });
  });

  it('changes customer terms, including 2/10 net 30, and refuses a half-specified discount', async () => {
    await withRollback(async (tx) => {
      const customer = await makeCustomer(tx);
      const updated = await updateCustomer(
        customer.id,
        { termsDays: 30, termsDiscountPct: '2', termsDiscountDays: 10, customerType: 'foodservice' },
        ctx(tx),
      );
      expect(updated.termsDiscountPct).toBe('2.00');
      expect(updated.termsDiscountDays).toBe(10);
      expect(updated.customerType).toBe('foodservice');

      const refused = await refusal(tx, (sp) => updateCustomer(customer.id, { termsDiscountDays: 0 }, ctx(sp)));
      expect(refused.code).toBe('invalid_input');
    });
  });

  it('sets a vendor 1099 flag and W-9 details, storing only the last four of the TIN', async () => {
    await withRollback(async (tx) => {
      const vendor = await makeVendor(tx);
      const updated = await updateVendor(
        vendor.id,
        { is1099: true, w9OnFile: true, w9ReceivedAt: '2026-02-01', taxIdLast4: '4321', legalName: 'Test Person' },
        ctx(tx),
      );
      expect(updated.is1099).toBe(true);
      expect(updated.w9ReceivedAt).toBe('2026-02-01');
      expect(updated.taxIdLast4).toBe('4321');

      const refused = await refusal(tx, (sp) => updateVendor(vendor.id, { taxIdLast4: '123456789' }, ctx(sp)));
      expect(refused.code).toBe('invalid_input');
    });
  });
});

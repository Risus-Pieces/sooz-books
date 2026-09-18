/**
 * Changing what has not happened yet: customer and vendor records, and draft
 * invoices and bills.
 *
 * A draft is rewritten wholesale — header and lines — through the same
 * `prepareInvoice` / `prepareBill` a new document goes through, so an edited
 * draft is held to exactly the rules a new one is. It keeps its id and, for an
 * invoice, its number: numbers are issued once and never reissued. An issued
 * invoice or an approved bill is in the ledger and is never edited; the
 * correction is a void.
 */

import { and, eq, ne } from 'drizzle-orm';

import {
  type Bill,
  type Customer,
  type CustomerType,
  type Vendor,
  type VendorType,
  billLines,
  bills,
  customers,
  invoiceLines,
  invoices,
  type Invoice,
  vendors,
} from '@/db/schema';

import {
  type ArapContext,
  accountById,
  optionalText,
  requireDate,
  requireUuid,
  runArap,
} from './common';
import { ArapError, invalidInput, invalidState, notFound } from './errors';
import { type NewBillInput, prepareBill } from './bills';
import { type NewInvoiceInput, prepareInvoice } from './invoices';

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

/** Replaces a draft invoice's header and lines. Refused once it has been issued. */
export async function updateDraftInvoice(
  invoiceId: string,
  input: NewInvoiceInput,
  ctx: ArapContext,
): Promise<Invoice> {
  requireUuid('invoiceId', invoiceId);
  return runArap(ctx, async (tx) => {
    const [current] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId)).for('update');
    if (current === undefined) throw notFound('Invoice', invoiceId);
    if (current.status !== 'draft') {
      throw invalidState(`Invoice ${current.invoiceNo} is ${current.status}; only a draft can be edited. Void it instead.`);
    }

    const prepared = await prepareInvoice(tx, input);
    await tx.delete(invoiceLines).where(eq(invoiceLines.invoiceId, invoiceId));
    const [updated] = await tx
      .update(invoices)
      .set(prepared.header)
      .where(and(eq(invoices.id, invoiceId), eq(invoices.status, 'draft')))
      .returning();
    await tx.insert(invoiceLines).values(prepared.lines.map((line) => ({ ...line, invoiceId })));
    return updated;
  });
}

/** Replaces a draft bill's header and lines. Refused once it has been approved. */
export async function updateDraftBill(billId: string, input: NewBillInput, ctx: ArapContext): Promise<Bill> {
  requireUuid('billId', billId);
  return runArap(ctx, async (tx) => {
    const [current] = await tx.select().from(bills).where(eq(bills.id, billId)).for('update');
    if (current === undefined) throw notFound('Bill', billId);
    if (current.status !== 'draft') {
      throw invalidState(`Bill ${current.billNo} is ${current.status}; only a draft can be edited. Void it instead.`);
    }

    const { vendor, header, lines } = await prepareBill(tx, input);
    const [duplicate] = await tx
      .select({ id: bills.id })
      .from(bills)
      .where(and(eq(bills.vendorId, vendor.id), eq(bills.billNo, header.billNo), ne(bills.id, billId)));
    if (duplicate !== undefined) {
      throw new ArapError('duplicate_document', `${vendor.name} bill ${header.billNo} is already entered.`);
    }

    await tx.delete(billLines).where(eq(billLines.billId, billId));
    const [updated] = await tx
      .update(bills)
      .set(header)
      .where(and(eq(bills.id, billId), eq(bills.status, 'draft')))
      .returning();
    await tx.insert(billLines).values(lines.map((line) => ({ ...line, billId })));
    return updated;
  });
}

// ---------------------------------------------------------------------------
// Customers and vendors
// ---------------------------------------------------------------------------

function requireDays(value: number | undefined, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 0 || value > 365) {
    throw invalidInput(`${field} must be a whole number of days between 0 and 365.`);
  }
  return value;
}

function requirePct(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const text = value.trim() === '' ? '0' : value.trim();
  if (!/^\d{1,2}(?:\.\d{1,2})?$/.test(text)) {
    throw invalidInput(`Discount percentage ${JSON.stringify(value)} must be between 0 and 99.99.`);
  }
  return text;
}

function requireName(value: string | undefined, what: string): string | undefined {
  if (value === undefined) return undefined;
  const name = optionalText(value);
  if (name === null) throw invalidInput(`A ${what} needs a name.`);
  return name;
}

/** Early-payment terms must be a pair: a percentage needs days, and days need a percentage. */
function assertDiscountTerms(pct: string, days: number, netDays: number): void {
  const hasPct = Number(pct) > 0;
  if (hasPct !== days > 0) {
    throw invalidInput('An early-payment discount needs both a percentage and a number of days, e.g. 2% in 10 days.');
  }
  if (days > netDays) throw invalidInput('The discount window cannot be longer than the net terms.');
}

export interface CustomerPatch {
  name?: string;
  displayName?: string | null;
  customerType?: CustomerType;
  channelId?: string | null;
  email?: string | null;
  phone?: string | null;
  termsDays?: number;
  termsDiscountPct?: string;
  termsDiscountDays?: number;
  creditLimitCents?: number | null;
  notes?: string | null;
  active?: boolean;
}

/** Changes a customer record. Only the fields given change; open invoices keep the terms they were issued on. */
export async function updateCustomer(customerId: string, patch: CustomerPatch, ctx: ArapContext): Promise<Customer> {
  requireUuid('customerId', customerId);
  const name = requireName(patch.name, 'customer');
  const termsDays = requireDays(patch.termsDays, 'Terms');
  const discountDays = requireDays(patch.termsDiscountDays, 'Discount days');
  const pct = requirePct(patch.termsDiscountPct);
  if (patch.channelId) requireUuid('channelId', patch.channelId);
  if (patch.creditLimitCents !== undefined && patch.creditLimitCents !== null) {
    if (!Number.isSafeInteger(patch.creditLimitCents) || patch.creditLimitCents < 0) {
      throw invalidInput('The credit limit must be zero or a positive amount.');
    }
  }

  return runArap(ctx, async (tx) => {
    const [current] = await tx.select().from(customers).where(eq(customers.id, customerId)).for('update');
    if (current === undefined) throw notFound('Customer', customerId);
    assertDiscountTerms(
      pct ?? current.termsDiscountPct,
      discountDays ?? current.termsDiscountDays,
      termsDays ?? current.termsDays,
    );

    const [row] = await tx
      .update(customers)
      .set({
        ...(name === undefined ? {} : { name }),
        ...(patch.displayName === undefined ? {} : { displayName: optionalText(patch.displayName) }),
        ...(patch.customerType === undefined ? {} : { customerType: patch.customerType }),
        ...(patch.channelId === undefined ? {} : { channelId: patch.channelId }),
        ...(patch.email === undefined ? {} : { email: optionalText(patch.email) }),
        ...(patch.phone === undefined ? {} : { phone: optionalText(patch.phone) }),
        ...(termsDays === undefined ? {} : { termsDays }),
        ...(pct === undefined ? {} : { termsDiscountPct: pct }),
        ...(discountDays === undefined ? {} : { termsDiscountDays: discountDays }),
        ...(patch.creditLimitCents === undefined ? {} : { creditLimitCents: patch.creditLimitCents }),
        ...(patch.notes === undefined ? {} : { notes: optionalText(patch.notes) }),
        ...(patch.active === undefined ? {} : { active: patch.active }),
      })
      .where(eq(customers.id, customerId))
      .returning();
    return row;
  });
}

export interface VendorPatch {
  name?: string;
  displayName?: string | null;
  vendorType?: VendorType;
  email?: string | null;
  phone?: string | null;
  termsDays?: number;
  defaultExpenseAccountId?: string | null;
  is1099?: boolean;
  w9OnFile?: boolean;
  w9ReceivedAt?: string | null;
  taxIdLast4?: string | null;
  legalName?: string | null;
  notes?: string | null;
  active?: boolean;
}

/** Changes a vendor record, including its 1099 flag and W-9 details. Only the fields given change. */
export async function updateVendor(vendorId: string, patch: VendorPatch, ctx: ArapContext): Promise<Vendor> {
  requireUuid('vendorId', vendorId);
  const name = requireName(patch.name, 'vendor');
  const termsDays = requireDays(patch.termsDays, 'Terms');
  if (patch.taxIdLast4 !== undefined && patch.taxIdLast4 !== null && !/^\d{4}$/.test(patch.taxIdLast4)) {
    throw invalidInput('Only the last four digits of a tax id are stored.');
  }
  const w9ReceivedAt =
    patch.w9ReceivedAt === undefined || patch.w9ReceivedAt === null
      ? patch.w9ReceivedAt
      : requireDate('w9ReceivedAt', patch.w9ReceivedAt);
  if (patch.w9OnFile === false && w9ReceivedAt) {
    throw invalidInput('A W-9 received date means the W-9 is on file.');
  }

  return runArap(ctx, async (tx) => {
    if (patch.defaultExpenseAccountId) await accountById(tx, patch.defaultExpenseAccountId);
    const [row] = await tx
      .update(vendors)
      .set({
        ...(name === undefined ? {} : { name }),
        ...(patch.displayName === undefined ? {} : { displayName: optionalText(patch.displayName) }),
        ...(patch.vendorType === undefined ? {} : { vendorType: patch.vendorType }),
        ...(patch.email === undefined ? {} : { email: optionalText(patch.email) }),
        ...(patch.phone === undefined ? {} : { phone: optionalText(patch.phone) }),
        ...(termsDays === undefined ? {} : { termsDays }),
        ...(patch.defaultExpenseAccountId === undefined
          ? {}
          : { defaultExpenseAccountId: patch.defaultExpenseAccountId }),
        ...(patch.is1099 === undefined ? {} : { is1099: patch.is1099 }),
        ...(patch.w9OnFile === undefined ? {} : { w9OnFile: patch.w9OnFile }),
        ...(w9ReceivedAt === undefined ? {} : { w9ReceivedAt }),
        ...(patch.taxIdLast4 === undefined ? {} : { taxIdLast4: patch.taxIdLast4 }),
        ...(patch.legalName === undefined ? {} : { legalName: optionalText(patch.legalName) }),
        ...(patch.notes === undefined ? {} : { notes: optionalText(patch.notes) }),
        ...(patch.active === undefined ? {} : { active: patch.active }),
      })
      .where(eq(vendors.id, vendorId))
      .returning();
    if (row === undefined) throw notFound('Vendor', vendorId);
    return row;
  });
}

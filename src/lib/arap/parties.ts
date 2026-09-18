/**
 * Customers and vendors: creating them, and the vendor tax profile that drives
 * 1099 reporting. Vendor aliases and bank-statement vendor matching live in
 * `@/lib/banking/vendors`; this module owns only the sub-ledger fields.
 */

import { eq } from 'drizzle-orm';

import {
  type Customer,
  type CustomerType,
  type Vendor,
  type VendorType,
  channels,
  customers,
  vendors,
} from '@/db/schema';
import { CHANNEL_CODES, type ChannelCode } from '@/lib/ledger/coa';

import {
  type ArapContext,
  type LedgerDb,
  accountById,
  optionalText,
  requireDate,
  requireUuid,
  runArap,
} from './common';
import { invalidInput, notFound } from './errors';

export interface NewCustomerInput {
  name: string;
  displayName?: string;
  customerType?: CustomerType;
  channelId?: string | null;
  email?: string;
  phone?: string;
  termsDays?: number;
  /** Early-payment discount, e.g. "2.00" for 2/10 net 30. */
  termsDiscountPct?: string;
  termsDiscountDays?: number;
  creditLimitCents?: number | null;
  notes?: string;
}

function requireTerms(days: number | undefined, field: string): number | undefined {
  if (days === undefined) return undefined;
  if (!Number.isInteger(days) || days < 0 || days > 365) {
    throw invalidInput(`${field} must be a whole number of days between 0 and 365.`);
  }
  return days;
}

function requirePct(pct: string | undefined): string | undefined {
  if (pct === undefined) return undefined;
  const text = pct.trim();
  if (!/^\d{1,2}(?:\.\d{1,2})?$/.test(text)) {
    throw invalidInput(`Discount percentage ${JSON.stringify(pct)} must be between 0 and 99.99.`);
  }
  return text;
}

export async function createCustomer(input: NewCustomerInput, ctx: ArapContext): Promise<Customer> {
  const name = optionalText(input.name);
  if (name === null) throw invalidInput('A customer needs a name.');
  const termsDays = requireTerms(input.termsDays, 'Terms');
  const discountDays = requireTerms(input.termsDiscountDays, 'Discount days');
  const pct = requirePct(input.termsDiscountPct);
  if (input.channelId) requireUuid('channelId', input.channelId);

  return runArap(ctx, async (tx) => {
    const [row] = await tx
      .insert(customers)
      .values({
        name,
        displayName: optionalText(input.displayName),
        customerType: input.customerType ?? 'wholesale',
        channelId: input.channelId ?? null,
        email: optionalText(input.email),
        phone: optionalText(input.phone),
        ...(termsDays === undefined ? {} : { termsDays }),
        ...(pct === undefined ? {} : { termsDiscountPct: pct }),
        ...(discountDays === undefined ? {} : { termsDiscountDays: discountDays }),
        creditLimitCents: input.creditLimitCents ?? null,
        notes: optionalText(input.notes),
      })
      .returning();
    return row;
  });
}

export interface NewVendorInput {
  name: string;
  displayName?: string;
  vendorType?: VendorType;
  email?: string;
  phone?: string;
  termsDays?: number;
  defaultExpenseAccountId?: string | null;
  is1099?: boolean;
  w9OnFile?: boolean;
  w9ReceivedAt?: string | null;
  taxIdLast4?: string | null;
  legalName?: string | null;
  notes?: string;
}

function requireLast4(value: string | null | undefined): string | null | undefined {
  if (value === undefined || value === null) return value;
  if (!/^\d{4}$/.test(value)) throw invalidInput('Only the last four digits of a tax id are stored.');
  return value;
}

export async function createVendor(input: NewVendorInput, ctx: ArapContext): Promise<Vendor> {
  const name = optionalText(input.name);
  if (name === null) throw invalidInput('A vendor needs a name.');
  const termsDays = requireTerms(input.termsDays, 'Terms');
  const last4 = requireLast4(input.taxIdLast4);
  const w9ReceivedAt =
    input.w9ReceivedAt === undefined || input.w9ReceivedAt === null
      ? null
      : requireDate('w9ReceivedAt', input.w9ReceivedAt);

  return runArap(ctx, async (tx) => {
    if (input.defaultExpenseAccountId) await accountById(tx, input.defaultExpenseAccountId);
    const [row] = await tx
      .insert(vendors)
      .values({
        name,
        displayName: optionalText(input.displayName),
        vendorType: input.vendorType ?? 'other',
        email: optionalText(input.email),
        phone: optionalText(input.phone),
        ...(termsDays === undefined ? {} : { termsDays }),
        defaultExpenseAccountId: input.defaultExpenseAccountId ?? null,
        is1099: input.is1099 ?? false,
        w9OnFile: input.w9OnFile ?? false,
        w9ReceivedAt,
        taxIdLast4: last4 ?? null,
        legalName: optionalText(input.legalName),
        notes: optionalText(input.notes),
      })
      .returning();
    return row;
  });
}

export interface VendorTaxProfile {
  is1099?: boolean;
  w9OnFile?: boolean;
  w9ReceivedAt?: string | null;
  taxIdLast4?: string | null;
  legalName?: string | null;
}

/** Sets a vendor's 1099 flag and W-9 details. Only the fields given change. */
export async function updateVendorTaxProfile(
  vendorId: string,
  profile: VendorTaxProfile,
  ctx: ArapContext,
): Promise<Vendor> {
  requireUuid('vendorId', vendorId);
  const last4 = requireLast4(profile.taxIdLast4);
  const receivedAt =
    profile.w9ReceivedAt === undefined || profile.w9ReceivedAt === null
      ? profile.w9ReceivedAt
      : requireDate('w9ReceivedAt', profile.w9ReceivedAt);

  return runArap(ctx, async (tx) => {
    const [row] = await tx
      .update(vendors)
      .set({
        ...(profile.is1099 === undefined ? {} : { is1099: profile.is1099 }),
        ...(profile.w9OnFile === undefined ? {} : { w9OnFile: profile.w9OnFile }),
        ...(receivedAt === undefined ? {} : { w9ReceivedAt: receivedAt }),
        ...(last4 === undefined ? {} : { taxIdLast4: last4 }),
        ...(profile.legalName === undefined ? {} : { legalName: optionalText(profile.legalName) }),
      })
      .where(eq(vendors.id, vendorId))
      .returning();
    if (row === undefined) throw notFound('Vendor', vendorId);
    return row;
  });
}

// ---------------------------------------------------------------------------
// Channel of a customer
// ---------------------------------------------------------------------------

/** Where a customer of this type sells through, when the record names no channel. */
const CHANNEL_BY_CUSTOMER_TYPE: Readonly<Record<CustomerType, ChannelCode | null>> = {
  dtc: 'DTC',
  marketplace: 'AMAZON',
  distributor: 'DISTRIBUTOR',
  wholesale: 'WHOLESALE',
  foodservice: 'FOODSERVICE',
  other: null,
};

export interface ResolvedChannel {
  id: string;
  code: string;
}

function isChannelCode(code: string): code is ChannelCode {
  return (CHANNEL_CODES as readonly string[]).includes(code);
}

export { isChannelCode };

/** The channel an invoice to this customer belongs to: the customer's own, else its type's. */
export async function channelForCustomer(
  tx: LedgerDb,
  customer: Pick<Customer, 'channelId' | 'customerType'>,
): Promise<ResolvedChannel | null> {
  if (customer.channelId !== null) {
    const [row] = await tx
      .select({ id: channels.id, code: channels.code })
      .from(channels)
      .where(eq(channels.id, customer.channelId));
    return row ?? null;
  }
  const code = CHANNEL_BY_CUSTOMER_TYPE[customer.customerType];
  if (code === null) return null;
  const [row] = await tx
    .select({ id: channels.id, code: channels.code })
    .from(channels)
    .where(eq(channels.code, code));
  return row ?? null;
}

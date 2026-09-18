/**
 * Fixtures for the AR/AP suites. Every test runs inside `withRollback` from the
 * ledger's test support, so each customer, vendor, bank account and document
 * made here disappears with the transaction and the seeded data is only read.
 */

import { eq, sql } from 'drizzle-orm';

import {
  type Customer,
  type CustomerType,
  type Vendor,
  type VendorType,
  accounts,
  bankAccounts,
  bankTransactions,
  channels,
} from '@/db/schema';

import type { LedgerDb } from './common';
import { createCustomer, createVendor } from './parties';

let serial = 0;

function tag(): string {
  serial += 1;
  return `${Date.now().toString(36)}-${String(serial)}`;
}

/** Brings the deferred balance checks forward so a bad entry fails inside the test. */
export async function checkNow(tx: LedgerDb): Promise<void> {
  await tx.execute(sql`set constraints all immediate`);
  await tx.execute(sql`set constraints all deferred`);
}

export async function accountId(tx: LedgerDb, code: string): Promise<string> {
  const [row] = await tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.code, code));
  if (row === undefined) throw new Error(`Seeded account ${code} is missing.`);
  return row.id;
}

export async function channelId(tx: LedgerDb, code: string): Promise<string> {
  const [row] = await tx.select({ id: channels.id }).from(channels).where(eq(channels.code, code));
  if (row === undefined) throw new Error(`Seeded channel ${code} is missing.`);
  return row.id;
}

export async function makeCustomer(
  tx: LedgerDb,
  overrides: {
    name?: string;
    customerType?: CustomerType;
    channelId?: string | null;
    termsDays?: number;
    termsDiscountPct?: string;
    termsDiscountDays?: number;
  } = {},
): Promise<Customer> {
  return createCustomer(
    {
      name: overrides.name ?? `ZZ Test Customer ${tag()}`,
      customerType: overrides.customerType ?? 'wholesale',
      channelId: overrides.channelId ?? null,
      termsDays: overrides.termsDays ?? 30,
      ...(overrides.termsDiscountPct === undefined ? {} : { termsDiscountPct: overrides.termsDiscountPct }),
      ...(overrides.termsDiscountDays === undefined ? {} : { termsDiscountDays: overrides.termsDiscountDays }),
    },
    { userId: null, tx },
  );
}

export async function makeVendor(
  tx: LedgerDb,
  overrides: {
    name?: string;
    vendorType?: VendorType;
    defaultExpenseAccountId?: string | null;
    is1099?: boolean;
    w9OnFile?: boolean;
    termsDays?: number;
  } = {},
): Promise<Vendor> {
  return createVendor(
    {
      name: overrides.name ?? `ZZ Test Vendor ${tag()}`,
      vendorType: overrides.vendorType ?? 'other',
      defaultExpenseAccountId: overrides.defaultExpenseAccountId ?? null,
      is1099: overrides.is1099 ?? false,
      w9OnFile: overrides.w9OnFile ?? false,
      termsDays: overrides.termsDays ?? 30,
    },
    { userId: null, tx },
  );
}

/**
 * A throwaway bank account on a seeded bank GL account no real feed uses
 * (1020 Savings & Tax Reserve), so fixture lines never mix with the Relay rows.
 */
export async function makeBankAccount(tx: LedgerDb, glCode = '1020'): Promise<{ id: string; accountId: string }> {
  const glId = await accountId(tx, glCode);
  const [row] = await tx
    .insert(bankAccounts)
    .values({ accountId: glId, name: `ZZ arap test ${tag()}`, kind: 'checking', mask: '0000' })
    .returning({ id: bankAccounts.id, accountId: bankAccounts.accountId });
  return row;
}

export async function makeBankLine(
  tx: LedgerDb,
  bankAccountId: string,
  line: { date: string; amountCents: number; description: string; suggestedCustomerId?: string; suggestedVendorId?: string },
): Promise<string> {
  const normalized = line.description.toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const [row] = await tx
    .insert(bankTransactions)
    .values({
      bankAccountId,
      txnDate: line.date,
      description: line.description,
      descriptionNormalized: normalized,
      amountCents: line.amountCents,
      fingerprint: `arap-test-${tag()}`,
      suggestedCustomerId: line.suggestedCustomerId ?? null,
      suggestedVendorId: line.suggestedVendorId ?? null,
    })
    .returning({ id: bankTransactions.id });
  return row.id;
}

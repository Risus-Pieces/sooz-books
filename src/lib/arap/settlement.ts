/**
 * Settling invoices and bills: locking them, checking an application against
 * the open balance, and moving `paid_cents` / `credited_cents` and `status`
 * together inside the caller's transaction.
 *
 * Balance is always total − paid − credited − deducted (bills have no
 * deductions). An early-payment discount settles an invoice as surely as cash
 * does, so it is counted in `paid_cents` alongside the money.
 */

import { and, eq, inArray, sql } from 'drizzle-orm';

import { type Bill, type Invoice, bankTransactions, bills, invoices, journalEntries } from '@/db/schema';
import type { CalendarDate } from '@/lib/dates';

import { type LedgerDb, requirePositiveCents, requireUuid } from './common';
import { ArapError, invalidInput, invalidState, notFound } from './errors';

export interface ApplicationInput {
  /** Invoice id for AR documents, bill id for AP documents. */
  documentId: string;
  amountCents: number;
}

/** Rejects duplicate targets and non-positive amounts before anything is locked. */
export function normalizeApplications(applications: readonly ApplicationInput[]): ApplicationInput[] {
  const seen = new Set<string>();
  return applications.map((app, index) => {
    requireUuid(`applications[${index}].documentId`, app.documentId);
    requirePositiveCents(`applications[${index}].amountCents`, app.amountCents);
    if (seen.has(app.documentId)) {
      throw invalidInput('The same document appears twice in one application; combine the amounts.');
    }
    seen.add(app.documentId);
    return app;
  });
}

/** Locks invoices in id order (a fixed order, so two writers cannot deadlock). */
export async function lockInvoices(tx: LedgerDb, ids: readonly string[]): Promise<Map<string, Invoice>> {
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select()
    .from(invoices)
    .where(inArray(invoices.id, [...ids]))
    .orderBy(invoices.id)
    .for('update');
  const map = new Map(rows.map((row) => [row.id, row]));
  for (const id of ids) if (!map.has(id)) throw notFound('Invoice', id);
  return map;
}

export async function lockBills(tx: LedgerDb, ids: readonly string[]): Promise<Map<string, Bill>> {
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select()
    .from(bills)
    .where(inArray(bills.id, [...ids]))
    .orderBy(bills.id)
    .for('update');
  const map = new Map(rows.map((row) => [row.id, row]));
  for (const id of ids) if (!map.has(id)) throw notFound('Bill', id);
  return map;
}

export function invoiceOpenBalance(invoice: Invoice): number {
  return invoice.totalCents - invoice.paidCents - invoice.creditedCents - invoice.deductedCents;
}

export function billOpenBalance(bill: Bill): number {
  return bill.totalCents - bill.paidCents - bill.creditedCents;
}

/** An issued, unvoided invoice of this customer, dated no later than the application. */
export function assertInvoiceApplicable(
  invoice: Invoice,
  customerId: string,
  onDate: CalendarDate,
  settleCents: number,
): void {
  if (invoice.customerId !== customerId) {
    throw new ArapError('party_mismatch', `Invoice ${invoice.invoiceNo} belongs to another customer.`);
  }
  if (invoice.status !== 'open' && invoice.status !== 'partial') {
    throw invalidState(`Invoice ${invoice.invoiceNo} is ${invoice.status} and cannot take a payment or credit.`);
  }
  if (invoice.invoiceDate > onDate) {
    throw invalidInput(`Invoice ${invoice.invoiceNo} is dated ${invoice.invoiceDate}, after ${onDate}.`);
  }
  const balance = invoiceOpenBalance(invoice);
  if (settleCents > balance) {
    throw new ArapError(
      'over_application',
      `Invoice ${invoice.invoiceNo} has ${balance} cents open; ${settleCents} cannot be applied to it.`,
    );
  }
}

export function assertBillApplicable(bill: Bill, vendorId: string, onDate: CalendarDate, settleCents: number): void {
  if (bill.vendorId !== vendorId) {
    throw new ArapError('party_mismatch', `Bill ${bill.billNo} belongs to another vendor.`);
  }
  if (bill.status !== 'open' && bill.status !== 'partial') {
    throw invalidState(`Bill ${bill.billNo} is ${bill.status} and cannot take a payment or credit.`);
  }
  if (bill.billDate > onDate) {
    throw invalidInput(`Bill ${bill.billNo} is dated ${bill.billDate}, after ${onDate}.`);
  }
  const balance = billOpenBalance(bill);
  if (settleCents > balance) {
    throw new ArapError(
      'over_application',
      `Bill ${bill.billNo} has ${balance} cents open; ${settleCents} cannot be applied to it.`,
    );
  }
}

const INVOICE_STATUS = sql`(case
  when ${invoices.totalCents} - ${invoices.paidCents} - ${invoices.creditedCents} - ${invoices.deductedCents} = 0 then 'paid'
  when ${invoices.paidCents} + ${invoices.creditedCents} + ${invoices.deductedCents} > 0 then 'partial'
  else 'open' end)::doc_status`;

const BILL_STATUS = sql`(case
  when ${bills.totalCents} - ${bills.paidCents} - ${bills.creditedCents} = 0 then 'paid'
  when ${bills.paidCents} + ${bills.creditedCents} > 0 then 'partial'
  else 'open' end)::doc_status`;

/**
 * Moves an invoice's settled amounts by the given deltas (negative to unapply)
 * and recomputes its status from the new figures. Two statements, because an
 * UPDATE's SET list only ever sees the row's old values.
 */
export async function adjustInvoice(
  tx: LedgerDb,
  invoiceId: string,
  delta: { paidCents?: number; creditedCents?: number },
): Promise<void> {
  const paid = delta.paidCents ?? 0;
  const credited = delta.creditedCents ?? 0;
  await tx
    .update(invoices)
    .set({
      paidCents: sql`${invoices.paidCents} + ${paid}`,
      creditedCents: sql`${invoices.creditedCents} + ${credited}`,
    })
    .where(eq(invoices.id, invoiceId));
  await tx
    .update(invoices)
    .set({ status: INVOICE_STATUS })
    .where(and(eq(invoices.id, invoiceId), inArray(invoices.status, ['open', 'partial', 'paid'])));
}

export async function adjustBill(
  tx: LedgerDb,
  billId: string,
  delta: { paidCents?: number; creditedCents?: number },
): Promise<void> {
  const paid = delta.paidCents ?? 0;
  const credited = delta.creditedCents ?? 0;
  await tx
    .update(bills)
    .set({
      paidCents: sql`${bills.paidCents} + ${paid}`,
      creditedCents: sql`${bills.creditedCents} + ${credited}`,
    })
    .where(eq(bills.id, billId));
  await tx
    .update(bills)
    .set({ status: BILL_STATUS })
    .where(and(eq(bills.id, billId), inArray(bills.status, ['open', 'partial', 'paid'])));
}

/** Whether a posted entry has been reversed (that is, its document voided). */
export async function isReversed(tx: LedgerDb, entryId: string | null): Promise<boolean> {
  if (entryId === null) return false;
  const [row] = await tx
    .select({ id: journalEntries.id })
    .from(journalEntries)
    .where(and(eq(journalEntries.reversesId, entryId), eq(journalEntries.status, 'posted')))
    .limit(1);
  return row !== undefined;
}

/** Posted, unreversed entries a document raised, so a void reverses all of them. */
export async function liveEntriesOf(tx: LedgerDb, sourceType: string, sourceId: string): Promise<string[]> {
  const rows = await tx.execute<{ id: string }>(sql`
    select e.id
      from journal_entries e
     where e.source_type = ${sourceType}
       and e.source_id = ${sourceId}
       and e.status = 'posted'
       and not exists (select 1 from journal_entries r where r.reverses_id = e.id and r.status = 'posted')
     order by e.entry_no
  `);
  return rows.map((row) => row.id);
}

export function assertOnOrAfter(date: CalendarDate, floor: CalendarDate, what: string): void {
  if (date < floor) throw invalidInput(`${what} cannot be dated before ${floor}.`);
}

/**
 * Puts a matched bank line back in the review queue once the document it was
 * matched to is void. Only touches the line if it still points at that entry.
 */
export async function releaseBankTransaction(tx: LedgerDb, bankTransactionId: string, entryId: string): Promise<void> {
  await tx
    .update(bankTransactions)
    .set({
      status: 'unreviewed',
      matchedType: null,
      matchedId: null,
      journalEntryId: null,
      reviewedBy: null,
      reviewedAt: null,
    })
    .where(and(eq(bankTransactions.id, bankTransactionId), eq(bankTransactions.journalEntryId, entryId)));
}

/**
 * Bill payments: money out, applied across a vendor's bills.
 *
 * Paying posts Dr 2000 AP (per bill, plus any unapplied prepayment) / Cr the
 * bank, cash or card account the money left from, with the vendor on every
 * line. Anything not applied to a bill stays on AP as a debit — a prepayment
 * the vendor owes us goods or a bill for — and can be applied later with
 * `applyVendorPrepayment`, which moves only the sub-ledger.
 *
 * A payment made by card is marked not 1099-reportable: the card network
 * reports it to the IRS on a 1099-K, and reporting it again on a 1099-NEC
 * would double-count the vendor's income.
 */

import { eq } from 'drizzle-orm';

import {
  type BillPayment,
  type PaymentMethod,
  billPaymentApplications,
  billPayments,
  vendors,
} from '@/db/schema';
import { type CalendarDate, today } from '@/lib/dates';
import { ACCOUNTS } from '@/lib/ledger/coa';
import { type DraftLine, postJournalEntry } from '@/lib/ledger/post';
import { reverseEntry } from '@/lib/ledger/reverse';
import { sumCents } from '@/lib/money';

import {
  type AccountInfo,
  type ArapContext,
  type LedgerDb,
  accountById,
  appendNote,
  appliedAtFor,
  laterOf,
  optionalText,
  requireDate,
  requirePositiveCents,
  requireUuid,
  runArap,
} from './common';
import { ArapError, invalidInput, invalidState, notFound } from './errors';
import { voidDate } from './invoices';
import { nextDocumentNumber } from './numbering';
import {
  adjustBill,
  assertBillApplicable,
  assertOnOrAfter,
  isReversed,
  liveEntriesOf,
  lockBills,
  normalizeApplications,
  releaseBankTransaction,
} from './settlement';

export interface NewBillPaymentInput {
  vendorId: string;
  paymentDate: CalendarDate;
  amountCents: number;
  /** The bank, cash or card account the money left from. */
  paymentAccountId: string;
  /** Defaults to 'card' when paid from a card account, 'ach' otherwise. */
  method?: PaymentMethod;
  reference?: string;
  memo?: string;
  applications?: readonly { billId: string; amountCents: number }[];
  /** Set by bank matching: the statement line this payment is. */
  bankTransactionId?: string;
}

export interface BillPaymentResult {
  payment: BillPayment;
  entryId: string;
  unappliedCents: number;
}

const PAYABLE_FROM: ReadonlySet<string> = new Set(['bank', 'cash', 'credit_card']);

function assertPaymentAccount(account: AccountInfo): void {
  const subtype = account.subtype ?? '';
  if (account.isControl || !(PAYABLE_FROM.has(subtype) || account.isBank)) {
    throw invalidInput(`${account.code} ${account.name} is not a bank, cash or card account; a bill is paid from one.`);
  }
}

/** Card payments are reported by the card network (1099-K), never on a 1099-NEC. */
export function isCardPayment(method: PaymentMethod, account: Pick<AccountInfo, 'subtype'>): boolean {
  return method === 'card' || account.subtype === 'credit_card';
}

export async function payBills(input: NewBillPaymentInput, ctx: ArapContext): Promise<BillPaymentResult> {
  requireUuid('vendorId', input.vendorId);
  const paymentDate = requireDate('paymentDate', input.paymentDate);
  const amount = requirePositiveCents('Payment amount', input.amountCents);
  const applications = normalizeApplications(
    (input.applications ?? []).map((a) => ({ documentId: a.billId, amountCents: a.amountCents })),
  );
  const applied = sumCents(applications.map((a) => a.amountCents));
  if (applied > amount) {
    throw new ArapError('over_application', `Applications total ${applied} cents but only ${amount} cents were paid.`);
  }

  return runArap(ctx, async (tx) => {
    const [vendor] = await tx.select().from(vendors).where(eq(vendors.id, input.vendorId));
    if (vendor === undefined) throw notFound('Vendor', input.vendorId);
    const account = await accountById(tx, input.paymentAccountId);
    assertPaymentAccount(account);
    const method: PaymentMethod = input.method ?? (account.subtype === 'credit_card' ? 'card' : 'ach');

    const locked = await lockBills(
      tx,
      applications.map((a) => a.documentId),
    );
    for (const app of applications) {
      const bill = locked.get(app.documentId);
      if (bill === undefined) throw notFound('Bill', app.documentId);
      assertBillApplicable(bill, vendor.id, paymentDate, app.amountCents);
    }

    const paymentNo = await nextDocumentNumber(tx, 'bill_payment');
    const [payment] = await tx
      .insert(billPayments)
      .values({
        paymentNo,
        vendorId: vendor.id,
        paymentDate,
        method,
        reference: optionalText(input.reference),
        amountCents: amount,
        appliedCents: applied,
        paymentAccountId: account.id,
        bankTransactionId: input.bankTransactionId ?? null,
        is1099Reportable: !isCardPayment(method, account),
        memo: optionalText(input.memo),
        createdBy: ctx.userId,
      })
      .returning();

    const lines: DraftLine[] = [];
    for (const app of applications) {
      const bill = locked.get(app.documentId);
      lines.push({
        accountCode: ACCOUNTS.AP,
        debitCents: app.amountCents,
        vendorId: vendor.id,
        memo: `Payment on bill ${bill?.billNo ?? app.documentId}`,
      });
    }
    const unapplied = amount - applied;
    if (unapplied > 0) {
      lines.push({
        accountCode: ACCOUNTS.AP,
        debitCents: unapplied,
        vendorId: vendor.id,
        memo: `Unapplied vendor prepayment ${paymentNo}`,
      });
    }
    lines.push({ accountId: account.id, creditCents: amount, vendorId: vendor.id, memo: `Payment ${paymentNo}` });

    const posted = await postJournalEntry(
      {
        date: paymentDate,
        memo: `Payment ${paymentNo} to ${vendor.name}`,
        sourceType: 'bill_payment',
        sourceId: payment.id,
        lines,
      },
      { userId: ctx.userId, tx },
    );

    if (applications.length > 0) {
      await tx.insert(billPaymentApplications).values(
        applications.map((app) => ({
          paymentId: payment.id,
          billId: app.documentId,
          amountCents: app.amountCents,
          discountCents: 0,
          appliedAt: appliedAtFor(paymentDate),
        })),
      );
      for (const app of applications) await adjustBill(tx, app.documentId, { paidCents: app.amountCents });
    }

    const [linked] = await tx
      .update(billPayments)
      .set({ journalEntryId: posted.entryId })
      .where(eq(billPayments.id, payment.id))
      .returning();
    return { payment: linked, entryId: posted.entryId, unappliedCents: unapplied };
  });
}

async function lockPayment(tx: LedgerDb, paymentId: string): Promise<BillPayment> {
  requireUuid('paymentId', paymentId);
  const [payment] = await tx.select().from(billPayments).where(eq(billPayments.id, paymentId)).for('update');
  if (payment === undefined) throw notFound('Bill payment', paymentId);
  return payment;
}

/** Applies an unapplied vendor prepayment to open bills of the same vendor. No ledger entry. */
export async function applyVendorPrepayment(
  paymentId: string,
  input: { date?: CalendarDate; applications: readonly { billId: string; amountCents: number }[] },
  ctx: ArapContext,
): Promise<BillPayment> {
  const applications = normalizeApplications(
    input.applications.map((a) => ({ documentId: a.billId, amountCents: a.amountCents })),
  );
  if (applications.length === 0) throw invalidInput('Choose at least one bill to apply the prepayment to.');

  return runArap(ctx, async (tx) => {
    const payment = await lockPayment(tx, paymentId);
    if (payment.journalEntryId === null || (await isReversed(tx, payment.journalEntryId))) {
      throw invalidState(`Payment ${payment.paymentNo} is void.`);
    }
    const total = sumCents(applications.map((a) => a.amountCents));
    const unapplied = payment.amountCents - payment.appliedCents;
    if (total > unapplied) {
      throw new ArapError(
        'over_application',
        `Payment ${payment.paymentNo} has ${unapplied} cents unapplied; ${total} cannot be applied.`,
      );
    }
    const locked = await lockBills(
      tx,
      applications.map((a) => a.documentId),
    );
    const latest = [...locked.values()].reduce((max, bill) => laterOf(max, bill.billDate), payment.paymentDate);
    const date = input.date === undefined ? laterOf(today(), latest) : requireDate('date', input.date);
    assertOnOrAfter(date, payment.paymentDate, 'The application');

    for (const app of applications) {
      const bill = locked.get(app.documentId);
      if (bill === undefined) throw notFound('Bill', app.documentId);
      assertBillApplicable(bill, payment.vendorId, date, app.amountCents);
    }

    await tx.insert(billPaymentApplications).values(
      applications.map((app) => ({
        paymentId: payment.id,
        billId: app.documentId,
        amountCents: app.amountCents,
        discountCents: 0,
        appliedAt: appliedAtFor(date),
      })),
    );
    for (const app of applications) await adjustBill(tx, app.documentId, { paidCents: app.amountCents });

    const [updated] = await tx
      .update(billPayments)
      .set({ appliedCents: payment.appliedCents + total })
      .where(eq(billPayments.id, payment.id))
      .returning();
    return updated;
  });
}

/**
 * Voids a bill payment: reverses it, puts the bills it paid back to open, and
 * returns a matched bank line to the review queue.
 */
export async function voidBillPayment(
  paymentId: string,
  options: { date?: CalendarDate; reason?: string },
  ctx: ArapContext,
): Promise<BillPayment> {
  return runArap(ctx, async (tx) => {
    const payment = await lockPayment(tx, paymentId);
    if (payment.journalEntryId === null) throw invalidState(`Payment ${payment.paymentNo} was never posted.`);
    if (await isReversed(tx, payment.journalEntryId)) throw invalidState(`Payment ${payment.paymentNo} is already void.`);

    const date = voidDate(options.date, payment.paymentDate);
    const memo = `Void payment ${payment.paymentNo}${options.reason ? ` — ${options.reason.trim()}` : ''}`;
    for (const entryId of await liveEntriesOf(tx, 'bill_payment', payment.id)) {
      await reverseEntry(entryId, { date, memo, userId: ctx.userId, tx, owner: 'bill_payment' });
    }

    const apps = await tx.select().from(billPaymentApplications).where(eq(billPaymentApplications.paymentId, payment.id));
    await lockBills(
      tx,
      apps.map((a) => a.billId),
    );
    for (const app of apps) await adjustBill(tx, app.billId, { paidCents: -(app.amountCents + app.discountCents) });

    if (payment.bankTransactionId !== null) {
      await releaseBankTransaction(tx, payment.bankTransactionId, payment.journalEntryId);
    }

    const [updated] = await tx
      .update(billPayments)
      .set({ memo: appendNote(payment.memo, `Void ${date}${options.reason ? `: ${options.reason.trim()}` : ''}`) })
      .where(eq(billPayments.id, payment.id))
      .returning();
    return updated;
  });
}

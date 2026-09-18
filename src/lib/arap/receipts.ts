/**
 * Customer receipts: money in, applied across invoices.
 *
 * Recording a receipt posts
 *
 *     Dr bank or 1040 Undeposited Funds   amount received
 *     Dr 4580 Early Payment Discounts     discount taken per terms
 *        Cr 1200 Accounts Receivable      amount + discounts
 *
 * The AR credit is split per invoice it settles (on that invoice's channel);
 * whatever is not applied stays on AR as the customer's credit and can be
 * applied to a later invoice with `applyReceiptCredit`, which moves no ledger
 * money — both sides of it are the same customer's receivable.
 *
 * An early-payment discount is only taken when the receipt is recorded: it is
 * a term of paying on time, and the payment is the event that earns it.
 */

import { eq } from 'drizzle-orm';

import {
  type PaymentMethod,
  type Receipt,
  customers,
  receiptApplications,
  receipts,
} from '@/db/schema';
import { type CalendarDate, daysBetween, today } from '@/lib/dates';
import { ACCOUNTS } from '@/lib/ledger/coa';
import { type DraftLine, postJournalEntry } from '@/lib/ledger/post';
import { reverseEntry } from '@/lib/ledger/reverse';
import { sumCents } from '@/lib/money';

import {
  type ArapContext,
  type LedgerDb,
  accountByCode,
  accountById,
  appendNote,
  appliedAtFor,
  isMoneyAccount,
  laterOf,
  optionalText,
  percentOfCents,
  requireDate,
  requireNonNegativeCents,
  requirePositiveCents,
  requireUuid,
  runArap,
} from './common';
import { ArapError, invalidInput, invalidState, notFound } from './errors';
import { voidDate } from './invoices';
import { nextDocumentNumber } from './numbering';
import {
  adjustInvoice,
  assertInvoiceApplicable,
  assertOnOrAfter,
  isReversed,
  liveEntriesOf,
  lockInvoices,
  normalizeApplications,
  releaseBankTransaction,
} from './settlement';

export interface ReceiptApplicationInput {
  invoiceId: string;
  /** Cash applied to the invoice. */
  amountCents: number;
  /** Early-payment discount taken on this invoice, within the customer's terms. */
  discountCents?: number;
}

export interface NewReceiptInput {
  customerId: string;
  receiptDate: CalendarDate;
  amountCents: number;
  method?: PaymentMethod;
  reference?: string;
  memo?: string;
  /** Where the money went. Defaults to 1040 Undeposited Funds. */
  depositAccountId?: string;
  applications?: readonly ReceiptApplicationInput[];
  /** Set by bank matching: the statement line this receipt is. */
  bankTransactionId?: string;
  remittanceId?: string;
}

export interface ReceiptResult {
  receipt: Receipt;
  entryId: string;
  unappliedCents: number;
}

/** The largest early-payment discount the terms allow on this invoice on this date, or 0. */
export function allowedDiscountCents(
  terms: { termsDiscountPct: string; termsDiscountDays: number },
  invoice: { invoiceDate: CalendarDate; totalCents: number },
  paidOn: CalendarDate,
): number {
  if (terms.termsDiscountDays <= 0) return 0;
  if (daysBetween(invoice.invoiceDate, paidOn) > terms.termsDiscountDays) return 0;
  return percentOfCents(invoice.totalCents, terms.termsDiscountPct);
}

export async function recordReceipt(input: NewReceiptInput, ctx: ArapContext): Promise<ReceiptResult> {
  requireUuid('customerId', input.customerId);
  const receiptDate = requireDate('receiptDate', input.receiptDate);
  const amount = requirePositiveCents('Receipt amount', input.amountCents);
  const applications = (input.applications ?? []).map((app, index) => {
    const discount = requireNonNegativeCents(`applications[${index}].discountCents`, app.discountCents ?? 0);
    return { ...normalizeApplications([{ documentId: app.invoiceId, amountCents: app.amountCents }])[0], discount };
  });
  if (new Set(applications.map((a) => a.documentId)).size !== applications.length) {
    throw invalidInput('The same invoice appears twice in one receipt; combine the amounts.');
  }
  const appliedCash = sumCents(applications.map((a) => a.amountCents));
  if (appliedCash > amount) {
    throw new ArapError(
      'over_application',
      `Applications total ${appliedCash} cents but only ${amount} cents were received.`,
    );
  }

  return runArap(ctx, async (tx) => {
    const [customer] = await tx.select().from(customers).where(eq(customers.id, input.customerId));
    if (customer === undefined) throw notFound('Customer', input.customerId);

    const deposit = input.depositAccountId
      ? await accountById(tx, input.depositAccountId)
      : await accountByCode(tx, ACCOUNTS.UNDEPOSITED_FUNDS);
    // A bank-feed account is allowed: when the statement brings in this deposit, the
    // review queue refuses to post it again and offers this receipt's entry to match it
    // to instead (banking/booked.ts), so the cash is booked once.
    if (!isMoneyAccount(deposit) || deposit.subtype === 'credit_card' || deposit.isControl) {
      throw invalidInput(`${deposit.code} ${deposit.name} cannot receive a customer payment.`);
    }

    const locked = await lockInvoices(
      tx,
      applications.map((a) => a.documentId),
    );
    for (const app of applications) {
      const invoice = locked.get(app.documentId);
      if (invoice === undefined) throw notFound('Invoice', app.documentId);
      assertInvoiceApplicable(invoice, customer.id, receiptDate, app.amountCents + app.discount);
      if (app.discount > 0) {
        const allowed = allowedDiscountCents(customer, invoice, receiptDate);
        if (allowed === 0) {
          throw new ArapError(
            'discount_not_allowed',
            `${customer.name}'s terms allow no early-payment discount on invoice ${invoice.invoiceNo} paid ${receiptDate}.`,
          );
        }
        if (app.discount > allowed) {
          throw new ArapError(
            'discount_not_allowed',
            `The terms allow at most ${allowed} cents discount on invoice ${invoice.invoiceNo}; ${app.discount} was entered.`,
          );
        }
      }
    }

    const receiptNo = await nextDocumentNumber(tx, 'receipt');
    const [receipt] = await tx
      .insert(receipts)
      .values({
        receiptNo,
        customerId: customer.id,
        receiptDate,
        method: input.method ?? 'ach',
        reference: optionalText(input.reference),
        amountCents: amount,
        appliedCents: appliedCash,
        depositAccountId: deposit.id,
        bankTransactionId: input.bankTransactionId ?? null,
        remittanceId: input.remittanceId ?? null,
        memo: optionalText(input.memo),
        createdBy: ctx.userId,
      })
      .returning();

    const unapplied = amount - appliedCash;
    const lines: DraftLine[] = [
      { accountId: deposit.id, debitCents: amount, customerId: customer.id, memo: `Receipt ${receiptNo}` },
    ];
    for (const app of applications) {
      const invoice = locked.get(app.documentId);
      if (invoice === undefined) continue;
      if (app.discount > 0) {
        lines.push({
          accountCode: ACCOUNTS.EARLY_PAYMENT_DISCOUNTS,
          debitCents: app.discount,
          customerId: customer.id,
          channelId: invoice.channelId,
          memo: `Early payment discount ${invoice.invoiceNo}`,
        });
      }
      lines.push({
        accountCode: ACCOUNTS.AR,
        creditCents: app.amountCents + app.discount,
        customerId: customer.id,
        channelId: invoice.channelId,
        memo: `Payment on ${invoice.invoiceNo}`,
      });
    }
    if (unapplied > 0) {
      lines.push({
        accountCode: ACCOUNTS.AR,
        creditCents: unapplied,
        customerId: customer.id,
        memo: `Unapplied customer credit ${receiptNo}`,
      });
    }

    const posted = await postJournalEntry(
      {
        date: receiptDate,
        memo: `Receipt ${receiptNo} from ${customer.name}`,
        sourceType: 'receipt',
        sourceId: receipt.id,
        lines,
      },
      { userId: ctx.userId, tx },
    );

    if (applications.length > 0) {
      await tx.insert(receiptApplications).values(
        applications.map((app) => ({
          receiptId: receipt.id,
          invoiceId: app.documentId,
          amountCents: app.amountCents,
          discountCents: app.discount,
          appliedAt: appliedAtFor(receiptDate),
        })),
      );
      for (const app of applications) {
        await adjustInvoice(tx, app.documentId, { paidCents: app.amountCents + app.discount });
      }
    }

    const [linked] = await tx
      .update(receipts)
      .set({ journalEntryId: posted.entryId })
      .where(eq(receipts.id, receipt.id))
      .returning();

    return { receipt: linked, entryId: posted.entryId, unappliedCents: unapplied };
  });
}

async function lockReceipt(tx: LedgerDb, receiptId: string): Promise<Receipt> {
  requireUuid('receiptId', receiptId);
  const [receipt] = await tx.select().from(receipts).where(eq(receipts.id, receiptId)).for('update');
  if (receipt === undefined) throw notFound('Receipt', receiptId);
  return receipt;
}

export interface ApplyCreditInput {
  /** Accounting date of the application. Defaults to today, or the latest document date if later. */
  date?: CalendarDate;
  applications: readonly { invoiceId: string; amountCents: number }[];
}

/**
 * Applies a customer's unapplied receipt to open invoices. No ledger entry: the
 * money already sits on this customer's AR as a credit, and applying it moves
 * it between two receivables of the same customer.
 */
export async function applyReceiptCredit(
  receiptId: string,
  input: ApplyCreditInput,
  ctx: ArapContext,
): Promise<Receipt> {
  const applications = normalizeApplications(
    input.applications.map((a) => ({ documentId: a.invoiceId, amountCents: a.amountCents })),
  );
  if (applications.length === 0) throw invalidInput('Choose at least one invoice to apply the credit to.');

  return runArap(ctx, async (tx) => {
    const receipt = await lockReceipt(tx, receiptId);
    if (receipt.journalEntryId === null || (await isReversed(tx, receipt.journalEntryId))) {
      throw invalidState(`Receipt ${receipt.receiptNo} is void.`);
    }
    if (receipt.customerId === null) throw invalidState(`Receipt ${receipt.receiptNo} has no customer.`);
    const total = sumCents(applications.map((a) => a.amountCents));
    const unapplied = receipt.amountCents - receipt.appliedCents;
    if (total > unapplied) {
      throw new ArapError(
        'over_application',
        `Receipt ${receipt.receiptNo} has ${unapplied} cents unapplied; ${total} cannot be applied.`,
      );
    }

    const locked = await lockInvoices(
      tx,
      applications.map((a) => a.documentId),
    );
    const latest = [...locked.values()].reduce(
      (max, inv) => (inv.invoiceDate > max ? inv.invoiceDate : max),
      receipt.receiptDate,
    );
    const date = input.date === undefined ? laterOf(today(), latest) : requireDate('date', input.date);
    assertOnOrAfter(date, receipt.receiptDate, 'The application');

    for (const app of applications) {
      const invoice = locked.get(app.documentId);
      if (invoice === undefined) throw notFound('Invoice', app.documentId);
      assertInvoiceApplicable(invoice, receipt.customerId, date, app.amountCents);
    }

    await tx.insert(receiptApplications).values(
      applications.map((app) => ({
        receiptId: receipt.id,
        invoiceId: app.documentId,
        amountCents: app.amountCents,
        discountCents: 0,
        appliedAt: appliedAtFor(date),
      })),
    );
    for (const app of applications) await adjustInvoice(tx, app.documentId, { paidCents: app.amountCents });

    const [updated] = await tx
      .update(receipts)
      .set({ appliedCents: receipt.appliedCents + total })
      .where(eq(receipts.id, receipt.id))
      .returning();
    return updated;
  });
}


export interface VoidReceiptOptions {
  date?: CalendarDate;
  reason?: string;
}

/**
 * Voids a receipt: reverses its entry, takes its payments back off the
 * invoices it settled, and, if it came from a bank match, returns that bank
 * line to the review queue. The application rows stay as history; point-in-time
 * aging ignores them from the void date on.
 */
export async function voidReceipt(receiptId: string, options: VoidReceiptOptions, ctx: ArapContext): Promise<Receipt> {
  return runArap(ctx, async (tx) => {
    const receipt = await lockReceipt(tx, receiptId);
    if (receipt.journalEntryId === null) throw invalidState(`Receipt ${receipt.receiptNo} was never posted.`);
    if (await isReversed(tx, receipt.journalEntryId)) throw invalidState(`Receipt ${receipt.receiptNo} is already void.`);

    const date = voidDate(options.date, receipt.receiptDate);
    const memo = `Void receipt ${receipt.receiptNo}${options.reason ? ` — ${options.reason.trim()}` : ''}`;
    for (const entryId of await liveEntriesOf(tx, 'receipt', receipt.id)) {
      await reverseEntry(entryId, { date, memo, userId: ctx.userId, tx, owner: 'receipt' });
    }

    const apps = await tx
      .select()
      .from(receiptApplications)
      .where(eq(receiptApplications.receiptId, receipt.id));
    await lockInvoices(
      tx,
      apps.map((a) => a.invoiceId),
    );
    for (const app of apps) {
      await adjustInvoice(tx, app.invoiceId, { paidCents: -(app.amountCents + app.discountCents) });
    }

    if (receipt.bankTransactionId !== null) {
      await releaseBankTransaction(tx, receipt.bankTransactionId, receipt.journalEntryId);
    }

    const [updated] = await tx
      .update(receipts)
      .set({ memo: appendNote(receipt.memo, `Void ${date}${options.reason ? `: ${options.reason.trim()}` : ''}`) })
      .where(eq(receipts.id, receipt.id))
      .returning();
    return updated;
  });
}

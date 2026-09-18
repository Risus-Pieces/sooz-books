/**
 * Credit memos: a reduction of what a customer owes, for returns, allowances or
 * a price correction.
 *
 * Issuing posts Dr contra revenue (4585 Returns & Allowances unless another
 * contra-revenue account is named) / Cr 1200 AR, on the customer and channel.
 * The credit then sits on the customer's AR until it is applied to invoices;
 * applying it moves no ledger money, only the sub-ledger.
 */

import { eq } from 'drizzle-orm';

import { type CreditMemo, creditMemoApplications, creditMemos, customers } from '@/db/schema';
import { type CalendarDate, today } from '@/lib/dates';
import { ACCOUNTS } from '@/lib/ledger/coa';
import { postJournalEntry } from '@/lib/ledger/post';
import { reverseEntry } from '@/lib/ledger/reverse';
import { sumCents } from '@/lib/money';

import {
  type ArapContext,
  type LedgerDb,
  accountByCode,
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
import { channelForCustomer } from './parties';
import {
  adjustInvoice,
  assertInvoiceApplicable,
  assertOnOrAfter,
  isReversed,
  lockInvoices,
  normalizeApplications,
} from './settlement';

export interface NewCreditMemoInput {
  customerId: string;
  memoDate: CalendarDate;
  reason: string;
  amountCents: number;
  /** A contra-revenue account. Defaults to 4585 Returns & Allowances. */
  accountId?: string;
  /** Defaults to the customer's channel. */
  channelId?: string | null;
  /** Apply straight away, dated the memo date. */
  applications?: readonly { invoiceId: string; amountCents: number }[];
}

export async function issueCreditMemo(input: NewCreditMemoInput, ctx: ArapContext): Promise<CreditMemo> {
  requireUuid('customerId', input.customerId);
  const memoDate = requireDate('memoDate', input.memoDate);
  const amount = requirePositiveCents('Credit amount', input.amountCents);
  const reason = optionalText(input.reason);
  if (reason === null) throw invalidInput('A credit memo needs a reason.');
  const applications = normalizeApplications(
    (input.applications ?? []).map((a) => ({ documentId: a.invoiceId, amountCents: a.amountCents })),
  );
  const applied = sumCents(applications.map((a) => a.amountCents));
  if (applied > amount) {
    throw new ArapError('over_application', `Applications total ${applied} cents, more than the ${amount} credit.`);
  }

  return runArap(ctx, async (tx) => {
    const [customer] = await tx.select().from(customers).where(eq(customers.id, input.customerId));
    if (customer === undefined) throw notFound('Customer', input.customerId);

    const account = input.accountId
      ? await accountById(tx, input.accountId)
      : await accountByCode(tx, ACCOUNTS.RETURNS_AND_ALLOWANCES);
    if (account.subtype !== 'contra_revenue') {
      throw invalidInput(`${account.code} ${account.name} is not a contra-revenue account; a credit memo reduces sales.`);
    }
    const channelId =
      input.channelId !== undefined && input.channelId !== null
        ? requireUuid('channelId', input.channelId)
        : ((await channelForCustomer(tx, customer))?.id ?? null);

    const locked = await lockInvoices(
      tx,
      applications.map((a) => a.documentId),
    );
    for (const app of applications) {
      const invoice = locked.get(app.documentId);
      if (invoice === undefined) throw notFound('Invoice', app.documentId);
      assertInvoiceApplicable(invoice, customer.id, memoDate, app.amountCents);
    }

    const memoNo = await nextDocumentNumber(tx, 'credit_memo');
    const [memo] = await tx
      .insert(creditMemos)
      .values({
        memoNo,
        customerId: customer.id,
        memoDate,
        reason,
        amountCents: amount,
        appliedCents: applied,
        revenueAccountId: account.id,
        createdBy: ctx.userId,
      })
      .returning();

    const posted = await postJournalEntry(
      {
        date: memoDate,
        memo: `Credit memo ${memoNo} to ${customer.name}: ${reason}`,
        sourceType: 'credit_memo',
        sourceId: memo.id,
        lines: [
          { accountId: account.id, debitCents: amount, customerId: customer.id, channelId, memo: reason },
          { accountCode: ACCOUNTS.AR, creditCents: amount, customerId: customer.id, channelId, memo: `Credit memo ${memoNo}` },
        ],
      },
      { userId: ctx.userId, tx },
    );

    if (applications.length > 0) {
      await tx.insert(creditMemoApplications).values(
        applications.map((app) => ({
          creditMemoId: memo.id,
          invoiceId: app.documentId,
          amountCents: app.amountCents,
          appliedAt: appliedAtFor(memoDate),
        })),
      );
      for (const app of applications) {
        await adjustInvoice(tx, app.documentId, { creditedCents: app.amountCents });
      }
    }

    const [linked] = await tx
      .update(creditMemos)
      .set({ journalEntryId: posted.entryId })
      .where(eq(creditMemos.id, memo.id))
      .returning();
    return linked;
  });
}

async function lockMemo(tx: LedgerDb, memoId: string): Promise<CreditMemo> {
  requireUuid('creditMemoId', memoId);
  const [memo] = await tx.select().from(creditMemos).where(eq(creditMemos.id, memoId)).for('update');
  if (memo === undefined) throw notFound('Credit memo', memoId);
  return memo;
}

/** Applies an issued credit memo's remaining credit to open invoices of the same customer. */
export async function applyCreditMemo(
  memoId: string,
  input: { date?: CalendarDate; applications: readonly { invoiceId: string; amountCents: number }[] },
  ctx: ArapContext,
): Promise<CreditMemo> {
  const applications = normalizeApplications(
    input.applications.map((a) => ({ documentId: a.invoiceId, amountCents: a.amountCents })),
  );
  if (applications.length === 0) throw invalidInput('Choose at least one invoice to apply the credit to.');

  return runArap(ctx, async (tx) => {
    const memo = await lockMemo(tx, memoId);
    if (memo.journalEntryId === null || (await isReversed(tx, memo.journalEntryId))) {
      throw invalidState(`Credit memo ${memo.memoNo} is void.`);
    }
    const total = sumCents(applications.map((a) => a.amountCents));
    const remaining = memo.amountCents - memo.appliedCents;
    if (total > remaining) {
      throw new ArapError(
        'over_application',
        `Credit memo ${memo.memoNo} has ${remaining} cents left; ${total} cannot be applied.`,
      );
    }

    const locked = await lockInvoices(
      tx,
      applications.map((a) => a.documentId),
    );
    const latest = [...locked.values()].reduce((max, inv) => laterOf(max, inv.invoiceDate), memo.memoDate);
    const date = input.date === undefined ? laterOf(today(), latest) : requireDate('date', input.date);
    assertOnOrAfter(date, memo.memoDate, 'The application');

    for (const app of applications) {
      const invoice = locked.get(app.documentId);
      if (invoice === undefined) throw notFound('Invoice', app.documentId);
      assertInvoiceApplicable(invoice, memo.customerId, date, app.amountCents);
    }

    await tx.insert(creditMemoApplications).values(
      applications.map((app) => ({
        creditMemoId: memo.id,
        invoiceId: app.documentId,
        amountCents: app.amountCents,
        appliedAt: appliedAtFor(date),
      })),
    );
    for (const app of applications) {
      await adjustInvoice(tx, app.documentId, { creditedCents: app.amountCents });
    }

    const [updated] = await tx
      .update(creditMemos)
      .set({ appliedCents: memo.appliedCents + total })
      .where(eq(creditMemos.id, memo.id))
      .returning();
    return updated;
  });
}

/** Voids an unapplied credit memo by reversing it. */
export async function voidCreditMemo(
  memoId: string,
  options: { date?: CalendarDate; reason?: string },
  ctx: ArapContext,
): Promise<CreditMemo> {
  return runArap(ctx, async (tx) => {
    const memo = await lockMemo(tx, memoId);
    if (memo.journalEntryId === null) throw invalidState(`Credit memo ${memo.memoNo} was never posted.`);
    if (await isReversed(tx, memo.journalEntryId)) throw invalidState(`Credit memo ${memo.memoNo} is already void.`);
    if (memo.appliedCents > 0) {
      throw invalidState(`Credit memo ${memo.memoNo} is applied to invoices; it cannot be voided.`);
    }
    const date = voidDate(options.date, memo.memoDate);
    await reverseEntry(memo.journalEntryId, {
      date,
      memo: `Void credit memo ${memo.memoNo}${options.reason ? ` — ${options.reason.trim()}` : ''}`,
      userId: ctx.userId,
      tx,
      owner: 'credit_memo',
    });
    const [updated] = await tx
      .update(creditMemos)
      .set({ reason: appendNote(memo.reason, `Void ${date}`) })
      .where(eq(creditMemos.id, memo.id))
      .returning();
    return updated;
  });
}

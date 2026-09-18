/**
 * Vendor credits: a vendor reducing what we owe — a return, a short shipment,
 * a rebate.
 *
 * Issuing posts Dr 2000 AP / Cr the account the credit reverses (usually the
 * original expense or inventory account), with the vendor on both lines. The
 * credit sits on AP until applied to bills; applying moves only the sub-ledger.
 */

import { eq } from 'drizzle-orm';

import { type VendorCredit, vendorCreditApplications, vendorCredits, vendors } from '@/db/schema';
import { type CalendarDate, today } from '@/lib/dates';
import { ACCOUNTS } from '@/lib/ledger/coa';
import { postJournalEntry } from '@/lib/ledger/post';
import { reverseEntry } from '@/lib/ledger/reverse';
import { sumCents } from '@/lib/money';

import {
  type ArapContext,
  type LedgerDb,
  accountById,
  appendNote,
  appliedAtFor,
  isMoneyAccount,
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
  lockBills,
  normalizeApplications,
} from './settlement';

export interface NewVendorCreditInput {
  vendorId: string;
  creditDate: CalendarDate;
  reason: string;
  amountCents: number;
  /** The account the credit reverses. Defaults to the vendor's default expense account. */
  accountId?: string;
  applications?: readonly { billId: string; amountCents: number }[];
}

export async function issueVendorCredit(input: NewVendorCreditInput, ctx: ArapContext): Promise<VendorCredit> {
  requireUuid('vendorId', input.vendorId);
  const creditDate = requireDate('creditDate', input.creditDate);
  const amount = requirePositiveCents('Credit amount', input.amountCents);
  const reason = optionalText(input.reason);
  if (reason === null) throw invalidInput('A vendor credit needs a reason.');
  const applications = normalizeApplications(
    (input.applications ?? []).map((a) => ({ documentId: a.billId, amountCents: a.amountCents })),
  );
  const applied = sumCents(applications.map((a) => a.amountCents));
  if (applied > amount) {
    throw new ArapError('over_application', `Applications total ${applied} cents, more than the ${amount} credit.`);
  }

  return runArap(ctx, async (tx) => {
    const [vendor] = await tx.select().from(vendors).where(eq(vendors.id, input.vendorId));
    if (vendor === undefined) throw notFound('Vendor', input.vendorId);
    const accountId = input.accountId ?? vendor.defaultExpenseAccountId;
    if (accountId === null) throw invalidInput(`${vendor.name} has no default account; choose the account this credit reverses.`);
    const account = await accountById(tx, accountId);
    if (account.isControl || isMoneyAccount(account)) {
      throw invalidInput(`${account.code} ${account.name} cannot carry a vendor credit; choose the account it reverses.`);
    }

    const locked = await lockBills(
      tx,
      applications.map((a) => a.documentId),
    );
    for (const app of applications) {
      const bill = locked.get(app.documentId);
      if (bill === undefined) throw notFound('Bill', app.documentId);
      assertBillApplicable(bill, vendor.id, creditDate, app.amountCents);
    }

    const creditNo = await nextDocumentNumber(tx, 'vendor_credit');
    const [credit] = await tx
      .insert(vendorCredits)
      .values({
        creditNo,
        vendorId: vendor.id,
        creditDate,
        reason,
        amountCents: amount,
        appliedCents: applied,
        accountId: account.id,
      })
      .returning();

    const posted = await postJournalEntry(
      {
        date: creditDate,
        memo: `Vendor credit ${creditNo} from ${vendor.name}: ${reason}`,
        sourceType: 'vendor_credit',
        sourceId: credit.id,
        lines: [
          { accountCode: ACCOUNTS.AP, debitCents: amount, vendorId: vendor.id, memo: `Vendor credit ${creditNo}` },
          { accountId: account.id, creditCents: amount, vendorId: vendor.id, memo: reason },
        ],
      },
      { userId: ctx.userId, tx },
    );

    if (applications.length > 0) {
      await tx.insert(vendorCreditApplications).values(
        applications.map((app) => ({
          creditId: credit.id,
          billId: app.documentId,
          amountCents: app.amountCents,
          appliedAt: appliedAtFor(creditDate),
        })),
      );
      for (const app of applications) await adjustBill(tx, app.documentId, { creditedCents: app.amountCents });
    }

    const [linked] = await tx
      .update(vendorCredits)
      .set({ journalEntryId: posted.entryId })
      .where(eq(vendorCredits.id, credit.id))
      .returning();
    return linked;
  });
}

async function lockCredit(tx: LedgerDb, creditId: string): Promise<VendorCredit> {
  requireUuid('vendorCreditId', creditId);
  const [credit] = await tx.select().from(vendorCredits).where(eq(vendorCredits.id, creditId)).for('update');
  if (credit === undefined) throw notFound('Vendor credit', creditId);
  return credit;
}

export async function applyVendorCredit(
  creditId: string,
  input: { date?: CalendarDate; applications: readonly { billId: string; amountCents: number }[] },
  ctx: ArapContext,
): Promise<VendorCredit> {
  const applications = normalizeApplications(
    input.applications.map((a) => ({ documentId: a.billId, amountCents: a.amountCents })),
  );
  if (applications.length === 0) throw invalidInput('Choose at least one bill to apply the credit to.');

  return runArap(ctx, async (tx) => {
    const credit = await lockCredit(tx, creditId);
    if (credit.journalEntryId === null || (await isReversed(tx, credit.journalEntryId))) {
      throw invalidState(`Vendor credit ${credit.creditNo} is void.`);
    }
    const total = sumCents(applications.map((a) => a.amountCents));
    const remaining = credit.amountCents - credit.appliedCents;
    if (total > remaining) {
      throw new ArapError(
        'over_application',
        `Vendor credit ${credit.creditNo} has ${remaining} cents left; ${total} cannot be applied.`,
      );
    }
    const locked = await lockBills(
      tx,
      applications.map((a) => a.documentId),
    );
    const latest = [...locked.values()].reduce((max, bill) => laterOf(max, bill.billDate), credit.creditDate);
    const date = input.date === undefined ? laterOf(today(), latest) : requireDate('date', input.date);
    assertOnOrAfter(date, credit.creditDate, 'The application');

    for (const app of applications) {
      const bill = locked.get(app.documentId);
      if (bill === undefined) throw notFound('Bill', app.documentId);
      assertBillApplicable(bill, credit.vendorId, date, app.amountCents);
    }

    await tx.insert(vendorCreditApplications).values(
      applications.map((app) => ({
        creditId: credit.id,
        billId: app.documentId,
        amountCents: app.amountCents,
        appliedAt: appliedAtFor(date),
      })),
    );
    for (const app of applications) await adjustBill(tx, app.documentId, { creditedCents: app.amountCents });

    const [updated] = await tx
      .update(vendorCredits)
      .set({ appliedCents: credit.appliedCents + total })
      .where(eq(vendorCredits.id, credit.id))
      .returning();
    return updated;
  });
}

export async function voidVendorCredit(
  creditId: string,
  options: { date?: CalendarDate; reason?: string },
  ctx: ArapContext,
): Promise<VendorCredit> {
  return runArap(ctx, async (tx) => {
    const credit = await lockCredit(tx, creditId);
    if (credit.journalEntryId === null) throw invalidState(`Vendor credit ${credit.creditNo} was never posted.`);
    if (await isReversed(tx, credit.journalEntryId)) throw invalidState(`Vendor credit ${credit.creditNo} is already void.`);
    if (credit.appliedCents > 0) throw invalidState(`Vendor credit ${credit.creditNo} is applied to bills; it cannot be voided.`);
    const date = voidDate(options.date, credit.creditDate);
    await reverseEntry(credit.journalEntryId, {
      date,
      memo: `Void vendor credit ${credit.creditNo}${options.reason ? ` — ${options.reason.trim()}` : ''}`,
      userId: ctx.userId,
      tx,
      owner: 'vendor_credit',
    });
    const [updated] = await tx
      .update(vendorCredits)
      .set({ reason: appendNote(credit.reason, `Void ${date}`) })
      .where(eq(vendorCredits.id, credit.id))
      .returning();
    return updated;
  });
}

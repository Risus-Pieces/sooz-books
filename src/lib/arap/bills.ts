/**
 * Vendor bills: draft, approve, void.
 *
 * A bill is entered as a draft and approved; approval posts
 *
 *     Dr expense or inventory (per line)
 *        Cr 2000 Accounts Payable        total
 *
 * with the vendor on every line. A line on an inventory account (1320 Raw
 * Ingredients, 1330 Packaging, …) is flagged `is_inventory` and capitalizes:
 * an ingredient purchase order lands on the balance sheet, and reaches COGS
 * only when the inventory module relieves it into a production run. Voiding
 * reverses the posting and is refused once anything has been paid or credited.
 */

import { and, asc, eq } from 'drizzle-orm';

import { db } from '@/db/client';
import { type Bill, type BillLine, type Vendor, billLines, bills, vendors } from '@/db/schema';
import { type CalendarDate, addDays } from '@/lib/dates';
import { ACCOUNTS } from '@/lib/ledger/coa';
import { type DraftLine, postJournalEntry } from '@/lib/ledger/post';
import { reverseEntry } from '@/lib/ledger/reverse';
import { sumCents } from '@/lib/money';
import { isUniqueViolation } from '@/lib/db-errors';

import {
  type AccountInfo,
  type ArapContext,
  type LedgerDb,
  accountsById,
  appendNote,
  extendCents,
  isMoneyAccount,
  optionalText,
  parseQuantity,
  requireDate,
  requireNonNegativeCents,
  requireUuid,
  runArap,
} from './common';
import { ArapError, invalidInput, invalidState, notFound } from './errors';
import { type VoidOptions, voidDate } from './invoices';

export interface BillLineInput {
  description: string;
  /** Defaults to the vendor's default expense account. */
  accountId?: string | null;
  /** The line amount. May be negative for a credit within the bill. Computed from quantity × unit cost when omitted. */
  amountCents?: number;
  quantity?: string | number | null;
  unitCostCents?: number | null;
  productId?: string | null;
  channelId?: string | null;
  /**
   * Whether the line capitalizes into inventory. Derived from the account (an
   * inventory account always capitalizes); passing true for any other account
   * is refused rather than silently expensed.
   */
  isInventory?: boolean;
}

export interface NewBillInput {
  vendorId: string;
  /** The vendor's own invoice number; unique per vendor. */
  billNo: string;
  billDate: CalendarDate;
  dueDate?: CalendarDate;
  termsDays?: number;
  poNumber?: string;
  memo?: string;
  source?: string;
  externalId?: string;
  lines: readonly BillLineInput[];
}

export interface BillWithLines {
  bill: Bill;
  lines: BillLine[];
}

function assertBillAccount(account: AccountInfo, lineNo: number, wantsInventory: boolean | undefined): boolean {
  if (account.isControl) {
    throw invalidInput(`Line ${lineNo}: ${account.code} ${account.name} is a control account and cannot be a bill line.`);
  }
  if (isMoneyAccount(account)) {
    throw invalidInput(
      `Line ${lineNo}: ${account.code} ${account.name} holds money; a bill line is what was bought, not how it was paid.`,
    );
  }
  if (!account.active) throw invalidInput(`Line ${lineNo}: ${account.code} ${account.name} is inactive.`);
  const capitalizes = account.subtype === 'inventory';
  if (wantsInventory === true && !capitalizes) {
    throw invalidInput(
      `Line ${lineNo} is marked as inventory but ${account.code} ${account.name} is not an inventory account.`,
    );
  }
  return capitalizes;
}

/** A bill's header figures and lines, validated, not yet written. */
export interface PreparedBill {
  vendor: Vendor;
  header: {
    billNo: string;
    vendorId: string;
    billDate: CalendarDate;
    dueDate: CalendarDate;
    termsDays: number;
    poNumber: string | null;
    memo: string | null;
    subtotalCents: number;
    totalCents: number;
  };
  lines: Omit<typeof billLines.$inferInsert, 'billId'>[];
}

/**
 * Validates a bill and prepares its lines without writing anything. Shared by
 * `createBill` and by editing a draft, so a draft is held to the same rules.
 */
export async function prepareBill(tx: LedgerDb, input: NewBillInput): Promise<PreparedBill> {
  requireUuid('vendorId', input.vendorId);
  const billNo = optionalText(input.billNo);
  if (billNo === null) throw invalidInput("A bill needs the vendor's invoice number.");
  const billDate = requireDate('billDate', input.billDate);
  if (input.lines.length === 0) throw invalidInput('A bill needs at least one line.');

  const [vendor] = await tx.select().from(vendors).where(eq(vendors.id, input.vendorId));
  if (vendor === undefined) throw notFound('Vendor', input.vendorId);

  const termsDays = input.termsDays ?? vendor.termsDays;
  if (!Number.isInteger(termsDays) || termsDays < 0) throw invalidInput('Terms must be a whole number of days.');
  const dueDate = input.dueDate === undefined ? addDays(billDate, termsDays) : requireDate('dueDate', input.dueDate);
  if (dueDate < billDate) throw invalidInput('The due date is before the bill date.');

  const accountIds = input.lines.map((line, index) => {
    const id = line.accountId ?? vendor.defaultExpenseAccountId;
    if (id === null) {
      throw invalidInput(`Line ${index + 1}: ${vendor.name} has no default account, so choose one for this line.`);
    }
    return requireUuid('accountId', id);
  });
  const accountMap = await accountsById(tx, accountIds);

  const prepared = input.lines.map((line, index) => {
    const lineNo = index + 1;
    const description = optionalText(line.description);
    if (description === null) throw invalidInput(`Line ${lineNo} needs a description.`);
    const account = accountMap.get(accountIds[index]);
    if (account === undefined) throw invalidInput(`Line ${lineNo}: account ${accountIds[index]} does not exist.`);
    const isInventory = assertBillAccount(account, lineNo, line.isInventory);

    const quantity =
      line.quantity === undefined || line.quantity === null ? null : parseQuantity(line.quantity);
    const unitCost =
      line.unitCostCents === undefined || line.unitCostCents === null
        ? null
        : requireNonNegativeCents(`Line ${lineNo} unit cost`, line.unitCostCents);
    let amount: number;
    if (line.amountCents !== undefined) {
      if (!Number.isSafeInteger(line.amountCents) || line.amountCents === 0) {
        throw invalidInput(`Line ${lineNo}: the amount must be a non-zero whole number of cents.`);
      }
      amount = line.amountCents;
    } else if (quantity !== null && unitCost !== null) {
      amount = extendCents(quantity.scaled, unitCost);
      if (amount === 0) throw invalidInput(`Line ${lineNo} comes to zero.`);
    } else {
      throw invalidInput(`Line ${lineNo} needs an amount, or a quantity and a unit cost.`);
    }

    return {
      lineNo,
      description,
      accountId: account.id,
      amountCents: amount,
      quantity: quantity?.text ?? null,
      unitCostCents: unitCost,
      productId: line.productId ? requireUuid('productId', line.productId) : null,
      channelId: line.channelId ? requireUuid('channelId', line.channelId) : null,
      isInventory,
    };
  });

  const total = sumCents(prepared.map((l) => l.amountCents));
  if (total <= 0) throw invalidInput('A bill must total more than zero; enter a vendor credit instead.');

  return {
    vendor,
    header: {
      billNo,
      vendorId: vendor.id,
      billDate,
      dueDate,
      termsDays,
      poNumber: optionalText(input.poNumber),
      memo: optionalText(input.memo),
      subtotalCents: total,
      totalCents: total,
    },
    lines: prepared,
  };
}

/** Enters a draft bill. Nothing posts until it is approved. */
export async function createBill(input: NewBillInput, ctx: ArapContext): Promise<BillWithLines> {
  return runArap(ctx, async (tx) => {
    const { vendor, header, lines: prepared } = await prepareBill(tx, input);
    const { billNo } = header;

    const [duplicate] = await tx
      .select({ id: bills.id })
      .from(bills)
      .where(and(eq(bills.vendorId, vendor.id), eq(bills.billNo, billNo)));
    if (duplicate !== undefined) {
      throw new ArapError('duplicate_document', `${vendor.name} bill ${billNo} is already entered.`);
    }

    let bill: Bill;
    try {
      [bill] = await tx
        .insert(bills)
        .values({
          ...header,
          status: 'draft',
          source: optionalText(input.source) ?? 'manual',
          externalId: optionalText(input.externalId),
          createdBy: ctx.userId,
        })
        .returning();
    } catch (error) {
      if (isUniqueViolation(error, 'bills_vendor_id_bill_no_key')) {
        throw new ArapError('duplicate_document', `${vendor.name} bill ${billNo} is already entered.`);
      }
      throw error;
    }

    const lines = await tx
      .insert(billLines)
      .values(prepared.map((l) => ({ ...l, billId: bill.id })))
      .returning();
    return { bill, lines: lines.sort((a, b) => a.lineNo - b.lineNo) };
  });
}

async function lockBill(tx: LedgerDb, billId: string): Promise<Bill> {
  requireUuid('billId', billId);
  const [bill] = await tx.select().from(bills).where(eq(bills.id, billId)).for('update');
  if (bill === undefined) throw notFound('Bill', billId);
  return bill;
}

/** The journal lines approving `bill` posts. Pure; exported for tests. */
export function billPostingLines(bill: Bill, lines: readonly BillLine[]): DraftLine[] {
  const vendorId = bill.vendorId;
  const posting: DraftLine[] = lines.map((line) => ({
    accountId: line.accountId,
    ...(line.amountCents > 0 ? { debitCents: line.amountCents } : { creditCents: -line.amountCents }),
    vendorId,
    channelId: line.channelId,
    productId: line.productId,
    memo: line.description,
  }));
  posting.push({
    accountCode: ACCOUNTS.AP,
    creditCents: bill.totalCents,
    vendorId,
    memo: `Bill ${bill.billNo}`,
  });
  return posting;
}

/**
 * Approves a draft bill: posts it and opens it for payment. Server Actions gate
 * this behind the approve capability; the engine records who did it through
 * the journal entry's `posted_by` and the audit log.
 */
export async function approveBill(billId: string, ctx: ArapContext): Promise<Bill> {
  return runArap(ctx, async (tx) => {
    const bill = await lockBill(tx, billId);
    if (bill.status !== 'draft') throw invalidState(`Bill ${bill.billNo} is ${bill.status}; only a draft can be approved.`);
    const lines = await tx.select().from(billLines).where(eq(billLines.billId, bill.id)).orderBy(asc(billLines.lineNo));
    if (lines.length === 0) throw invalidState(`Bill ${bill.billNo} has no lines.`);
    if (sumCents(lines.map((l) => l.amountCents)) !== bill.totalCents) {
      throw invalidState(`Bill ${bill.billNo} total does not agree with its lines.`);
    }

    const [vendor] = await tx.select({ name: vendors.name }).from(vendors).where(eq(vendors.id, bill.vendorId));
    const posted = await postJournalEntry(
      {
        date: bill.billDate,
        memo: `Bill ${bill.billNo} from ${vendor?.name ?? 'vendor'}`,
        sourceType: 'bill',
        sourceId: bill.id,
        lines: billPostingLines(bill, lines),
      },
      { userId: ctx.userId, tx },
    );

    const [updated] = await tx
      .update(bills)
      .set({ status: 'open', journalEntryId: posted.entryId })
      .where(and(eq(bills.id, bill.id), eq(bills.status, 'draft')))
      .returning();
    return updated;
  });
}

export async function createAndApproveBill(input: NewBillInput, ctx: ArapContext): Promise<Bill> {
  return runArap(ctx, async (tx) => {
    const { bill } = await createBill(input, { userId: ctx.userId, tx });
    return approveBill(bill.id, { userId: ctx.userId, tx });
  });
}

/** Voids a bill: a draft just becomes void; an approved bill is reversed. Refused once paid or credited. */
export async function voidBill(billId: string, options: VoidOptions, ctx: ArapContext): Promise<Bill> {
  return runArap(ctx, async (tx) => {
    const bill = await lockBill(tx, billId);
    if (bill.status === 'void') throw invalidState(`Bill ${bill.billNo} is already void.`);
    if (bill.paidCents + bill.creditedCents > 0) {
      throw invalidState(`Bill ${bill.billNo} has payments or credits applied; unapply them before voiding.`);
    }
    if (bill.journalEntryId !== null) {
      await reverseEntry(bill.journalEntryId, {
        date: voidDate(options.date, bill.billDate),
        memo: `Void bill ${bill.billNo}${options.reason ? ` — ${options.reason.trim()}` : ''}`,
        userId: ctx.userId,
        tx,
        owner: 'bill',
      });
    }
    const [updated] = await tx
      .update(bills)
      .set({ status: 'void', memo: options.reason ? appendNote(bill.memo, `Void: ${options.reason.trim()}`) : bill.memo })
      .where(eq(bills.id, bill.id))
      .returning();
    return updated;
  });
}

export async function getBill(billId: string, exec: LedgerDb = db): Promise<BillWithLines | null> {
  requireUuid('billId', billId);
  const [bill] = await exec.select().from(bills).where(eq(bills.id, billId));
  if (bill === undefined) return null;
  const lines = await exec.select().from(billLines).where(eq(billLines.billId, billId)).orderBy(asc(billLines.lineNo));
  return { bill, lines };
}

/**
 * Customer invoices: draft, issue, void.
 *
 * An invoice is written as a draft with its lines, then issued. Issuing posts
 *
 *     Dr 1200 Accounts Receivable        total
 *        Cr revenue (per line)           gross line amount
 *     Dr 4510 Trade Discounts            line and invoice discounts
 *        Cr 4060 Shipping Income         shipping charged
 *        Cr 2200 Sales Tax Payable       tax collected
 *
 * with the customer and channel on every line, so revenue is never booked net
 * and the channel P&L sees the discount beside the sale it reduced. Voiding
 * posts the reversal and is refused once any money, credit or deduction has
 * been applied — unwind those first.
 */

import { and, asc, eq } from 'drizzle-orm';

import { db } from '@/db/client';
import {
  type Invoice,
  type InvoiceLine,
  channels,
  customers,
  invoiceLines,
  invoices,
} from '@/db/schema';
import { type CalendarDate, addDays, today } from '@/lib/dates';
import { ACCOUNTS, CHANNEL_REVENUE_ACCOUNT } from '@/lib/ledger/coa';
import { type DraftLine, postJournalEntry } from '@/lib/ledger/post';
import { reverseEntry } from '@/lib/ledger/reverse';
import { sumCents } from '@/lib/money';

import {
  type AccountInfo,
  type ArapContext,
  type LedgerDb,
  accountByCode,
  accountsById,
  appendNote,
  extendCents,
  optionalText,
  parseQuantity,
  requireDate,
  requireNonNegativeCents,
  requireUuid,
  runArap,
} from './common';
import { ArapError, invalidInput, invalidState, notFound } from './errors';
import { nextDocumentNumber } from './numbering';
import { channelForCustomer, isChannelCode } from './parties';

export interface InvoiceLineInput {
  description: string;
  productId?: string | null;
  /** Units as an exact decimal (up to four places). Defaults to 1. */
  quantity?: string | number;
  unitPriceCents: number;
  /** Discount taken on this line, booked to 4510 rather than netted off revenue. */
  discountCents?: number;
  taxCents?: number;
  /** Overrides the channel's revenue account. Must be a revenue account, not contra revenue. */
  revenueAccountId?: string | null;
  /** Defaults to the invoice's channel. */
  channelId?: string | null;
}

export interface NewInvoiceInput {
  customerId: string;
  invoiceDate: CalendarDate;
  /** Defaults to the invoice date plus the terms. */
  dueDate?: CalendarDate;
  /** Defaults to the customer's terms. */
  termsDays?: number;
  /** Defaults to the customer's channel. */
  channelId?: string | null;
  poNumber?: string;
  memo?: string;
  /** An invoice-level discount on top of any line discounts. */
  discountCents?: number;
  shippingCents?: number;
  source?: string;
  externalId?: string;
  lines: readonly InvoiceLineInput[];
}

export interface InvoiceWithLines {
  invoice: Invoice;
  lines: InvoiceLine[];
}

async function channelCodeOf(tx: LedgerDb, channelId: string): Promise<string> {
  const [row] = await tx.select({ code: channels.code }).from(channels).where(eq(channels.id, channelId));
  if (row === undefined) throw invalidInput(`Channel ${channelId} does not exist.`);
  return row.code;
}

function assertRevenueAccount(account: AccountInfo, lineNo: number): void {
  if (account.type !== 'revenue' || account.subtype === 'contra_revenue') {
    throw invalidInput(
      `Line ${lineNo}: ${account.code} ${account.name} is not a revenue account. Discounts go in the discount field, not as a negative sale.`,
    );
  }
  if (!account.active) throw invalidInput(`Line ${lineNo}: ${account.code} ${account.name} is inactive.`);
}

/** An invoice's header figures and lines, validated and priced, not yet written. */
export interface PreparedInvoice {
  header: {
    customerId: string;
    channelId: string | null;
    invoiceDate: CalendarDate;
    dueDate: CalendarDate;
    termsDays: number;
    poNumber: string | null;
    memo: string | null;
    subtotalCents: number;
    discountCents: number;
    shippingCents: number;
    taxCents: number;
    totalCents: number;
  };
  lines: Omit<typeof invoiceLines.$inferInsert, 'invoiceId'>[];
}

/**
 * Validates an invoice and prices its lines without writing anything. Shared by
 * `createInvoice` and by editing a draft, so a draft is held to exactly the
 * rules a new invoice is.
 */
export async function prepareInvoice(tx: LedgerDb, input: NewInvoiceInput): Promise<PreparedInvoice> {
  requireUuid('customerId', input.customerId);
  const invoiceDate = requireDate('invoiceDate', input.invoiceDate);
  if (input.lines.length === 0) throw invalidInput('An invoice needs at least one line.');
  const headerDiscount = requireNonNegativeCents('Invoice discount', input.discountCents ?? 0);
  const shipping = requireNonNegativeCents('Shipping', input.shippingCents ?? 0);

  const [customer] = await tx.select().from(customers).where(eq(customers.id, input.customerId));
  if (customer === undefined) throw notFound('Customer', input.customerId);
  if (!customer.active) throw invalidState(`${customer.name} is inactive.`);

  const termsDays = input.termsDays ?? customer.termsDays;
  if (!Number.isInteger(termsDays) || termsDays < 0) throw invalidInput('Terms must be a whole number of days.');
  const dueDate =
    input.dueDate === undefined ? addDays(invoiceDate, termsDays) : requireDate('dueDate', input.dueDate);
  if (dueDate < invoiceDate) throw invalidInput('The due date is before the invoice date.');

  let invoiceChannelId: string | null;
  if (input.channelId !== undefined && input.channelId !== null) {
    invoiceChannelId = requireUuid('channelId', input.channelId);
    await channelCodeOf(tx, invoiceChannelId);
  } else {
    invoiceChannelId = (await channelForCustomer(tx, customer))?.id ?? null;
  }

  const explicitAccounts = await accountsById(
    tx,
    input.lines.flatMap((l) => (l.revenueAccountId ? [requireUuid('revenueAccountId', l.revenueAccountId)] : [])),
  );
  const channelCodes = new Map<string, string>();
  const defaultAccounts = new Map<string, AccountInfo>();

  const prepared = [];
  for (const [index, line] of input.lines.entries()) {
    const lineNo = index + 1;
    const description = optionalText(line.description);
    if (description === null) throw invalidInput(`Line ${lineNo} needs a description.`);
    const quantity = parseQuantity(line.quantity ?? '1');
    const unitPrice = requireNonNegativeCents(`Line ${lineNo} unit price`, line.unitPriceCents);
    const amount = extendCents(quantity.scaled, unitPrice);
    const discount = requireNonNegativeCents(`Line ${lineNo} discount`, line.discountCents ?? 0);
    const tax = requireNonNegativeCents(`Line ${lineNo} tax`, line.taxCents ?? 0);
    if (discount > amount) throw invalidInput(`Line ${lineNo}: the discount is larger than the line.`);

    const channelId = line.channelId ? requireUuid('channelId', line.channelId) : invoiceChannelId;

    let account: AccountInfo | undefined;
    if (line.revenueAccountId) {
      account = explicitAccounts.get(line.revenueAccountId);
      if (account === undefined) throw invalidInput(`Line ${lineNo}: account ${line.revenueAccountId} does not exist.`);
    } else {
      if (channelId === null) {
        throw invalidInput(
          `Line ${lineNo}: ${customer.name} has no sales channel, so name the revenue account for this line.`,
        );
      }
      let code = channelCodes.get(channelId);
      if (code === undefined) {
        code = await channelCodeOf(tx, channelId);
        channelCodes.set(channelId, code);
      }
      if (!isChannelCode(code)) {
        throw invalidInput(`Line ${lineNo}: channel ${code} has no default revenue account; name one for this line.`);
      }
      const revenueCode = CHANNEL_REVENUE_ACCOUNT[code];
      account = defaultAccounts.get(revenueCode);
      if (account === undefined) {
        account = await accountByCode(tx, revenueCode);
        defaultAccounts.set(revenueCode, account);
      }
    }
    assertRevenueAccount(account, lineNo);

    prepared.push({
      lineNo,
      description,
      productId: line.productId ? requireUuid('productId', line.productId) : null,
      quantity: quantity.text,
      unitPriceCents: unitPrice,
      amountCents: amount,
      discountCents: discount,
      taxCents: tax,
      revenueAccountId: account.id,
      channelId,
    });
  }

  const subtotal = sumCents(prepared.map((l) => l.amountCents));
  const lineDiscounts = sumCents(prepared.map((l) => l.discountCents));
  const tax = sumCents(prepared.map((l) => l.taxCents));
  if (headerDiscount > subtotal - lineDiscounts) {
    throw invalidInput('The invoice discount is larger than the discounted subtotal.');
  }
  const discount = lineDiscounts + headerDiscount;
  const total = subtotal - discount + shipping + tax;
  if (total <= 0) throw invalidInput('An invoice must total more than zero; issue a credit memo instead.');

  return {
    header: {
      customerId: customer.id,
      channelId: invoiceChannelId,
      invoiceDate,
      dueDate,
      termsDays,
      poNumber: optionalText(input.poNumber),
      memo: optionalText(input.memo),
      subtotalCents: subtotal,
      discountCents: discount,
      shippingCents: shipping,
      taxCents: tax,
      totalCents: total,
    },
    lines: prepared,
  };
}

/** Creates a draft invoice with its lines and its number. Nothing posts yet. */
export async function createInvoice(input: NewInvoiceInput, ctx: ArapContext): Promise<InvoiceWithLines> {
  return runArap(ctx, async (tx) => {
    const prepared = await prepareInvoice(tx, input);
    const invoiceNo = await nextDocumentNumber(tx, 'invoice');
    const [invoice] = await tx
      .insert(invoices)
      .values({
        invoiceNo,
        ...prepared.header,
        status: 'draft',
        source: optionalText(input.source) ?? 'manual',
        externalId: optionalText(input.externalId),
        createdBy: ctx.userId,
      })
      .returning();

    const lines = await tx
      .insert(invoiceLines)
      .values(prepared.lines.map((l) => ({ ...l, invoiceId: invoice.id })))
      .returning();

    return { invoice, lines: lines.sort((a, b) => a.lineNo - b.lineNo) };
  });
}

async function lockInvoice(tx: LedgerDb, invoiceId: string): Promise<Invoice> {
  requireUuid('invoiceId', invoiceId);
  const [invoice] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId)).for('update');
  if (invoice === undefined) throw notFound('Invoice', invoiceId);
  return invoice;
}

/** The journal lines that issuing `invoice` posts. Pure; exported for tests. */
export function invoicePostingLines(invoice: Invoice, lines: readonly InvoiceLine[]): DraftLine[] {
  const customerId = invoice.customerId;
  const posting: DraftLine[] = [
    {
      accountCode: ACCOUNTS.AR,
      debitCents: invoice.totalCents,
      customerId,
      channelId: invoice.channelId,
      memo: `Invoice ${invoice.invoiceNo}`,
    },
  ];

  for (const line of lines) {
    if (line.revenueAccountId === null) {
      throw invalidState(`Invoice ${invoice.invoiceNo} line ${line.lineNo} has no revenue account.`);
    }
    if (line.amountCents > 0) {
      posting.push({
        accountId: line.revenueAccountId,
        creditCents: line.amountCents,
        customerId,
        channelId: line.channelId,
        productId: line.productId,
        memo: line.description,
      });
    }
    if (line.discountCents > 0) {
      posting.push({
        accountCode: ACCOUNTS.TRADE_OFF_INVOICE,
        debitCents: line.discountCents,
        customerId,
        channelId: line.channelId,
        productId: line.productId,
        memo: `Discount: ${line.description}`,
      });
    }
  }

  const lineDiscounts = sumCents(lines.map((l) => l.discountCents));
  const headerDiscount = invoice.discountCents - lineDiscounts;
  if (headerDiscount > 0) {
    posting.push({
      accountCode: ACCOUNTS.TRADE_OFF_INVOICE,
      debitCents: headerDiscount,
      customerId,
      channelId: invoice.channelId,
      memo: `Invoice discount ${invoice.invoiceNo}`,
    });
  }
  if (invoice.shippingCents > 0) {
    posting.push({
      accountCode: ACCOUNTS.SHIPPING_INCOME,
      creditCents: invoice.shippingCents,
      customerId,
      channelId: invoice.channelId,
      memo: `Shipping ${invoice.invoiceNo}`,
    });
  }

  const taxByChannel = new Map<string | null, number>();
  for (const line of lines) {
    if (line.taxCents > 0) taxByChannel.set(line.channelId, (taxByChannel.get(line.channelId) ?? 0) + line.taxCents);
  }
  for (const [channelId, cents] of taxByChannel) {
    posting.push({
      accountCode: ACCOUNTS.SALES_TAX_PAYABLE,
      creditCents: cents,
      customerId,
      channelId,
      memo: `Sales tax ${invoice.invoiceNo}`,
    });
  }
  return posting;
}

/** Posts a draft invoice to the ledger and opens it for payment. */
export async function issueInvoice(invoiceId: string, ctx: ArapContext): Promise<Invoice> {
  return runArap(ctx, async (tx) => {
    const invoice = await lockInvoice(tx, invoiceId);
    if (invoice.status !== 'draft') {
      throw invalidState(`Invoice ${invoice.invoiceNo} is ${invoice.status}; only a draft can be issued.`);
    }
    const lines = await tx
      .select()
      .from(invoiceLines)
      .where(eq(invoiceLines.invoiceId, invoice.id))
      .orderBy(asc(invoiceLines.lineNo));
    if (lines.length === 0) throw invalidState(`Invoice ${invoice.invoiceNo} has no lines.`);

    // The header totals were computed from these lines; recheck before they reach the ledger.
    const expected =
      sumCents(lines.map((l) => l.amountCents)) -
      invoice.discountCents +
      invoice.shippingCents +
      sumCents(lines.map((l) => l.taxCents));
    if (expected !== invoice.totalCents) {
      throw invalidState(`Invoice ${invoice.invoiceNo} total does not agree with its lines.`);
    }

    const posted = await postJournalEntry(
      {
        date: invoice.invoiceDate,
        memo: `Invoice ${invoice.invoiceNo}`,
        sourceType: 'invoice',
        sourceId: invoice.id,
        lines: invoicePostingLines(invoice, lines),
      },
      { userId: ctx.userId, tx },
    );

    const [updated] = await tx
      .update(invoices)
      .set({ status: 'open', journalEntryId: posted.entryId })
      .where(and(eq(invoices.id, invoice.id), eq(invoices.status, 'draft')))
      .returning();
    return updated;
  });
}

/** Creates and issues in one transaction. */
export async function createAndIssueInvoice(input: NewInvoiceInput, ctx: ArapContext): Promise<Invoice> {
  return runArap(ctx, async (tx) => {
    const { invoice } = await createInvoice(input, { userId: ctx.userId, tx });
    return issueInvoice(invoice.id, { userId: ctx.userId, tx });
  });
}

export interface VoidOptions {
  /** Accounting date of the void. Defaults to today on the books' calendar, or the document date if later. */
  date?: CalendarDate;
  reason?: string;
}

/**
 * Voids an invoice. A draft simply becomes void and keeps its number; an issued
 * invoice is reversed. Refused once anything has been applied to it.
 */
export async function voidInvoice(invoiceId: string, options: VoidOptions, ctx: ArapContext): Promise<Invoice> {
  return runArap(ctx, async (tx) => {
    const invoice = await lockInvoice(tx, invoiceId);
    if (invoice.status === 'void') throw invalidState(`Invoice ${invoice.invoiceNo} is already void.`);

    const settled = invoice.paidCents + invoice.creditedCents + invoice.deductedCents;
    if (settled > 0) {
      throw new ArapError(
        'invalid_state',
        `Invoice ${invoice.invoiceNo} has payments, credits or deductions applied; unapply them before voiding.`,
      );
    }

    if (invoice.journalEntryId !== null) {
      const date = voidDate(options.date, invoice.invoiceDate);
      await reverseEntry(invoice.journalEntryId, {
        date,
        memo: `Void invoice ${invoice.invoiceNo}${options.reason ? ` — ${options.reason.trim()}` : ''}`,
        userId: ctx.userId,
        tx,
        owner: 'invoice',
      });
    }

    const [updated] = await tx
      .update(invoices)
      .set({
        status: 'void',
        memo: options.reason ? appendNote(invoice.memo, `Void: ${options.reason.trim()}`) : invoice.memo,
      })
      .where(eq(invoices.id, invoice.id))
      .returning();
    return updated;
  });
}

/** The date a void or reversal lands on: never before the document it undoes. */
export function voidDate(requested: CalendarDate | undefined, documentDate: CalendarDate): CalendarDate {
  if (requested !== undefined) {
    const date = requireDate('date', requested);
    if (date < documentDate) throw invalidInput(`A void cannot be dated before the document (${documentDate}).`);
    return date;
  }
  const now = today();
  return now < documentDate ? documentDate : now;
}

export async function getInvoice(invoiceId: string, exec: LedgerDb = db): Promise<InvoiceWithLines | null> {
  requireUuid('invoiceId', invoiceId);
  const [invoice] = await exec.select().from(invoices).where(eq(invoices.id, invoiceId));
  if (invoice === undefined) return null;
  const lines = await exec
    .select()
    .from(invoiceLines)
    .where(eq(invoiceLines.invoiceId, invoiceId))
    .orderBy(asc(invoiceLines.lineNo));
  return { invoice, lines };
}

/** Open balance: total less everything that has settled it. */
export function invoiceBalance(invoice: Pick<Invoice, 'totalCents' | 'paidCents' | 'creditedCents' | 'deductedCents'>): number {
  return invoice.totalCents - invoice.paidCents - invoice.creditedCents - invoice.deductedCents;
}

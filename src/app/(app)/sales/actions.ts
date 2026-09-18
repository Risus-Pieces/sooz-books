'use server';

/**
 * Every mutation the Sales screens can make. Each checks `ar.manage`, hands the
 * work to `@/lib/arap`, returns `{ ok: false, error }` rather than throwing at
 * the form, and revalidates the screens whose figures just moved.
 */

import { revalidatePath } from 'next/cache';

import type {
  ActionResult,
  ApplicationForm,
  CustomerForm,
  DocRef,
  InvoiceForm,
  ReceiptForm,
} from '@/components/arap/types';
import {
  type NewInvoiceInput,
  applyReceiptCredit,
  createCustomer,
  createInvoice,
  issueInvoice,
  recordReceipt,
  updateCustomer,
  updateDraftInvoice,
  voidInvoice,
  voidReceipt,
} from '@/lib/arap';
import { runArap } from '@/lib/arap/common';
import { requireCapability } from '@/lib/auth/session';

import { fail, ok, wholeCents } from './failure';

function refreshSales(...extra: string[]): void {
  for (const path of ['/sales', '/sales/invoices', '/sales/receipts', '/sales/aging', '/sales/customers', '/dashboard', '/ledger']) {
    revalidatePath(path);
  }
  for (const path of extra) revalidatePath(path);
}

function blankToUndefined(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

export async function saveCustomer(customerId: string | null, form: CustomerForm): Promise<ActionResult<{ id: string }>> {
  try {
    const user = await requireCapability('ar.manage');
    const creditLimitCents =
      form.creditLimitCents === null ? null : wholeCents('Credit limit', form.creditLimitCents);
    const pct = form.termsDiscountPct.trim() === '' ? '0' : form.termsDiscountPct.trim();

    if (customerId === null) {
      if ((Number(pct) > 0) !== form.termsDiscountDays > 0) {
        return fail(new Error('An early-payment discount needs both a percentage and a number of days, e.g. 2% in 10 days.'));
      }
      const created = await createCustomer(
        {
          name: form.name,
          displayName: form.displayName,
          customerType: form.customerType,
          channelId: form.channelId,
          email: form.email,
          phone: form.phone,
          termsDays: form.termsDays,
          termsDiscountPct: pct,
          termsDiscountDays: form.termsDiscountDays,
          creditLimitCents,
          notes: form.notes,
        },
        { userId: user.id },
      );
      refreshSales();
      return ok({ id: created.id });
    }

    const updated = await updateCustomer(
      customerId,
      {
        name: form.name,
        displayName: form.displayName,
        customerType: form.customerType,
        channelId: form.channelId,
        email: form.email,
        phone: form.phone,
        termsDays: form.termsDays,
        termsDiscountPct: pct,
        termsDiscountDays: form.termsDiscountDays,
        creditLimitCents,
        notes: form.notes,
        active: form.active,
      },
      { userId: user.id },
    );
    refreshSales();
    return ok({ id: updated.id });
  } catch (error) {
    return fail(error);
  }
}

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------

function toInvoiceInput(form: InvoiceForm): NewInvoiceInput {
  return {
    customerId: form.customerId,
    invoiceDate: form.invoiceDate,
    ...(form.dueDate === null || form.dueDate === '' ? {} : { dueDate: form.dueDate }),
    poNumber: blankToUndefined(form.poNumber),
    memo: blankToUndefined(form.memo),
    discountCents: wholeCents('Invoice discount', form.discountCents),
    shippingCents: wholeCents('Shipping', form.shippingCents),
    lines: form.lines.map((line, index) => ({
      description: line.description,
      productId: line.productId,
      quantity: line.quantity.trim() === '' ? '1' : line.quantity.trim().replace(/,/g, ''),
      unitPriceCents: wholeCents(`Line ${index + 1} price`, line.unitPriceCents),
      discountCents: wholeCents(`Line ${index + 1} discount`, line.discountCents),
      taxCents: wholeCents(`Line ${index + 1} tax`, line.taxCents),
      revenueAccountId: line.revenueAccountId,
    })),
  };
}

/**
 * Saves an invoice as a draft, or saves and issues it in one transaction. A
 * new invoice takes the next number whichever way it is saved; an issued
 * invoice is in the ledger and is never edited again.
 */
export async function saveInvoice(
  invoiceId: string | null,
  form: InvoiceForm,
  intent: 'draft' | 'issue',
): Promise<ActionResult<DocRef>> {
  try {
    const user = await requireCapability('ar.manage');
    const input = toInvoiceInput(form);
    const saved = await runArap({ userId: user.id }, async (tx) => {
      const ctx = { userId: user.id, tx };
      const invoice =
        invoiceId === null ? (await createInvoice(input, ctx)).invoice : await updateDraftInvoice(invoiceId, input, ctx);
      return intent === 'issue' ? issueInvoice(invoice.id, ctx) : invoice;
    });
    refreshSales(`/sales/invoices/${saved.id}`);
    return ok({ id: saved.id, docNo: saved.invoiceNo });
  } catch (error) {
    return fail(error);
  }
}

export async function issueInvoiceAction(invoiceId: string): Promise<ActionResult<DocRef>> {
  try {
    const user = await requireCapability('ar.manage');
    const invoice = await issueInvoice(invoiceId, { userId: user.id });
    refreshSales(`/sales/invoices/${invoice.id}`);
    return ok({ id: invoice.id, docNo: invoice.invoiceNo });
  } catch (error) {
    return fail(error);
  }
}

export async function voidInvoiceAction(
  invoiceId: string,
  date: string | null,
  reason: string,
): Promise<ActionResult<DocRef>> {
  try {
    const user = await requireCapability('ar.manage');
    const invoice = await voidInvoice(
      invoiceId,
      { ...(date ? { date } : {}), ...(reason.trim() === '' ? {} : { reason }) },
      { userId: user.id },
    );
    refreshSales(`/sales/invoices/${invoice.id}`);
    return ok({ id: invoice.id, docNo: invoice.invoiceNo });
  } catch (error) {
    return fail(error);
  }
}

// ---------------------------------------------------------------------------
// Receipts
// ---------------------------------------------------------------------------

function applications(apps: readonly ApplicationForm[]) {
  return apps
    .filter((app) => app.amountCents > 0 || app.discountCents > 0)
    .map((app) => ({
      invoiceId: app.docId,
      amountCents: wholeCents('Applied amount', app.amountCents),
      discountCents: wholeCents('Discount', app.discountCents),
    }));
}

export async function recordReceiptAction(form: ReceiptForm): Promise<ActionResult<DocRef>> {
  try {
    const user = await requireCapability('ar.manage');
    const result = await recordReceipt(
      {
        customerId: form.customerId,
        receiptDate: form.receiptDate,
        amountCents: wholeCents('Amount received', form.amountCents),
        method: form.method,
        reference: blankToUndefined(form.reference),
        memo: blankToUndefined(form.memo),
        ...(form.depositAccountId === null ? {} : { depositAccountId: form.depositAccountId }),
        applications: applications(form.applications),
      },
      { userId: user.id },
    );
    refreshSales(`/sales/receipts/${result.receipt.id}`);
    for (const app of form.applications) revalidatePath(`/sales/invoices/${app.docId}`);
    return ok({ id: result.receipt.id, docNo: result.receipt.receiptNo });
  } catch (error) {
    return fail(error);
  }
}

export async function applyReceiptCreditAction(
  receiptId: string,
  date: string | null,
  apps: readonly ApplicationForm[],
): Promise<ActionResult<DocRef>> {
  try {
    const user = await requireCapability('ar.manage');
    const receipt = await applyReceiptCredit(
      receiptId,
      {
        ...(date ? { date } : {}),
        applications: apps
          .filter((app) => app.amountCents > 0)
          .map((app) => ({ invoiceId: app.docId, amountCents: wholeCents('Applied amount', app.amountCents) })),
      },
      { userId: user.id },
    );
    refreshSales(`/sales/receipts/${receipt.id}`);
    for (const app of apps) revalidatePath(`/sales/invoices/${app.docId}`);
    return ok({ id: receipt.id, docNo: receipt.receiptNo });
  } catch (error) {
    return fail(error);
  }
}

export async function voidReceiptAction(
  receiptId: string,
  date: string | null,
  reason: string,
): Promise<ActionResult<DocRef>> {
  try {
    const user = await requireCapability('ar.manage');
    const receipt = await voidReceipt(
      receiptId,
      { ...(date ? { date } : {}), ...(reason.trim() === '' ? {} : { reason }) },
      { userId: user.id },
    );
    refreshSales(`/sales/receipts/${receipt.id}`);
    revalidatePath('/banking');
    return ok({ id: receipt.id, docNo: receipt.receiptNo });
  } catch (error) {
    return fail(error);
  }
}

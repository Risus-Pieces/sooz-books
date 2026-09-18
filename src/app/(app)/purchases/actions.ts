'use server';

/**
 * Every mutation the Purchases screens can make. Bills and vendors need
 * `ap.manage`; releasing money needs `ap.pay`. Each hands the work to
 * `@/lib/arap`, returns `{ ok: false, error }` rather than throwing at the form,
 * and revalidates the screens whose figures just moved.
 */

import { revalidatePath } from 'next/cache';

import type { ActionResult, ApplicationForm, BillForm, DocRef, PaymentForm, VendorForm } from '@/components/arap/types';
import {
  type NewBillInput,
  applyVendorPrepayment,
  approveBill,
  createBill,
  createVendor,
  payBills,
  updateDraftBill,
  updateVendor,
  voidBill,
  voidBillPayment,
} from '@/lib/arap';
import { runArap } from '@/lib/arap/common';
import { requireCapability } from '@/lib/auth/session';

import { fail, ok, wholeCents } from '../sales/failure';

function refreshPurchases(...extra: string[]): void {
  for (const path of [
    '/purchases',
    '/purchases/bills',
    '/purchases/payments',
    '/purchases/aging',
    '/purchases/vendors',
    '/purchases/1099',
    '/dashboard',
    '/ledger',
  ]) {
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
// Vendors
// ---------------------------------------------------------------------------

export async function saveVendor(vendorId: string | null, form: VendorForm): Promise<ActionResult<{ id: string }>> {
  try {
    const user = await requireCapability('ap.manage');
    const last4 = form.taxIdLast4.trim() === '' ? null : form.taxIdLast4.trim();
    const receivedAt = form.w9OnFile && form.w9ReceivedAt ? form.w9ReceivedAt : null;

    if (vendorId === null) {
      const created = await createVendor(
        {
          name: form.name,
          displayName: form.displayName,
          vendorType: form.vendorType,
          email: form.email,
          phone: form.phone,
          termsDays: form.termsDays,
          defaultExpenseAccountId: form.defaultExpenseAccountId,
          is1099: form.is1099,
          w9OnFile: form.w9OnFile,
          w9ReceivedAt: receivedAt,
          taxIdLast4: last4,
          legalName: blankToUndefined(form.legalName) ?? null,
          notes: form.notes,
        },
        { userId: user.id },
      );
      refreshPurchases();
      return ok({ id: created.id });
    }

    const updated = await updateVendor(
      vendorId,
      {
        name: form.name,
        displayName: form.displayName,
        vendorType: form.vendorType,
        email: form.email,
        phone: form.phone,
        termsDays: form.termsDays,
        defaultExpenseAccountId: form.defaultExpenseAccountId,
        is1099: form.is1099,
        w9OnFile: form.w9OnFile,
        w9ReceivedAt: receivedAt,
        taxIdLast4: last4,
        legalName: form.legalName,
        notes: form.notes,
        active: form.active,
      },
      { userId: user.id },
    );
    refreshPurchases();
    return ok({ id: updated.id });
  } catch (error) {
    return fail(error);
  }
}

// ---------------------------------------------------------------------------
// Bills
// ---------------------------------------------------------------------------

function toBillInput(form: BillForm): NewBillInput {
  return {
    vendorId: form.vendorId,
    billNo: form.billNo,
    billDate: form.billDate,
    ...(form.dueDate === null || form.dueDate === '' ? {} : { dueDate: form.dueDate }),
    poNumber: blankToUndefined(form.poNumber),
    memo: blankToUndefined(form.memo),
    lines: form.lines.map((line, index) => {
      const quantity = line.quantity.trim().replace(/,/g, '');
      // Quantity × unit cost is extended by the engine, exactly; a typed amount stands on its own.
      const extended = quantity !== '' && line.unitCostCents !== null;
      return {
        description: line.description,
        accountId: line.accountId,
        ...(extended
          ? { quantity, unitCostCents: wholeCents(`Line ${index + 1} unit cost`, line.unitCostCents ?? 0) }
          : { amountCents: wholeCents(`Line ${index + 1} amount`, line.amountCents) }),
        ...(line.isInventory ? { isInventory: true } : {}),
      };
    }),
  };
}

/** Saves a bill as a draft, or saves and approves it — which posts it — in one transaction. */
export async function saveBill(
  billId: string | null,
  form: BillForm,
  intent: 'draft' | 'approve',
): Promise<ActionResult<DocRef>> {
  try {
    const user = await requireCapability('ap.manage');
    const input = toBillInput(form);
    const saved = await runArap({ userId: user.id }, async (tx) => {
      const ctx = { userId: user.id, tx };
      const bill = billId === null ? (await createBill(input, ctx)).bill : await updateDraftBill(billId, input, ctx);
      return intent === 'approve' ? approveBill(bill.id, ctx) : bill;
    });
    refreshPurchases(`/purchases/bills/${saved.id}`);
    return ok({ id: saved.id, docNo: saved.billNo });
  } catch (error) {
    return fail(error);
  }
}

export async function approveBillAction(billId: string): Promise<ActionResult<DocRef>> {
  try {
    const user = await requireCapability('ap.manage');
    const bill = await approveBill(billId, { userId: user.id });
    refreshPurchases(`/purchases/bills/${bill.id}`);
    return ok({ id: bill.id, docNo: bill.billNo });
  } catch (error) {
    return fail(error);
  }
}

export async function voidBillAction(billId: string, date: string | null, reason: string): Promise<ActionResult<DocRef>> {
  try {
    const user = await requireCapability('ap.manage');
    const bill = await voidBill(
      billId,
      { ...(date ? { date } : {}), ...(reason.trim() === '' ? {} : { reason }) },
      { userId: user.id },
    );
    refreshPurchases(`/purchases/bills/${bill.id}`);
    return ok({ id: bill.id, docNo: bill.billNo });
  } catch (error) {
    return fail(error);
  }
}

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

export async function payBillsAction(form: PaymentForm): Promise<ActionResult<DocRef>> {
  try {
    const user = await requireCapability('ap.pay');
    const result = await payBills(
      {
        vendorId: form.vendorId,
        paymentDate: form.paymentDate,
        amountCents: wholeCents('Payment amount', form.amountCents),
        paymentAccountId: form.paymentAccountId,
        ...(form.method === null ? {} : { method: form.method }),
        reference: blankToUndefined(form.reference),
        memo: blankToUndefined(form.memo),
        applications: form.applications
          .filter((app) => app.amountCents > 0)
          .map((app) => ({ billId: app.docId, amountCents: wholeCents('Applied amount', app.amountCents) })),
      },
      { userId: user.id },
    );
    refreshPurchases(`/purchases/payments/${result.payment.id}`);
    for (const app of form.applications) revalidatePath(`/purchases/bills/${app.docId}`);
    return ok({ id: result.payment.id, docNo: result.payment.paymentNo });
  } catch (error) {
    return fail(error);
  }
}

export async function applyVendorPrepaymentAction(
  paymentId: string,
  date: string | null,
  apps: readonly ApplicationForm[],
): Promise<ActionResult<DocRef>> {
  try {
    const user = await requireCapability('ap.pay');
    const payment = await applyVendorPrepayment(
      paymentId,
      {
        ...(date ? { date } : {}),
        applications: apps
          .filter((app) => app.amountCents > 0)
          .map((app) => ({ billId: app.docId, amountCents: wholeCents('Applied amount', app.amountCents) })),
      },
      { userId: user.id },
    );
    refreshPurchases(`/purchases/payments/${payment.id}`);
    for (const app of apps) revalidatePath(`/purchases/bills/${app.docId}`);
    return ok({ id: payment.id, docNo: payment.paymentNo });
  } catch (error) {
    return fail(error);
  }
}

export async function voidBillPaymentAction(
  paymentId: string,
  date: string | null,
  reason: string,
): Promise<ActionResult<DocRef>> {
  try {
    const user = await requireCapability('ap.pay');
    const payment = await voidBillPayment(
      paymentId,
      { ...(date ? { date } : {}), ...(reason.trim() === '' ? {} : { reason }) },
      { userId: user.id },
    );
    refreshPurchases(`/purchases/payments/${payment.id}`);
    revalidatePath('/banking');
    return ok({ id: payment.id, docNo: payment.paymentNo });
  } catch (error) {
    return fail(error);
  }
}

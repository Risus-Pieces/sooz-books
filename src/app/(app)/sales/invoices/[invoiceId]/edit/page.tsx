import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import { InvoiceFormView } from "@/components/arap/invoice-form";
import { Badge } from "@/components/ui/badge";
import { can } from "@/lib/auth/roles";
import { requireUser } from "@/lib/auth/session";
import { addDays } from "@/lib/dates";

import { accountOptions } from "../../../../ledger/queries";
import {
  customerPicks,
  invoiceDetail,
  productPickOptions,
  revenueAccountsOf,
} from "../../../queries";

export const metadata: Metadata = { title: "Edit invoice" };

/** Only a draft can be edited; anything issued is in the ledger and goes back to its own page. */
export default async function EditInvoicePage({
  params,
}: {
  params: Promise<{ invoiceId: string }>;
}) {
  const [user, { invoiceId }] = await Promise.all([requireUser(), params]);
  const invoice = await invoiceDetail(invoiceId);
  if (invoice === null) notFound();
  if (invoice.status !== "draft") redirect(`/sales/invoices/${invoice.id}`);

  const [customers, accounts, products] = await Promise.all([
    customerPicks(),
    accountOptions(),
    productPickOptions(),
  ]);
  const lineDiscounts = invoice.lines.reduce(
    (sum, l) => sum + l.discountCents,
    0,
  );

  return (
    <InvoiceFormView
      toolbar={{
        title: `Edit ${invoice.invoiceNo}`,
        subtitle: <Badge tone="warning">Draft</Badge>,
        back: {
          href: `/sales/invoices/${invoice.id}`,
          label: "Invoice",
        },
        info: (
          <p>
            {invoice.customerName}&rsquo;s draft keeps its number however it
            changes.
          </p>
        ),
      }}
      invoiceId={invoice.id}
      customers={customers}
      revenueAccounts={revenueAccountsOf(accounts)}
      products={products}
      initial={{
        customerId: invoice.customerId,
        invoiceDate: invoice.invoiceDate,
        dueDate: invoice.dueDate,
        poNumber: invoice.poNumber ?? "",
        memo: invoice.memo ?? "",
        discountCents: invoice.discountCents - lineDiscounts,
        shippingCents: invoice.shippingCents,
        lines: invoice.lines.map((line) => ({
          description: line.description,
          productId: line.productId,
          quantity: line.quantity.includes(".")
            ? line.quantity.replace(/\.?0+$/, "")
            : line.quantity,
          unitPriceCents: line.unitPriceCents,
          discountCents: line.discountCents,
          taxCents: line.taxCents,
          revenueAccountId: line.revenueAccountId,
        })),
      }}
      dueDateOverridden={
        invoice.dueDate !== addDays(invoice.invoiceDate, invoice.termsDays)
      }
      canManage={can(user.role, "ar.manage")}
    />
  );
}

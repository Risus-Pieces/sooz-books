import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { InvoiceFormView } from '@/components/arap/invoice-form';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { can } from '@/lib/auth/roles';
import { requireUser } from '@/lib/auth/session';
import { addDays } from '@/lib/dates';

import { accountOptions } from '../../../../ledger/queries';
import { customerPicks, invoiceDetail, productPickOptions, revenueAccountsOf } from '../../../queries';

export const metadata: Metadata = { title: 'Edit invoice' };

/** Only a draft can be edited; anything issued is in the ledger and goes back to its own page. */
export default async function EditInvoicePage({ params }: { params: Promise<{ invoiceId: string }> }) {
  const [user, { invoiceId }] = await Promise.all([requireUser(), params]);
  const invoice = await invoiceDetail(invoiceId);
  if (invoice === null) notFound();
  if (invoice.status !== 'draft') redirect(`/sales/invoices/${invoice.id}`);

  const [customers, accounts, products] = await Promise.all([customerPicks(), accountOptions(), productPickOptions()]);
  const lineDiscounts = invoice.lines.reduce((sum, l) => sum + l.discountCents, 0);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        eyebrow="Sales"
        title={`Edit ${invoice.invoiceNo}`}
        description={`${invoice.customerName} · keeps its number however it changes.`}
        meta={<Badge tone="warning">Draft</Badge>}
        actions={
          <Button asChild variant="ghost" size="sm">
            <Link href={`/sales/invoices/${invoice.id}`}>Back to the invoice</Link>
          </Button>
        }
      />
      <InvoiceFormView
        invoiceId={invoice.id}
        invoiceNo={invoice.invoiceNo}
        customers={customers}
        revenueAccounts={revenueAccountsOf(accounts)}
        products={products}
        initial={{
          customerId: invoice.customerId,
          invoiceDate: invoice.invoiceDate,
          dueDate: invoice.dueDate,
          poNumber: invoice.poNumber ?? '',
          memo: invoice.memo ?? '',
          discountCents: invoice.discountCents - lineDiscounts,
          shippingCents: invoice.shippingCents,
          lines: invoice.lines.map((line) => ({
            description: line.description,
            productId: line.productId,
            quantity: line.quantity.includes('.') ? line.quantity.replace(/\.?0+$/, '') : line.quantity,
            unitPriceCents: line.unitPriceCents,
            discountCents: line.discountCents,
            taxCents: line.taxCents,
            revenueAccountId: line.revenueAccountId,
          })),
        }}
        dueDateOverridden={invoice.dueDate !== addDays(invoice.invoiceDate, invoice.termsDays)}
        canManage={can(user.role, 'ar.manage')}
      />
    </div>
  );
}

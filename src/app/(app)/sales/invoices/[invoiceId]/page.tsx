import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { HandCoins, Pencil } from 'lucide-react';

import { PostDocButton, PrintButton } from '@/components/arap/doc-buttons';
import { DocStatusBadge, Fact } from '@/components/arap/doc-status';
import { InvoiceSheet } from '@/components/arap/invoice-sheet';
import { VoidButton } from '@/components/arap/void-button';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatCents, Money } from '@/components/ui/money';
import { PageHeader } from '@/components/ui/page-header';
import { can } from '@/lib/auth/roles';
import { requireUser } from '@/lib/auth/session';
import { daysBetween, today } from '@/lib/dates';

import { issueInvoiceAction, voidInvoiceAction } from '../../actions';
import { companyName, invoiceDetail } from '../../queries';

export async function generateMetadata({ params }: { params: Promise<{ invoiceId: string }> }): Promise<Metadata> {
  const { invoiceId } = await params;
  const invoice = await invoiceDetail(invoiceId);
  return { title: invoice === null ? 'Invoice' : `${invoice.invoiceNo} · ${invoice.customerName}` };
}

const SETTLEMENT_LABEL = {
  receipt: 'Payment',
  credit_memo: 'Credit memo',
  deduction: 'Deduction',
  bill_payment: 'Payment',
  vendor_credit: 'Credit',
} as const;

export default async function InvoicePage({ params }: { params: Promise<{ invoiceId: string }> }) {
  const [user, { invoiceId }] = await Promise.all([requireUser(), params]);
  const [invoice, company] = await Promise.all([invoiceDetail(invoiceId), companyName()]);
  if (invoice === null) notFound();

  const canManage = can(user.role, 'ar.manage');
  const now = today();
  const open = invoice.status === 'open' || invoice.status === 'partial';
  const daysOverdue = open && invoice.dueDate < now ? daysBetween(invoice.dueDate, now) : 0;
  const settled = invoice.paidCents + invoice.creditedCents + invoice.deductedCents;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        eyebrow="Sales · Invoice"
        title={`${invoice.invoiceNo}`}
        description={`${invoice.customerName} · dated ${invoice.invoiceDate} · due ${invoice.dueDate}`}
        meta={<DocStatusBadge status={invoice.status} daysOverdue={daysOverdue} />}
        actions={
          <>
            <Button asChild variant="ghost" size="sm">
              <Link href="/sales/invoices">All invoices</Link>
            </Button>
            <PrintButton />
            {canManage && invoice.status === 'draft' ? (
              <>
                <Button asChild variant="secondary" size="sm">
                  <Link href={`/sales/invoices/${invoice.id}/edit`}>
                    <Pencil />
                    Edit draft
                  </Link>
                </Button>
                <VoidButton
                  label="Discard draft"
                  docNo={invoice.invoiceNo}
                  consequence="The draft becomes void and keeps its number, so the invoice sequence has no gap. Nothing was posted, so nothing is reversed."
                  minDate={invoice.invoiceDate}
                  defaultDate={now}
                  needsDate={false}
                  onVoid={voidInvoiceAction.bind(null, invoice.id)}
                />
                <PostDocButton
                  label="Issue invoice"
                  done="issued"
                  icon="send"
                  confirmText={`Issue ${invoice.invoiceNo}? It posts to Accounts Receivable and can only be corrected by voiding it.`}
                  onPost={issueInvoiceAction.bind(null, invoice.id)}
                />
              </>
            ) : null}
            {canManage && open ? (
              <Button asChild size="sm">
                <Link href={`/sales/receipts/new?customer=${invoice.customerId}&invoice=${invoice.id}`}>
                  <HandCoins />
                  Record payment
                </Link>
              </Button>
            ) : null}
            {canManage && open && settled === 0 ? (
              <VoidButton
                label="Void invoice"
                docNo={invoice.invoiceNo}
                consequence="Posts a reversal of the invoice on the date you choose. The number stays used."
                minDate={invoice.invoiceDate}
                defaultDate={now}
                needsDate
                onVoid={voidInvoiceAction.bind(null, invoice.id)}
              />
            ) : null}
          </>
        }
      />

      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <InvoiceSheet invoice={invoice} companyName={company} companyLocation="Houston, Texas" />

        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle>In the books</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid grid-cols-2 gap-3">
                <Fact label="Ledger">
                  {invoice.journalEntryId ? (
                    <Link href={`/ledger/${invoice.journalEntryId}`} className="num text-primary hover:underline">
                      Entry #{invoice.journalEntryNo}
                    </Link>
                  ) : (
                    <span className="text-muted-foreground">Not posted</span>
                  )}
                </Fact>
                <Fact label="Channel">{invoice.channelName ?? <span className="text-muted-foreground">None</span>}</Fact>
                <Fact label="Total">
                  <Money cents={invoice.totalCents} plain />
                </Fact>
                <Fact label="Open">
                  <Money cents={invoice.status === 'void' || invoice.status === 'draft' ? 0 : invoice.balanceCents} plain className="font-semibold" />
                </Fact>
              </dl>
              {invoice.status === 'draft' ? (
                <p className="mt-3 text-xs text-muted-foreground">
                  A draft counts for nothing until it is issued. Issuing posts Dr 1200 Accounts Receivable, Cr the sales
                  account for each line, with discounts to 4510.
                </p>
              ) : null}
              {invoice.status === 'void' && invoice.voidEntryId ? (
                <p className="mt-3 text-xs text-muted-foreground">
                  Reversed by{' '}
                  <Link href={`/ledger/${invoice.voidEntryId}`} className="text-primary hover:underline">
                    its void entry
                  </Link>
                  .
                </p>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Payments and credits</CardTitle>
            </CardHeader>
            {invoice.settlements.length === 0 ? (
              <p className="px-4 py-4 text-xs text-muted-foreground">
                {invoice.status === 'draft' || invoice.status === 'void'
                  ? 'None.'
                  : 'Nothing received yet. When the customer pays, record the receipt here, or match their deposit from the bank review.'}
              </p>
            ) : (
              <ul className="flex flex-col">
                {invoice.settlements.map((s) => (
                  <li key={`${s.kind}-${s.id}-${s.date}-${s.amountCents}`} className="rule-row flex items-baseline justify-between gap-3 px-4 py-2 text-sm">
                    <span className="min-w-0">
                      <span className="text-muted-foreground">{SETTLEMENT_LABEL[s.kind]}</span>{' '}
                      {s.kind === 'receipt' ? (
                        <Link href={`/sales/receipts/${s.id}`} className="num text-primary hover:underline">
                          {s.docNo}
                        </Link>
                      ) : (
                        <span className="num">{s.docNo}</span>
                      )}
                      <span className="num block text-2xs text-muted-foreground">
                        {s.date}
                        {s.discountCents > 0 ? ` · incl. ${formatCents(s.discountCents)} discount` : ''}
                        {s.void ? ' · void' : ''}
                      </span>
                    </span>
                    <Money cents={s.amountCents + s.discountCents} plain className={s.void ? 'text-muted-foreground line-through' : undefined} />
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

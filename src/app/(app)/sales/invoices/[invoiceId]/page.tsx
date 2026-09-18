import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { PostDocButton, PrintButton } from '@/components/arap/doc-buttons';
import { FlowCard, SettledBar } from '@/components/arap/doc-preview';
import { DocStatusBadge } from '@/components/arap/doc-status';
import { invoiceFlow } from '@/components/arap/flows';
import { InvoiceSheet } from '@/components/arap/invoice-sheet';
import { VoidButton } from '@/components/arap/void-button';
import { PageToolbar } from '@/components/shell/page-toolbar';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Glyph } from '@/components/ui/glyph';
import { Dot } from '@/components/ui/icon-badge';
import { GroupRow, InsetGroup, ListRow } from '@/components/ui/inset-group';
import { Money } from '@/components/ui/money';
import { ToolbarGroup, ToolbarLink } from '@/components/ui/toolbar';
import { can } from '@/lib/auth/roles';
import { requireUser } from '@/lib/auth/session';
import { daysBetween, today } from '@/lib/dates';
import { shortDate } from '@/lib/ui/format';

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
  const invoice = await invoiceDetail(invoiceId);
  if (invoice === null) notFound();
  const company = await companyName();

  const canManage = can(user.role, 'ar.manage');
  const now = today();
  const open = invoice.status === 'open' || invoice.status === 'partial';
  const daysOverdue = open && invoice.dueDate < now ? daysBetween(invoice.dueDate, now) : 0;
  const settled = invoice.paidCents + invoice.creditedCents + invoice.deductedCents;
  const draft = invoice.status === 'draft';

  return (
    <div className="flex flex-col gap-3.5 max-md:gap-3">
      <PageToolbar
        back={{ href: '/sales/invoices', label: 'Invoices' }}
        phoneTitleRow
        title={invoice.invoiceNo}
        subtitle={<DocStatusBadge status={invoice.status} daysOverdue={daysOverdue} />}
        info={
          draft ? (
            <p>
              A draft counts for nothing until it is issued. Issuing posts Dr 1200 Accounts Receivable, Cr the sales
              account for each line, with discounts to 4510. The print view makes a clean PDF for the buyer.
            </p>
          ) : (
            <p>
              The invoice as the customer sees it. Print it or save it as a PDF. An issued invoice is corrected only by
              voiding it, which posts a reversal and keeps the number.
            </p>
          )
        }
        actions={
          <>
            <ToolbarGroup>
              <PrintButton />
              {canManage && draft ? (
                <ToolbarLink href={`/sales/invoices/${invoice.id}/edit`} glyph="pencil" label="Edit draft" />
              ) : null}
            </ToolbarGroup>
            {canManage && draft ? (
              <ToolbarGroup>
                <VoidButton
                  label="Discard draft"
                  glyph="trash"
                  docNo={invoice.invoiceNo}
                  consequence="The draft becomes void and keeps its number, so the invoice sequence has no gap. Nothing was posted, so nothing is reversed."
                  minDate={invoice.invoiceDate}
                  defaultDate={now}
                  needsDate={false}
                  onVoid={voidInvoiceAction.bind(null, invoice.id)}
                />
              </ToolbarGroup>
            ) : null}
            {canManage && open && settled === 0 ? (
              <ToolbarGroup>
                <VoidButton
                  label="Void invoice"
                  docNo={invoice.invoiceNo}
                  consequence={`Posts a reversal of ${invoice.invoiceNo}, taking it out of Accounts Receivable and sales on the date you choose. The number stays used.`}
                  minDate={invoice.invoiceDate}
                  defaultDate={now}
                  needsDate
                  onVoid={voidInvoiceAction.bind(null, invoice.id)}
                />
              </ToolbarGroup>
            ) : null}
            {canManage && draft ? (
              <PostDocButton
                label="Issue invoice"
                done="issued"
                icon="send"
                confirmText={`Issue ${invoice.invoiceNo}? It posts to Accounts Receivable and can only be corrected by voiding it.`}
                onPost={issueInvoiceAction.bind(null, invoice.id)}
              />
            ) : null}
            {canManage && open ? (
              <Button asChild>
                <Link href={`/sales/receipts/new?customer=${invoice.customerId}&invoice=${invoice.id}`}>
                  <Glyph name="arrow-in" size={15} />
                  Record payment
                </Link>
              </Button>
            ) : null}
          </>
        }
      />

      <div className="grid grid-cols-1 items-start gap-3.5 max-md:gap-3 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="flex min-w-0 flex-col gap-3.5 max-md:gap-3">
          <InvoiceSheet invoice={invoice} companyName={company} companyLocation="Houston, Texas" />
          {invoice.status !== 'void' ? (
            <div className="mx-auto w-full max-w-[52rem]">
              <FlowCard flow={invoiceFlow(invoice)} caption={draft ? 'Issuing posts' : 'Posted'} />
            </div>
          ) : null}
        </div>

        <div className="flex flex-col gap-3.5 max-md:gap-3 xl:sticky xl:top-[72px]">
          {open ? (
            <Card className="flex flex-col gap-3 px-5 pt-4 pb-5 max-sm:px-4">
              <p className="text-sm font-semibold text-label2">Open</p>
              <Money cents={invoice.balanceCents} currency plain className="-mt-2 block text-3xl font-bold tracking-[-0.028em]" />
              <SettledBar settledCents={settled} openCents={invoice.balanceCents} />
            </Card>
          ) : null}

          <InsetGroup>
            <GroupRow label="Customer" href={`/sales/invoices?customer=${invoice.customerId}`}>
              <span className="truncate">{invoice.customerName}</span>
            </GroupRow>
            <GroupRow label="Channel">{invoice.channelName ?? 'None'}</GroupRow>
            {invoice.journalEntryId ? (
              <GroupRow label="Ledger" href={`/ledger/${invoice.journalEntryId}`}>
                <span className="num">Entry #{invoice.journalEntryNo}</span>
              </GroupRow>
            ) : (
              <GroupRow label="Ledger">Not posted</GroupRow>
            )}
            {invoice.status === 'void' && invoice.voidEntryId ? (
              <GroupRow label="Reversal" href={`/ledger/${invoice.voidEntryId}`}>
                Void entry
              </GroupRow>
            ) : null}
          </InsetGroup>

          {invoice.settlements.length > 0 ? (
            <InsetGroup header="Payments" separatorInset={34}>
              {invoice.settlements.map((s) => (
                <ListRow
                  key={`${s.kind}-${s.id}-${s.date}-${s.amountCents}`}
                  href={s.kind === 'receipt' ? `/sales/receipts/${s.id}` : undefined}
                  leading={<Dot tint={s.void ? 'quiet' : s.kind === 'deduction' ? 'orange' : 'green'} />}
                  title={
                    <>
                      {SETTLEMENT_LABEL[s.kind]} <span className="num font-normal text-label2">{s.docNo}</span>
                    </>
                  }
                  subtitle={
                    <>
                      {shortDate(s.date)}
                      {s.discountCents > 0 ? (
                        <>
                          {' · '}
                          <Money cents={s.discountCents} currency plain /> discount
                        </>
                      ) : null}
                      {s.void ? ' · void' : ''}
                    </>
                  }
                  trailing={<Money cents={s.amountCents + s.discountCents} currency plain className={s.void ? 'line-through opacity-60' : undefined} />}
                />
              ))}
            </InsetGroup>
          ) : null}
        </div>
      </div>
    </div>
  );
}

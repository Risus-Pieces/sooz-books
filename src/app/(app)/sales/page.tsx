import type { Metadata } from 'next';
import Link from 'next/link';

import { OwedCard, SectionLinks, agingSplit } from '@/components/arap/overview';
import { InvoiceRegister } from '@/components/arap/registers';
import { PageToolbar } from '@/components/shell/page-toolbar';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Money } from '@/components/ui/money';
import { ToolbarGroup, ToolbarLink } from '@/components/ui/toolbar';
import { arAging } from '@/lib/arap';
import { can } from '@/lib/auth/roles';
import { requireUser } from '@/lib/auth/session';
import { monthShort } from '@/lib/ui/format';

import { salesOverview } from './queries';

export const metadata: Metadata = { title: 'Sales' };

/**
 * Receivables at a glance: what customers owe as one bar split by age, what is late, what came in
 * this month. Every figure is read from issued invoices and posted receipts.
 */
export default async function SalesPage() {
  const user = await requireUser('/sales');
  const data = await salesOverview();
  const aging = await arAging(data.asOf);
  const canManage = can(user.role, 'ar.manage');
  const nothingYet = data.recentInvoices.length === 0;

  const actions = canManage ? (
    <ToolbarGroup>
      <ToolbarLink href="/sales/invoices/new" glyph="plus" label="New invoice" />
      <ToolbarLink href="/sales/receipts/new" glyph="arrow-in" label="Record receipt" />
    </ToolbarGroup>
  ) : undefined;

  const info = (
    <p>
      Invoices to restaurants, shops and distributors, and the money they send back. Square sales at markets post
      through Square Clearing and never need an invoice.
    </p>
  );

  const links = (
    <SectionLinks
      links={[
        { label: 'Invoices', href: '/sales/invoices', glyph: 'doc-text', tint: 'pink', value: data.openCount > 0 ? `${data.openCount} open` : undefined },
        ...(data.draftCount > 0 ? [{ label: 'Drafts', href: '/sales/invoices?status=draft', glyph: 'pencil' as const, tint: 'orange' as const, value: data.draftCount }] : []),
        { label: 'Customers', href: '/sales/customers', glyph: 'people', tint: 'blue', value: data.customerCount },
        { label: 'Receipts', href: '/sales/receipts', glyph: 'arrow-in', tint: 'green' },
        { label: 'Aging', href: '/sales/aging', glyph: 'hourglass', tint: 'purple' },
      ]}
    />
  );

  if (nothingYet) {
    return (
      <div className="flex flex-col gap-3.5 max-md:gap-3">
        <PageToolbar title="Sales" info={info} actions={actions} />
        <Card>
          <EmptyState
            glyph="doc-text"
            title="No invoices yet"
            description={
              data.customerCount === 0
                ? 'Add a customer with their terms, write the invoice, then print it or save it as a PDF. Issuing posts it to Accounts Receivable and the right sales channel.'
                : 'Issuing an invoice posts it to Accounts Receivable and the customer’s sales channel; the print view makes a clean PDF for the buyer.'
            }
            action={
              canManage ? (
                <Button asChild>
                  <Link href="/sales/invoices/new">New invoice</Link>
                </Button>
              ) : undefined
            }
            secondaryAction={
              canManage && data.customerCount === 0 ? (
                <Button asChild variant="secondary">
                  <Link href="/sales/customers?new=1">Add customer</Link>
                </Button>
              ) : undefined
            }
          />
        </Card>
        {links}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3.5 max-md:gap-3">
      <PageToolbar
        title="Sales"
        subtitle={
          <>
            {data.openCount} open · <Money cents={data.openCents} currency plain />
          </>
        }
        info={info}
        actions={actions}
      />

      <div className="grid gap-3.5 max-md:gap-3 lg:grid-cols-12">
        <OwedCard
          className="lg:col-span-8"
          title="Receivables"
          info={
            <p>
              What customers owe on issued invoices, less the deductions, receipts and credits not yet matched to an
              invoice, split by how late it is. This net figure ties to 1200 Accounts Receivable; the open invoices in
              the header are before that netting. Credits on account sit in Current. The bar opens the full aging.
            </p>
          }
          totalCents={aging.totals.total}
          split={agingSplit(aging.parties)}
          buckets={aging.totals}
          agingHref="/sales/aging"
          stats={[
            { label: 'Overdue', cents: data.overdueCents, note: data.overdueCount, tone: 'red', href: '/sales/invoices?status=overdue' },
            { label: 'Due soon', cents: data.dueSoonCents, note: data.dueSoonCount, tone: 'orange', href: '/sales/invoices?status=open' },
            { label: 'Received', cents: data.receivedThisMonthCents, note: monthShort(Number(data.asOf.slice(5, 7))), href: '/sales/receipts' },
            ...(data.unappliedCents > 0 ? [{ label: 'Credit', cents: data.unappliedCents, href: '/sales/receipts' }] : []),
          ]}
        />

        <div className="lg:col-span-4">{links}</div>

        <div className="min-w-0 lg:col-span-6">
          {data.overdueInvoices.length === 0 ? (
            <Card className="h-full">
              <EmptyState glyph="check-circle" title="Nobody is late" />
            </Card>
          ) : (
            <InvoiceRegister
              rows={data.overdueInvoices}
              grouped={false}
              header="Most overdue"
              headerAccessory={<SeeAll href="/sales/invoices?status=overdue" label="All overdue invoices" />}
            />
          )}
        </div>
        <div className="min-w-0 lg:col-span-6">
          <InvoiceRegister
            rows={data.recentInvoices}
            grouped={false}
            header="Recent"
            headerAccessory={<SeeAll href="/sales/invoices" label="All invoices" />}
          />
        </div>
      </div>
    </div>
  );
}

function SeeAll({ href, label }: { href: string; label: string }) {
  return (
    <Link href={href} aria-label={label} className="text-sm font-medium text-ink-blue hover:underline">
      See all
    </Link>
  );
}

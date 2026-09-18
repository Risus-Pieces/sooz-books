import type { Metadata } from 'next';
import Link from 'next/link';
import { FileText, HandCoins, Plus, Store } from 'lucide-react';

import { InvoiceRegister } from '@/components/arap/registers';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Money } from '@/components/ui/money';
import { PageHeader } from '@/components/ui/page-header';
import { StatTile } from '@/components/ui/stat-tile';
import { can } from '@/lib/auth/roles';
import { requireUser } from '@/lib/auth/session';
import { addDays } from '@/lib/dates';

import { salesOverview } from './queries';

export const metadata: Metadata = { title: 'Sales' };

/**
 * Receivables at a glance: what customers owe, what is late, what came in this
 * month. Every figure is read from issued invoices and posted receipts.
 */
export default async function SalesPage() {
  const [user, data] = await Promise.all([requireUser('/sales'), salesOverview()]);
  const canManage = can(user.role, 'ar.manage');
  const nothingYet = data.recentInvoices.length === 0;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        eyebrow="Sales"
        title="Receivables"
        description="Invoices to restaurants, shops and distributors, and the money they send back. Square sales at markets post through Square Clearing and never need an invoice."
        actions={
          canManage ? (
            <>
              <Button asChild variant="secondary" size="sm">
                <Link href="/sales/receipts/new">
                  <HandCoins />
                  Record receipt
                </Link>
              </Button>
              <Button asChild size="sm">
                <Link href="/sales/invoices/new">
                  <Plus />
                  New invoice
                </Link>
              </Button>
            </>
          ) : null
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Open receivables"
          value={<Money cents={data.openCents} currency plain />}
          hint={`${data.openCount} ${data.openCount === 1 ? 'invoice' : 'invoices'}`}
          footer={
            <Link href="/sales/aging" className="text-primary hover:underline">
              Aging by customer
            </Link>
          }
        />
        <StatTile
          label="Overdue"
          value={<Money cents={data.overdueCents} currency plain className={data.overdueCents > 0 ? 'text-negative' : undefined} />}
          hint={`${data.overdueCount} late`}
          footer={
            data.overdueCount === 0 ? (
              'Nothing past its due date.'
            ) : (
              <Link href="/sales/invoices?status=overdue" className="text-primary hover:underline">
                Chase the late ones
              </Link>
            )
          }
        />
        <StatTile
          label="Due in 14 days"
          value={<Money cents={data.dueSoonCents} currency plain />}
          hint={`${data.dueSoonCount} due`}
          footer={`Open invoices due by ${addDays(data.asOf, 14)}.`}
        />
        <StatTile
          label="Received this month"
          value={<Money cents={data.receivedThisMonthCents} currency plain />}
          footer={
            data.unappliedCents > 0 ? (
              <span>
                <Money cents={data.unappliedCents} plain /> unapplied credit on account
              </span>
            ) : data.draftCount > 0 ? (
              <Link href="/sales/invoices?status=draft" className="text-primary hover:underline">
                {data.draftCount} draft {data.draftCount === 1 ? 'invoice' : 'invoices'} not yet issued
              </Link>
            ) : (
              'Posted customer receipts.'
            )
          }
        />
      </div>

      {nothingYet ? (
        <Card>
          <EmptyState
            icon={<FileText />}
            title="No invoices yet"
            description={
              data.customerCount === 0
                ? 'Invoice a restaurant or wholesale buyer: add them as a customer with their terms (2/10 net 30 works), write the invoice, then print it or save it as a PDF for the buyer. Issuing posts it to Accounts Receivable and the right sales channel.'
                : 'Write the first invoice. Issuing posts it to Accounts Receivable and the customer’s sales channel; the print view makes a clean PDF for the buyer.'
            }
            action={
              canManage ? (
                <Button asChild size="sm">
                  <Link href="/sales/invoices/new">
                    <Plus />
                    New invoice
                  </Link>
                </Button>
              ) : undefined
            }
            secondaryAction={
              canManage && data.customerCount === 0 ? (
                <Button asChild variant="secondary" size="sm">
                  <Link href="/sales/customers?new=1">
                    <Store />
                    Add a customer
                  </Link>
                </Button>
              ) : undefined
            }
          />
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Most overdue</CardTitle>
              <Link href="/sales/invoices?status=overdue" className="text-xs text-primary hover:underline">
                All overdue
              </Link>
            </CardHeader>
            {data.overdueInvoices.length === 0 ? (
              <EmptyState title="Nobody is late" description="Every open invoice is inside its terms." />
            ) : (
              <InvoiceRegister rows={data.overdueInvoices} />
            )}
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Recent invoices</CardTitle>
              <Link href="/sales/invoices" className="text-xs text-primary hover:underline">
                All invoices
              </Link>
            </CardHeader>
            <InvoiceRegister rows={data.recentInvoices} />
          </Card>
        </div>
      )}
    </div>
  );
}

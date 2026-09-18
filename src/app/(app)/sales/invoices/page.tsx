import type { Metadata } from 'next';
import Link from 'next/link';
import { FileText, Plus } from 'lucide-react';

import { FilterTabs } from '@/components/arap/doc-status';
import { FilterBar, hrefWith } from '@/components/arap/filter-bar';
import { InvoiceRegister } from '@/components/arap/registers';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { can } from '@/lib/auth/roles';
import { requireUser } from '@/lib/auth/session';

import {
  INVOICE_STATUS_FILTERS,
  type InvoiceStatusFilter,
  customerPicks,
  invoiceList,
  invoiceStatusCounts,
  readInvoiceFilters,
} from '../queries';

export const metadata: Metadata = { title: 'Invoices' };

const STATUS_LABELS: Record<InvoiceStatusFilter, string> = {
  all: 'All',
  open: 'Open',
  overdue: 'Overdue',
  draft: 'Drafts',
  paid: 'Paid',
  void: 'Void',
};

const EMPTY_FOR: Record<InvoiceStatusFilter, string> = {
  all: 'No invoice matches these filters.',
  open: 'Nothing is owed on an issued invoice.',
  overdue: 'Nobody is late. Every open invoice is inside its terms.',
  draft: 'No drafts waiting to be issued.',
  paid: 'No invoice has been paid in full yet.',
  void: 'No invoice has been voided.',
};

type SearchParams = Record<string, string | string[] | undefined>;

export default async function InvoicesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const [user, raw] = await Promise.all([requireUser('/sales/invoices'), searchParams]);
  const filters = readInvoiceFilters(raw);
  const [rows, counts, customers] = await Promise.all([invoiceList(filters), invoiceStatusCounts(), customerPicks()]);
  const canManage = can(user.role, 'ar.manage');

  const current = { status: filters.status, customer: filters.customerId, from: filters.from, to: filters.to, q: filters.q };
  const customerName = customers.find((c) => c.id === filters.customerId)?.name;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        eyebrow="Sales"
        title="Invoices"
        description={customerName ? `Everything invoiced to ${customerName}.` : 'Every invoice, drafts to paid. Numbers run in order and are never reused.'}
        meta={<Badge tone="neutral">{counts.all} total</Badge>}
        actions={
          canManage ? (
            <Button asChild size="sm">
              <Link href={filters.customerId ? `/sales/invoices/new?customer=${filters.customerId}` : '/sales/invoices/new'}>
                <Plus />
                New invoice
              </Link>
            </Button>
          ) : null
        }
        tabs={
          <FilterTabs
            label="Invoice status"
            tabs={INVOICE_STATUS_FILTERS.map((status) => ({
              key: status,
              label: STATUS_LABELS[status],
              count: counts[status],
              href: hrefWith('/sales/invoices', current, 'status', status),
              active: filters.status === status,
            }))}
          />
        }
      />

      {counts.all === 0 ? (
        <Card>
          <EmptyState
            icon={<FileText />}
            title="No invoices yet"
            description="An invoice asks a customer to pay for what they took on terms: cases to a restaurant, a wholesale order to a shop. Issuing one posts it to Accounts Receivable and to that customer's sales channel, with discounts kept visible rather than netted off."
            action={
              canManage ? (
                <Button asChild size="sm">
                  <Link href="/sales/invoices/new">
                    <Plus />
                    Write the first invoice
                  </Link>
                </Button>
              ) : undefined
            }
          />
        </Card>
      ) : (
        <Card>
          <FilterBar
            action="/sales/invoices"
            status={filters.status}
            party={{
              name: 'customer',
              label: 'Customer',
              value: filters.customerId,
              options: customers.map((c) => ({ id: c.id, name: c.name })),
            }}
            from={filters.from}
            to={filters.to}
            q={filters.q}
          />
          {rows.length === 0 ? (
            <EmptyState title={EMPTY_FOR[filters.status]} description="Change the filters above to see more." />
          ) : (
            <InvoiceRegister rows={rows} />
          )}
        </Card>
      )}
    </div>
  );
}

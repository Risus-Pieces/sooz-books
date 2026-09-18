import type { Metadata } from 'next';
import Link from 'next/link';
import { Plus, Receipt } from 'lucide-react';

import { FilterTabs } from '@/components/arap/doc-status';
import { FilterBar, hrefWith } from '@/components/arap/filter-bar';
import { BillRegister } from '@/components/arap/registers';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { can } from '@/lib/auth/roles';
import { requireUser } from '@/lib/auth/session';

import { BILL_STATUS_FILTERS, type BillStatusFilter, billList, billStatusCounts, readBillFilters, vendorPicks } from '../queries';

export const metadata: Metadata = { title: 'Bills' };

const STATUS_LABELS: Record<BillStatusFilter, string> = {
  all: 'All',
  open: 'Open',
  overdue: 'Overdue',
  draft: 'Drafts',
  paid: 'Paid',
  void: 'Void',
};

const EMPTY_FOR: Record<BillStatusFilter, string> = {
  all: 'No bill matches these filters.',
  open: 'Nothing is owed on an approved bill.',
  overdue: 'No bill is past its due date.',
  draft: 'No drafts waiting for approval.',
  paid: 'No bill has been paid in full yet.',
  void: 'No bill has been voided.',
};

type SearchParams = Record<string, string | string[] | undefined>;

export default async function BillsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const [user, raw] = await Promise.all([requireUser('/purchases/bills'), searchParams]);
  const filters = readBillFilters(raw);
  const [rows, counts, vendors] = await Promise.all([billList(filters), billStatusCounts(), vendorPicks()]);
  const canManage = can(user.role, 'ap.manage');
  const current = { status: filters.status, vendor: filters.vendorId, from: filters.from, to: filters.to, q: filters.q };
  const vendorName = vendors.find((v) => v.id === filters.vendorId)?.name;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        eyebrow="Purchases"
        title="Bills"
        description={vendorName ? `Every bill from ${vendorName}.` : 'Vendor bills from draft to paid. The Inventory column is what capitalized rather than expensed.'}
        meta={<Badge tone="neutral">{counts.all} total</Badge>}
        actions={
          canManage ? (
            <Button asChild size="sm">
              <Link href={filters.vendorId ? `/purchases/bills/new?vendor=${filters.vendorId}` : '/purchases/bills/new'}>
                <Plus />
                New bill
              </Link>
            </Button>
          ) : null
        }
        tabs={
          <FilterTabs
            label="Bill status"
            tabs={BILL_STATUS_FILTERS.map((status) => ({
              key: status,
              label: STATUS_LABELS[status],
              count: counts[status],
              href: hrefWith('/purchases/bills', current, 'status', status),
              active: filters.status === status,
            }))}
          />
        }
      />

      {counts.all === 0 ? (
        <Card>
          <EmptyState
            icon={<Receipt />}
            title="No bills yet"
            description="A bill records what a vendor has invoiced you on terms, before you pay it. Ingredient and packaging lines capitalize to inventory (1320, 1330); everything else expenses. Approving posts the bill to Accounts Payable with the vendor on every line, so 1099 and vendor spend reports see it."
            action={
              canManage ? (
                <Button asChild size="sm">
                  <Link href="/purchases/bills/new">
                    <Plus />
                    Enter the first bill
                  </Link>
                </Button>
              ) : undefined
            }
          />
        </Card>
      ) : (
        <Card>
          <FilterBar
            action="/purchases/bills"
            status={filters.status}
            party={{ name: 'vendor', label: 'Vendor', value: filters.vendorId, options: vendors.map((v) => ({ id: v.id, name: v.name })) }}
            from={filters.from}
            to={filters.to}
            q={filters.q}
          />
          {rows.length === 0 ? (
            <EmptyState title={EMPTY_FOR[filters.status]} description="Change the filters above to see more." />
          ) : (
            <BillRegister rows={rows} />
          )}
        </Card>
      )}
    </div>
  );
}

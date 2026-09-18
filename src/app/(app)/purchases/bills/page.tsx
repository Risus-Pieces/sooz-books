import type { Metadata } from 'next';
import Link from 'next/link';

import { BillPreview } from '@/components/arap/doc-preview';
import { FilterTabs } from '@/components/arap/doc-status';
import { ActiveFilters, RegisterFilter, RegisterSearch, hrefWith } from '@/components/arap/filter-bar';
import { BillRegister } from '@/components/arap/registers';
import { PageToolbar } from '@/components/shell/page-toolbar';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { SplitView } from '@/components/ui/detail-pane';
import { EmptyState } from '@/components/ui/empty-state';
import { Money } from '@/components/ui/money';
import { ToolbarGroup, ToolbarLink } from '@/components/ui/toolbar';
import { can } from '@/lib/auth/roles';
import { requireUser } from '@/lib/auth/session';
import { daysBetween, today } from '@/lib/dates';

import { BILL_STATUS_FILTERS, type BillStatusFilter, billDetail, billList, billStatusCounts, readBillFilters, vendorPicks } from '../queries';

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
  all: 'No matches',
  open: 'Nothing owed',
  overdue: 'Nothing late',
  draft: 'No drafts',
  paid: 'Nothing paid yet',
  void: 'Nothing voided',
};

type SearchParams = Record<string, string | string[] | undefined>;

export default async function BillsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const [user, raw] = await Promise.all([requireUser('/purchases/bills'), searchParams]);
  const filters = readBillFilters(raw);
  const rows = await billList(filters);
  const counts = await billStatusCounts();
  const vendors = await vendorPicks();
  const canManage = can(user.role, 'ap.manage');
  const canPay = can(user.role, 'ap.pay');

  const current = { status: filters.status, vendor: filters.vendorId, from: filters.from, to: filters.to, q: filters.q };
  const filterProps = {
    action: '/purchases/bills',
    status: filters.status,
    party: { name: 'vendor', label: 'Vendor', value: filters.vendorId, options: vendors.map((v) => ({ id: v.id, name: v.name })) },
    from: filters.from,
    to: filters.to,
    q: filters.q,
  };
  const live = rows.filter((r) => r.status !== 'void');
  const openCents = rows.reduce((s, r) => s + r.balanceCents, 0);
  const totalCents = live.reduce((s, r) => s + r.totalCents, 0);
  const inventoryCents = live.reduce((s, r) => s + r.inventoryCents, 0);
  const selectedId = typeof raw.id === 'string' ? raw.id : '';
  const selectedRow = rows.find((r) => r.id === selectedId) ?? rows[0] ?? null;
  const selected = selectedRow === null ? null : await billDetail(selectedRow.id);
  const now = today();
  const selectedLate =
    selected !== null && (selected.status === 'open' || selected.status === 'partial') && selected.dueDate < now
      ? daysBetween(selected.dueDate, now)
      : 0;
  const footer = (
    <span className="flex flex-wrap justify-between gap-x-3">
      <span>
        {rows.length} {rows.length === 1 ? 'bill' : 'bills'} · <Money cents={totalCents} currency plain />
        {inventoryCents > 0 ? (
          <>
            {' · '}
            <Money cents={inventoryCents} currency plain /> inventory
          </>
        ) : null}
      </span>
      <span>
        <Money cents={openCents} currency plain /> open
      </span>
    </span>
  );

  return (
    <div className="flex flex-col gap-3.5 max-md:gap-3">
      <PageToolbar
        title="Bills"
        subtitle={<>{counts.all}</>}
        info={
          <p>
            Vendor bills from draft to paid. Approving posts a bill to Accounts Payable with the vendor on every line;
            ingredient and packaging lines capitalize to inventory (marked with a cube) instead of expense.
          </p>
        }
        search={counts.all > 0 ? <RegisterSearch {...filterProps} /> : undefined}
        actions={
          <>
            {counts.all > 0 ? <RegisterFilter {...filterProps} /> : null}
            {canManage || canPay ? (
              <ToolbarGroup>
                {canManage ? (
                  <ToolbarLink
                    href={filters.vendorId ? `/purchases/bills/new?vendor=${filters.vendorId}` : '/purchases/bills/new'}
                    glyph="plus"
                    label="New bill"
                  />
                ) : null}
                {canPay ? (
                  <ToolbarLink
                    href={filters.vendorId ? `/purchases/payments/new?vendor=${filters.vendorId}` : '/purchases/payments/new'}
                    glyph="dollar"
                    label="Pay bills"
                  />
                ) : null}
              </ToolbarGroup>
            ) : null}
          </>
        }
      />

      {counts.all === 0 ? (
        <Card>
          <EmptyState
            glyph="doc"
            title="No bills yet"
            description="A bill records what a vendor has invoiced you on terms, before you pay it. Ingredient and packaging lines capitalize to inventory (1320, 1330); everything else expenses."
            action={
              canManage ? (
                <Button asChild>
                  <Link href="/purchases/bills/new">New bill</Link>
                </Button>
              ) : undefined
            }
          />
        </Card>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
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
            <ActiveFilters {...filterProps} />
          </div>
          {rows.length === 0 ? (
            <Card>
              <EmptyState glyph="search" title={EMPTY_FOR[filters.status]} />
            </Card>
          ) : (
            <>
              <div className="max-lg:hidden">
                <SplitView
                  listWidth={380}
                  className="overflow-clip rounded-2xl bg-bg shadow-card"
                  list={
                    <div className="px-1.5 pb-2">
                      <BillRegister
                        rows={rows}
                        footer={footer}
                        select={{ selectedId: selectedRow?.id ?? null, href: (id) => hrefWith('/purchases/bills', current, 'id', id) }}
                      />
                    </div>
                  }
                  detail={selected === null ? null : <BillPreview bill={selected} daysOverdue={selectedLate} canPay={canPay} />}
                />
              </div>
              <BillRegister rows={rows} footer={footer} className="lg:hidden" />
            </>
          )}
        </>
      )}
    </div>
  );
}

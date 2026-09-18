import type { Metadata } from 'next';
import Link from 'next/link';

import { InvoicePreview } from '@/components/arap/doc-preview';
import { FilterTabs } from '@/components/arap/doc-status';
import { ActiveFilters, RegisterFilter, RegisterSearch, hrefWith } from '@/components/arap/filter-bar';
import { InvoiceRegister } from '@/components/arap/registers';
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

import {
  INVOICE_STATUS_FILTERS,
  type InvoiceStatusFilter,
  customerPicks,
  invoiceDetail,
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
  all: 'No matches',
  open: 'Nothing open',
  overdue: 'Nobody is late',
  draft: 'No drafts',
  paid: 'Nothing paid yet',
  void: 'Nothing voided',
};

type SearchParams = Record<string, string | string[] | undefined>;

export default async function InvoicesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const [user, raw] = await Promise.all([requireUser('/sales/invoices'), searchParams]);
  const filters = readInvoiceFilters(raw);
  const rows = await invoiceList(filters);
  const counts = await invoiceStatusCounts();
  const customers = await customerPicks();
  const canManage = can(user.role, 'ar.manage');

  const current = { status: filters.status, customer: filters.customerId, from: filters.from, to: filters.to, q: filters.q };
  const filterProps = {
    action: '/sales/invoices',
    status: filters.status,
    party: { name: 'customer', label: 'Customer', value: filters.customerId, options: customers.map((c) => ({ id: c.id, name: c.name })) },
    from: filters.from,
    to: filters.to,
    q: filters.q,
  };
  const newHref = filters.customerId ? `/sales/invoices/new?customer=${filters.customerId}` : '/sales/invoices/new';
  const openCents = rows.reduce((s, r) => s + r.balanceCents, 0);
  const totalCents = rows.filter((r) => r.status !== 'void').reduce((s, r) => s + r.totalCents, 0);
  const selectedId = typeof raw.id === 'string' ? raw.id : '';
  const selectedRow = rows.find((r) => r.id === selectedId) ?? rows[0] ?? null;
  const selected = selectedRow === null ? null : await invoiceDetail(selectedRow.id);
  const now = today();
  const selectedLate =
    selected !== null && (selected.status === 'open' || selected.status === 'partial') && selected.dueDate < now
      ? daysBetween(selected.dueDate, now)
      : 0;
  const footer = (
    <span className="flex flex-wrap justify-between gap-x-3">
      <span>
        {rows.length} {rows.length === 1 ? 'invoice' : 'invoices'} · <Money cents={totalCents} currency plain />
      </span>
      <span>
        <Money cents={openCents} currency plain /> open
      </span>
    </span>
  );

  return (
    <div className="flex flex-col gap-3.5 max-md:gap-3">
      <PageToolbar
        title="Invoices"
        subtitle={<>{counts.all}</>}
        info={
          <p>
            Every invoice, drafts to paid. Numbers run in order and are never reused. Issuing posts an invoice to
            Accounts Receivable and the customer&rsquo;s sales channel.
          </p>
        }
        search={counts.all > 0 ? <RegisterSearch {...filterProps} /> : undefined}
        actions={
          <>
            {counts.all > 0 ? <RegisterFilter {...filterProps} /> : null}
            {canManage ? (
              <ToolbarGroup>
                <ToolbarLink href={newHref} glyph="plus" label="New invoice" />
              </ToolbarGroup>
            ) : null}
          </>
        }
      />

      {counts.all === 0 ? (
        <Card>
          <EmptyState
            glyph="doc-text"
            title="No invoices yet"
            description="An invoice asks a customer to pay for what they took on terms. Issuing one posts it to Accounts Receivable and to that customer's sales channel, with discounts kept visible rather than netted off."
            action={
              canManage ? (
                <Button asChild>
                  <Link href="/sales/invoices/new">New invoice</Link>
                </Button>
              ) : undefined
            }
          />
        </Card>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
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
                      <InvoiceRegister
                        rows={rows}
                        footer={footer}
                        select={{ selectedId: selectedRow?.id ?? null, href: (id) => hrefWith('/sales/invoices', current, 'id', id) }}
                      />
                    </div>
                  }
                  detail={
                    selected === null ? null : <InvoicePreview invoice={selected} daysOverdue={selectedLate} canManage={canManage} />
                  }
                />
              </div>
              <InvoiceRegister rows={rows} footer={footer} className="lg:hidden" />
            </>
          )}
        </>
      )}
    </div>
  );
}

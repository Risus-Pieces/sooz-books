import type { Metadata } from 'next';
import Link from 'next/link';

import { OwedCard, SectionLinks, agingSplit } from '@/components/arap/overview';
import { BillRegister } from '@/components/arap/registers';
import { PageToolbar } from '@/components/shell/page-toolbar';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Money } from '@/components/ui/money';
import { ToolbarGroup, ToolbarLink } from '@/components/ui/toolbar';
import { apAging } from '@/lib/arap';
import { can } from '@/lib/auth/roles';
import { requireUser } from '@/lib/auth/session';

import { purchasesOverview } from './queries';

export const metadata: Metadata = { title: 'Purchases' };

/**
 * Payables at a glance: what Sooz owes as one bar split by age, what is due, drafts waiting on
 * approval, and how much of this year's buying went onto the balance sheet as inventory.
 */
export default async function PurchasesPage() {
  const user = await requireUser('/purchases');
  const data = await purchasesOverview();
  const aging = await apAging(data.asOf);
  const canManage = can(user.role, 'ap.manage');
  const canPay = can(user.role, 'ap.pay');
  const nothingYet = data.upcoming.length === 0 && data.drafts.length === 0;

  const actions =
    canManage || canPay ? (
      <ToolbarGroup>
        {canManage ? <ToolbarLink href="/purchases/bills/new" glyph="plus" label="New bill" /> : null}
        {canPay ? <ToolbarLink href="/purchases/payments/new" glyph="dollar" label="Pay bills" /> : null}
      </ToolbarGroup>
    ) : undefined;

  const info = (
    <p>
      Bills from ingredient, packaging and service vendors, and the payments that settle them. Most small purchases
      are paid by card or ACH and booked from the bank review instead; use bills for anything on terms.
    </p>
  );

  const links = (
    <SectionLinks
      links={[
        { label: 'Bills', href: '/purchases/bills', glyph: 'doc', tint: 'red', value: data.openCount > 0 ? `${data.openCount} open` : undefined },
        ...(data.draftCount > 0
          ? [{ label: 'Drafts', href: '/purchases/bills?status=draft', glyph: 'pencil' as const, tint: 'orange' as const, value: data.draftCount }]
          : []),
        { label: 'Vendors', href: '/purchases/vendors', glyph: 'people', tint: 'blue', value: data.vendorCount },
        { label: 'Payments', href: '/purchases/payments', glyph: 'arrow-out', tint: 'green' },
        { label: 'Aging', href: '/purchases/aging', glyph: 'hourglass', tint: 'purple' },
        { label: '1099', href: '/purchases/1099', glyph: 'doc-text', tint: 'gray', value: data.flagged1099Count > 0 ? data.flagged1099Count : undefined },
      ]}
    />
  );

  if (nothingYet) {
    return (
      <div className="flex flex-col gap-3.5 max-md:gap-3">
        <PageToolbar title="Purchases" info={info} actions={actions} />
        <Card>
          <EmptyState
            glyph="doc"
            title="No bills yet"
            description="Enter a bill when a vendor gives you terms: a co-packer run, a pallet of bottles, an ingredient order on net 30. Ingredient and packaging lines capitalize to inventory. Approving posts the bill to Accounts Payable; paying it clears it."
            action={
              canManage ? (
                <Button asChild>
                  <Link href="/purchases/bills/new">New bill</Link>
                </Button>
              ) : undefined
            }
          />
        </Card>
        {links}
      </div>
    );
  }

  const year = data.asOf.slice(0, 4);

  return (
    <div className="flex flex-col gap-3.5 max-md:gap-3">
      <PageToolbar
        title="Purchases"
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
          title="Payables"
          info={
            <p>
              What Sooz owes on approved bills, split by how late it is. Prepayments sit in Current. Inventory is what
              ingredient and packaging lines capitalized this year. The bar opens the full aging.
            </p>
          }
          totalCents={aging.totals.total}
          split={agingSplit(aging.parties)}
          buckets={aging.totals}
          agingHref="/purchases/aging"
          stats={[
            { label: 'Overdue', cents: data.overdueCents, note: data.overdueCount, tone: 'red', href: '/purchases/bills?status=overdue' },
            { label: 'Due soon', cents: data.dueSoonCents, note: data.dueSoonCount, tone: 'orange', href: '/purchases/bills?status=open' },
            { label: 'Inventory', cents: data.capitalizedThisYearCents, note: year, href: '/inventory' },
            ...(data.prepaidCents > 0 ? [{ label: 'Prepaid', cents: data.prepaidCents, href: '/purchases/payments' }] : []),
          ]}
        />

        <div className="lg:col-span-4">{links}</div>

        <div className="min-w-0 lg:col-span-6">
          {data.upcoming.length === 0 ? (
            <Card className="h-full">
              <EmptyState glyph="check-circle" title="Nothing owed" />
            </Card>
          ) : (
            <BillRegister
              rows={data.upcoming}
              grouped={false}
              header="Coming due"
              headerAccessory={<SeeAll href="/purchases/bills?status=open" label="All open bills" />}
            />
          )}
        </div>
        <div className="min-w-0 lg:col-span-6">
          {data.drafts.length === 0 ? (
            <Card className="h-full">
              <EmptyState glyph="check-circle" title="No drafts" />
            </Card>
          ) : (
            <BillRegister
              rows={data.drafts}
              grouped={false}
              header="Drafts"
              headerAccessory={<SeeAll href="/purchases/bills?status=draft" label="All draft bills" />}
            />
          )}
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

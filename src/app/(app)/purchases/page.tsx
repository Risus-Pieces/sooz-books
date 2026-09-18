import type { Metadata } from 'next';
import Link from 'next/link';
import { Banknote, Plus, Receipt } from 'lucide-react';

import { BillRegister } from '@/components/arap/registers';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Money } from '@/components/ui/money';
import { PageHeader } from '@/components/ui/page-header';
import { StatTile } from '@/components/ui/stat-tile';
import { can } from '@/lib/auth/roles';
import { requireUser } from '@/lib/auth/session';
import { addDays } from '@/lib/dates';

import { purchasesOverview } from './queries';

export const metadata: Metadata = { title: 'Purchases' };

/**
 * Payables at a glance: bills owed and when, drafts waiting on approval, and
 * how much of this year's buying went onto the balance sheet as inventory.
 */
export default async function PurchasesPage() {
  const [user, data] = await Promise.all([requireUser('/purchases'), purchasesOverview()]);
  const canManage = can(user.role, 'ap.manage');
  const canPay = can(user.role, 'ap.pay');
  const nothingYet = data.upcoming.length === 0 && data.drafts.length === 0;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        eyebrow="Purchases"
        title="Payables"
        description="Bills from ingredient, packaging and service vendors, and the payments that settle them. Most small purchases are paid by card or ACH and booked from the bank review instead; use bills for anything on terms."
        actions={
          <>
            {canPay ? (
              <Button asChild variant="secondary" size="sm">
                <Link href="/purchases/payments/new">
                  <Banknote />
                  Pay bills
                </Link>
              </Button>
            ) : null}
            {canManage ? (
              <Button asChild size="sm">
                <Link href="/purchases/bills/new">
                  <Plus />
                  New bill
                </Link>
              </Button>
            ) : null}
          </>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Open payables"
          value={<Money cents={data.openCents} currency plain />}
          hint={`${data.openCount} ${data.openCount === 1 ? 'bill' : 'bills'}`}
          footer={
            <Link href="/purchases/aging" className="text-primary hover:underline">
              Aging by vendor
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
              <Link href="/purchases/bills?status=overdue" className="text-primary hover:underline">
                See late bills
              </Link>
            )
          }
        />
        <StatTile
          label="Due in 14 days"
          value={<Money cents={data.dueSoonCents} currency plain />}
          hint={`${data.dueSoonCount} due`}
          footer={`Approved bills due by ${addDays(data.asOf, 14)}.`}
        />
        <StatTile
          label={`Capitalized in ${data.asOf.slice(0, 4)}`}
          value={<Money cents={data.capitalizedThisYearCents} currency plain />}
          footer="Ingredient and packaging lines on approved bills, held in inventory."
        />
      </div>

      {nothingYet ? (
        <Card>
          <EmptyState
            icon={<Receipt />}
            title="No bills yet"
            description="Enter a bill when a vendor gives you terms — a co-packer run, a pallet of bottles, an ingredient order on net 30. Mark ingredient and packaging lines Capitalize so they land in 1320 / 1330 inventory instead of expense. Approving a bill posts it to Accounts Payable; paying it clears it."
            action={
              canManage ? (
                <Button asChild size="sm">
                  <Link href="/purchases/bills/new">
                    <Plus />
                    Enter a bill
                  </Link>
                </Button>
              ) : undefined
            }
            secondaryAction={
              <Button asChild variant="secondary" size="sm">
                <Link href="/purchases/vendors">
                  Review the {data.vendorCount} vendors
                </Link>
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Coming due</CardTitle>
              <Link href="/purchases/bills?status=open" className="text-xs text-primary hover:underline">
                All open bills
              </Link>
            </CardHeader>
            {data.upcoming.length === 0 ? (
              <EmptyState title="Nothing owed" description="Every approved bill is paid." />
            ) : (
              <BillRegister rows={data.upcoming} />
            )}
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Drafts waiting for approval</CardTitle>
              <Link href="/purchases/bills?status=draft" className="text-xs text-primary hover:underline">
                All drafts
              </Link>
            </CardHeader>
            {data.drafts.length === 0 ? (
              <EmptyState title="No drafts" description="Every bill entered has been approved." />
            ) : (
              <BillRegister rows={data.drafts} />
            )}
          </Card>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        <Card className="p-3 text-xs text-muted-foreground">
          <p className="eyebrow mb-1">Vendors</p>
          <Link href="/purchases/vendors" className="text-sm font-medium text-foreground hover:underline">
            {data.vendorCount} active
          </Link>{' '}
          · {data.flagged1099Count} flagged for 1099
        </Card>
        <Card className="p-3 text-xs text-muted-foreground">
          <p className="eyebrow mb-1">Prepayments</p>
          <Money cents={data.prepaidCents} currency plain className="text-sm font-medium text-foreground" /> paid ahead of a bill
        </Card>
        <Card className="p-3 text-xs text-muted-foreground">
          <p className="eyebrow mb-1">1099 season</p>
          <Link href="/purchases/1099" className="text-sm font-medium text-primary hover:underline">
            Contractor payments by year
          </Link>
        </Card>
      </div>
    </div>
  );
}

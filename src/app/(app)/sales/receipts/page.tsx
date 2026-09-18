import type { Metadata } from 'next';
import Link from 'next/link';

import { ReceiptRegister } from '@/components/arap/registers';
import { PageToolbar } from '@/components/shell/page-toolbar';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Money } from '@/components/ui/money';
import { ToolbarGroup, ToolbarLink } from '@/components/ui/toolbar';
import { can } from '@/lib/auth/roles';
import { requireUser } from '@/lib/auth/session';

import { receiptList } from '../queries';

export const metadata: Metadata = { title: 'Receipts' };

export default async function ReceiptsPage() {
  const [user, rows] = await Promise.all([requireUser('/sales/receipts'), receiptList()]);
  const canManage = can(user.role, 'ar.manage');
  const live = rows.filter((r) => !r.void);
  const receivedCents = live.reduce((s, r) => s + r.amountCents, 0);
  const creditCents = live.reduce((s, r) => s + r.amountCents - r.appliedCents, 0);

  return (
    <div className="flex flex-col gap-3.5 max-md:gap-3">
      <PageToolbar
        title="Receipts"
        subtitle={
          rows.length > 0 ? (
            <>
              {rows.length} · <Money cents={receivedCents} currency plain />
            </>
          ) : undefined
        }
        info={
          <p>
            Money customers sent, and which invoices it paid. Anything not applied stays on their account as a credit.
            A deposit that shows up in the bank review can be matched to its invoice there instead.
          </p>
        }
        actions={
          canManage ? (
            <ToolbarGroup>
              <ToolbarLink href="/sales/receipts/new" glyph="plus" label="Record receipt" />
            </ToolbarGroup>
          ) : undefined
        }
      />
      {rows.length === 0 ? (
        <Card>
          <EmptyState
            glyph="arrow-in"
            title="No payments yet"
            description="When a restaurant or shop pays an invoice by check, ACH or wire, record it here and tick the invoices it covers; an early-payment discount their terms allow is taken automatically."
            action={
              canManage ? (
                <Button asChild>
                  <Link href="/sales/receipts/new">Record receipt</Link>
                </Button>
              ) : undefined
            }
          />
        </Card>
      ) : (
        <ReceiptRegister
          rows={rows}
          footer={
            creditCents > 0 ? (
              <>
                <Money cents={creditCents} currency plain /> held as customer credit
              </>
            ) : undefined
          }
        />
      )}
    </div>
  );
}

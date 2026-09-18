import type { Metadata } from 'next';
import Link from 'next/link';

import { PaymentRegister } from '@/components/arap/registers';
import { PageToolbar } from '@/components/shell/page-toolbar';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Money } from '@/components/ui/money';
import { ToolbarGroup, ToolbarLink } from '@/components/ui/toolbar';
import { can } from '@/lib/auth/roles';
import { requireUser } from '@/lib/auth/session';

import { paymentList } from '../queries';

export const metadata: Metadata = { title: 'Bill payments' };

export default async function PaymentsPage() {
  const [user, rows] = await Promise.all([requireUser('/purchases/payments'), paymentList()]);
  const canPay = can(user.role, 'ap.pay');
  const live = rows.filter((r) => !r.void);
  const paidCents = live.reduce((s, r) => s + r.amountCents, 0);
  const prepaidCents = live.reduce((s, r) => s + r.amountCents - r.appliedCents, 0);

  return (
    <div className="flex flex-col gap-3.5 max-md:gap-3">
      <PageToolbar
        title="Payments"
        subtitle={
          rows.length > 0 ? (
            <>
              {rows.length} · <Money cents={paidCents} currency plain />
            </>
          ) : undefined
        }
        info={
          <p>
            Money paid against vendor bills. One payment can settle several bills from the same vendor; money paid
            before the bill arrives is kept as a prepayment. Card payments are marked so they never count toward a
            1099-NEC.
          </p>
        }
        actions={
          canPay ? (
            <ToolbarGroup>
              <ToolbarLink href="/purchases/payments/new" glyph="plus" label="Pay bills" />
            </ToolbarGroup>
          ) : undefined
        }
      />
      {rows.length === 0 ? (
        <Card>
          <EmptyState
            glyph="dollar"
            title="No bill payments yet"
            description="Pay one bill or several from the same vendor in one payment, from a Relay account or a card. A matching withdrawal in the bank review can be linked to its bill there instead."
            action={
              canPay ? (
                <Button asChild>
                  <Link href="/purchases/payments/new">Pay bills</Link>
                </Button>
              ) : undefined
            }
          />
        </Card>
      ) : (
        <PaymentRegister
          rows={rows}
          footer={
            prepaidCents > 0 ? (
              <>
                <Money cents={prepaidCents} currency plain /> held as prepayment
              </>
            ) : undefined
          }
        />
      )}
    </div>
  );
}

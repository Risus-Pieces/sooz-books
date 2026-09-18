import type { Metadata } from 'next';
import Link from 'next/link';
import { Banknote } from 'lucide-react';

import { PaymentRegister } from '@/components/arap/registers';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { can } from '@/lib/auth/roles';
import { requireUser } from '@/lib/auth/session';

import { paymentList } from '../queries';

export const metadata: Metadata = { title: 'Bill payments' };

export default async function PaymentsPage() {
  const [user, rows] = await Promise.all([requireUser('/purchases/payments'), paymentList()]);
  const canPay = can(user.role, 'ap.pay');

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        eyebrow="Purchases"
        title="Bill payments"
        description="Money paid against vendor bills. Card payments are marked so they never count toward a 1099-NEC."
        meta={<Badge tone="neutral">{rows.length}</Badge>}
        actions={
          canPay ? (
            <Button asChild size="sm">
              <Link href="/purchases/payments/new">
                <Banknote />
                Pay bills
              </Link>
            </Button>
          ) : null
        }
      />
      <Card>
        {rows.length === 0 ? (
          <EmptyState
            icon={<Banknote />}
            title="No bill payments yet"
            description="Pay one bill or several from the same vendor in one payment, from a Relay account or a card. It clears the bills from payables; a payment made before the bill arrives is kept as a prepayment. A matching withdrawal in the bank review can be linked to its bill there instead."
            action={
              canPay ? (
                <Button asChild size="sm">
                  <Link href="/purchases/payments/new">Pay bills</Link>
                </Button>
              ) : undefined
            }
          />
        ) : (
          <PaymentRegister rows={rows} />
        )}
      </Card>
    </div>
  );
}

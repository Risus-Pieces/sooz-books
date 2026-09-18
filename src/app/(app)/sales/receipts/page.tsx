import type { Metadata } from 'next';
import Link from 'next/link';
import { HandCoins } from 'lucide-react';

import { ReceiptRegister } from '@/components/arap/registers';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { can } from '@/lib/auth/roles';
import { requireUser } from '@/lib/auth/session';

import { receiptList } from '../queries';

export const metadata: Metadata = { title: 'Receipts' };

export default async function ReceiptsPage() {
  const [user, rows] = await Promise.all([requireUser('/sales/receipts'), receiptList()]);
  const canManage = can(user.role, 'ar.manage');

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        eyebrow="Sales"
        title="Receipts"
        description="Money customers sent, and which invoices it paid. Anything not applied stays on their account as a credit."
        meta={<Badge tone="neutral">{rows.length}</Badge>}
        actions={
          canManage ? (
            <Button asChild size="sm">
              <Link href="/sales/receipts/new">
                <HandCoins />
                Record receipt
              </Link>
            </Button>
          ) : null
        }
      />
      <Card>
        {rows.length === 0 ? (
          <EmptyState
            icon={<HandCoins />}
            title="No customer payments recorded"
            description="When a restaurant or shop pays an invoice by check, ACH or wire, record it here and tick the invoices it covers — an early-payment discount their terms allow is taken automatically. A deposit that shows up in the bank review can be matched to its invoice there instead."
            action={
              canManage ? (
                <Button asChild size="sm">
                  <Link href="/sales/receipts/new">Record a receipt</Link>
                </Button>
              ) : undefined
            }
          />
        ) : (
          <ReceiptRegister rows={rows} />
        )}
      </Card>
    </div>
  );
}

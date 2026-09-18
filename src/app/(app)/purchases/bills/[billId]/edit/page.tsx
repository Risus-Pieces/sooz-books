import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { BillFormView } from '@/components/arap/bill-form';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { can } from '@/lib/auth/roles';
import { requireUser } from '@/lib/auth/session';
import { addDays } from '@/lib/dates';

import { accountOptions } from '../../../../ledger/queries';
import { billDetail, billLineAccounts, vendorPicks } from '../../../queries';

export const metadata: Metadata = { title: 'Edit bill' };

/** Only a draft can be edited; an approved bill is in the ledger and is corrected by voiding. */
export default async function EditBillPage({ params }: { params: Promise<{ billId: string }> }) {
  const [user, { billId }] = await Promise.all([requireUser(), params]);
  const bill = await billDetail(billId);
  if (bill === null) notFound();
  if (bill.status !== 'draft') redirect(`/purchases/bills/${bill.id}`);

  const [vendors, accounts] = await Promise.all([vendorPicks(), accountOptions()]);
  const canManage = can(user.role, 'ap.manage');

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        eyebrow="Purchases"
        title={`Edit ${bill.vendorName} ${bill.billNo}`}
        meta={<Badge tone="warning">Draft</Badge>}
        actions={
          <Button asChild variant="ghost" size="sm">
            <Link href={`/purchases/bills/${bill.id}`}>Back to the bill</Link>
          </Button>
        }
      />
      <BillFormView
        billId={bill.id}
        vendors={vendors}
        accounts={billLineAccounts(accounts)}
        initial={{
          vendorId: bill.vendorId,
          billNo: bill.billNo,
          billDate: bill.billDate,
          dueDate: bill.dueDate,
          poNumber: bill.poNumber ?? '',
          memo: bill.memo ?? '',
          lines: bill.lines.map((line) => ({
            description: line.description,
            accountId: line.accountId,
            quantity: line.quantity === null ? '' : line.quantity.includes('.') ? line.quantity.replace(/\.?0+$/, '') : line.quantity,
            unitCostCents: line.unitCostCents,
            amountCents: line.amountCents,
            isInventory: line.isInventory,
          })),
        }}
        dueDateOverridden={bill.dueDate !== addDays(bill.billDate, bill.termsDays)}
        canManage={canManage}
        canApprove={canManage}
      />
    </div>
  );
}

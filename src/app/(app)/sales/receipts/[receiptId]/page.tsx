import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { ApplyCredit } from '@/components/arap/apply-credit';
import { MoneyDocDetailView } from '@/components/arap/money-doc-detail';
import { VoidButton } from '@/components/arap/void-button';
import { Badge } from '@/components/ui/badge';
import { PageToolbar } from '@/components/shell/page-toolbar';
import { formatCents } from '@/components/ui/money';
import { ToolbarGroup } from '@/components/ui/toolbar';
import { can } from '@/lib/auth/roles';
import { requireUser } from '@/lib/auth/session';
import { today } from '@/lib/dates';

import { applyReceiptCreditAction, voidReceiptAction } from '../../actions';
import { openInvoicesFor, receiptDetail } from '../../queries';

export async function generateMetadata({ params }: { params: Promise<{ receiptId: string }> }): Promise<Metadata> {
  const { receiptId } = await params;
  const receipt = await receiptDetail(receiptId);
  return { title: receipt === null ? 'Receipt' : `Receipt ${receipt.docNo}` };
}

export default async function ReceiptPage({ params }: { params: Promise<{ receiptId: string }> }) {
  const [user, { receiptId }] = await Promise.all([requireUser(), params]);
  const receipt = await receiptDetail(receiptId);
  if (receipt === null) notFound();

  const canManage = can(user.role, 'ar.manage');
  const unapplied = receipt.amountCents - receipt.appliedCents;
  const openDocs =
    canManage && !receipt.void && unapplied > 0 && receipt.partyId !== null ? await openInvoicesFor(receipt.partyId) : [];

  return (
    <div className="flex flex-col gap-3.5 max-md:gap-3">
      <PageToolbar
        back={{ href: '/sales/receipts', label: 'Receipts' }}
        title={receipt.docNo}
        subtitle={receipt.void ? <Badge tone="neutral">Void</Badge> : undefined}
        info={
          <p>
            Money received from a customer and the invoices it paid. Money not applied stays on their account as a credit and can be applied below.
          </p>
        }
        actions={
          canManage && !receipt.void ? (
            <ToolbarGroup>
              <VoidButton
                label="Void receipt"
                docNo={receipt.docNo}
                consequence={
                  receipt.bankTransactionId
                    ? `Posts a reversal of the ${formatCents(receipt.amountCents, { currency: true })} receipt, reopens the invoices it paid, and returns its bank line to the review queue.`
                    : `Posts a reversal of the ${formatCents(receipt.amountCents, { currency: true })} receipt and reopens the invoices it paid.`
                }
                minDate={receipt.date}
                defaultDate={today()}
                needsDate
                onVoid={voidReceiptAction.bind(null, receipt.id)}
              />
            </ToolbarGroup>
          ) : undefined
        }
      />
      <MoneyDocDetailView doc={receipt} side="ar">
        {openDocs.length > 0 ? (
          <ApplyCredit
            side="ar"
            unappliedCents={unapplied}
            docs={openDocs}
            minDate={receipt.date}
            today={today()}
            onApply={applyReceiptCreditAction.bind(null, receipt.id)}
          />
        ) : null}
      </MoneyDocDetailView>
    </div>
  );
}

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

import { applyVendorPrepaymentAction, voidBillPaymentAction } from '../../actions';
import { openBillsFor, paymentDetail } from '../../queries';

export async function generateMetadata({ params }: { params: Promise<{ paymentId: string }> }): Promise<Metadata> {
  const { paymentId } = await params;
  const payment = await paymentDetail(paymentId);
  return { title: payment === null ? 'Payment' : `Payment ${payment.docNo}` };
}

export default async function PaymentPage({ params }: { params: Promise<{ paymentId: string }> }) {
  const [user, { paymentId }] = await Promise.all([requireUser(), params]);
  const payment = await paymentDetail(paymentId);
  if (payment === null) notFound();

  const canPay = can(user.role, 'ap.pay');
  const unapplied = payment.amountCents - payment.appliedCents;
  const openDocs =
    canPay && !payment.void && unapplied > 0 && payment.partyId !== null ? await openBillsFor(payment.partyId) : [];

  return (
    <div className="flex flex-col gap-3.5 max-md:gap-3">
      <PageToolbar
        back={{ href: '/purchases/payments', label: 'Payments' }}
        title={payment.docNo}
        subtitle={payment.void ? <Badge tone="neutral">Void</Badge> : undefined}
        info={
          <p>
            Money paid to a vendor and the bills it settled. Money not applied is a prepayment and can be applied below when the bill arrives.
          </p>
        }
        actions={
          canPay && !payment.void ? (
            <ToolbarGroup>
              <VoidButton
                label="Void payment"
                docNo={payment.docNo}
                consequence={
                  payment.bankTransactionId
                    ? `Posts a reversal of the ${formatCents(payment.amountCents, { currency: true })} payment, reopens the bills it paid, and returns its bank line to the review queue.`
                    : `Posts a reversal of the ${formatCents(payment.amountCents, { currency: true })} payment and reopens the bills it paid.`
                }
                minDate={payment.date}
                defaultDate={today()}
                needsDate
                onVoid={voidBillPaymentAction.bind(null, payment.id)}
              />
            </ToolbarGroup>
          ) : undefined
        }
      />
      <MoneyDocDetailView doc={payment} side="ap">
        {openDocs.length > 0 ? (
          <ApplyCredit
            side="ap"
            unappliedCents={unapplied}
            docs={openDocs}
            minDate={payment.date}
            today={today()}
            onApply={applyVendorPrepaymentAction.bind(null, payment.id)}
          />
        ) : null}
      </MoneyDocDetailView>
    </div>
  );
}

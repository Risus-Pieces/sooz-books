import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { ApplyCredit } from '@/components/arap/apply-credit';
import { MoneyDocDetailView } from '@/components/arap/money-doc-detail';
import { VoidButton } from '@/components/arap/void-button';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
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
    <div className="flex flex-col gap-5">
      <PageHeader
        eyebrow="Purchases · Payment"
        title={payment.docNo}
        description={`${payment.partyName ?? ''} · ${payment.date}`}
        meta={payment.void ? <Badge tone="neutral">Void</Badge> : null}
        actions={
          <>
            <Button asChild variant="ghost" size="sm">
              <Link href="/purchases/payments">All payments</Link>
            </Button>
            {canPay && !payment.void ? (
              <VoidButton
                label="Void payment"
                docNo={payment.docNo}
                consequence={
                  payment.bankTransactionId
                    ? 'Reverses the payment, reopens the bills it paid, and returns its bank line to the review queue.'
                    : 'Reverses the payment and reopens the bills it paid.'
                }
                minDate={payment.date}
                defaultDate={today()}
                needsDate
                onVoid={voidBillPaymentAction.bind(null, payment.id)}
              />
            ) : null}
          </>
        }
      />
      <MoneyDocDetailView doc={payment} side="ap" />
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
    </div>
  );
}

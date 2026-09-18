import type { Metadata } from 'next';
import Link from 'next/link';

import { MoneyDocForm } from '@/components/arap/money-doc-form';
import { termsLabel } from '@/components/arap/math';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { can } from '@/lib/auth/roles';
import { requireUser } from '@/lib/auth/session';
import { today } from '@/lib/dates';

import { customerPicks, depositAccountOptions, isUuid, openInvoicesFor } from '../../queries';

export const metadata: Metadata = { title: 'Record receipt' };

type SearchParams = Record<string, string | string[] | undefined>;

export default async function NewReceiptPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const [user, raw] = await Promise.all([requireUser('/sales/receipts/new'), searchParams]);
  const customerId = typeof raw.customer === 'string' && isUuid(raw.customer) ? raw.customer : null;
  const invoiceId = typeof raw.invoice === 'string' && isUuid(raw.invoice) ? raw.invoice : null;

  const [customers, accounts, openDocs] = await Promise.all([
    customerPicks(),
    depositAccountOptions(),
    customerId === null ? Promise.resolve([]) : openInvoicesFor(customerId),
  ]);
  const undeposited = accounts.find((a) => a.hint === '1040') ?? accounts[0] ?? null;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        eyebrow="Sales"
        title="Record receipt"
        description="Checks usually go to Undeposited Funds until the deposit clears; an ACH or wire can go straight to the bank account it landed in."
        actions={
          <Button asChild variant="ghost" size="sm">
            <Link href="/sales/receipts">Back to receipts</Link>
          </Button>
        }
      />
      <MoneyDocForm
        side="ar"
        parties={customers.map((c) => ({
          id: c.id,
          name: c.name,
          note: termsLabel(c.termsDays, c.termsDiscountPct, c.termsDiscountDays),
          termsDays: c.termsDays,
          termsDiscountPct: c.termsDiscountPct,
          termsDiscountDays: c.termsDiscountDays,
        }))}
        partyId={customers.some((c) => c.id === customerId) ? customerId : null}
        openDocs={openDocs}
        accounts={accounts}
        defaultAccountId={undeposited?.id ?? null}
        today={today()}
        preselect={invoiceId === null ? [] : [invoiceId]}
        canSubmit={can(user.role, 'ar.manage')}
      />
    </div>
  );
}

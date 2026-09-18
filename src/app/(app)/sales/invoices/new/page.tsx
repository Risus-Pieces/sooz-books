import type { Metadata } from 'next';
import Link from 'next/link';

import { InvoiceFormView } from '@/components/arap/invoice-form';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { can } from '@/lib/auth/roles';
import { requireUser } from '@/lib/auth/session';
import { today } from '@/lib/dates';

import { accountOptions } from '../../../ledger/queries';
import { customerPicks, isUuid, productPickOptions, revenueAccountsOf } from '../../queries';

export const metadata: Metadata = { title: 'New invoice' };

type SearchParams = Record<string, string | string[] | undefined>;

export default async function NewInvoicePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const [user, raw] = await Promise.all([requireUser('/sales/invoices/new'), searchParams]);
  const [customers, accounts, products] = await Promise.all([customerPicks(), accountOptions(), productPickOptions()]);
  const preset = typeof raw.customer === 'string' && isUuid(raw.customer) ? raw.customer : '';

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        eyebrow="Sales"
        title="New invoice"
        description="The number is assigned when you save. A draft stays out of the books until it is issued."
        actions={
          <Button asChild variant="ghost" size="sm">
            <Link href="/sales/invoices">Back to invoices</Link>
          </Button>
        }
      />
      <InvoiceFormView
        invoiceId={null}
        invoiceNo={null}
        customers={customers}
        revenueAccounts={revenueAccountsOf(accounts)}
        products={products}
        initial={{
          customerId: customers.some((c) => c.id === preset) ? preset : '',
          invoiceDate: today(),
          dueDate: null,
          poNumber: '',
          memo: '',
          discountCents: 0,
          shippingCents: 0,
          lines: [],
        }}
        dueDateOverridden={false}
        canManage={can(user.role, 'ar.manage')}
      />
    </div>
  );
}

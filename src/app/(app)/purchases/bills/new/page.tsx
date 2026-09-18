import type { Metadata } from 'next';

import { BillFormView } from '@/components/arap/bill-form';
import { can } from '@/lib/auth/roles';
import { requireUser } from '@/lib/auth/session';
import { today } from '@/lib/dates';

import { accountOptions } from '../../../ledger/queries';
import { isUuid } from '../../../sales/queries';
import { billLineAccounts, vendorPicks } from '../../queries';

export const metadata: Metadata = { title: 'New bill' };

type SearchParams = Record<string, string | string[] | undefined>;

export default async function NewBillPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const [user, raw] = await Promise.all([requireUser('/purchases/bills/new'), searchParams]);
  const [vendors, accounts] = await Promise.all([vendorPicks(), accountOptions()]);
  const preset = typeof raw.vendor === 'string' && isUuid(raw.vendor) ? raw.vendor : '';
  const vendor = vendors.find((v) => v.id === preset);
  const canManage = can(user.role, 'ap.manage');

  return (
    <BillFormView
        toolbar={{
          title: 'New bill',
          back: { href: '/purchases/bills', label: 'Bills' },
          info: <p>Copy the vendor&rsquo;s invoice: their number, date and lines. Save a draft to check later, or approve it to post.</p>,
        }}
        billId={null}
        vendors={vendors}
        accounts={billLineAccounts(accounts)}
        initial={{
          vendorId: vendor?.id ?? '',
          billNo: '',
          billDate: today(),
          dueDate: null,
          poNumber: '',
          memo: '',
          lines: vendor
            ? [{ description: '', accountId: vendor.defaultExpenseAccountId, quantity: '', unitCostCents: null, amountCents: 0, isInventory: false }]
            : [],
        }}
        dueDateOverridden={false}
        canManage={canManage}
        canApprove={canManage}
      />
  );
}

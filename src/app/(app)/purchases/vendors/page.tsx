import type { Metadata } from 'next';

import { VendorTable } from '@/components/arap/vendor-table';
import { can } from '@/lib/auth/roles';
import { requireUser } from '@/lib/auth/session';

import { accountOptions } from '../../ledger/queries';
import { billLineAccounts, vendorRows } from '../queries';

export const metadata: Metadata = { title: 'Vendors' };

type SearchParams = Record<string, string | string[] | undefined>;

export default async function VendorsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const [user, raw] = await Promise.all([requireUser('/purchases/vendors'), searchParams]);
  const rows = await vendorRows();
  const accounts = await accountOptions();

  return (
    <VendorTable
      rows={rows}
      accounts={billLineAccounts(accounts)}
      canManage={can(user.role, 'ap.manage')}
      openNew={raw.new === '1'}
    />
  );
}

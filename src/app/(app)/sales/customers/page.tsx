import type { Metadata } from 'next';

import { CustomerTable } from '@/components/arap/customer-table';
import { can } from '@/lib/auth/roles';
import { requireUser } from '@/lib/auth/session';

import { customerRows, salesChannelOptions } from '../queries';

export const metadata: Metadata = { title: 'Customers' };

type SearchParams = Record<string, string | string[] | undefined>;

export default async function CustomersPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const [user, raw] = await Promise.all([requireUser('/sales/customers'), searchParams]);
  const rows = await customerRows();
  const channels = await salesChannelOptions();

  return <CustomerTable rows={rows} channels={channels} canManage={can(user.role, 'ar.manage')} openNew={raw.new === '1'} />;
}

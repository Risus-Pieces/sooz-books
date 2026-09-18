import type { Metadata } from 'next';

import { CustomerTable } from '@/components/arap/customer-table';
import { Badge } from '@/components/ui/badge';
import { PageHeader } from '@/components/ui/page-header';
import { can } from '@/lib/auth/roles';
import { requireUser } from '@/lib/auth/session';

import { customerRows, salesChannelOptions } from '../queries';

export const metadata: Metadata = { title: 'Customers' };

type SearchParams = Record<string, string | string[] | undefined>;

export default async function CustomersPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const [user, raw] = await Promise.all([requireUser('/sales/customers'), searchParams]);
  const [rows, channels] = await Promise.all([customerRows(), salesChannelOptions()]);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        eyebrow="Sales"
        title="Customers"
        description="Who you invoice, on what terms, and which sales channel their revenue reports under."
        meta={<Badge tone="neutral">{rows.filter((r) => r.active).length} active</Badge>}
      />
      <CustomerTable rows={rows} channels={channels} canManage={can(user.role, 'ar.manage')} openNew={raw.new === '1'} />
    </div>
  );
}

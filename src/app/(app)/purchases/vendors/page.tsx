import type { Metadata } from 'next';

import { VendorTable } from '@/components/arap/vendor-table';
import { Badge } from '@/components/ui/badge';
import { PageHeader } from '@/components/ui/page-header';
import { can } from '@/lib/auth/roles';
import { requireUser } from '@/lib/auth/session';

import { accountOptions } from '../../ledger/queries';
import { billLineAccounts, vendorRows } from '../queries';

export const metadata: Metadata = { title: 'Vendors' };

type SearchParams = Record<string, string | string[] | undefined>;

export default async function VendorsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const [user, raw] = await Promise.all([requireUser('/purchases/vendors'), searchParams]);
  const [rows, accounts] = await Promise.all([vendorRows(), accountOptions()]);
  const flagged = rows.filter((r) => r.is1099).length;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        eyebrow="Purchases"
        title="Vendors"
        description="Who Sooz buys from, where their spending usually lands, and who needs a 1099. The bank review matches statement lines to these vendors."
        meta={
          <>
            <Badge tone="neutral">{rows.filter((r) => r.active).length} active</Badge>
            <Badge tone={flagged > 0 ? 'primary' : 'neutral'}>{flagged} on 1099</Badge>
          </>
        }
      />
      <VendorTable
        rows={rows}
        accounts={billLineAccounts(accounts)}
        canManage={can(user.role, 'ap.manage')}
        openNew={raw.new === '1'}
      />
    </div>
  );
}

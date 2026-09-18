import type { Metadata } from 'next';

import { AccountTree } from '@/components/ledger/account-tree';
import { Badge } from '@/components/ui/badge';
import { PageHeader } from '@/components/ui/page-header';
import { can } from '@/lib/auth/roles';
import { requireUser } from '@/lib/auth/session';

import { accountTreeRows } from '../queries';

export const metadata: Metadata = {
  title: 'Chart of accounts',
};

/**
 * The chart of accounts with its posted balances.
 *
 * Balances are as of today and accrual, which is what a chart of accounts is
 * for — the reports are where a basis and a date range belong.
 */
export default async function ChartOfAccountsPage() {
  const [user, accounts] = await Promise.all([requireUser('/ledger/accounts'), accountTreeRows()]);
  const active = accounts.filter((account) => account.active).length;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        eyebrow="Books"
        title="Chart of accounts"
        description="Every account the ledger can post to, nested as it reads on a statement."
        meta={<Badge tone="neutral">{active} active</Badge>}
      />
      <AccountTree accounts={accounts} canManage={can(user.role, 'settings.manage')} />
    </div>
  );
}

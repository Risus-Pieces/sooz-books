import type { Metadata } from 'next';

import { AccountTree } from '@/components/ledger/account-tree';
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
 * for — the reports are where a basis and a date range belong. The outline draws
 * its own toolbar, because its search and filters live with it.
 */
export default async function ChartOfAccountsPage() {
  const [user, accounts] = await Promise.all([requireUser('/ledger/accounts'), accountTreeRows()]);

  return (
    <div className="flex flex-col gap-3.5 max-md:gap-3">
      <AccountTree accounts={accounts} canManage={can(user.role, 'settings.manage')} />
    </div>
  );
}

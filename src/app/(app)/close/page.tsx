import type { Metadata } from 'next';

import { PeriodTable } from '@/components/ledger/period-table';
import { monthLabel } from '@/components/ledger/types';
import { Badge } from '@/components/ui/badge';
import { PageHeader } from '@/components/ui/page-header';
import { can } from '@/lib/auth/roles';
import { requireUser } from '@/lib/auth/session';

import { periodRows } from '../ledger/queries';

export const metadata: Metadata = {
  title: 'Close',
};

/**
 * The close screen: what is in each month, and whether it is shut.
 *
 * A month with no row in `periods` is open — the table records decisions rather
 * than the calendar — so every month back to the first entry gets a row here
 * whether or not anyone has ever touched it.
 */
export default async function ClosePage() {
  const [user, periods] = await Promise.all([requireUser('/close'), periodRows()]);

  const current = periods.find((period) => period.current) ?? periods[0];
  const openDrafts = periods.reduce((sum, period) => sum + period.draftCount, 0);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        eyebrow="Books"
        title="Close"
        description="Closing a month freezes it: nothing posts into a closed period, and corrections after that are reversing entries in a later one."
        meta={
          <>
            {current === undefined ? null : (
              <Badge tone={current.status === 'closed' ? 'neutral' : 'info'}>
                {monthLabel(current.year, current.month)} {current.status}
              </Badge>
            )}
            {openDrafts > 0 ? (
              <Badge tone="warning">
                {openDrafts} {openDrafts === 1 ? 'draft' : 'drafts'} outstanding
              </Badge>
            ) : null}
          </>
        }
      />
      <PeriodTable
        periods={periods}
        canClose={can(user.role, 'ledger.close')}
        canReopen={can(user.role, 'ledger.reopen')}
      />
    </div>
  );
}

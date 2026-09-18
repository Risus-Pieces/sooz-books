import type { Metadata } from 'next';
import { Lock } from 'lucide-react';

import { CloseHistory } from '@/components/planning/close-history';
import { CloseWorkspace } from '@/components/planning/close-workspace';
import { MonthRail } from '@/components/planning/month-rail';
import { Badge } from '@/components/ui/badge';
import { PageHeader } from '@/components/ui/page-header';
import { can } from '@/lib/auth/roles';
import { requireUser } from '@/lib/auth/session';

import { closeMonths, closeScreen, closedPeriods } from './queries';

export const metadata: Metadata = {
  title: 'Close',
};

export const dynamic = 'force-dynamic';

type SearchParams = Record<string, string | string[] | undefined>;

/**
 * The month-end close. The month defaults to the earliest one still open —
 * months close in order, and a later month cannot be trusted while an earlier
 * one is still moving.
 */
export default async function ClosePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const [user, params, months] = await Promise.all([requireUser('/close'), searchParams, closeMonths()]);

  const raw = Array.isArray(params.month) ? params.month[0] : params.month;
  const fallback = months.find((m) => m.status === 'open') ?? months[months.length - 1];
  const selected = months.find((m) => m.key === raw) ?? fallback;

  const [screen, history] = await Promise.all([closeScreen(selected.year, selected.month), closedPeriods()]);
  const closedCount = months.filter((m) => m.status === 'closed').length;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        eyebrow="Books"
        title="Month-end close"
        description="Closing a month freezes it: nothing posts into a closed month, and corrections after that are reversing entries in a later one."
        meta={
          <>
            <Badge tone={screen.periodStatus === 'closed' ? 'positive' : 'info'}>
              {screen.periodStatus === 'closed' ? <Lock /> : null}
              {selected.label} {screen.periodStatus}
            </Badge>
            <Badge tone="neutral">
              {closedCount} of {months.length} months closed
            </Badge>
          </>
        }
        tabs={<MonthRail months={months} selected={selected.key} path="/close" />}
      />

      <CloseWorkspace
        year={selected.year}
        month={selected.month}
        monthLabel={selected.label}
        checklistId={screen.checklistId}
        periodStatus={screen.periodStatus}
        tasks={screen.tasks}
        canWork={can(user.role, 'ledger.close')}
      />

      <CloseHistory rows={history} canReopen={can(user.role, 'ledger.reopen')} />
    </div>
  );
}

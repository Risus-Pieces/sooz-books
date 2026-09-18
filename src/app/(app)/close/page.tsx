import type { Metadata } from 'next';

import { PageToolbar } from '@/components/shell/page-toolbar';
import { Pill } from '@/components/ui/pill';
import { can } from '@/lib/auth/roles';
import { requireUser } from '@/lib/auth/session';

import { CloseHistory } from './_components/close-history';
import { CloseWorkspace } from './_components/close-workspace';
import { MonthStrip } from './_components/month-strip';
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
    <div className="flex flex-col gap-3.5 max-md:gap-3">
      <PageToolbar
        title="Close"
        subtitle={
          <>
            <span className="num">
              {closedCount}/{months.length} closed
            </span>
            {screen.periodStatus === 'closed' ? (
              <Pill tone="green" glyph="lock" className="h-5 px-2 text-2xs">
                {selected.label}
              </Pill>
            ) : null}
          </>
        }
        info={
          <p>
            Closing a month freezes it: nothing posts into a closed month, and corrections after that are reversing
            entries in a later one. Months close in order. Reopening is owner-only.
          </p>
        }
      />

      <MonthStrip months={months} selected={selected.key} />

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

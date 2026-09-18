import type { Metadata } from 'next';

import { ReportSurface } from '@/components/reports/report-surface';
import { requireCapability } from '@/lib/auth/session';
import { monthStart, today } from '@/lib/dates';
import { trialBalanceReport } from '@/lib/reports/trial-balance';
import { type SearchParams, parseReportRequest } from '@/lib/reports/types';

export const metadata: Metadata = {
  title: 'Trial Balance',
};

export const dynamic = 'force-dynamic';

const PATH = '/reports/trial-balance';

export default async function TrialBalancePage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const [, params] = await Promise.all([requireCapability('reports.view'), searchParams]);

  const anchor = today();
  const request = parseReportRequest(params, {
    defaultWindow: { from: monthStart(anchor), to: anchor },
    anchor,
  });

  const report = await trialBalanceReport(request);

  return (
    <ReportSurface
      report={report}
      request={request}
      path={PATH}
      kind="trial-balance"
      channels={[]}
      columnModes={['total']}
      showCompare={false}
      dense
      description="Every account with a balance as of the end date. An account sitting on the wrong side of its normal balance is flagged beside its name."
    />
  );
}

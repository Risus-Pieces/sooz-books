import type { Metadata } from 'next';

import { BalanceSummary } from '@/components/reports/report-charts';
import { ReportSurface } from '@/components/reports/report-surface';
import { requireCapability } from '@/lib/auth/session';
import { monthStart, today } from '@/lib/dates';
import { balanceSheetReport } from '@/lib/reports/balance-sheet';
import { type SearchParams, parseReportRequest } from '@/lib/reports/types';

export const metadata: Metadata = {
  title: 'Balance Sheet',
};

export const dynamic = 'force-dynamic';

const PATH = '/reports/balance-sheet';

export default async function BalanceSheetPage({
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

  const report = await balanceSheetReport(request);

  // The end date's position: the "current" balance column, else the last period before any comparison.
  const amountColumns = report.columns.filter((column) => column.kind === 'amount');
  const currentIndex = amountColumns.findIndex((column) => column.key === 'current');
  const at = Math.max(0, currentIndex !== -1 ? currentIndex : amountColumns.filter((c) => c.group !== 'compare').length - 1);

  return (
    <ReportSurface
      summary={
        <BalanceSummary
          assetsCents={report.totals.assets[at] ?? 0}
          liabilitiesCents={report.totals.liabilities[at] ?? 0}
          equityCents={report.totals.equity[at] ?? 0}
        />
      }
      report={report}
      request={request}
      path={PATH}
      kind="balance-sheet"
      channels={[]}
      columnModes={['total', 'months', 'quarters']}
      showCompare
      description="The position as of the end date. The current period's result is split out of retained earnings, because nothing has been closed to 3900 yet."
    />
  );
}

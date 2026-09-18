import type { Metadata } from 'next';

import { ReportSurface } from '@/components/reports/report-surface';
import { requireCapability } from '@/lib/auth/session';
import { today } from '@/lib/dates';
import { cashFlowReport } from '@/lib/reports/cash-flow';
import { type SearchParams, parseReportRequest, yearStart } from '@/lib/reports/types';

export const metadata: Metadata = {
  title: 'Cash Flow',
};

export const dynamic = 'force-dynamic';

const PATH = '/reports/cash-flow';

/**
 * The statement of cash flows, indirect method, off the posted ledger. It ties
 * itself to the cash accounts and prints an error row rather than a plug when it
 * cannot, so a figure on this page is either right or visibly wrong.
 */
export default async function CashFlowPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const [, params] = await Promise.all([requireCapability('reports.view'), searchParams]);

  const anchor = today();
  const request = parseReportRequest(params, {
    defaultWindow: { from: yearStart(anchor), to: anchor },
    anchor,
  });

  const report = await cashFlowReport(request);

  return (
    <ReportSurface
      report={report}
      request={request}
      path={PATH}
      kind="cash-flow"
      channels={[]}
      columnModes={['total', 'months']}
      showCompare={false}
      description="Net income walked to the change in cash: operating, investing and financing. Square Clearing is not cash — a payout Square still holds is a receivable until it lands in Relay. Bank lines still in the review queue are not in these figures."
    />
  );
}

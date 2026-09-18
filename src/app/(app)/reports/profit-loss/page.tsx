import type { Metadata } from 'next';
import { asc, eq } from 'drizzle-orm';

import { PnlSummary, type PnlMonth } from '@/components/reports/report-charts';
import { ReportSurface } from '@/components/reports/report-surface';
import { db } from '@/db/client';
import { channels } from '@/db/schema';
import { requireCapability } from '@/lib/auth/session';
import { monthStart, today } from '@/lib/dates';
import { profitAndLossReport } from '@/lib/reports/pnl';
import { type SearchParams, parseReportRequest, yearStart } from '@/lib/reports/types';
import { monthLong, monthShort } from '@/lib/ui/format';

export const metadata: Metadata = {
  title: 'Profit & Loss',
};

export const dynamic = 'force-dynamic';

const PATH = '/reports/profit-loss';

export default async function ProfitAndLossPage({
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

  // The summary chart runs month by month from January (or the report's own start, if earlier),
  // so a one-month statement still opens with the year's shape.
  const chartFrom = request.from < yearStart(request.to) ? request.from : yearStart(request.to);
  const [report, chart, channelRows] = await Promise.all([
    profitAndLossReport(request),
    profitAndLossReport({
      ...request,
      from: chartFrom,
      columns: 'months',
      compareTo: undefined,
      percentOfNetSales: false,
      includeZeroRows: false,
    }),
    db
      .select({ id: channels.id, name: channels.name })
      .from(channels)
      .where(eq(channels.active, true))
      .orderBy(asc(channels.sortOrder)),
  ]);

  // Amount columns map one-to-one onto the totals' buckets; the last is the range total.
  const buckets = chart.columns.filter((column) => column.kind === 'amount');
  const months: PnlMonth[] = buckets.flatMap((column, index) => {
    if (column.key === 'total' || column.from == null) return [];
    const month = Number(column.from.slice(5, 7));
    const netSales = chart.totals.netSales[index] ?? 0;
    const netIncome = chart.totals.netIncome[index] ?? 0;
    return [
      {
        label: monthShort(month),
        name: `${monthLong(month)} ${column.from.slice(0, 4)}`,
        revenueCents: netSales,
        expenseCents: netSales - netIncome,
      },
    ];
  });
  const current = report.columns.filter((column) => column.kind === 'amount').findIndex((c) => c.key === 'total');

  return (
    <ReportSurface
      summary={<PnlSummary months={months} netIncomeCents={report.totals.netIncome[Math.max(0, current)] ?? 0} />}
      report={report}
      request={request}
      path={PATH}
      kind="profit-loss"
      channels={channelRows}
      showCompare
      showPercent
      description="Gross sales less trade spend is net sales; everything that scales with a case sold comes out before contribution margin."
    />
  );
}

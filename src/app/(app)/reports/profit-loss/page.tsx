import type { Metadata } from 'next';
import { asc, eq } from 'drizzle-orm';

import { ReportSurface } from '@/components/reports/report-surface';
import { db } from '@/db/client';
import { channels } from '@/db/schema';
import { requireCapability } from '@/lib/auth/session';
import { monthStart, today } from '@/lib/dates';
import { profitAndLossReport } from '@/lib/reports/pnl';
import { type SearchParams, parseReportRequest } from '@/lib/reports/types';

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

  const [report, channelRows] = await Promise.all([
    profitAndLossReport(request),
    db
      .select({ id: channels.id, name: channels.name })
      .from(channels)
      .where(eq(channels.active, true))
      .orderBy(asc(channels.sortOrder)),
  ]);

  return (
    <ReportSurface
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

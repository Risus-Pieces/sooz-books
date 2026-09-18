import type { Metadata } from 'next';
import Link from 'next/link';
import { ChartNoAxesColumn } from 'lucide-react';

import { MarginChart } from '@/components/inventory/margin-chart';
import { MarginToolbar, type MarginGroupKey } from '@/components/inventory/margin-toolbar';
import { ReportMatrix } from '@/components/reports/report-matrix';
import { Badge } from '@/components/ui/badge';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Money } from '@/components/ui/money';
import { PageHeader } from '@/components/ui/page-header';
import { StatTile } from '@/components/ui/stat-tile';
import { requireCapability } from '@/lib/auth/session';
import { isCalendarDate, today } from '@/lib/dates';
import { grossMarginBy, type MarginRow } from '@/lib/inventory/margin';
import { datePresets, formatBasisPoints, formatWindow, yearStart } from '@/lib/reports/types';

export const metadata: Metadata = {
  title: 'Gross Margin',
};

export const dynamic = 'force-dynamic';

const PATH = '/reports/margin';
const GROUPS: readonly MarginGroupKey[] = ['product', 'channel', 'product_channel'];
const CHART_ROWS = 12;

function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function chartLabel(row: MarginRow, by: MarginGroupKey): string {
  const product = row.sku ?? 'Unassigned';
  const channel = row.channelCode ?? 'Unassigned';
  if (by === 'product') return product;
  if (by === 'channel') return row.channelName ?? channel;
  return `${product} · ${channel}`;
}

/**
 * Gross margin by product, channel, or both, read off the ledger's product and
 * channel dimensions: net sales less COGS, and the margin as a share of sales.
 */
export default async function MarginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [, params] = await Promise.all([requireCapability('reports.view'), searchParams]);
  const anchor = today();
  const rawFrom = one(params.from);
  const rawTo = one(params.to);
  let from = rawFrom && isCalendarDate(rawFrom) ? rawFrom : yearStart(anchor);
  let to = rawTo && isCalendarDate(rawTo) ? rawTo : anchor;
  if (from > to) [from, to] = [to, from];
  const rawBy = one(params.by);
  const groupBy: MarginGroupKey = GROUPS.includes(rawBy as MarginGroupKey) ? (rawBy as MarginGroupKey) : 'product';

  const result = await grossMarginBy({ from, to, groupBy });
  const { totals, rows } = result;
  const chart = rows.slice(0, CHART_ROWS).map((r) => ({
    label: chartLabel(r, groupBy),
    netSalesCents: r.netSalesCents,
    grossMarginCents: r.grossMarginCents,
    grossMarginBps: r.grossMarginBps,
  }));

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        eyebrow="Reports"
        title="Gross margin"
        description="Net sales less cost of goods sold, by the product and channel each posted line carries. COGS reaches a SKU when its month’s COGS batch posts."
        meta={
          <>
            <Badge tone="outline">{formatWindow(from, to)}</Badge>
            <Badge tone="neutral">Accrual basis</Badge>
          </>
        }
      />

      <MarginToolbar
        path={PATH}
        from={from}
        to={to}
        groupBy={groupBy}
        presets={datePresets(anchor).map((p) => ({ key: p.key, label: p.label, from: p.from, to: p.to }))}
      />

      {rows.length === 0 ? (
        <Card>
          <EmptyState
            icon={<ChartNoAxesColumn />}
            title="No sales or COGS posted in this range"
            description="Margin appears once revenue and COGS are posted. Square deposits post to Square Clearing without SKU detail, so product margin needs the month’s Peasy shipments imported and its COGS batch posted."
            action={
              <Link href="/inventory/cogs" className="text-xs font-medium text-primary hover:underline">
                Monthly COGS
              </Link>
            }
          />
        </Card>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <StatTile label="Net sales" value={<Money cents={totals.netSalesCents} currency plain />} />
            <StatTile label="Cost of goods sold" value={<Money cents={totals.cogsCents} currency plain />} />
            <StatTile label="Gross margin" value={<Money cents={totals.grossMarginCents} currency />} />
            <StatTile
              label="Gross margin %"
              value={totals.netSalesCents === 0 ? '—' : formatBasisPoints(totals.grossMarginBps)}
              footer={totals.netSalesCents === 0 ? 'No net sales in the range.' : 'Of net sales.'}
            />
          </div>

          <Card className="min-w-0 overflow-hidden">
            <CardHeader>
              <CardTitle>Gross margin dollars</CardTitle>
              <span className="text-xs text-muted-foreground">
                {rows.length > CHART_ROWS ? `Top ${CHART_ROWS} of ${rows.length} by net sales` : 'By net sales'}
              </span>
            </CardHeader>
            <div className="p-3">
              <MarginChart data={chart} />
            </div>
          </Card>

          <Card className="min-w-0 overflow-hidden">
            <ReportMatrix report={result.report} />
          </Card>
        </>
      )}
    </div>
  );
}

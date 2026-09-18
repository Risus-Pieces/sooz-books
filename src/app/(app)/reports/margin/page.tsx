import type { ReactNode } from 'react';
import type { Metadata } from 'next';
import Link from 'next/link';

import { SplitBar } from '@/components/charts';
import { MarginChart } from '@/components/inventory/margin-chart';
import { MarginToolbar, type MarginGroupKey } from '@/components/inventory/margin-toolbar';
import { ReportMatrix } from '@/components/reports/report-matrix';
import { PageToolbar } from '@/components/shell/page-toolbar';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { LegendItem } from '@/components/ui/icon-badge';
import { Money } from '@/components/ui/money';
import { requireCapability } from '@/lib/auth/session';
import { cn } from '@/lib/cn';
import { isCalendarDate, today } from '@/lib/dates';
import { grossMarginBy, type MarginRow } from '@/lib/inventory/margin';
import { datePresets, formatBasisPoints, formatWindow, yearStart } from '@/lib/reports/types';
import { dollars } from '@/lib/ui/format';

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
 * Gross margin by product, channel, or both, read off the ledger's product and channel dimensions:
 * net sales less COGS, and the margin as a share of sales. It opens with the chart — sales split
 * into what was kept and what the goods cost — then the figures.
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
  const kept = Math.max(0, totals.grossMarginCents);
  const cogs = Math.max(0, totals.cogsCents);

  return (
    <div className="flex flex-col gap-3.5 max-md:gap-3">
      <PageToolbar
        title="Gross margin"
        subtitle={<>{formatWindow(from, to)} · Accrual</>}
        info="Net sales less cost of goods sold, by the product and channel each posted line carries. COGS reaches a SKU when its month’s COGS batch posts."
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
            glyph="percent"
            title="No sales or COGS posted"
            description="Margin appears once revenue and COGS are posted. Square deposits post to Square Clearing without SKU detail, so product margin needs the month’s Peasy shipments imported and its COGS batch posted."
            action={
              <Button asChild variant="secondary">
                <Link href="/inventory/cogs">Monthly COGS</Link>
              </Button>
            }
          />
        </Card>
      ) : (
        <>
          <Card className="px-5 pt-[18px] pb-4 max-md:p-4">
            <div className="grid gap-x-8 gap-y-4 lg:grid-cols-[16rem_minmax(0,1fr)]">
              <div className="flex flex-col">
                <h2 className="text-sm font-semibold text-label2">Margin</h2>
                <p
                  className={cn(
                    'num mt-0.5 text-5xl leading-[1.05] font-bold tracking-[-0.03em] max-md:text-[2.5rem]',
                    totals.grossMarginCents < 0 && 'text-ink-red',
                  )}
                >
                  {totals.netSalesCents === 0 ? '—' : formatBasisPoints(totals.grossMarginBps)}
                </p>
                <SplitBar
                  className="mt-4"
                  label={`Net sales ${dollars(totals.netSalesCents)}: kept ${dollars(totals.grossMarginCents)}, COGS ${dollars(totals.cogsCents)}`}
                  segments={[
                    { label: 'Kept', value: kept, tint: 'green' },
                    { label: 'COGS', value: cogs, tint: 'gray' },
                  ]}
                />
                <dl className="mt-3 grid rounded-[11px] bg-inset">
                  <Fact label="Net sales">
                    <Money cents={totals.netSalesCents} currency plain />
                  </Fact>
                  <Fact label={<LegendItem tint="gray">COGS</LegendItem>}>
                    <Money cents={totals.cogsCents} currency plain />
                  </Fact>
                  <Fact label={<LegendItem tint="green">Margin</LegendItem>}>
                    <Money cents={totals.grossMarginCents} currency plain className={totals.grossMarginCents < 0 ? 'text-ink-red' : undefined} />
                  </Fact>
                </dl>
              </div>
              <div className="min-w-0">
                <div className="mb-1 flex items-center justify-between gap-2 text-xs font-medium text-label2">
                  <span>{rows.length > CHART_ROWS ? `Top ${CHART_ROWS} of ${rows.length}` : 'By net sales'}</span>
                  <span>Margin · %</span>
                </div>
                <MarginChart data={chart} />
              </div>
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

function Fact({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="flex h-9 items-center justify-between px-3 [&+&]:hairline-t">
      <dt className="text-sm font-medium text-label2">{label}</dt>
      <dd className="text-sm font-semibold">{children}</dd>
    </div>
  );
}

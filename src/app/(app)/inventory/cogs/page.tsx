import type { Metadata } from 'next';
import Link from 'next/link';

import { DivergingBars, Responsive, type DivergingColumn, type DivergingSeries } from '@/components/charts';
import { BatchLines } from '@/components/inventory/batch-lines';
import { DraftBatchButton, PostBatchButton, ReverseBatchButton } from '@/components/inventory/cogs-panels';
import { EntryPreview } from '@/components/inventory/entry-preview';
import { ShipmentsImport } from '@/components/inventory/shipments-import';
import { StackBar } from '@/components/inventory/stack-bar';
import { COMPONENT_LABELS, COMPONENT_STYLE, formatUnits, periodKey, periodLabel } from '@/components/inventory/types';
import { PageToolbar } from '@/components/shell/page-toolbar';
import { Card } from '@/components/ui/card';
import { DetailPane } from '@/components/ui/detail-pane';
import { EmptyState } from '@/components/ui/empty-state';
import { Glyph } from '@/components/ui/glyph';
import { IconBadge, LegendItem } from '@/components/ui/icon-badge';
import { InsetGroup } from '@/components/ui/inset-group';
import { Money } from '@/components/ui/money';
import { Pill } from '@/components/ui/pill';
import { ToolbarGroup } from '@/components/ui/toolbar';
import { can } from '@/lib/auth/roles';
import { requireCapability } from '@/lib/auth/session';
import { cn } from '@/lib/cn';
import { periodEndDate } from '@/lib/inventory/cogs';
import { monthInitial, monthShort } from '@/lib/ui/format';
import type { Tint } from '@/lib/ui/tints';

import { batchDetail, batchRows, channelOptions, shipmentMonths, type BatchRow } from '../queries';

export const metadata: Metadata = {
  title: 'COGS',
};

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const STATUS: Record<BatchRow['status'], { label: string; tint: Tint; pill: 'green' | 'orange' | 'neutral' }> = {
  posted: { label: 'Posted', tint: 'green', pill: 'green' },
  draft: { label: 'Draft', tint: 'orange', pill: 'orange' },
  reversed: { label: 'Reversed', tint: 'gray', pill: 'neutral' },
};

const COGS_SERIES: DivergingSeries[] = [{ key: 'cogs', label: 'COGS', tint: 'cyan' }];

const sep =
  'relative before:pointer-events-none before:absolute before:top-0 before:right-0 before:left-[var(--sep-inset)] before:border-t-[0.5px] before:border-sep first:before:hidden';

/**
 * The monthly COGS batch: units shipped (from Peasy) valued at the unit cost in effect at month
 * end, relieved from Finished Goods into COGS by SKU × channel. Months and batches on the left; the
 * chosen batch, its split and the entry it posts on the right (below, on a phone).
 */
export default async function CogsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [user, params, months, batches, channels] = await Promise.all([
    requireCapability('reports.view'),
    searchParams,
    shipmentMonths(),
    batchRows(),
    channelOptions(),
  ]);
  const canManage = can(user.role, 'inventory.manage');

  const requested = typeof params.batch === 'string' && UUID.test(params.batch) ? params.batch : null;
  const selectedId = requested ?? batches.find((b) => b.status === 'draft')?.id ?? batches[0]?.id ?? null;
  const detail = selectedId ? await batchDetail(selectedId) : null;
  const selectedLabel = detail ? periodLabel(detail.batch.year, detail.batch.month) : '';

  const empty = months.length === 0 && batches.length === 0;
  const posted = batches.filter((b) => b.status === 'posted');
  const postedTotal = posted.reduce((s, b) => s + b.totalCogsCents, 0);

  // COGS posted by month, oldest first, for the chart header.
  const byMonth = [...posted].sort((a, b) => a.year - b.year || a.month - b.month);
  const columns = (compact: boolean): DivergingColumn[] =>
    byMonth.map((b) => ({
      label: compact ? monthInitial(b.month) : monthShort(b.month),
      name: periodLabel(b.year, b.month),
      up: { cogs: b.totalCogsCents },
      down: {},
    }));

  const info =
    'Each month, the units Peasy says shipped are valued at the unit cost in effect on the last day of the month and relieved from Finished Goods — one line per SKU and channel, so margin reads straight off the ledger.';

  return (
    <div className="flex flex-col gap-3.5 max-md:gap-3">
      <PageToolbar
        title="COGS"
        back={{ href: '/inventory', label: 'Inventory' }}
        phoneTitleRow
        subtitle={posted.length > 0 ? <Money cents={postedTotal} currency plain /> : undefined}
        info={info}
        actions={
          canManage && !empty ? (
            <ToolbarGroup>
              <ShipmentsImport channels={channels} variant="toolbar" />
            </ToolbarGroup>
          ) : undefined
        }
      />

      {empty ? (
        <Card>
          <EmptyState
            glyph="truck"
            title="Nothing shipped yet"
            description="COGS starts when finished goods leave. Cost a production run first so each SKU has a unit cost, then import each month’s shipments from Peasy and draft that month’s batch here. Square sales today carry no SKU detail, so they need a Peasy shipments export to reach COGS."
            action={canManage ? <ShipmentsImport channels={channels} /> : undefined}
          />
        </Card>
      ) : (
        <>
          {byMonth.length > 0 ? (
            <Card className="px-5 pt-[18px] pb-4 max-md:p-4">
              <div className="mb-2.5 flex items-center gap-2">
                <h2 className="flex-1 text-lg font-semibold tracking-[-0.01em]">By month</h2>
                <LegendItem tint="cyan">COGS posted</LegendItem>
              </div>
              <Responsive
                desktop={<DivergingBars columns={columns(false)} upSeries={COGS_SERIES} downSeries={[]} title="COGS posted by month" />}
                phone={
                  <DivergingBars columns={columns(true)} upSeries={COGS_SERIES} downSeries={[]} width={342} compact title="COGS posted by month" />
                }
              />
            </Card>
          ) : null}

          <div className="grid items-start gap-3.5 max-md:gap-3 lg:grid-cols-[360px_minmax(0,1fr)]">
            <div className="flex min-w-0 flex-col">
              <InsetGroup header="Shipped" separatorInset={60} className="[&>div:first-child]:pt-0">
                {months.length === 0 ? (
                  <p className="px-4 py-5 text-sm font-medium text-label2">No shipments imported</p>
                ) : (
                  months.map((m) => {
                    const key = periodKey(m.year, m.month);
                    const batch = batches.find((b) => b.year === m.year && b.month === m.month && b.status !== 'reversed');
                    const status = m.batchStatus ?? null;
                    const body = (
                      <>
                        <IconBadge glyph="truck" tint={status === 'posted' ? 'green' : status === 'draft' ? 'orange' : 'gray'} size="lg" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-semibold max-sm:text-lg max-sm:font-medium" title={m.filename ?? undefined}>
                            {periodLabel(m.year, m.month)}
                          </span>
                          <span className="num mt-0.5 block truncate text-xs text-label2 max-sm:text-sm">
                            {formatUnits(m.units - m.returns)} units · {m.skus} SKU · {m.channels} ch
                          </span>
                        </span>
                      </>
                    );
                    if (batch) {
                      return (
                        <Link
                          key={key}
                          href={`/inventory/cogs?batch=${batch.id}`}
                          scroll={false}
                          aria-current={batch.id === selectedId ? 'true' : undefined}
                          className={cn(
                            sep,
                            'flex min-h-14 items-center gap-3 px-4 py-2 transition-colors hover:bg-fill2',
                            batch.id === selectedId && 'bg-fill2',
                          )}
                        >
                          {body}
                          <span className="shrink-0 text-right">
                            <Money cents={batch.totalCogsCents} currency plain className="block text-sm font-semibold" />
                            <span className={cn('text-xs font-medium', status === 'draft' ? 'text-ink-orange' : 'text-label2')}>
                              {status === 'draft' ? 'Draft' : 'Posted'}
                            </span>
                          </span>
                        </Link>
                      );
                    }
                    return (
                      <div key={key} className={cn(sep, 'flex min-h-14 items-center gap-3 px-4 py-2')}>
                        {body}
                        {canManage ? (
                          <DraftBatchButton period={key} label={periodLabel(m.year, m.month)} compact />
                        ) : (
                          <span className="text-xs font-medium text-label2">Not drafted</span>
                        )}
                      </div>
                    );
                  })
                )}
              </InsetGroup>

              {batches.some((b) => b.status === 'reversed') ? (
                <InsetGroup header="Reversed" separatorInset={60}>
                  {batches
                    .filter((b) => b.status === 'reversed')
                    .map((b) => (
                      <Link
                        key={b.id}
                        href={`/inventory/cogs?batch=${b.id}`}
                        scroll={false}
                        aria-current={b.id === selectedId ? 'true' : undefined}
                        className={cn(sep, 'flex min-h-12 items-center gap-3 px-4 py-2 transition-colors hover:bg-fill2', b.id === selectedId && 'bg-fill2')}
                      >
                        <IconBadge glyph="undo" tint="gray" size="lg" />
                        <span className="min-w-0 flex-1 truncate text-sm font-semibold">{periodLabel(b.year, b.month)}</span>
                        <Money cents={b.totalCogsCents} currency plain className="text-sm text-label2 line-through" />
                      </Link>
                    ))}
                </InsetGroup>
              ) : null}
            </div>

            {detail ? (
              <Card className="min-w-0 overflow-hidden">
                <DetailPane
                  className="[&>div]:px-5 [&>div]:pt-5 max-sm:[&>div]:px-4"
                  leading={<IconBadge glyph="truck" tint={STATUS[detail.batch.status].tint} size="xl" />}
                  title={selectedLabel}
                  meta={[
                    <span key="units" className="num">
                      {formatUnits(detail.batch.totalUnits)} units
                    </span>,
                    ...(detail.batch.entry
                      ? [
                          <Link key="entry" href={`/ledger/${detail.batch.entry.id}`} className="num text-ink-blue hover:underline">
                            Entry #{detail.batch.entry.entryNo}
                          </Link>,
                        ]
                      : []),
                    ...(detail.batch.reversal
                      ? [
                          <Link key="rev" href={`/ledger/${detail.batch.reversal.id}`} className="num text-ink-blue hover:underline">
                            Reversal #{detail.batch.reversal.entryNo}
                          </Link>,
                        ]
                      : []),
                  ]}
                  amount={<Money cents={detail.batch.totalCogsCents} currency plain />}
                  status={
                    <Pill tone={STATUS[detail.batch.status].pill} glyph={detail.batch.status === 'posted' ? 'check' : detail.batch.status === 'draft' ? 'pencil' : 'undo'}>
                      {STATUS[detail.batch.status].label}
                    </Pill>
                  }
                  actions={
                    canManage ? (
                      detail.batch.status === 'draft' ? (
                        <>
                          <PostBatchButton batchId={detail.batch.id} label={selectedLabel} totalCents={detail.batch.totalCogsCents} />
                          <DraftBatchButton
                            period={periodKey(detail.batch.year, detail.batch.month)}
                            label={selectedLabel}
                            redraft
                          />
                        </>
                      ) : detail.batch.status === 'posted' ? (
                        <ReverseBatchButton
                          batchId={detail.batch.id}
                          label={selectedLabel}
                          periodEnd={periodEndDate({ year: detail.batch.year, month: detail.batch.month })}
                        />
                      ) : null
                    ) : undefined
                  }
                >
                  {detail.components.length > 0 ? (
                    <div className="flex flex-col gap-2.5">
                      <StackBar
                        height={12}
                        label={`COGS for ${selectedLabel} by component`}
                        segments={detail.components.map((c) => ({
                          key: c,
                          label: COMPONENT_LABELS[c],
                          cents: detail.lines.reduce((s, l) => s + (l.components[c] ?? 0), 0),
                          tint: COMPONENT_STYLE[c].tint,
                        }))}
                      />
                      <div aria-hidden className="flex flex-wrap gap-x-4 gap-y-1">
                        {detail.components.map((c) => (
                          <LegendItem key={c} tint={COMPONENT_STYLE[c].tint}>
                            {COMPONENT_LABELS[c]}
                          </LegendItem>
                        ))}
                      </div>
                    </div>
                  ) : null}
                  <div className="-mx-5 hairline-t max-sm:-mx-4">
                    <BatchLines lines={detail.lines} components={detail.components} />
                  </div>
                  <div className="-mx-5 hairline-t max-sm:-mx-4">
                    <p className="flex items-center gap-1.5 px-5 pt-3 text-xs font-semibold text-label2 max-sm:px-4">
                      <Glyph name={detail.batch.status === 'draft' ? 'hourglass' : 'check-circle'} size={13} />
                      {detail.batch.status === 'draft' ? 'Will post' : 'Posted'}
                    </p>
                    <EntryPreview entry={detail.entry} dimensions caption={`COGS entry for ${selectedLabel}`} />
                  </div>
                </DetailPane>
              </Card>
            ) : (
              <Card className="max-lg:hidden">
                <EmptyState glyph="doc" title="No batch drafted" />
              </Card>
            )}
          </div>
        </>
      )}
    </div>
  );
}

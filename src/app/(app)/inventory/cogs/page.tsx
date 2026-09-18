import type { Metadata } from 'next';
import Link from 'next/link';
import { Truck } from 'lucide-react';

import { BatchLines } from '@/components/inventory/batch-lines';
import { DraftBatchButton, PostBatchButton, ReverseBatchButton } from '@/components/inventory/cogs-panels';
import { EntryPreview } from '@/components/inventory/entry-preview';
import { ShipmentsImport } from '@/components/inventory/shipments-import';
import { Table, TableScroll, Td, Th } from '@/components/inventory/table';
import { formatUnits, periodKey, periodLabel } from '@/components/inventory/types';
import { Badge } from '@/components/ui/badge';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Money } from '@/components/ui/money';
import { PageHeader } from '@/components/ui/page-header';
import { can } from '@/lib/auth/roles';
import { requireCapability } from '@/lib/auth/session';
import { periodEndDate } from '@/lib/inventory/cogs';

import { batchDetail, batchRows, channelOptions, shipmentMonths, type BatchRow } from '../queries';

export const metadata: Metadata = {
  title: 'COGS',
};

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function BatchStatus({ status }: { status: BatchRow['status'] }) {
  if (status === 'posted') return <Badge tone="positive">Posted</Badge>;
  if (status === 'reversed') return <Badge tone="neutral">Reversed</Badge>;
  return <Badge tone="warning">Draft</Badge>;
}

/**
 * The monthly COGS batch: units shipped (from Peasy) valued at the unit cost in
 * effect at month end, relieved from Finished Goods into COGS by SKU × channel.
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

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        eyebrow="Inventory"
        title="Cost of goods sold"
        description="Each month, the units Peasy says shipped are valued at the unit cost in effect on the last day of the month and relieved from Finished Goods — one line per SKU and channel, so margin reads straight off the ledger."
        actions={canManage && !empty ? <ShipmentsImport channels={channels} variant="secondary" /> : null}
      />

      {empty ? (
        <Card>
          <EmptyState
            icon={<Truck />}
            title="Nothing has shipped yet"
            description="COGS starts when finished goods leave. Cost a production run first so each SKU has a unit cost, then import each month’s shipments from Peasy and draft that month’s batch here. Square sales today carry no SKU detail, so they need a Peasy shipments export to reach COGS."
            action={canManage ? <ShipmentsImport channels={channels} /> : undefined}
          />
        </Card>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          <Card className="min-w-0 overflow-hidden">
            <CardHeader>
              <CardTitle>Shipped units by month</CardTitle>
            </CardHeader>
            {months.length === 0 ? (
              <p className="px-4 py-6 text-xs text-muted-foreground">No shipments imported.</p>
            ) : (
              <TableScroll>
                <Table caption="Shipped units by month" className="min-w-[32rem]">
                  <thead>
                    <tr>
                      <Th>Month</Th>
                      <Th align="right">Units</Th>
                      <Th align="right">SKUs</Th>
                      <Th align="right">Channels</Th>
                      <Th>COGS</Th>
                      <Th className="w-28" />
                    </tr>
                  </thead>
                  <tbody>
                    {months.map((m) => (
                      <tr key={periodKey(m.year, m.month)} className="rule-row">
                        <Td>
                          <span className="font-medium whitespace-nowrap" title={m.filename ?? undefined}>
                            {periodLabel(m.year, m.month)}
                          </span>
                        </Td>
                        <Td align="right" className="num">
                          {formatUnits(m.units - m.returns)}
                        </Td>
                        <Td align="right" className="num">
                          {m.skus}
                        </Td>
                        <Td align="right" className="num">
                          {m.channels}
                        </Td>
                        <Td>
                          {m.batchStatus === 'posted' ? (
                            <Badge tone="positive">Posted</Badge>
                          ) : m.batchStatus === 'draft' ? (
                            <Badge tone="warning">Draft</Badge>
                          ) : (
                            <span className="text-xs text-muted-foreground">Not drafted</span>
                          )}
                        </Td>
                        <Td align="right">
                          {canManage && m.batchStatus !== 'posted' ? (
                            <DraftBatchButton
                              period={periodKey(m.year, m.month)}
                              label={periodLabel(m.year, m.month)}
                              redraft={m.batchStatus === 'draft'}
                            />
                          ) : null}
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </TableScroll>
            )}
          </Card>

          <Card className="min-w-0 overflow-hidden">
            <CardHeader>
              <CardTitle>Batches</CardTitle>
            </CardHeader>
            {batches.length === 0 ? (
              <p className="px-4 py-6 text-xs text-muted-foreground">
                No batch drafted yet. Draft a month from its shipped units.
              </p>
            ) : (
              <TableScroll>
                <Table caption="COGS batches" className="min-w-[30rem]">
                  <thead>
                    <tr>
                      <Th>Month</Th>
                      <Th>Status</Th>
                      <Th align="right">Units</Th>
                      <Th align="right">COGS</Th>
                      <Th>Entry</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {batches.map((b) => (
                      <tr key={b.id} className={b.id === selectedId ? 'rule-row bg-primary/5' : 'rule-row'}>
                        <Td>
                          <Link href={`/inventory/cogs?batch=${b.id}`} scroll={false} className="font-medium text-primary hover:underline">
                            {periodLabel(b.year, b.month)}
                          </Link>
                        </Td>
                        <Td>
                          <BatchStatus status={b.status} />
                        </Td>
                        <Td align="right" className="num">
                          {formatUnits(b.totalUnits)}
                        </Td>
                        <Td align="right">
                          <Money cents={b.totalCogsCents} plain />
                        </Td>
                        <Td className="text-xs">
                          {b.entry ? (
                            <Link href={`/ledger/${b.entry.id}`} className="num text-primary hover:underline">
                              #{b.entry.entryNo}
                            </Link>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                          {b.reversal ? (
                            <>
                              {' '}
                              <span className="text-muted-foreground">reversed by</span>{' '}
                              <Link href={`/ledger/${b.reversal.id}`} className="num text-primary hover:underline">
                                #{b.reversal.entryNo}
                              </Link>
                            </>
                          ) : null}
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </TableScroll>
            )}
          </Card>
        </div>
      )}

      {detail ? (
        <Card className="min-w-0 overflow-hidden">
          <CardHeader>
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle>COGS · {selectedLabel}</CardTitle>
              <BatchStatus status={detail.batch.status} />
            </div>
            {canManage ? (
              <div className="flex flex-wrap items-center gap-2">
                {detail.batch.status === 'draft' ? (
                  <>
                    <DraftBatchButton
                      period={periodKey(detail.batch.year, detail.batch.month)}
                      label={selectedLabel}
                      redraft
                    />
                    <PostBatchButton batchId={detail.batch.id} label={selectedLabel} totalCents={detail.batch.totalCogsCents} />
                  </>
                ) : detail.batch.status === 'posted' ? (
                  <ReverseBatchButton
                    batchId={detail.batch.id}
                    label={selectedLabel}
                    periodEnd={periodEndDate({ year: detail.batch.year, month: detail.batch.month })}
                  />
                ) : null}
              </div>
            ) : null}
          </CardHeader>
          <BatchLines lines={detail.lines} components={detail.components} />
          <div className="border-t border-border">
            <p className="eyebrow px-3 pt-3">
              {detail.batch.status === 'draft' ? 'Entry posting will make' : 'Entry as posted'}
            </p>
            <EntryPreview entry={detail.entry} dimensions caption={`COGS entry for ${selectedLabel}`} />
          </div>
        </Card>
      ) : null}
    </div>
  );
}

import type { Metadata } from 'next';
import Link from 'next/link';
import { Factory, FileSpreadsheet } from 'lucide-react';

import { CostFlow, type FlowStation } from '@/components/inventory/cost-flow';
import { StageTable } from '@/components/inventory/stage-table';
import { Callout } from '@/components/inventory/table';
import { dayLabel, periodLabel } from '@/components/inventory/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { formatCents, Money } from '@/components/ui/money';
import { PageHeader } from '@/components/ui/page-header';
import { can } from '@/lib/auth/roles';
import { requireCapability } from '@/lib/auth/session';

import { overviewData } from './queries';

export const metadata: Metadata = {
  title: 'Inventory',
};

export const dynamic = 'force-dynamic';

/**
 * Inventory at a glance: what the ledger carries in each stage, what Peasy last
 * counted, and where the cost of the product sits on its way to COGS.
 */
export default async function InventoryPage() {
  const [user, data] = await Promise.all([requireCapability('reports.view'), overviewData()]);
  const canManage = can(user.role, 'inventory.manage');

  const materials = data.stages
    .filter((s) => s.stage === 'raw' || s.stage === 'packaging')
    .reduce((sum, s) => sum + s.ledgerCents, 0);
  const finished = data.stages.find((s) => s.stage === 'finished')?.ledgerCents ?? 0;
  const pending = data.bankQueue.totalCents;
  const noRuns = data.runs.open + data.runs.costed === 0;

  const stations: FlowStation[] = [
    {
      key: 'materials',
      title: 'Materials',
      accounts: '1320 · 1330',
      cents: materials,
      state: 'waiting',
      note:
        pending > 0 ? (
          <>
            <Money cents={pending} currency plain className="text-foreground" /> more is waiting in the bank review
            queue ({data.bankQueue.count} {data.bankQueue.count === 1 ? 'line' : 'lines'}) and capitalizes here once
            approved.
          </>
        ) : materials > 0 ? (
          'Ingredients and packaging bought and held at cost.'
        ) : (
          'Ingredients and packaging capitalize here as their bank lines and bills are approved.'
        ),
    },
    {
      key: 'production',
      title: 'Production',
      accounts: 'co-packer',
      cents: null,
      figure: noRuns ? (
        <span className="text-muted-foreground">No runs</span>
      ) : (
        <span className="num">
          {data.runs.open} open · {data.runs.costed} costed
        </span>
      ),
      state: 'waiting',
      note: noRuns
        ? 'Create the first production run when the co-packer runs, then attach the materials and tolling it used.'
        : data.runs.latest
          ? `Latest: ${data.runs.latest.runNo}, ${data.runs.latest.sku}, ${data.runs.latest.runDate}${data.runs.latest.unitCostCents === null ? ' — not costed yet.' : ` at ${formatCents(data.runs.latest.unitCostCents, { currency: true })} a unit.`}`
          : '',
      action: canManage
        ? noRuns
          ? { label: 'Create the first run', href: '/inventory/production?new=1' }
          : { label: 'Production runs', href: '/inventory/production' }
        : undefined,
    },
    {
      key: 'finished',
      title: 'Finished goods',
      accounts: '1310',
      cents: finished,
      state: 'waiting',
      note:
        finished > 0
          ? 'Costed runs, held at their unit cost until they ship.'
          : 'Costing a run moves its value here at a struck unit cost.',
    },
    {
      key: 'cogs',
      title: 'Cost of goods sold',
      accounts: '5010–5040',
      cents: data.cogs.lastPosted?.cogsCents ?? null,
      figure: data.cogs.lastPosted ? undefined : <span className="text-muted-foreground">Nothing shipped</span>,
      state: 'waiting',
      note: data.cogs.lastPosted
        ? `Last posted: ${periodLabel(data.cogs.lastPosted.year, data.cogs.lastPosted.month)}.${data.cogs.drafts > 0 ? ` ${data.cogs.drafts} draft waiting to post.` : ''}`
        : 'Each month, units shipped (from Peasy) relieve Finished Goods at cost.',
      action: finished > 0 || data.shipmentsMonths > 0 ? { label: 'Monthly COGS', href: '/inventory/cogs' } : undefined,
    },
  ];

  // The first station with work outstanding is the next thing to do; the ones
  // before it are behind us.
  const current =
    materials === 0 && pending > 0
      ? 'materials'
      : noRuns || data.runs.open > 0 || finished === 0
        ? 'production'
        : 'cogs';
  const currentIndex = stations.findIndex((s) => s.key === current);
  stations.forEach((station, index) => {
    station.state = index < currentIndex ? 'done' : index === currentIndex ? 'current' : 'waiting';
  });

  const variance = data.snapshot?.varianceCents ?? 0;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        eyebrow="Inventory"
        title="Inventory value"
        description="What the ledger carries in each stage of inventory, against what Peasy last counted, and where the cost of the product sits on its way to COGS."
        meta={<Badge tone="outline">As of {dayLabel(data.asOf)}</Badge>}
        actions={
          canManage ? (
            <>
              <Button asChild variant="secondary" size="sm">
                <Link href="/inventory/valuation">
                  <FileSpreadsheet />
                  Import a Peasy count
                </Link>
              </Button>
              <Button asChild size="sm">
                <Link href="/inventory/production?new=1">
                  <Factory />
                  New production run
                </Link>
              </Button>
            </>
          ) : null
        }
      />

      {data.snapshot === null ? (
        <Callout
          tone="info"
          title="No Peasy count to tie out against yet"
          action={
            canManage ? (
              <Button asChild size="sm" variant="secondary">
                <Link href="/inventory/valuation">Import a count</Link>
              </Button>
            ) : null
          }
        >
          The ledger figures below stand on their own until a Peasy inventory export is imported. Import one at month
          end so the count and the books can be compared stage by stage.
        </Callout>
      ) : variance !== 0 ? (
        <Callout
          tone="warning"
          title={
            <>
              Peasy and the ledger differ by <Money cents={variance} currency signed plain /> on {data.snapshot.date}
            </>
          }
          action={
            <Button asChild size="sm">
              <Link href="/inventory/valuation">Review the tie-out</Link>
            </Button>
          }
        >
          Peasy counted <Money cents={data.snapshot.snapshotCents} currency plain /> against{' '}
          <Money cents={data.snapshot.ledgerCents} currency plain /> in the ledger. Explain the difference, or post the
          proposed adjustment after reviewing it.
        </Callout>
      ) : (
        <Callout tone="positive" title={`Peasy and the ledger agree on ${data.snapshot.date}`}>
          The last count ties to the cent: <Money cents={data.snapshot.snapshotCents} currency plain />.
        </Callout>
      )}

      <section aria-label="Where inventory cost sits" className="flex flex-col gap-2">
        <h2 className="eyebrow">Where the cost sits</h2>
        <CostFlow stations={stations} />
      </section>

      <div className="grid gap-4 lg:grid-cols-[3fr_2fr]">
        <Card className="min-w-0 overflow-hidden">
          <CardHeader>
            <CardTitle>Inventory by stage</CardTitle>
            <Link href="/inventory/valuation" className="text-xs text-primary hover:underline">
              Tie-out history
            </Link>
          </CardHeader>
          <StageTable
            rows={data.stages}
            reserveCents={data.reserveCents}
            snapshotDate={data.snapshot?.date ?? null}
            asOf={data.asOf}
          />
          {data.snapshot !== null && data.snapshot.date !== data.asOf ? (
            <p className="border-t border-border px-3 py-2 text-2xs text-muted-foreground">
              Variance compares the count with the ledger on the count date, {data.snapshot.date}.
            </p>
          ) : null}
        </Card>

        <Card className="min-w-0">
          <CardHeader>
            <CardTitle>Waiting to capitalize</CardTitle>
            <Money cents={pending} currency plain className="text-sm font-semibold" />
          </CardHeader>
          {data.bankQueue.byAccount.length === 0 ? (
            <p className="px-4 py-6 text-xs text-muted-foreground">
              No unposted bank line is headed for an inventory account.
            </p>
          ) : (
            <div className="flex flex-col">
              <ul className="flex flex-col">
                {data.bankQueue.byAccount.map((row) => (
                  <li key={row.code} className="rule-row flex items-baseline justify-between gap-3 px-4 py-2 text-sm">
                    <span className="min-w-0 truncate">
                      <span className="num mr-2 text-muted-foreground">{row.code}</span>
                      {row.name}
                      <span className="ml-2 text-xs text-muted-foreground">
                        {row.count} {row.count === 1 ? 'line' : 'lines'}
                      </span>
                    </span>
                    <Money cents={row.cents} plain />
                  </li>
                ))}
              </ul>
              <p className="px-4 py-3 text-xs leading-relaxed text-muted-foreground">
                Ingredient and packaging purchases in the bank review queue, suggested to inventory and not yet
                approved. Nothing here is on the books until someone approves each line in the{' '}
                <Link href="/banking/review" className="text-primary hover:underline">
                  review queue
                </Link>
                .
              </p>
            </div>
          )}
          <dl className="grid grid-cols-3 gap-3 border-t border-border px-4 py-3">
            <div>
              <dt className="eyebrow">Products</dt>
              <dd className="num mt-1 text-sm">{data.productCount}</dd>
            </div>
            <div>
              <dt className="eyebrow">Months shipped</dt>
              <dd className="num mt-1 text-sm">{data.shipmentsMonths}</dd>
            </div>
            <div>
              <dt className="eyebrow">Adjustments</dt>
              <dd className="num mt-1 text-sm">
                <Link href="/inventory/adjustments" className="hover:underline">
                  {data.adjustments}
                </Link>
              </dd>
            </div>
          </dl>
        </Card>
      </div>
    </div>
  );
}

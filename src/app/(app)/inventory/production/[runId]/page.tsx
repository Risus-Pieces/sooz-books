import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';

import { RunStatusBadge } from '@/components/inventory/runs-table';
import {
  CostedSummary,
  CostingCard,
  LandedCostsCard,
  RecordOutputButton,
  ReopenRunButton,
} from '@/components/inventory/run-panels';
import { formatUnits } from '@/components/inventory/types';
import { Badge } from '@/components/ui/badge';
import { Money } from '@/components/ui/money';
import { PageHeader } from '@/components/ui/page-header';
import { StatTile } from '@/components/ui/stat-tile';
import { can } from '@/lib/auth/roles';
import { requireCapability } from '@/lib/auth/session';

import { openBillLines, openRunOptions, runDetail, stockBalances } from '../../queries';

export const metadata: Metadata = {
  title: 'Production Run',
};

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function RunPage({ params }: { params: Promise<{ runId: string }> }) {
  const [user, { runId }] = await Promise.all([requireCapability('reports.view'), params]);
  if (!UUID.test(runId)) notFound();
  const [run, billLines, openRuns, stock] = await Promise.all([
    runDetail(runId),
    openBillLines(),
    openRunOptions(),
    stockBalances(),
  ]);
  if (!run) notFound();
  const canManage = can(user.role, 'inventory.manage');
  const isOpen = run.status === 'open';
  const landed = run.landedCosts.reduce((sum, c) => sum + c.amountCents, 0);
  const unitCost = isOpen ? (run.preview?.unitCostCents ?? null) : run.unitCostCents;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        eyebrow="Inventory · Production run"
        title={`${run.runNo} · ${run.product.name}`}
        breadcrumbs={
          <Link
            href="/inventory/production"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-3" aria-hidden />
            Production runs
          </Link>
        }
        meta={
          <>
            <RunStatusBadge status={run.status} />
            <Badge tone="outline">
              <span className="num">{run.product.sku}</span>
            </Badge>
          </>
        }
        description={[
          `Run ${run.runDate}`,
          run.coManName ? `at ${run.coManName}` : null,
          run.lotCode ? `lot ${run.lotCode}` : null,
        ]
          .filter(Boolean)
          .join(' · ')}
        actions={
          canManage ? (
            isOpen ? (
              <RecordOutputButton run={run} />
            ) : run.status === 'costed' ? (
              <ReopenRunButton run={run} />
            ) : null
          ) : null
        }
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <StatTile
          label="Good units"
          value={run.goodUnits === 0 ? <span className="text-muted-foreground">—</span> : formatUnits(run.goodUnits)}
          hint={run.product.unit}
          footer={
            run.unitsProduced === 0
              ? run.unitsPlanned === null
                ? 'Output not recorded yet.'
                : `${formatUnits(run.unitsPlanned)} planned; output not recorded yet.`
              : `${formatUnits(run.unitsProduced)} produced, ${formatUnits(run.unitsRejected)} rejected${run.unitsPlanned === null ? '' : `, ${formatUnits(run.unitsPlanned)} planned`}.`
          }
        />
        <StatTile
          label="Landed cost"
          value={<Money cents={isOpen ? landed : run.totalCostCents} currency plain />}
          hint={`${run.landedCosts.length} ${run.landedCosts.length === 1 ? 'cost' : 'costs'}`}
          footer={isOpen ? 'Attached so far; costing moves it into Finished Goods.' : 'Moved into Finished Goods at costing.'}
        />
        <StatTile
          label={isOpen ? 'Unit cost if costed now' : 'Unit cost'}
          value={unitCost === null ? <span className="text-muted-foreground">—</span> : <Money cents={unitCost} currency plain />}
          footer={isOpen ? 'Recomputed when the run is costed.' : `Effective ${run.costDate ?? run.runDate}.`}
        />
      </div>

      <div className="flex flex-col gap-4">
        <LandedCostsCard run={run} canManage={canManage} billLines={billLines} openRuns={openRuns} stock={stock} />
        {isOpen ? <CostingCard run={run} canManage={canManage} /> : <CostedSummary run={run} />}
      </div>

      {run.notes ? <p className="max-w-prose text-xs text-muted-foreground">{run.notes}</p> : null}
    </div>
  );
}

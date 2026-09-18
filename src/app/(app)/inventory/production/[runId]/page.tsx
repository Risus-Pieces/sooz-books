import type { ReactNode } from 'react';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { SplitBar } from '@/components/charts';
import { RunStatusBadge } from '@/components/inventory/runs-table';
import {
  CostedSummary,
  CostingCard,
  LandedCostActions,
  LandedCostsCard,
  RecordOutputButton,
  ReopenRunButton,
} from '@/components/inventory/run-panels';
import { formatUnits } from '@/components/inventory/types';
import { PageToolbar } from '@/components/shell/page-toolbar';
import { IconBadge, LegendItem } from '@/components/ui/icon-badge';
import { Money } from '@/components/ui/money';
import { ToolbarGroup } from '@/components/ui/toolbar';
import { can } from '@/lib/auth/roles';
import { requireCapability } from '@/lib/auth/session';
import { cn } from '@/lib/cn';
import { mediumDate } from '@/lib/ui/format';
import type { GlyphName } from '@/lib/ui/glyphs';
import type { Tint } from '@/lib/ui/tints';

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

  const actions = canManage ? (
    <>
      {isOpen ? (
        <ToolbarGroup>
          <LandedCostActions run={run} billLines={billLines} openRuns={openRuns} stock={stock} />
        </ToolbarGroup>
      ) : null}
      {isOpen || run.status === 'costed' ? (
        <ToolbarGroup>{isOpen ? <RecordOutputButton run={run} /> : <ReopenRunButton run={run} />}</ToolbarGroup>
      ) : null}
    </>
  ) : undefined;

  return (
    <div className="flex flex-col gap-3.5 max-md:gap-3">
      <PageToolbar
        title={run.runNo}
        back={{ href: '/inventory/production', label: 'Production runs' }}
        phoneTitleRow
        subtitle={
          <>
            <span className="max-w-60 truncate">{run.product.name}</span>
            <span className="num text-label2">{run.product.sku}</span>
          </>
        }
        info="A production run gathers the tolling, materials and freight that went into one batch. Record the co-packer’s output, attach each cost, then cost the run: that strikes the unit cost and moves the value into Finished Goods."
        actions={actions}
      />

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <RunStatusBadge status={run.status} />
        <span className="flex flex-wrap items-center gap-1.5 text-sm font-medium text-label2">
          <span className="num">{mediumDate(run.runDate)}</span>
          {run.coManName ? (
            <>
              <span aria-hidden className="size-[3px] rounded-full bg-label3" />
              {run.coManName}
            </>
          ) : null}
          {run.lotCode ? (
            <>
              <span aria-hidden className="size-[3px] rounded-full bg-label3" />
              Lot <span className="num">{run.lotCode}</span>
            </>
          ) : null}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-3.5 max-md:gap-3 sm:grid-cols-3">
        <Tile glyph="cube" tint="indigo" label="Good units" cap={run.product.unit} className="max-sm:col-span-2">
          <Figure>{run.goodUnits === 0 ? <span className="text-label2">—</span> : formatUnits(run.goodUnits)}</Figure>
          {run.unitsProduced > 0 ? (
            <div className="mt-auto flex flex-col gap-2">
              <SplitBar
                label={`${formatUnits(run.goodUnits)} good, ${formatUnits(run.unitsRejected)} rejected`}
                segments={[
                  { label: 'Good', value: run.goodUnits, tint: 'green' },
                  { label: 'Rejected', value: run.unitsRejected, tint: 'red', muted: true },
                ]}
              />
              <div aria-hidden className="flex justify-between gap-2">
                <LegendItem tint="green">
                  <span className="num">{formatUnits(run.goodUnits)}</span> good
                </LegendItem>
                <LegendItem tint="red">
                  <span className="num">{formatUnits(run.unitsRejected)}</span> rejected
                </LegendItem>
              </div>
            </div>
          ) : (
            <p className="mt-auto text-xs font-medium text-label2">
              {run.unitsPlanned === null ? 'Not recorded' : `${formatUnits(run.unitsPlanned)} planned`}
            </p>
          )}
        </Tile>
        <Tile glyph="doc" tint="teal" label="Landed cost" cap={`${run.landedCosts.length} ${run.landedCosts.length === 1 ? 'cost' : 'costs'}`}>
          <Figure>
            <Money cents={isOpen ? landed : run.totalCostCents} currency plain />
          </Figure>
          <p className="mt-auto text-xs font-medium text-label2">{isOpen ? 'Attached so far' : 'In Finished Goods'}</p>
        </Tile>
        <Tile glyph="tag" tint="green" label="Unit cost" cap={isOpen ? 'Preview' : undefined}>
          <Figure>{unitCost === null ? <span className="text-label2">—</span> : <Money cents={unitCost} currency plain />}</Figure>
          <p className="mt-auto text-xs font-medium text-label2">
            {isOpen ? 'If costed now' : `From ${mediumDate(run.costDate ?? run.runDate)}`}
          </p>
        </Tile>
      </div>

      <div className="grid items-start gap-3.5 max-md:gap-3 xl:grid-cols-2">
        <LandedCostsCard run={run} canManage={canManage} />
        {isOpen ? <CostingCard run={run} canManage={canManage} /> : <CostedSummary run={run} />}
      </div>

      {run.notes ? (
        <section className="rounded-2xl bg-card px-5 py-3.5 shadow-card max-md:rounded-[22px]">
          <h2 className="text-xs font-semibold text-label2">Notes</h2>
          <p className="mt-1 max-w-prose text-sm">{run.notes}</p>
        </section>
      ) : null}
    </div>
  );
}

function Tile({
  glyph,
  tint,
  label,
  cap,
  className,
  children,
}: {
  glyph: GlyphName;
  tint: Tint;
  label: string;
  cap?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={cn("flex min-h-[136px] min-w-0 flex-col gap-2 rounded-2xl bg-card px-[18px] py-4 shadow-card max-md:min-h-0 max-md:rounded-[22px] max-md:p-3.5", className)}>
      <div className="flex min-w-0 items-center gap-2 text-sm font-semibold max-md:text-lg">
        <IconBadge glyph={glyph} tint={tint} />
        <h2 className="truncate">{label}</h2>
        {cap ? (
          <span className="ml-auto shrink-0 rounded-[6px] bg-fill2 px-[7px] py-0.5 text-2xs font-semibold text-label2">{cap}</span>
        ) : null}
      </div>
      {children}
    </section>
  );
}

function Figure({ children }: { children: ReactNode }) {
  return (
    <div className="num text-3xl leading-[1.1] font-bold tracking-[-0.028em] max-md:text-2xl max-md:tracking-[-0.022em]">
      {children}
    </div>
  );
}

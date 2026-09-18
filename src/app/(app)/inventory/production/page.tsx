import type { Metadata } from 'next';

import { NewRunDialog } from '@/components/inventory/new-run-dialog';
import { ComponentLegend, RunsTable, type RunsTableRow } from '@/components/inventory/runs-table';
import { StackBar } from '@/components/inventory/stack-bar';
import { COMPONENT_KEYS, COMPONENT_LABELS, COMPONENT_STYLE, type CostComponentKey } from '@/components/inventory/types';
import { PageToolbar } from '@/components/shell/page-toolbar';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { IconBadge } from '@/components/ui/icon-badge';
import { GroupRow, InsetGroup } from '@/components/ui/inset-group';
import { Money } from '@/components/ui/money';
import { ToolbarGroup } from '@/components/ui/toolbar';
import { can } from '@/lib/auth/roles';
import { requireCapability } from '@/lib/auth/session';
import { categoryForCode } from '@/lib/ui/categories';

import {
  bankQueueInventory,
  productOptions,
  productionRunRows,
  runComponentTotals,
  stockBalances,
  vendorOptions,
} from '../queries';

export const metadata: Metadata = {
  title: 'Production Runs',
};

export const dynamic = 'force-dynamic';

/** The next run number: one past the highest `R-###` in use, else R-001. */
function nextRunNo(runNos: readonly string[]): string {
  const numbers = runNos.map((no) => /^R-(\d+)$/i.exec(no)?.[1]).filter((n): n is string => n !== undefined);
  const next = numbers.length === 0 ? 1 : Math.max(...numbers.map(Number)) + 1;
  return `R-${String(next).padStart(3, '0')}`;
}

export default async function ProductionPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [user, params, runs, products, vendors, stock, queue, split] = await Promise.all([
    requireCapability('reports.view'),
    searchParams,
    productionRunRows(),
    productOptions(),
    vendorOptions(),
    stockBalances(),
    bankQueueInventory(),
    runComponentTotals(),
  ]);
  const canManage = can(user.role, 'inventory.manage');
  const openNew = canManage && params.new === '1';
  const open = runs.filter((r) => r.status === 'open').length;

  const rows: RunsTableRow[] = runs.map((r) => ({ ...r, components: split.get(r.id) ?? {} }));
  const totals: Partial<Record<CostComponentKey, number>> = {};
  for (const r of rows) {
    for (const k of COMPONENT_KEYS) totals[k] = (totals[k] ?? 0) + (r.components[k] ?? 0);
  }
  const landed = rows.reduce((sum, r) => sum + r.landedCostCents, 0);

  const dialog = (trigger: 'button' | 'toolbar', defaultOpen: boolean) => (
    <NewRunDialog
      products={products}
      vendors={vendors}
      suggestedRunNo={nextRunNo(runs.map((r) => r.runNo))}
      defaultOpen={defaultOpen}
      trigger={trigger}
    />
  );

  return (
    <div className="flex flex-col gap-3.5 max-md:gap-3">
      <PageToolbar
        title="Production runs"
        back={{ href: '/inventory', label: 'Inventory' }}
        phoneTitleRow
        subtitle={
          runs.length > 0 ? (
            <span className="num">
              {runs.length} {runs.length === 1 ? 'run' : 'runs'}
              {open > 0 ? ` · ${open} open` : ''}
            </span>
          ) : undefined
        }
        info="Each run gathers the tolling, materials and freight that went into one batch, then strikes the unit cost and moves the value into Finished Goods."
        actions={canManage && runs.length > 0 ? <ToolbarGroup>{dialog('toolbar', openNew)}</ToolbarGroup> : undefined}
      />

      {runs.length === 0 ? (
        <>
          <Card>
            <EmptyState
              glyph="wrench"
              title="No production runs yet"
              description="Create the first production run when the co-packer runs; attach the materials it consumed and the tolling invoice, and costing the run moves that value into Finished Goods."
              action={canManage ? dialog('button', openNew) : undefined}
            />
          </Card>
          <InsetGroup header="Materials on hand" separatorInset={50}>
            {stock.map((s) => {
              const c = categoryForCode(s.code);
              return (
                <GroupRow
                  key={s.code}
                  label={
                    <span className="flex items-center gap-3">
                      <IconBadge glyph={c.glyph} tint={c.tint} size="lg" />
                      {c.label}
                    </span>
                  }
                >
                  <Money cents={s.cents} currency plain className="font-semibold text-label" />
                </GroupRow>
              );
            })}
            <GroupRow
              href="/banking/review"
              label={
                <span className="flex items-center gap-3">
                  <IconBadge glyph="tray" tint="orange" size="lg" />
                  In review
                </span>
              }
            >
              <Money cents={queue.totalCents} currency plain className="font-semibold text-label" />
            </GroupRow>
          </InsetGroup>
        </>
      ) : (
        <>
          <Card className="px-5 pt-[18px] pb-4 max-md:p-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-sm font-semibold text-label2">Landed cost</h2>
                <Money
                  cents={landed}
                  currency
                  plain
                  className="mt-0.5 block text-[2.5rem] leading-[1.05] font-bold tracking-[-0.03em] max-md:text-[2.125rem]"
                />
              </div>
            </div>
            <StackBar
              className="mt-4"
              height={12}
              label="Landed cost by component, all runs"
              segments={COMPONENT_KEYS.map((k) => ({
                key: k,
                label: COMPONENT_LABELS[k],
                cents: totals[k] ?? 0,
                tint: COMPONENT_STYLE[k].tint,
              }))}
            />
            <div className="mt-3">
              <ComponentLegend totals={totals} />
            </div>
          </Card>
          <RunsTable rows={rows} />
        </>
      )}
    </div>
  );
}

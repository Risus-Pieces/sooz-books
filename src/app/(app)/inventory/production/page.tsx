import type { Metadata } from 'next';
import { Factory } from 'lucide-react';

import { NewRunDialog } from '@/components/inventory/new-run-dialog';
import { RunsTable } from '@/components/inventory/runs-table';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { formatCents, Money } from '@/components/ui/money';
import { PageHeader } from '@/components/ui/page-header';
import { can } from '@/lib/auth/roles';
import { requireCapability } from '@/lib/auth/session';

import { bankQueueInventory, productOptions, productionRunRows, stockBalances, vendorOptions } from '../queries';

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
  const [user, params, runs, products, vendors, stock, queue] = await Promise.all([
    requireCapability('reports.view'),
    searchParams,
    productionRunRows(),
    productOptions(),
    vendorOptions(),
    stockBalances(),
    bankQueueInventory(),
  ]);
  const canManage = can(user.role, 'inventory.manage');
  const openNew = canManage && params.new === '1';
  const stockCents = stock.reduce((sum, s) => sum + s.cents, 0);
  const open = runs.filter((r) => r.status === 'open').length;

  const dialog = (trigger: 'button' | 'none', defaultOpen: boolean) => (
    <NewRunDialog
      products={products}
      vendors={vendors}
      suggestedRunNo={nextRunNo(runs.map((r) => r.runNo))}
      defaultOpen={defaultOpen}
      trigger={trigger}
    />
  );

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        eyebrow="Inventory"
        title="Production runs"
        description="Each run gathers the tolling, materials and freight that went into one batch, then strikes the unit cost and moves the value into Finished Goods."
        meta={
          runs.length > 0 ? (
            <>
              <Badge tone="outline">{runs.length} runs</Badge>
              {open > 0 ? <Badge tone="info">{open} open</Badge> : null}
            </>
          ) : null
        }
        actions={canManage && runs.length > 0 ? dialog('button', openNew) : null}
      />

      {runs.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Factory />}
            title="No production runs yet"
            description={
              stockCents > 0 || queue.totalCents > 0
                ? `Sooz has ${formatCents(stockCents + queue.totalCents, { currency: true })} of ingredients and packaging on hand or waiting in the bank queue, and nothing has been made from it yet. Create the first production run when the co-packer runs; attach the materials it consumed and the tolling invoice, and costing the run moves that value into Finished Goods.`
                : 'Create the first production run when the co-packer runs; attach the materials it consumed and the tolling invoice, and costing the run moves that value into Finished Goods.'
            }
            action={canManage ? <span>{dialog('button', openNew)}</span> : undefined}
          />
          <dl className="grid grid-cols-2 gap-3 border-t border-border px-4 py-3 sm:grid-cols-3">
            {stock.map((s) => (
              <div key={s.code}>
                <dt className="eyebrow">
                  <span className="num">{s.code}</span> {s.name}
                </dt>
                <dd className="mt-1 text-sm">
                  <Money cents={s.cents} currency plain />
                </dd>
              </div>
            ))}
            <div>
              <dt className="eyebrow">In the bank queue</dt>
              <dd className="mt-1 text-sm">
                <Money cents={queue.totalCents} currency plain />
              </dd>
            </div>
          </dl>
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <RunsTable rows={runs} />
        </Card>
      )}
    </div>
  );
}


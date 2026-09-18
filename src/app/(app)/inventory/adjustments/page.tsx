import type { Metadata } from 'next';
import Link from 'next/link';
import { PackageMinus } from 'lucide-react';

import { AdjustmentForm } from '@/components/inventory/adjustment-form';
import { Table, TableScroll, Td, Th } from '@/components/inventory/table';
import { formatUnits, REASON_LABELS, STAGE_LABELS, type AdjustmentReasonKey } from '@/components/inventory/types';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Money } from '@/components/ui/money';
import { PageHeader } from '@/components/ui/page-header';
import { can } from '@/lib/auth/roles';
import { requireCapability } from '@/lib/auth/session';

import { adjustmentRows, channelOptions, productOptions } from '../queries';

export const metadata: Metadata = {
  title: 'Adjustments',
};

export const dynamic = 'force-dynamic';

/**
 * Stock that leaves other than by sale — spoilage, samples, demo pours,
 * write-offs — and counts that come back higher than the books.
 */
export default async function AdjustmentsPage() {
  const [user, rows, products, channels] = await Promise.all([
    requireCapability('reports.view'),
    adjustmentRows(),
    productOptions(),
    channelOptions(),
  ]);
  const canManage = can(user.role, 'inventory.manage');
  const total = rows.reduce((sum, r) => sum + r.valueCents, 0);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        eyebrow="Inventory"
        title="Adjustments"
        description="Samples, demo product and donations go to 5070; spoilage, damage and anything lost or miscounted to 5060. Each adjustment posts one entry, shown in full before it posts."
      />

      {canManage ? (
        products.length === 0 ? (
          <Card>
            <EmptyState
              icon={<PackageMinus />}
              title="No products to adjust yet"
              description="Adjustments are recorded against a product. Products are added when the first production run is created or when a Peasy count is imported."
              action={
                <Button asChild size="sm">
                  <Link href="/inventory/production?new=1">Create the first production run</Link>
                </Button>
              }
            />
          </Card>
        ) : (
          <AdjustmentForm products={products} channels={channels} />
        )
      ) : null}

      <Card className="min-w-0 overflow-hidden">
        <CardHeader>
          <CardTitle>Posted adjustments</CardTitle>
          {rows.length > 0 ? <Money cents={total} currency signed plain className="text-sm font-semibold" /> : null}
        </CardHeader>
        {rows.length === 0 ? (
          <p className="px-4 py-6 text-xs text-muted-foreground">
            No adjustment has been posted. Samples handed out at a tasting or a case that spoiled at the co-packer are
            recorded above, at the unit cost the product carries on the day.
          </p>
        ) : (
          <TableScroll>
            <Table caption="Posted adjustments" className="min-w-[48rem]">
              <thead>
                <tr>
                  <Th>Number</Th>
                  <Th>Date</Th>
                  <Th>SKU</Th>
                  <Th>Reason</Th>
                  <Th>Stage</Th>
                  <Th align="right">Quantity</Th>
                  <Th align="right">Value</Th>
                  <Th>Entry</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="rule-row">
                    <Td className="num whitespace-nowrap">{r.adjustmentNo}</Td>
                    <Td className="num whitespace-nowrap text-muted-foreground">{r.date}</Td>
                    <Td className="num">{r.sku}</Td>
                    <Td>
                      {REASON_LABELS[r.reason as AdjustmentReasonKey] ?? r.reason}
                      {r.memo ? <span className="ml-2 text-xs text-muted-foreground">{r.memo}</span> : null}
                    </Td>
                    <Td className="text-muted-foreground">{STAGE_LABELS[r.stage]}</Td>
                    <Td align="right" className="num">
                      {formatUnits(r.quantity)}
                    </Td>
                    <Td align="right">
                      <Money cents={r.valueCents} signed />
                    </Td>
                    <Td className="text-xs">
                      {r.entry ? (
                        <Link href={`/ledger/${r.entry.id}`} className="num text-primary hover:underline">
                          #{r.entry.entryNo}
                        </Link>
                      ) : (
                        '—'
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </TableScroll>
        )}
      </Card>
    </div>
  );
}

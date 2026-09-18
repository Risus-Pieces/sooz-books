import type { Metadata } from 'next';
import Link from 'next/link';

import { CategoryBars, type CategoryBarRow } from '@/components/charts';
import { AdjustmentSheet } from '@/components/inventory/adjustment-form';
import {
  formatUnits,
  REASON_KEYS,
  REASON_LABELS,
  REASON_STYLE,
  STAGE_LABELS,
  type AdjustmentReasonKey,
} from '@/components/inventory/types';
import { PageToolbar } from '@/components/shell/page-toolbar';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { IconBadge } from '@/components/ui/icon-badge';
import { InsetGroup, ListRow } from '@/components/ui/inset-group';
import { Money } from '@/components/ui/money';
import { ToolbarGroup } from '@/components/ui/toolbar';
import { can } from '@/lib/auth/roles';
import { requireCapability } from '@/lib/auth/session';
import { monthLong, shortDate } from '@/lib/ui/format';

import { adjustmentRows, channelOptions, productOptions } from '../queries';

export const metadata: Metadata = {
  title: 'Adjustments',
};

export const dynamic = 'force-dynamic';

function reasonKey(reason: string): AdjustmentReasonKey | null {
  return REASON_KEYS.find((r) => r === reason) ?? null;
}

/**
 * Stock that leaves other than by sale — spoilage, samples, demo pours, write-offs — and counts
 * that come back higher than the books. The value by reason first, then every adjustment by month.
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
  const canRecord = canManage && products.length > 0;

  const byReason = new Map<string, CategoryBarRow>();
  for (const r of rows) {
    const key = reasonKey(r.reason);
    const row = byReason.get(r.reason) ?? {
      key: r.reason,
      label: key ? REASON_LABELS[key] : r.reason,
      tint: key ? REASON_STYLE[key].tint : 'gray',
      cents: 0,
      count: 0,
    };
    row.cents += Math.abs(r.valueCents);
    row.count = (row.count ?? 0) + 1;
    byReason.set(r.reason, row);
  }
  const reasons = [...byReason.values()].sort((a, b) => b.cents - a.cents);

  const months = new Map<string, typeof rows>();
  for (const r of rows) {
    const key = r.date.slice(0, 7);
    months.set(key, [...(months.get(key) ?? []), r]);
  }

  return (
    <div className="flex flex-col gap-3.5 max-md:gap-3">
      <PageToolbar
        title="Adjustments"
        back={{ href: '/inventory', label: 'Inventory' }}
        phoneTitleRow
        subtitle={rows.length > 0 ? <Money cents={total} currency signed plain /> : undefined}
        info="Samples, demo product and donations go to 5070; spoilage, damage and anything lost or miscounted to 5060. Each adjustment posts one entry, shown in full before it posts, at the unit cost the product carries on the day."
        actions={
          canRecord ? (
            <ToolbarGroup>
              <AdjustmentSheet products={products} channels={channels} />
            </ToolbarGroup>
          ) : undefined
        }
      />

      {canManage && products.length === 0 ? (
        <Card>
          <EmptyState
            glyph="cube"
            title="No products yet"
            description="Adjustments are recorded against a product. Products are added when the first production run is created or when a Peasy count is imported."
            action={
              <Button asChild>
                <Link href="/inventory/production?new=1">New production run</Link>
              </Button>
            }
          />
        </Card>
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState
            glyph="cube"
            title="No adjustments yet"
            description="Samples handed out at a tasting or a case that spoiled at the co-packer are recorded here, at the unit cost the product carries on the day."
            action={canRecord ? <AdjustmentSheet products={products} channels={channels} trigger="button" /> : undefined}
          />
        </Card>
      ) : (
        <>
          <Card className="px-5 pt-[18px] pb-3 max-md:p-4">
            <div className="mb-1.5 flex items-center gap-2">
              <h2 className="flex-1 text-lg font-semibold tracking-[-0.01em]">By reason</h2>
              <Money cents={total} currency signed plain className="font-semibold" />
            </div>
            <CategoryBars rows={reasons} />
          </Card>

          {[...months.entries()].map(([key, list]) => (
            <InsetGroup key={key} header={`${monthLong(Number(key.slice(5, 7)))} ${key.slice(0, 4)}`} separatorInset={63}>
              {list.map((r) => {
                const reason = reasonKey(r.reason);
                const style = reason ? REASON_STYLE[reason] : { tint: 'gray' as const, glyph: 'ellipsis' as const };
                return (
                  <ListRow
                    key={r.id}
                    href={r.entry ? `/ledger/${r.entry.id}` : undefined}
                    chevron={r.entry !== null}
                    leading={<IconBadge glyph={style.glyph} tint={style.tint} size="xl" />}
                    title={
                      <>
                        {reason ? REASON_LABELS[reason] : r.reason}
                        <span className="num ml-2 text-xs font-medium text-label2">{r.sku}</span>
                      </>
                    }
                    subtitle={
                      <>
                        <span className="num">{formatUnits(r.quantity)}</span>
                        <span>{STAGE_LABELS[r.stage]}</span>
                        {r.memo ? <span className="truncate">· {r.memo}</span> : null}
                      </>
                    }
                    trailing={<Money cents={r.valueCents} currency signed plain />}
                    detail={
                      <span className="num">
                        {shortDate(r.date)} · {r.adjustmentNo}
                      </span>
                    }
                  />
                );
              })}
            </InsetGroup>
          ))}
        </>
      )}
    </div>
  );
}

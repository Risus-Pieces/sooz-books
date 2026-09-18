import type { ComponentProps, ReactNode } from 'react';
import type { Metadata } from 'next';
import Link from 'next/link';

import { CategoryBars, type CategoryBarRow } from '@/components/charts';
import { CostFlow, type FlowStation } from '@/components/inventory/cost-flow';
import { StageComparison, StageTable } from '@/components/inventory/stage-table';
import { periodLabel } from '@/components/inventory/types';
import { PageToolbar } from '@/components/shell/page-toolbar';
import { Button } from '@/components/ui/button';
import { Glyph } from '@/components/ui/glyph';
import { IconBadge } from '@/components/ui/icon-badge';
import { InfoButton } from '@/components/ui/info-button';
import { GroupRow, InsetGroup } from '@/components/ui/inset-group';
import { Money } from '@/components/ui/money';
import { ToolbarGroup, ToolbarLink } from '@/components/ui/toolbar';
import { can } from '@/lib/auth/roles';
import { requireCapability } from '@/lib/auth/session';
import { categoryForCode } from '@/lib/ui/categories';
import { shortDate } from '@/lib/ui/format';

import { overviewData } from './queries';

export const metadata: Metadata = {
  title: 'Inventory',
};

export const dynamic = 'force-dynamic';

/**
 * Inventory at a glance: what the ledger carries in each stage against what Peasy last counted,
 * drawn as two bars on one scale; where the cost of the product sits on its way to COGS; and what
 * the bank review queue will capitalise once approved.
 */
/** "468.00" → "468", "12.50" → "12.5": a batch's unit total without trailing zeros. */
function formatUnits(units: string): string {
  const [whole, fraction = ''] = units.split('.');
  const trimmed = fraction.replace(/0+$/, '');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return trimmed === '' ? grouped : `${grouped}.${trimmed}`;
}

export default async function InventoryPage() {
  const [user, data] = await Promise.all([requireCapability('reports.view'), overviewData()]);
  const canManage = can(user.role, 'inventory.manage');

  const materials = data.stages
    .filter((s) => s.stage === 'raw' || s.stage === 'packaging')
    .reduce((sum, s) => sum + s.ledgerCents, 0);
  const finished = data.stages.find((s) => s.stage === 'finished')?.ledgerCents ?? 0;
  const ledgerTotal = data.stages.reduce((sum, s) => sum + s.ledgerCents, 0) + data.reserveCents;
  const pending = data.bankQueue.totalCents;
  const noRuns = data.runs.open + data.runs.costed === 0;
  const latest = data.runs.latest;
  const draft = data.cogs.latestDraft;

  const stations: FlowStation[] = [
    {
      key: 'materials',
      title: 'Materials',
      glyph: 'leaf',
      tint: 'teal',
      accounts: '1320 · 1330',
      cents: materials,
      caption:
        pending > 0 ? (
          <>
            +<Money cents={pending} currency plain /> in review
          </>
        ) : (
          'Held at cost'
        ),
      state: 'waiting',
      href: pending > 0 ? '/banking/review' : '/inventory/valuation',
    },
    {
      key: 'production',
      title: 'Production',
      glyph: 'wrench',
      tint: 'orange',
      accounts: 'Co-packer',
      cents: null,
      figure: noRuns ? 'No runs' : <span className="num">{data.runs.open} open</span>,
      caption: latest ? `${latest.runNo} · ${shortDate(latest.runDate)}` : 'None yet',
      state: 'waiting',
      href: noRuns && canManage ? '/inventory/production?new=1' : '/inventory/production',
    },
    {
      key: 'finished',
      title: 'Finished',
      glyph: 'tag',
      tint: 'indigo',
      accounts: '1310',
      cents: finished,
      caption: data.runs.costed > 0 ? `${data.runs.costed} costed ${data.runs.costed === 1 ? 'run' : 'runs'}` : 'Nothing costed',
      state: 'waiting',
      href: '/inventory/production',
    },
    {
      key: 'cogs',
      title: 'COGS',
      glyph: 'truck',
      tint: 'cyan',
      accounts: '5010–5040',
      cents: data.cogs.lastPosted?.cogsCents ?? null,
      // A drafted month is shipped product waiting to post: say how much, not "nothing shipped".
      figure: data.cogs.lastPosted
        ? undefined
        : draft
          ? <span className="num">{formatUnits(draft.units)} units</span>
          : 'Nothing shipped',
      caption: data.cogs.lastPosted
        ? `${periodLabel(data.cogs.lastPosted.year, data.cogs.lastPosted.month)}${draft ? ` · ${periodLabel(draft.year, draft.month)} draft` : ''}`
        : draft
          ? `${periodLabel(draft.year, draft.month)} · Draft`
          : 'None posted',
      state: 'waiting',
      href: draft ? `/inventory/cogs?batch=${draft.id}` : '/inventory/cogs',
    },
  ];

  // The first station with work outstanding is the next thing to do; the ones before it are behind us.
  const current =
    materials === 0 && pending > 0 ? 'materials' : noRuns || data.runs.open > 0 || finished === 0 ? 'production' : 'cogs';
  const currentIndex = stations.findIndex((s) => s.key === current);
  stations.forEach((station, index) => {
    station.state = index < currentIndex ? 'done' : index === currentIndex ? 'current' : 'waiting';
  });

  const queueRows: CategoryBarRow[] = data.bankQueue.byAccount.map((row) => {
    const category = categoryForCode(row.code);
    return {
      key: row.code,
      label: row.name,
      tint: category.tint,
      cents: row.cents,
      count: row.count,
      href: '/banking/review',
    };
  });

  const snapshot = data.snapshot;
  const variance = snapshot?.varianceCents ?? 0;

  return (
    <div className="flex flex-col gap-3.5 max-md:gap-3">
      <PageToolbar
        title="Inventory"
        subtitle={<>As of {shortDate(data.asOf)}</>}
        info={
          <>
            <p>
              What the ledger carries in each stage of inventory, against what Peasy last counted, and where the cost of
              the product sits on its way to cost of goods sold.
            </p>
            <p>Materials capitalise as their bank lines and bills are approved; costing a production run moves them into finished goods; shipping relieves finished goods to COGS each month.</p>
          </>
        }
        actions={
          canManage ? (
            <ToolbarGroup>
              <ToolbarLink href="/inventory/valuation" glyph="import" label="Import Peasy count" />
              <ToolbarLink href="/inventory/production?new=1" glyph="plus" label="New production run" />
            </ToolbarGroup>
          ) : undefined
        }
      />

      <div className="grid gap-3.5 max-md:gap-3 lg:grid-cols-12">
        {/* Value by stage, ledger against count */}
        <section className="min-w-0 rounded-2xl bg-card shadow-card max-md:rounded-[22px] lg:col-span-8">
          <div className="px-5 pt-[18px] pb-4 max-md:p-4">
            <div className="mb-4 flex items-start justify-between gap-4">
              <div>
                <h2 className="flex items-center gap-1 text-sm font-semibold text-label2">
                  Value
                  <InfoButton label="About inventory value" align="start">
                    <p>The ledger balance of each inventory account today: raw ingredients (1320), packaging (1330) and finished goods (1310).</p>
                    <p>Hatched: ingredient and packaging purchases still in the bank review queue. They are not on the books until each line is approved.</p>
                  </InfoButton>
                </h2>
                <Money
                  cents={ledgerTotal}
                  currency
                  plain
                  className="mt-0.5 block text-5xl leading-[1.05] font-bold tracking-[-0.03em] max-md:text-[2.5rem]"
                />
              </div>
              {pending > 0 ? (
                <Link
                  href="/banking/review"
                  className="mt-1 inline-flex shrink-0 items-center gap-1 rounded-full bg-fill2 px-2.5 py-1 text-xs font-semibold text-label2 hover:text-label"
                >
                  <Glyph name="tray" size={13} />+<Money cents={pending} currency plain whole />
                  <span className="max-sm:hidden">in review</span>
                </Link>
              ) : null}
            </div>
            <StageComparison rows={data.stages} snapshotDate={snapshot?.date ?? null} pendingCents={pending} />
          </div>
          <div className="hairline-t pb-1 max-md:hidden">
            <StageTable rows={data.stages} reserveCents={data.reserveCents} snapshotDate={snapshot?.date ?? null} asOf={data.asOf} />
          </div>
        </section>

        {/* Tie-out status */}
        <section className="flex min-w-0 flex-col rounded-2xl bg-card px-5 pt-[18px] pb-4 shadow-card max-md:rounded-[22px] max-md:p-4 lg:col-span-4">
          <div className="mb-2 flex items-center gap-2">
            <h2 className="flex-1 text-lg font-semibold tracking-[-0.01em]">Count</h2>
            <InfoButton label="About the count">
              <p>Peasy is the record of how many; the ledger is the record of what they cost. Import Peasy’s inventory export at month end and the tie-out compares the two, account by account.</p>
            </InfoButton>
          </div>
          <div className="flex flex-1 flex-col items-center justify-center gap-2 py-4 text-center">
            <IconBadge
              glyph={snapshot === null ? 'doc-text' : variance === 0 ? 'check' : 'warning'}
              tint={snapshot === null ? 'gray' : variance === 0 ? 'green' : 'orange'}
              size="xl"
              className="size-14 rounded-[14px] [&_svg]:size-7"
            />
            <p className="text-xl font-bold tracking-[-0.02em]">
              {snapshot === null ? (
                'No count yet'
              ) : variance === 0 ? (
                'Ties'
              ) : (
                <>
                  Off by <Money cents={variance} currency signed plain />
                </>
              )}
            </p>
            {snapshot !== null ? <p className="text-sm font-medium text-label2">{shortDate(snapshot.date)}</p> : null}
          </div>
          {snapshot !== null ? (
            <dl className="mb-3 grid rounded-[11px] bg-inset">
              <div className="flex h-9 items-center justify-between px-3">
                <dt className="font-medium text-label2">Peasy</dt>
                <dd className="font-semibold">
                  <Money cents={snapshot.snapshotCents} currency plain />
                </dd>
              </div>
              <div className="flex h-9 items-center justify-between hairline-t px-3">
                <dt className="font-medium text-label2">Ledger</dt>
                <dd className="font-semibold">
                  <Money cents={snapshot.ledgerCents} currency plain />
                </dd>
              </div>
            </dl>
          ) : null}
          <Button asChild variant={snapshot !== null && variance !== 0 ? 'default' : 'secondary'} className="w-full">
            <Link href="/inventory/valuation">
              {snapshot === null ? (canManage ? 'Import a count' : 'Valuation') : variance === 0 ? 'Valuation' : 'Review tie-out'}
            </Link>
          </Button>
        </section>
      </div>

      <section aria-labelledby="flow-heading" className="flex flex-col">
        <h2 id="flow-heading" className="px-4 pt-2 pb-1.5 text-sm font-semibold text-label2 max-md:px-1 max-md:pt-4 max-md:pb-2 max-md:text-xl max-md:font-bold max-md:tracking-[-0.02em] max-md:text-label">
          Cost flow
        </h2>
        <CostFlow stations={stations} />
      </section>

      <div className="grid gap-3.5 max-md:gap-3 lg:grid-cols-12">
        <section className="min-w-0 lg:col-span-8">
          <h2 className="px-1 pt-4 pb-2 text-xl font-bold tracking-[-0.02em] md:hidden">In review</h2>
          <div className="rounded-2xl bg-card px-5 pt-[18px] pb-3 lg:h-full shadow-card max-md:rounded-[22px] max-md:p-4 max-md:pt-2">
            <div className="mb-1.5 flex items-center gap-2 max-md:hidden">
              <h2 className="flex-1 text-lg font-semibold tracking-[-0.01em]">In review</h2>
              <Money cents={pending} currency plain className="font-semibold" />
              <Link
                href="/banking/review"
                aria-label="Open review"
                className="grid size-6 place-items-center rounded-full text-label3 hover:text-label2"
              >
                <Glyph name="chevron-right" size={14} weight={2.2} />
              </Link>
            </div>
            {queueRows.length === 0 ? (
              <p className="flex items-center justify-center gap-2 py-8 text-sm font-medium text-label2">
                <Glyph name="check-circle" size={16} />
                Nothing waiting
              </p>
            ) : (
              <>
                <div className="max-md:hidden">
                  <CategoryBars rows={queueRows} />
                </div>
                <div className="md:hidden">
                  <CategoryBars rows={queueRows} size="lg" />
                </div>
              </>
            )}
          </div>
        </section>

        <InsetGroup header="Inventory" className="min-w-0 lg:col-span-4 lg:-mt-5" separatorInset={50}>
          <NavRow href="/inventory/valuation" glyph="doc-text" tint="blue" label="Valuation">
            {snapshot ? shortDate(snapshot.date) : 'No count'}
          </NavRow>
          <NavRow href="/inventory/production" glyph="wrench" tint="orange" label="Production runs">
            <span className="num">{data.runs.open + data.runs.costed}</span>
          </NavRow>
          <NavRow href="/inventory/cogs" glyph="truck" tint="cyan" label="COGS">
            <span className="num">
              {data.shipmentsMonths} {data.shipmentsMonths === 1 ? 'month' : 'months'}
            </span>
          </NavRow>
          <NavRow href="/inventory/adjustments" glyph="minus" tint="red" label="Adjustments">
            <span className="num">{data.adjustments}</span>
          </NavRow>
          <NavRow href="/reports/margin" glyph="percent" tint="green" label="Gross margin">
            <span className="num">
              {data.productCount} {data.productCount === 1 ? 'product' : 'products'}
            </span>
          </NavRow>
        </InsetGroup>
      </div>
    </div>
  );
}

function NavRow({
  href,
  glyph,
  tint,
  label,
  children,
}: {
  href: string;
  glyph: ComponentProps<typeof IconBadge>['glyph'];
  tint: ComponentProps<typeof IconBadge>['tint'];
  label: string;
  children: ReactNode;
}) {
  return (
    <GroupRow
      href={href}
      label={
        <span className="flex items-center gap-3">
          <IconBadge glyph={glyph} tint={tint} size="lg" />
          {label}
        </span>
      }
    >
      {children}
    </GroupRow>
  );
}

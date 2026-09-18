import type { Metadata } from 'next';

import { BudgetControls } from '@/components/planning/budget-controls';
import { BudgetGrid } from '@/components/planning/budget-grid';
import { NavPopUp } from '@/components/planning/nav-pop-up';
import { PlanTabs } from '@/components/planning/plan-tabs';
import { Caveats } from '@/components/ui/caveats';
import { VarianceTable } from '@/components/planning/variance-table';
import { PageToolbar } from '@/components/shell/page-toolbar';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Glyph } from '@/components/ui/glyph';
import { IconBadge, LegendItem } from '@/components/ui/icon-badge';
import { InfoButton } from '@/components/ui/info-button';
import { Money } from '@/components/ui/money';
import { can } from '@/lib/auth/roles';
import { requireCapability } from '@/lib/auth/session';
import { cn } from '@/lib/cn';
import { dateParts, monthEnd, today } from '@/lib/dates';
import { dollars } from '@/lib/ui/format';
import type { GlyphName } from '@/lib/ui/glyphs';
import type { Tint } from '@/lib/ui/tints';

import {
  budgetAccounts,
  budgetGrid,
  budgetVersionOptions,
  budgetVsActualFor,
  contraRevenueAccountIds,
  varianceRows,
} from '../queries';

export const metadata: Metadata = {
  title: 'Budget',
};

export const dynamic = 'force-dynamic';

type SearchParams = Record<string, string | string[] | undefined>;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

const STATUS_TONE = { active: 'positive', draft: 'info', archived: 'neutral' } as const;
const STATUS_LABEL = { active: 'Active', draft: 'Draft', archived: 'Archived' } as const;

/** The window a variance period names, inside the version's fiscal year. */
function windowFor(period: string, year: number): { from: string; to: string; label: string } {
  const now = today();
  const { year: thisYear, month: thisMonth } = dateParts(now);
  if (/^(0[1-9]|1[0-2])$/.test(period)) {
    const m = Number(period);
    const from = `${year}-${period}-01`;
    return { from, to: monthEnd(from), label: `${MONTHS[m - 1]} ${year}` };
  }
  if (period === 'year' || year !== thisYear) {
    return { from: `${year}-01-01`, to: `${year}-12-31`, label: `Full year ${year}` };
  }
  return { from: `${year}-01-01`, to: monthEnd(`${year}-${String(thisMonth).padStart(2, '0')}-01`), label: `Jan–${MONTHS[thisMonth - 1]} ${year}` };
}

export default async function BudgetPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const [user, params] = await Promise.all([requireCapability('reports.view'), searchParams]);
  const canEdit = can(user.role, 'ledger.close');
  const thisYear = dateParts(today()).year;

  const versions = await budgetVersionOptions();
  const requested = one(params.version);
  const version =
    versions.find((v) => v.id === requested) ??
    versions.find((v) => v.fiscalYear === thisYear && v.status === 'active') ??
    versions.find((v) => v.status !== 'archived') ??
    versions[0] ??
    null;
  const tab = one(params.tab) === 'variance' ? 'variance' : 'grid';
  const period = one(params.period) ?? 'ytd';
  const base = version === null ? '/plan/budget' : `/plan/budget?version=${version.id}`;
  const join = version === null ? '?' : '&';

  return (
    <div className="flex flex-col gap-3.5 max-md:gap-3">
      <PageToolbar
        title={tab === 'variance' ? 'Budget vs actual' : 'Budget'}
        phoneTitleRow
        subtitle={
          version === null ? undefined : (
            <>
              <span className="num">{version.fiscalYear}</span>
              <Badge tone={STATUS_TONE[version.status]}>{STATUS_LABEL[version.status]}</Badge>
            </>
          )
        }
        info="The plan for the year by account and month, and how the posted books are tracking against it."
        actions={canEdit ? <BudgetControls version={version} defaultYear={thisYear} canEdit={canEdit} /> : undefined}
      />

      <div className="flex flex-wrap items-center gap-2">
        <PlanTabs
          current={tab === 'variance' ? 'variance' : 'budget'}
          budgetHref={base}
          varianceHref={version === null ? null : `${base}${join}tab=variance`}
        />
        <span className="flex-1" />
        {versions.length > 1 && version !== null ? (
          <NavPopUp
            aria-label="Budget version"
            value={version.id}
            options={versions.map((v) => ({
              value: v.id,
              label: `${v.name} · ${v.fiscalYear}${v.status === 'archived' ? ' (archived)' : ''}`,
              href: `/plan/budget?version=${v.id}${tab === 'variance' ? '&tab=variance' : ''}`,
              tint: v.status === 'active' ? 'green' : undefined,
            }))}
          />
        ) : null}
      </div>

      {version === null ? (
        <Card>
          <EmptyState
            glyph="target"
            title="No budget yet"
            description={
              canEdit
                ? `Start one with New budget in the toolbar. Then type figures into the grid, import a spreadsheet, or copy a year of posted actuals into ${thisYear}. Budget vs actual needs one to compare against.`
                : `No one has set a ${thisYear} budget yet. Someone who closes the books starts one here; budget vs actual needs one to compare against.`
            }
          />
        </Card>
      ) : tab === 'grid' ? (
        <GridView versionId={version.id} name={version.name} year={version.fiscalYear} editable={canEdit && version.status !== 'archived'} />
      ) : (
        <VarianceView versionId={version.id} year={version.fiscalYear} period={period} base={`${base}${join}tab=variance`} />
      )}
    </div>
  );
}

async function GridView({ versionId, name, year, editable }: { versionId: string; name: string; year: number; editable: boolean }) {
  const [grid, accounts, contraIds] = await Promise.all([budgetGrid(versionId), budgetAccounts(), contraRevenueAccountIds()]);
  return (
    <div className="flex flex-col gap-3">
      <BudgetGrid
        versionId={versionId}
        versionName={name}
        fiscalYear={year}
        editable={editable}
        rows={grid.rows}
        accounts={accounts}
        contraIds={contraIds}
      />
      {grid.channelCells > 0 ? (
        <p className="flex items-center gap-1.5 px-1 text-xs font-medium text-label2">
          <Glyph name="storefront" size={13} />+<span className="num">{grid.channelCells}</span> by channel ·{' '}
          <Money cents={grid.channelTotalCents} currency plain />
          <InfoButton label="About channel cells" align="start">
            These cells are budgeted by channel. They count in budget vs actual and are changed by importing a file with a
            Channel column.
          </InfoButton>
        </p>
      ) : null}
    </div>
  );
}

async function VarianceView({ versionId, year, period, base }: { versionId: string; year: number; period: string; base: string }) {
  const window = windowFor(period, year);
  const report = await budgetVsActualFor(versionId, window.from, window.to);
  const rows = varianceRows(report);
  const { netSales, netIncome } = report.totals;
  const periods = [
    { key: 'ytd', label: 'Year to date' },
    { key: 'year', label: 'Full year' },
    ...MONTHS.map((m, i) => ({ key: String(i + 1).padStart(2, '0'), label: `${m} ${year}` })),
  ];

  return (
    <div className="flex flex-col gap-3.5 max-md:gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <NavPopUp
          aria-label="Period"
          value={periods.some((p) => p.key === period) ? period : 'ytd'}
          options={periods.map((p) => ({ value: p.key, label: p.label, href: `${base}&period=${p.key}` }))}
        />
        <span className="text-xs font-medium text-label2">{window.label}</span>
        <span className="flex-1" />
        <Caveats items={report.meta.warnings} label="note" />
      </div>

      <div className="grid gap-3.5 max-md:gap-3 sm:grid-cols-2">
        <VsTile glyph="tag" tint="green" label="Net sales" actual={netSales.actualCents} budget={netSales.budgetCents} />
        <VsTile glyph="chart" tint="indigo" label="Net income" actual={netIncome.actualCents} budget={netIncome.budgetCents} />
      </div>

      <Card className="min-w-0 overflow-hidden pt-3">
        <div className="flex flex-wrap items-center gap-2 px-5 pb-1 max-sm:px-4">
          <h2 className="flex-1 text-lg font-semibold tracking-[-0.01em]">By line</h2>
          <div className="flex gap-3.5">
            <LegendItem tint="green">Better</LegendItem>
            <LegendItem tint="red">Worse</LegendItem>
          </div>
        </div>
        {rows.length === 0 || rows.every((r) => r.style !== 'account') ? (
          <EmptyState
            glyph="chart"
            title="Nothing budgeted or posted"
            description="Budget lines appear here with their posted actuals. Bank lines still in the review queue are not actuals until they post."
          />
        ) : (
          <VarianceTable rows={rows} />
        )}
      </Card>
    </div>
  );
}

/** Actual against budget for one line: the figure, and a bar filled to the share of budget used. */
function VsTile({
  glyph,
  tint,
  label,
  actual,
  budget,
}: {
  glyph: GlyphName;
  tint: Tint;
  label: string;
  actual: number;
  budget: number;
}) {
  const variance = actual - budget;
  const scale = Math.max(Math.abs(actual), Math.abs(budget), 1);
  return (
    <section className="flex min-w-0 flex-col gap-2 rounded-2xl bg-card px-[18px] py-4 shadow-card max-md:rounded-[22px] max-md:p-3.5">
      <div className="flex min-w-0 items-center gap-2 text-sm font-semibold max-md:text-lg">
        <IconBadge glyph={glyph} tint={tint} />
        <h2 className="truncate">{label}</h2>
        <Money
          cents={variance}
          currency
          signed
          plain
          className={cn('ml-auto text-xs font-semibold', variance > 0 ? 'text-ink-green' : variance < 0 ? 'text-ink-red' : 'text-label2')}
        />
      </div>
      <Money cents={actual} currency plain className="block text-3xl leading-[1.1] font-bold tracking-[-0.028em] max-md:text-2xl" />
      <div className="mt-1 flex flex-col gap-1.5">
        <Bar label="Actual" cents={actual} scale={scale} tint={tint} />
        <Bar label="Budget" cents={budget} scale={scale} tint="gray" />
      </div>
      <p className="sr-only">
        Actual {dollars(actual)} against a budget of {dollars(budget)}.
      </p>
    </section>
  );
}

function Bar({ label, cents, scale, tint }: { label: string; cents: number; scale: number; tint: Tint }) {
  const width = Math.round((Math.abs(cents) / scale) * 1000) / 10;
  return (
    <div aria-hidden className="grid grid-cols-[3.25rem_minmax(0,1fr)_auto] items-center gap-2 text-xs font-medium text-label2">
      <span>{label}</span>
      <span className="block h-2 rounded-full bg-fill2">
        {cents === 0 ? null : (
          <span
            className={cn('block h-full min-w-1 rounded-full', cents < 0 && 'opacity-60')}
            style={{ width: `${width}%`, background: `var(--${tint})` }}
          />
        )}
      </span>
      <Money cents={cents} currency plain whole className="min-w-[4.5rem] text-right text-label" />
    </div>
  );
}

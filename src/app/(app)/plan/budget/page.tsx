import type { Metadata } from 'next';
import Link from 'next/link';
import { Target } from 'lucide-react';

import { LinkTabs } from '@/components/banking/link-tabs';
import { BudgetControls } from '@/components/planning/budget-controls';
import { BudgetGrid } from '@/components/planning/budget-grid';
import { VarianceTable } from '@/components/planning/variance-table';
import { Badge } from '@/components/ui/badge';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Money } from '@/components/ui/money';
import { PageHeader } from '@/components/ui/page-header';
import { StatTile } from '@/components/ui/stat-tile';
import { can } from '@/lib/auth/roles';
import { requireCapability } from '@/lib/auth/session';
import { dateParts, monthEnd, today } from '@/lib/dates';
import { cn } from '@/lib/cn';

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
    <div className="flex flex-col gap-5">
      <PageHeader
        eyebrow="Plan"
        title="Budget"
        description="The plan for the year by account and month, and how the posted books are tracking against it."
        meta={
          version === null ? null : (
            <>
              <Badge tone="outline">
                {version.name} · {version.fiscalYear}
              </Badge>
              <Badge tone={STATUS_TONE[version.status]}>{version.status}</Badge>
            </>
          )
        }
        actions={<BudgetControls version={version} defaultYear={thisYear} canEdit={canEdit} />}
        tabs={
          <LinkTabs
            label="Plan"
            tabs={[
              { href: '/plan/forecast', label: 'Cash forecast', active: false },
              { href: base, label: 'Budget', active: tab === 'grid' },
              ...(version === null
                ? []
                : [{ href: `${base}${join}tab=variance`, label: 'Budget vs actual', active: tab === 'variance' }]),
            ]}
          />
        }
      />

      {versions.length > 1 ? (
        <nav aria-label="Budget versions" className="-mt-2 flex flex-wrap items-center gap-1.5">
          <span className="eyebrow mr-1">Versions</span>
          {versions.map((v) => (
            <Link
              key={v.id}
              href={`/plan/budget?version=${v.id}${tab === 'variance' ? '&tab=variance' : ''}`}
              aria-current={v.id === version?.id ? 'page' : undefined}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-sm border px-2 py-0.5 text-xs transition-colors',
                v.id === version?.id
                  ? 'border-primary/50 bg-primary/8 text-foreground'
                  : 'border-border text-muted-foreground hover:border-border-strong hover:text-foreground',
              )}
            >
              <span className="num">{v.fiscalYear}</span>
              {v.name}
              {v.status === 'active' ? <span className="size-1.5 rounded-full bg-positive" aria-label="active" /> : null}
              {v.status === 'archived' ? <span className="text-2xs">(archived)</span> : null}
            </Link>
          ))}
        </nav>
      ) : null}

      {version === null ? (
        <Card>
          <EmptyState
            icon={<Target />}
            title="No budget yet"
            description={
              canEdit
                ? `Start one with New budget at the top of this page. Then type figures into the grid, import a spreadsheet, or copy a year of posted actuals into ${thisYear}. Budget vs actual needs one to compare against.`
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
        <p className="text-xs text-muted-foreground">
          {grid.channelCells} more {grid.channelCells === 1 ? 'cell is' : 'cells are'} budgeted by channel (
          <Money cents={grid.channelTotalCents} currency plain />
          ). They count in budget vs actual and are changed by importing a file with a Channel column.
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
    ...MONTHS.map((m, i) => ({ key: String(i + 1).padStart(2, '0'), label: m })),
  ];

  return (
    <div className="flex flex-col gap-4">
      <nav aria-label="Period" className="relative -mx-1 overflow-x-auto px-1">
        <div className="flex min-w-max items-center gap-1">
          {periods.map((p) => (
            <Link
              key={p.key}
              href={`${base}&period=${p.key}`}
              aria-current={p.key === period ? 'page' : undefined}
              className={cn(
                'rounded-sm border px-2 py-0.5 text-xs transition-colors',
                p.key === period
                  ? 'border-primary/50 bg-primary/8 font-semibold text-foreground'
                  : 'border-transparent text-muted-foreground hover:border-border hover:text-foreground',
              )}
            >
              {p.label}
            </Link>
          ))}
        </div>
      </nav>

      <div className="grid gap-3 sm:grid-cols-2">
        <StatTile
          label="Net sales · actual vs budget"
          value={<Money cents={netSales.actualCents} currency plain />}
          hint={window.label}
          footer={
            <span>
              Budget <Money cents={netSales.budgetCents} currency plain /> · variance{' '}
              <Money cents={netSales.actualCents - netSales.budgetCents} currency signed colorPositive />
            </span>
          }
        />
        <StatTile
          label="Net income · actual vs budget"
          value={<Money cents={netIncome.actualCents} currency plain />}
          hint={window.label}
          footer={
            <span>
              Budget <Money cents={netIncome.budgetCents} currency plain /> · variance{' '}
              <Money cents={netIncome.actualCents - netIncome.budgetCents} currency signed colorPositive />
            </span>
          }
        />
      </div>

      <Card className="min-w-0 overflow-hidden">
        <CardHeader>
          <CardTitle>Budget vs actual · {window.label}</CardTitle>
          <span className="flex items-center gap-3 text-xs text-muted-foreground">
            <span className="flex items-center gap-1">
              <span className="size-2 rounded-full bg-positive" aria-hidden /> favourable
            </span>
            <span className="flex items-center gap-1">
              <span className="size-2 rounded-full bg-negative" aria-hidden /> unfavourable
            </span>
          </span>
        </CardHeader>
        {report.meta.warnings.length > 0 ? (
          <ul className="flex flex-col gap-0.5 border-b border-border bg-warning/6 px-4 py-2 text-xs text-warning">
            {report.meta.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        ) : null}
        {rows.length === 0 || rows.every((r) => r.style !== 'account') ? (
          <EmptyState
            title="Nothing budgeted or posted in this window"
            description="Budget lines appear here with their posted actuals. Bank lines still in the review queue are not actuals until they post."
          />
        ) : (
          <VarianceTable rows={rows} />
        )}
      </Card>
    </div>
  );
}

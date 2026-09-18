/**
 * The reads behind the Plan screens: budget versions and their grid, the
 * budget-vs-actual statement flattened for the variance table, and the
 * thirteen-week forecast in the shape the forecast screen draws. Nothing here
 * writes; mutations are in `./actions`.
 */

import { sql } from 'drizzle-orm';

import type {
  BankAccountOption,
  BudgetAccountOption,
  BudgetGridRow,
  BudgetVersionOption,
  ForecastItemRow,
  ForecastWeekRow,
  RecurrenceKey,
  VarianceRow,
} from '@/components/planning/types';
import { db } from '@/db/client';
import { budgetAccountOptions, listBudgetVersions } from '@/lib/planning/budget';
import { type BudgetVsActualReport, budgetVsActual } from '@/lib/planning/budget-vs-actual';
import { type CashForecast, buildCashForecast, listForecastItems, listForecastSnapshots, scoreSnapshot } from '@/lib/planning/forecast';
import type { CalendarDate } from '@/lib/dates';
import type { LedgerDb } from '@/lib/ledger/post';

function cents(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value ?? 0);
  if (!Number.isSafeInteger(n)) throw new Error(`Expected whole cents, received ${String(value)}.`);
  return n;
}

/* ------------------------------------------------------------------ budget */

export async function budgetVersionOptions(): Promise<BudgetVersionOption[]> {
  const versions = await listBudgetVersions();
  const counts = await db.execute<{ version_id: string; n: string | number }>(sql`
    select version_id, count(*) as n from budget_lines group by version_id
  `);
  const byVersion = new Map([...counts].map((r) => [r.version_id, Number(r.n)]));
  return versions
    .map((v) => ({
      id: v.id,
      name: v.name,
      fiscalYear: v.fiscalYear,
      status: v.status,
      lineCount: byVersion.get(v.id) ?? 0,
    }))
    .sort((a, b) => b.fiscalYear - a.fiscalYear || a.name.localeCompare(b.name));
}

export async function budgetAccounts(): Promise<BudgetAccountOption[]> {
  const rows = await budgetAccountOptions();
  return rows.map((r) => ({ id: r.id, code: r.code, name: r.name, type: r.type === 'revenue' ? 'revenue' : 'expense' }));
}

export interface BudgetGrid {
  rows: BudgetGridRow[];
  /** Cells budgeted to a channel: shown in budget vs actual, edited by import. */
  channelCells: number;
  channelTotalCents: number;
}

interface GridCell extends Record<string, unknown> {
  account_id: string;
  code: string;
  name: string;
  type: string;
  subtype: string | null;
  month: number;
  amount_cents: string | number;
  by_channel: boolean;
}

/** The version's cells with no channel, one row per account, plus a count of the by-channel cells. */
export async function budgetGrid(versionId: string, exec: LedgerDb = db): Promise<BudgetGrid> {
  const rows = await exec.execute<GridCell>(sql`
    select a.id as account_id, a.code, a.name, a.type::text as type, a.subtype,
           l.month, l.amount_cents, (l.channel_id is not null) as by_channel
      from budget_lines l
      join accounts a on a.id = l.account_id
     where l.version_id = ${versionId}
     order by a.code, l.month
  `);
  const grid = new Map<string, BudgetGridRow>();
  let channelCells = 0;
  let channelTotalCents = 0;
  for (const r of rows) {
    if (r.by_channel) {
      channelCells += 1;
      channelTotalCents += cents(r.amount_cents);
      continue;
    }
    const row =
      grid.get(r.account_id) ??
      ({
        accountId: r.account_id,
        code: r.code,
        name: r.name,
        type: r.type === 'revenue' ? 'revenue' : 'expense',
        months: Array.from({ length: 12 }, () => null),
      } satisfies BudgetGridRow);
    row.months[Number(r.month) - 1] = cents(r.amount_cents);
    grid.set(r.account_id, row);
  }
  return { rows: [...grid.values()], channelCells, channelTotalCents };
}

/** Contra-revenue accounts, whose positive budget reduces net sales. */
export async function contraRevenueAccountIds(): Promise<string[]> {
  const rows = await db.execute<{ id: string }>(sql`select id from accounts where subtype = 'contra_revenue'`);
  return [...rows].map((r) => r.id);
}

const INCOME_SECTIONS = ['gross_sales', 'other_income'];
const PROFIT_TOTALS = ['bva:net-sales', 'bva:gross-profit', 'bva:contribution-margin', 'bva:operating-income', 'bva:net-income'];

function sectionOf(id: string): string | null {
  const match = /^bva:([a-z_]+)/.exec(id);
  return match === null ? null : match[1];
}

/** The statement flattened, with each row told whether more is better. */
export function varianceRows(report: BudgetVsActualReport): VarianceRow[] {
  return report.rows
    .filter((r) => r.style !== 'spacer')
    .map((r) => {
      const incomeLike = PROFIT_TOTALS.includes(r.id) || INCOME_SECTIONS.includes(sectionOf(r.id) ?? '');
      const style: VarianceRow['style'] =
        r.style === 'section' ? 'section' : r.style === 'subtotal' ? 'subtotal' : r.style === 'total' ? 'total' : 'account';
      const drill = r.drilldown;
      return {
        id: r.id,
        label: r.label,
        code: r.code ?? null,
        level: r.level ?? 0,
        style,
        actualCents: r.values[0] ?? 0,
        budgetCents: r.values[1] ?? 0,
        varianceCents: r.values[2] ?? 0,
        variancePctBp: r.values[3] ?? 0,
        incomeLike,
        drilldownHref:
          drill?.accountId === undefined
            ? null
            : `/reports/general-ledger?account=${drill.accountId}&from=${drill.from ?? report.meta.from}&to=${drill.to ?? report.meta.to}`,
      };
    });
}

export async function budgetVsActualFor(
  versionId: string,
  from: CalendarDate,
  to: CalendarDate,
): Promise<BudgetVsActualReport> {
  return budgetVsActual({ versionId, from, to });
}

/* ---------------------------------------------------------------- forecast */

export interface ForecastScreen {
  forecast: CashForecast;
  weeks: ForecastWeekRow[];
  items: ForecastItemRow[];
  bankAccounts: BankAccountOption[];
  snapshots: Array<{
    id: string;
    asOfDate: string;
    scoredWeeks: number;
    unscoredWeeks: number;
    meanAbsClosingErrorCents: number;
    finalClosingVarianceCents: number;
  }>;
}

export async function forecastScreen(): Promise<ForecastScreen> {
  const forecast = await buildCashForecast();
  const items = await listForecastItems();
  const banks = await db.execute<{ id: string; name: string; mask: string | null }>(sql`
    select id, name, mask from bank_accounts where active order by name
  `);
  const snapshotList = await listForecastSnapshots();
  const snapshots: ForecastScreen['snapshots'] = [];
  for (const s of snapshotList.slice(-8).reverse()) {
    const score = await scoreSnapshot(s.id);
    snapshots.push({
      id: s.id,
      asOfDate: s.asOfDate,
      scoredWeeks: score.weeks.length,
      unscoredWeeks: score.unscoredWeeks,
      meanAbsClosingErrorCents: score.meanAbsClosingErrorCents,
      finalClosingVarianceCents: score.finalClosingVarianceCents,
    });
  }

  return {
    forecast,
    weeks: forecast.weeks.map((w) => ({
      weekStart: w.weekStart,
      weekEnd: w.weekEnd,
      openingCents: w.openingCents,
      arInflowCents: w.arInflowCents,
      itemInflowCents: w.itemInflowCents,
      apOutflowCents: w.apOutflowCents,
      itemOutflowCents: w.itemOutflowCents,
      closingCents: w.closingCents,
      flows: w.flows.map((f) => ({
        date: f.date,
        label: f.label,
        direction: f.direction,
        amountCents: f.amountCents,
        overdue: f.overdue,
      })),
    })),
    items: items.map((i) => ({
      id: i.id,
      label: i.label,
      category: i.category,
      direction: i.direction,
      amountCents: i.amountCents,
      expectedDate: i.expectedDate,
      recurrence: i.recurrence as RecurrenceKey,
      endDate: i.endDate,
      bankAccountId: i.bankAccountId,
      confidence: i.confidence,
      notes: i.notes,
    })),
    bankAccounts: [...banks].map((b) => ({ id: b.id, label: b.mask ? `${b.name.replace(/\s*••\d+$/, '')} ••${b.mask}` : b.name })),
    snapshots,
  };
}

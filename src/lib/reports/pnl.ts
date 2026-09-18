/**
 * The profit and loss statement, in the shape a CPG brand is actually run from.
 *
 * A generic accounting package prints revenue, expenses and a net figure. That
 * hides the two numbers this business lives on. Trade spend — off-invoice
 * allowances, billbacks, scans, slotting, spoilage, marketplace fees — is not an
 * operating expense; it is a reduction of the price actually realised, so it
 * sits between gross sales and NET SALES, itemised, because every percentage
 * anyone quotes is a percentage of net. And the cost of getting a case to a
 * customer — outbound freight, 3PL, FBA, processing — is not overhead either; it
 * scales with volume, so it comes out before CONTRIBUTION MARGIN, which is the
 * line that says whether selling more is worth doing.
 *
 * The statement therefore runs:
 *
 *     Gross Sales - Contra Revenue = NET SALES
 *     NET SALES - COGS = GROSS PROFIT
 *     GROSS PROFIT - Fulfillment & Selling = CONTRIBUTION MARGIN
 *     CONTRIBUTION MARGIN - Operating Expenses = OPERATING INCOME
 *     OPERATING INCOME +/- Other income and expense = NET INCOME
 *
 * Sections are decided by the root ancestor of each account, never by a code
 * range, so an account added under the right parent lands in the right section
 * without touching this file. Every revenue and expense account reaches exactly
 * one section, which is what makes NET INCOME here equal to the movement in
 * revenue and expense accounts in the trial balance.
 */

import { asc, eq } from 'drizzle-orm';

import { db } from '@/db/client';
import { type Account, channels } from '@/db/schema';
import { today } from '@/lib/dates';
import { listAccounts } from '@/lib/ledger/accounts';
import { ACCOUNTS } from '@/lib/ledger/coa';
import type { LedgerDb } from '@/lib/ledger/post';

import { type BalanceBucket, basisStrategy, fetchBalances } from './basis';
import {
  type AccountIndex,
  type ColumnDef,
  type Report,
  type ReportRequest,
  type ReportRow,
  add,
  addInto,
  basisPoints,
  emitTree,
  formatWindow,
  indexAccounts,
  isAllZero,
  monthLabel,
  monthsBetween,
  quarterLabel,
  quartersBetween,
  ratioRowValues,
  resolveCompareWindow,
  row,
  scale,
  sectionRow,
  subtract,
  zeros,
} from './types';

/* ----------------------------------------------------------------- sections */

export type PnlSection =
  | 'gross_sales'
  | 'contra_revenue'
  | 'cogs'
  | 'fulfillment'
  | 'opex'
  | 'other_income'
  | 'other_expense';

const SECTION_BY_ROOT: Readonly<Record<string, PnlSection>> = Object.freeze({
  [ACCOUNTS.GROSS_REVENUE]: 'gross_sales',
  [ACCOUNTS.CONTRA_REVENUE]: 'contra_revenue',
  [ACCOUNTS.COGS]: 'cogs',
  [ACCOUNTS.FULFILLMENT]: 'fulfillment',
  [ACCOUNTS.OPEX]: 'opex',
  [ACCOUNTS.OTHER_INCOME]: 'other_income',
  [ACCOUNTS.OTHER_EXPENSE]: 'other_expense',
  [ACCOUNTS.INCOME_TAX]: 'other_expense',
  [ACCOUNTS.ASK_MY_ACCOUNTANT]: 'other_expense',
});

const SECTION_LABEL: Readonly<Record<PnlSection, string>> = Object.freeze({
  gross_sales: 'Gross Sales',
  contra_revenue: 'Contra Revenue',
  cogs: 'Cost of Goods Sold',
  fulfillment: 'Fulfillment & Selling',
  opex: 'Operating Expenses',
  other_income: 'Other Income',
  other_expense: 'Other Expense',
});

const SECTION_ORDER: readonly PnlSection[] = [
  'gross_sales',
  'contra_revenue',
  'cogs',
  'fulfillment',
  'opex',
  'other_income',
  'other_expense',
];

/**
 * Contra revenue accounts are revenue accounts carrying debit balances, so the
 * ledger signs them negative. The statement shows them as positive deductions.
 */
const SECTION_DISPLAY_SIGN: Readonly<Record<PnlSection, 1 | -1>> = Object.freeze({
  gross_sales: 1,
  contra_revenue: -1,
  cogs: 1,
  fulfillment: 1,
  opex: 1,
  other_income: 1,
  other_expense: 1,
});

/** Stable row ids, so a caller can read a specific line without matching labels. */
export const PL_ROWS = Object.freeze({
  netSales: 'pl:net-sales',
  grossProfit: 'pl:gross-profit',
  grossMarginPct: 'pl:gross-margin-pct',
  contributionMargin: 'pl:contribution-margin',
  contributionMarginPct: 'pl:contribution-margin-pct',
  operatingIncome: 'pl:operating-income',
  operatingMarginPct: 'pl:operating-margin-pct',
  netIncome: 'pl:net-income',
  netMarginPct: 'pl:net-margin-pct',
});

/* -------------------------------------------------------------- column plan */

type CellSource =
  | { kind: 'bucket'; bucket: number }
  | { kind: 'percent'; bucket: number }
  | { kind: 'variance'; current: number; compare: number }
  | { kind: 'variance_pct'; current: number; compare: number };

interface ColumnPlan {
  buckets: BalanceBucket[];
  columns: ColumnDef[];
  sources: CellSource[];
  warnings: string[];
}

interface ChannelRow {
  id: string;
  name: string;
}

/**
 * Lays out the columns and the windows behind them.
 *
 * The percent-of-net-sales option adds a column beside every amount column in
 * single-total mode, where there are at most four; in the wider modes it is
 * added once, against the Total, because a thirteen-month statement with a
 * percentage beside each month is unreadable on any screen.
 */
function planColumns(
  request: ReportRequest,
  channelRows: readonly ChannelRow[],
): ColumnPlan {
  const buckets: BalanceBucket[] = [];
  const columns: ColumnDef[] = [];
  const sources: CellSource[] = [];
  const warnings: string[] = [];
  const percent = request.percentOfNetSales === true;

  const pushAmount = (
    bucket: BalanceBucket,
    column: Omit<ColumnDef, 'kind'>,
  ): number => {
    const index = buckets.length;
    buckets.push(bucket);
    columns.push({ ...column, kind: 'amount' });
    sources.push({ kind: 'bucket', bucket: index });
    return index;
  };

  const pushPercent = (bucket: number, key: string, group: ColumnDef['group']): void => {
    columns.push({ key, label: '% of net sales', kind: 'percent', group });
    sources.push({ kind: 'percent', bucket });
  };

  const compare = resolveCompareWindow(request);

  if (request.columns === 'months' || request.columns === 'quarters') {
    const windows =
      request.columns === 'months'
        ? monthsBetween(request.from, request.to)
        : quartersBetween(request.from, request.to);

    for (const window of windows) {
      pushAmount(
        { key: window.from, from: window.from, to: window.to },
        {
          key: window.from,
          label:
            request.columns === 'months' ? monthLabel(window.from) : quarterLabel(window.from),
          from: window.from,
          to: window.to,
          group: 'current',
        },
      );
    }

    const totalBucket = pushAmount(
      { key: 'total', from: request.from, to: request.to },
      {
        key: 'total',
        label: 'Total',
        from: request.from,
        to: request.to,
        emphasis: true,
        group: 'current',
      },
    );
    if (percent) pushPercent(totalBucket, 'total-pct', 'current');
    if (compare !== null) {
      warnings.push('A comparison period is only shown on the single-total column mode.');
    }
    return { buckets, columns, sources, warnings };
  }

  if (request.columns === 'channels') {
    for (const channel of channelRows) {
      pushAmount(
        { key: channel.id, from: request.from, to: request.to, channelId: channel.id },
        {
          key: channel.id,
          label: channel.name,
          from: request.from,
          to: request.to,
          channelId: channel.id,
          group: 'current',
        },
      );
    }

    if (request.channelIds === undefined) {
      pushAmount(
        { key: 'unallocated', from: request.from, to: request.to, unallocated: true },
        {
          key: 'unallocated',
          label: 'Unallocated',
          sublabel: 'no channel on the line',
          from: request.from,
          to: request.to,
          group: 'current',
        },
      );
    }

    const totalBucket = pushAmount(
      { key: 'total', from: request.from, to: request.to },
      {
        key: 'total',
        label: 'Total',
        from: request.from,
        to: request.to,
        emphasis: true,
        group: 'current',
      },
    );
    if (percent) pushPercent(totalBucket, 'total-pct', 'current');
    if (compare !== null) {
      warnings.push('A comparison period is only shown on the single-total column mode.');
    }
    return { buckets, columns, sources, warnings };
  }

  const current = pushAmount(
    { key: 'total', from: request.from, to: request.to },
    {
      key: 'total',
      label: 'Total',
      sublabel: formatWindow(request.from, request.to),
      from: request.from,
      to: request.to,
      emphasis: true,
      group: 'current',
    },
  );
  if (percent) pushPercent(current, 'total-pct', 'current');

  if (compare !== null) {
    const prior = pushAmount(
      { key: 'compare', from: compare.from, to: compare.to },
      {
        key: 'compare',
        label: 'Comparison',
        sublabel: formatWindow(compare.from, compare.to),
        from: compare.from,
        to: compare.to,
        group: 'compare',
      },
    );
    if (percent) pushPercent(prior, 'compare-pct', 'compare');

    columns.push({ key: 'variance', label: 'Variance', kind: 'variance', group: 'variance' });
    sources.push({ kind: 'variance', current, compare: prior });
    columns.push({ key: 'variance-pct', label: 'Variance %', kind: 'variance_pct', group: 'variance' });
    sources.push({ kind: 'variance_pct', current, compare: prior });
  }

  return { buckets, columns, sources, warnings };
}

/* ------------------------------------------------------------- projection */

/**
 * Rows are built against the data buckets, then projected onto the columns the
 * reader asked for. Keeping the two apart is what lets a percentage column, a
 * comparison and a variance be added without any section of the statement
 * knowing they exist.
 */
function project(
  rows: readonly ReportRow[],
  sources: readonly CellSource[],
  netSales: readonly number[],
): ReportRow[] {
  return rows.map((current) => {
    const values: number[] = [];
    const blankColumns: number[] = [];

    sources.forEach((source, index) => {
      switch (source.kind) {
        case 'bucket':
          values.push(current.values[source.bucket] ?? 0);
          return;
        case 'percent':
          // A margin line is already a percentage; dividing it by net sales
          // again would produce a figure with no meaning.
          if (current.format === 'percent') {
            values.push(0);
            blankColumns.push(index);
            return;
          }
          values.push(basisPoints(current.values[source.bucket] ?? 0, netSales[source.bucket] ?? 0));
          return;
        case 'variance':
          values.push((current.values[source.current] ?? 0) - (current.values[source.compare] ?? 0));
          return;
        case 'variance_pct': {
          if (current.format === 'percent') {
            values.push(0);
            blankColumns.push(index);
            return;
          }
          const base = current.values[source.compare] ?? 0;
          values.push(basisPoints((current.values[source.current] ?? 0) - base, base));
          return;
        }
      }
    });

    return {
      ...current,
      values,
      blankColumns: blankColumns.length > 0 ? blankColumns : undefined,
    };
  });
}

/* --------------------------------------------------------------- the report */

/** The statement's spine, one figure per data bucket. */
export interface ProfitAndLossTotals {
  grossSales: number[];
  contraRevenue: number[];
  netSales: number[];
  cogs: number[];
  grossProfit: number[];
  fulfillment: number[];
  contributionMargin: number[];
  operatingExpenses: number[];
  operatingIncome: number[];
  otherIncome: number[];
  otherExpense: number[];
  netIncome: number[];
}

function sectionRoots(index: AccountIndex): Map<PnlSection, Account[]> {
  const grouped = new Map<PnlSection, Account[]>();
  for (const section of SECTION_ORDER) grouped.set(section, []);

  for (const root of index.roots) {
    if (root.type !== 'revenue' && root.type !== 'expense') continue;
    const mapped =
      SECTION_BY_ROOT[root.code] ?? (root.type === 'revenue' ? 'other_income' : 'other_expense');
    grouped.get(mapped)?.push(root);
  }
  return grouped;
}

function unmappedRootWarning(index: AccountIndex): string | null {
  const strays = index.roots.filter(
    (root) =>
      (root.type === 'revenue' || root.type === 'expense') &&
      SECTION_BY_ROOT[root.code] === undefined,
  );
  if (strays.length === 0) return null;
  return (
    `${strays.map((root) => `${root.code} ${root.name}`).join(', ')} ` +
    `${strays.length === 1 ? 'is a revenue or expense account that is' : 'are revenue or expense accounts that are'} ` +
    'not parented under a known statement section, so it was reported under other income or expense. ' +
    'Give it a parent to place it properly.'
  );
}

export interface ProfitAndLossReport extends Report {
  /** For callers that need the figures rather than the rows. */
  totals: ProfitAndLossTotals;
}

/** The channels a by-channel statement gets a column for, in the order they are listed. */
async function columnChannels(
  request: ReportRequest,
  exec: LedgerDb,
): Promise<ChannelRow[]> {
  const rows = await exec
    .select({ id: channels.id, name: channels.name })
    .from(channels)
    .where(eq(channels.active, true))
    .orderBy(asc(channels.sortOrder));
  const wanted = request.channelIds;
  return wanted === undefined ? rows : rows.filter((channel) => wanted.includes(channel.id));
}

export async function profitAndLossReport(
  request: ReportRequest,
  exec: LedgerDb = db,
): Promise<ProfitAndLossReport> {
  const strategy = basisStrategy(request.basis);
  const accounts = await listAccounts({}, exec);
  const index = indexAccounts(accounts);

  const channelRows =
    request.columns === 'channels' ? await columnChannels(request, exec) : [];

  const plan = planColumns(request, channelRows);
  const width = plan.buckets.length;
  const balances = await fetchBalances(
    plan.buckets,
    { basis: request.basis, channelIds: request.channelIds },
    exec,
  );

  const roots = sectionRoots(index);
  const rows: ReportRow[] = [];

  const drilldown = (account: Account) => ({
    accountId: account.id,
    from: request.from,
    to: request.to,
  });

  /** Renders one section and returns its total, whether or not anything was shown. */
  const emitSection = (section: PnlSection): number[] => {
    const sectionRows: ReportRow[] = [];
    const total = emitTree(roots.get(section) ?? [], {
      index,
      values: (accountId) => balances.valuesFor(accountId),
      width,
      displaySign: SECTION_DISPLAY_SIGN[section],
      includeZeroRows: request.includeZeroRows,
      drilldown,
      idPrefix: `pl:${section}`,
      baseLevel: 1,
      transparentRoots: true,
      out: sectionRows,
    });

    if (sectionRows.length > 0) {
      rows.push(sectionRow(`pl:${section}`, SECTION_LABEL[section], width));
      rows.push(...sectionRows);
      rows.push(
        row({
          id: `pl:${section}:total`,
          label: `Total ${SECTION_LABEL[section]}`,
          level: 0,
          values: total,
          style: 'subtotal',
        }),
      );
    }
    return total;
  };

  const statementTotal = (id: string, label: string, values: number[]): void => {
    rows.push(row({ id, label, level: 0, values, style: 'total' }));
  };

  const marginRow = (id: string, label: string, numerator: number[], denominator: number[]): void => {
    rows.push(
      row({
        id,
        label,
        level: 0,
        values: ratioRowValues(numerator, denominator),
        style: 'ratio',
        format: 'percent',
      }),
    );
  };

  const grossSales = emitSection('gross_sales');
  const contraRevenue = emitSection('contra_revenue');
  const netSales = subtract(grossSales, contraRevenue);
  statementTotal(PL_ROWS.netSales, 'NET SALES', netSales);

  const cogs = emitSection('cogs');
  const grossProfit = subtract(netSales, cogs);
  statementTotal(PL_ROWS.grossProfit, 'GROSS PROFIT', grossProfit);
  marginRow(PL_ROWS.grossMarginPct, 'Gross margin', grossProfit, netSales);

  const fulfillment = emitSection('fulfillment');
  const contributionMargin = subtract(grossProfit, fulfillment);
  statementTotal(PL_ROWS.contributionMargin, 'CONTRIBUTION MARGIN', contributionMargin);
  marginRow(PL_ROWS.contributionMarginPct, 'Contribution margin', contributionMargin, netSales);

  const operatingExpenses = emitSection('opex');
  const operatingIncome = subtract(contributionMargin, operatingExpenses);
  statementTotal(PL_ROWS.operatingIncome, 'OPERATING INCOME', operatingIncome);
  marginRow(PL_ROWS.operatingMarginPct, 'Operating margin', operatingIncome, netSales);

  const otherIncome = emitSection('other_income');
  const otherExpense = emitSection('other_expense');
  const netIncome = add(operatingIncome, subtract(otherIncome, otherExpense));
  statementTotal(PL_ROWS.netIncome, 'NET INCOME', netIncome);
  marginRow(PL_ROWS.netMarginPct, 'Net margin', netIncome, netSales);

  // The statement's own arithmetic is one thing; that it agrees with the ledger
  // is another. Net income has to equal the movement in every revenue and
  // expense account, or a section is dropping accounts on the floor.
  const ledgerNetIncome = zeros(width);
  for (const account of accounts) {
    if (account.type !== 'revenue' && account.type !== 'expense') continue;
    const signed = balances.valuesFor(account.id);
    if (signed === undefined) continue;
    addInto(ledgerNetIncome, account.type === 'revenue' ? signed : scale(signed, -1));
  }

  const warnings = [...plan.warnings, ...strategy.caveats];
  const stray = unmappedRootWarning(index);
  if (stray !== null) warnings.push(stray);

  const suspense = index.byCode.get(ACCOUNTS.ASK_MY_ACCOUNTANT);
  if (suspense !== undefined && !isAllZero(balances.valuesFor(suspense.id) ?? zeros(width))) {
    warnings.push(
      'Ask My Accountant carries a balance. These books are not final until it is cleared.',
    );
  }

  if (!isAllZero(subtract(netIncome, ledgerNetIncome))) {
    rows.push(
      row({
        id: 'pl:tie-out-failed',
        label: 'STATEMENT DOES NOT TIE TO THE LEDGER',
        level: 0,
        values: subtract(ledgerNetIncome, netIncome),
        style: 'error',
        note: 'Net income above differs from the movement in revenue and expense accounts by this amount. A section is not reaching every account.',
      }),
    );
    warnings.push('Net income does not agree with the ledger. The statement is unreliable.');
  }

  return {
    columns: plan.columns,
    rows: project(rows, plan.sources, netSales),
    totals: {
      grossSales,
      contraRevenue,
      netSales,
      cogs,
      grossProfit,
      fulfillment,
      contributionMargin,
      operatingExpenses,
      operatingIncome,
      otherIncome,
      otherExpense,
      netIncome,
    },
    meta: {
      title: 'Profit & Loss',
      subtitle: formatWindow(request.from, request.to),
      from: request.from,
      to: request.to,
      basis: request.basis,
      columns: request.columns,
      generatedAt: today(),
      warnings,
    },
  };
}

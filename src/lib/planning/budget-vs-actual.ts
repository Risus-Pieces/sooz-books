/**
 * Budget against actual, in the shared report shape.
 *
 * The statement follows the P&L's CPG spine — gross sales, contra revenue, net
 * sales, COGS, gross profit, fulfillment, contribution margin, operating
 * expenses, operating income, other items, net income — so a line reads the same
 * here as on the P&L. Four columns: Actual, Budget, Variance (actual − budget)
 * and Variance % (variance ÷ |budget|, in basis points).
 *
 * The variance is signed the way the arithmetic goes, not by favourability: a
 * positive variance on revenue is good news, on an expense it is overspend. The
 * rows carry both signs honestly rather than flipping expense rows, so a total
 * is always the difference of the two columns above it.
 *
 * Budgets are monthly. A window that cuts a month in half still counts that
 * month's whole budget, and the report says so.
 */

import { and, eq, sql } from 'drizzle-orm';

import { type Account, type BudgetVersion, budgetVersions, channels } from '@/db/schema';
import { type CalendarDate, dateParts, monthEnd, monthStart, today } from '@/lib/dates';
import { listAccounts } from '@/lib/ledger/accounts';
import { ACCOUNTS } from '@/lib/ledger/coa';
import type { LedgerDb } from '@/lib/ledger/post';
import { fetchBalances } from '@/lib/reports/basis';
import {
  type AccountIndex,
  type ColumnDef,
  type Report,
  type ReportRow,
  addInto,
  basisPoints,
  emitTree,
  formatWindow,
  indexAccounts,
  row,
  sectionRow,
  subtract,
  zeros,
} from '@/lib/reports/types';

import { PlanningError, cents, reader } from './context';

export interface BudgetVsActualRequest {
  from: CalendarDate;
  to: CalendarDate;
  /** A version id. Defaults to the active version for the fiscal year `from` falls in. */
  versionId?: string;
  /** Restricts both sides to one channel. */
  channelId?: string;
  includeZeroRows?: boolean;
}

export interface BudgetVsActualReport extends Report {
  version: BudgetVersion;
  totals: {
    netSales: { actualCents: number; budgetCents: number };
    netIncome: { actualCents: number; budgetCents: number };
  };
}

type Section = 'gross_sales' | 'contra_revenue' | 'cogs' | 'fulfillment' | 'opex' | 'other_income' | 'other_expense';

const SECTION_BY_ROOT: Readonly<Record<string, Section>> = Object.freeze({
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

const SECTION_LABEL: Readonly<Record<Section, string>> = Object.freeze({
  gross_sales: 'Gross Sales',
  contra_revenue: 'Contra Revenue',
  cogs: 'Cost of Goods Sold',
  fulfillment: 'Fulfillment & Selling',
  opex: 'Operating Expenses',
  other_income: 'Other Income',
  other_expense: 'Other Expense',
});

export const BVA_ROWS = Object.freeze({
  netSales: 'bva:net-sales',
  grossProfit: 'bva:gross-profit',
  contributionMargin: 'bva:contribution-margin',
  operatingIncome: 'bva:operating-income',
  netIncome: 'bva:net-income',
});

function sectionRoots(index: AccountIndex): Map<Section, Account[]> {
  const grouped = new Map<Section, Account[]>();
  for (const root of index.roots) {
    if (root.type !== 'revenue' && root.type !== 'expense') continue;
    const section = SECTION_BY_ROOT[root.code] ?? (root.type === 'revenue' ? 'other_income' : 'other_expense');
    const list = grouped.get(section) ?? [];
    list.push(root);
    grouped.set(section, list);
  }
  return grouped;
}

async function resolveVersion(request: BudgetVsActualRequest, exec: LedgerDb): Promise<BudgetVersion> {
  if (request.versionId !== undefined) {
    const [version] = await exec.select().from(budgetVersions).where(eq(budgetVersions.id, request.versionId));
    if (version === undefined) throw new PlanningError('not_found', 'That budget version does not exist.');
    return version;
  }
  const year = dateParts(request.from).year;
  const [active] = await exec
    .select()
    .from(budgetVersions)
    .where(and(eq(budgetVersions.fiscalYear, year), eq(budgetVersions.status, 'active')));
  if (active === undefined) throw new PlanningError('not_found', `There is no active budget for ${year}.`);
  return active;
}

interface BudgetSumRow extends Record<string, unknown> {
  account_id: string;
  amount_cents: string | number;
}

/** Budget per account for every month the window touches, in statement sign. */
async function budgetByAccount(
  versionId: string,
  request: BudgetVsActualRequest,
  exec: LedgerDb,
): Promise<Map<string, number>> {
  const first = dateParts(request.from);
  const last = dateParts(request.to);
  const rows = await exec.execute<BudgetSumRow>(sql`
    select account_id, sum(amount_cents) as amount_cents
      from budget_lines
     where version_id = ${versionId}
       and year * 12 + month between ${first.year * 12 + first.month} and ${last.year * 12 + last.month}
       ${request.channelId === undefined ? sql`` : sql`and channel_id = ${request.channelId}::uuid`}
     group by account_id
  `);
  return new Map([...rows].map((r) => [r.account_id, cents(r.amount_cents)]));
}

export async function budgetVsActual(
  request: BudgetVsActualRequest,
  exec?: LedgerDb,
): Promise<BudgetVsActualReport> {
  const x = reader(exec);
  if (request.to < request.from) throw new PlanningError('invalid_input', 'The window ends before it starts.');
  const version = await resolveVersion(request, x);
  const accounts = await listAccounts({}, x);
  const index = indexAccounts(accounts);

  const actuals = await fetchBalances(
    [{ key: 'actual', from: request.from, to: request.to }],
    { basis: 'accrual', channelIds: request.channelId === undefined ? undefined : [request.channelId] },
    x,
  );
  const budget = await budgetByAccount(version.id, request, x);

  /** [actual, budget] in the statement's sign. */
  const pair = (account: Account): number[] => {
    const statementSign = account.subtype === 'contra_revenue' ? -1 : 1;
    const actual = (actuals.valuesFor(account.id)?.[0] ?? 0) * statementSign;
    return [actual === 0 ? 0 : actual, budget.get(account.id) ?? 0];
  };

  const roots = sectionRoots(index);
  const rows: ReportRow[] = [];
  const width = 2;

  const emitSection = (section: Section): number[] => {
    const body: ReportRow[] = [];
    const total = emitTree(roots.get(section) ?? [], {
      index,
      values: (accountId) => {
        const account = index.byId.get(accountId);
        return account === undefined ? undefined : pair(account);
      },
      width,
      displaySign: 1,
      includeZeroRows: request.includeZeroRows === true,
      drilldown: (account) => ({ accountId: account.id, from: request.from, to: request.to }),
      idPrefix: `bva:${section}`,
      baseLevel: 1,
      transparentRoots: true,
      out: body,
    });
    if (body.length > 0) {
      rows.push(sectionRow(`bva:${section}`, SECTION_LABEL[section], width));
      rows.push(...body);
      rows.push(row({ id: `bva:${section}:total`, label: `Total ${SECTION_LABEL[section]}`, values: total, style: 'subtotal' }));
    }
    return total;
  };
  const statementTotal = (id: string, label: string, values: number[]): void => {
    rows.push(row({ id, label, values, style: 'total' }));
  };

  const grossSales = emitSection('gross_sales');
  const contra = emitSection('contra_revenue');
  const netSales = subtract(grossSales, contra);
  statementTotal(BVA_ROWS.netSales, 'NET SALES', netSales);
  const grossProfit = subtract(netSales, emitSection('cogs'));
  statementTotal(BVA_ROWS.grossProfit, 'GROSS PROFIT', grossProfit);
  const contribution = subtract(grossProfit, emitSection('fulfillment'));
  statementTotal(BVA_ROWS.contributionMargin, 'CONTRIBUTION MARGIN', contribution);
  const operating = subtract(contribution, emitSection('opex'));
  statementTotal(BVA_ROWS.operatingIncome, 'OPERATING INCOME', operating);
  const otherIncome = emitSection('other_income');
  const otherExpense = emitSection('other_expense');
  const netIncome = addInto([...operating], subtract(otherIncome, otherExpense));
  statementTotal(BVA_ROWS.netIncome, 'NET INCOME', netIncome);

  const warnings: string[] = [];
  if (request.from !== monthStart(request.from) || request.to !== monthEnd(request.to)) {
    warnings.push('Budgets are monthly: a month the window only partly covers counts its whole budget.');
  }
  const budgeted = new Set(budget.keys());
  const strays = accounts.filter((a) => budgeted.has(a.id) && a.type !== 'revenue' && a.type !== 'expense');
  if (strays.length > 0) {
    warnings.push(`Budget lines on ${strays.map((a) => a.code).join(', ')} are not income or expense and are not shown.`);
  }
  if (request.channelId !== undefined) {
    const [channel] = await x.select({ name: channels.name }).from(channels).where(eq(channels.id, request.channelId));
    warnings.push(
      `Only ${channel?.name ?? 'one channel'}: actual lines tagged with it, and budget lines budgeted to it. ` +
        'Budget entered without a channel is left out.',
    );
  }
  if (version.status !== 'active') warnings.push(`"${version.name}" is ${version.status}, not the active budget.`);

  const columns: ColumnDef[] = [
    { key: 'actual', label: 'Actual', sublabel: formatWindow(request.from, request.to), kind: 'amount', from: request.from, to: request.to, group: 'current', emphasis: true },
    { key: 'budget', label: 'Budget', sublabel: version.name, kind: 'amount', group: 'compare' },
    { key: 'variance', label: 'Variance', sublabel: 'actual − budget', kind: 'variance', group: 'variance' },
    { key: 'variance-pct', label: 'Variance %', kind: 'variance_pct', group: 'variance' },
  ];

  const projected = rows.map((r): ReportRow => {
    if (r.style === 'section') return { ...r, values: zeros(4) };
    const [actual, planned] = r.values;
    const variance = actual - planned;
    return { ...r, values: [actual, planned, variance, basisPoints(variance, planned)] };
  });

  return {
    version,
    columns,
    rows: projected,
    totals: {
      netSales: { actualCents: netSales[0], budgetCents: netSales[1] },
      netIncome: { actualCents: netIncome[0], budgetCents: netIncome[1] },
    },
    meta: {
      title: 'Budget vs Actual',
      subtitle: `${version.name} · ${formatWindow(request.from, request.to)}`,
      from: request.from,
      to: request.to,
      basis: 'accrual',
      columns: 'total',
      generatedAt: today(),
      warnings,
    },
  };
}

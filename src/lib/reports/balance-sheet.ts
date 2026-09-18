/**
 * The balance sheet: what the company owns, what it owes and what is left, as of
 * a date.
 *
 * Two things here are easy to get wrong and are therefore done explicitly.
 *
 * Retained earnings. Sooz has never run a closing entry, so account 3900 holds
 * whatever was migrated into it and nothing else. The earnings that actually
 * accumulated live in the revenue and expense accounts. This report therefore
 * reconstructs them: everything those accounts earned before the period start is
 * shown as retained, and the current period's result is shown on its own line,
 * which is the number anyone opening this page is looking for.
 *
 * The balance check. Assets less liabilities and equity is zero by construction
 * — every posted entry balances, and the trial balance identity does the rest.
 * If it is ever not zero the report says so in a row that cannot be mistaken for
 * data, because a balance sheet that silently does not balance is worse than no
 * balance sheet.
 */

import { db } from '@/db/client';
import type { Account } from '@/db/schema';
import { type CalendarDate, today } from '@/lib/dates';
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
  dayBefore,
  emitTree,
  formatLongDate,
  indexAccounts,
  isAllZero,
  monthLabel,
  monthsBetween,
  quarterLabel,
  quartersBetween,
  resolveCompareWindow,
  row,
  scale,
  sectionRow,
  subtract,
  zeros,
} from './types';

/* ---------------------------------------------------------- classification */

/**
 * An asset root is non-current when its subtype says so. Everything else is
 * working capital: a new asset account is current until someone marks it
 * otherwise, which is the safer default for a brand with no long-lived assets
 * beyond tooling.
 */
const NON_CURRENT_ASSET_SUBTYPES: ReadonlySet<string> = new Set(['fixed_asset', 'intangible']);

/**
 * Debt sits under one root, but half of it is due within the year. The chart
 * carries no current-portion flag, so the split is stated here by account rather
 * than guessed from a name at render time. Anything under the debt root that is
 * not named here is presented as non-current.
 */
const CURRENT_DEBT_ACCOUNTS: ReadonlySet<string> = new Set<string>([
  ACCOUNTS.LINE_OF_CREDIT,
  ACCOUNTS.LOANS_CURRENT,
  ACCOUNTS.REVENUE_BASED_FINANCING,
  ACCOUNTS.ACCRUED_INTEREST,
]);

type Currency = 'current' | 'non_current';

function classify(account: Account, index: AccountIndex): Currency {
  const root = index.rootOf(account.id);
  if (root.subtype === 'debt') {
    // Walk from the account up to the root: a child of "Line of Credit" inherits
    // its parent's classification.
    let cursor: Account | undefined = account;
    while (cursor !== undefined && cursor.id !== root.id) {
      if (CURRENT_DEBT_ACCOUNTS.has(cursor.code)) return 'current';
      cursor = cursor.parentId === null ? undefined : index.byId.get(cursor.parentId);
    }
    return CURRENT_DEBT_ACCOUNTS.has(root.code) ? 'current' : 'non_current';
  }
  if (account.type === 'asset') {
    return root.subtype !== null && NON_CURRENT_ASSET_SUBTYPES.has(root.subtype)
      ? 'non_current'
      : 'current';
  }
  return 'current';
}

/** Stable row ids for callers that need a specific line. */
export const BS_ROWS = Object.freeze({
  totalAssets: 'bs:assets:total',
  totalLiabilities: 'bs:liabilities:total',
  retainedPrior: 'bs:equity:retained-prior',
  netIncome: 'bs:equity:net-income',
  totalEquity: 'bs:equity:total',
  totalLiabilitiesAndEquity: 'bs:liabilities-and-equity:total',
  outOfBalance: 'bs:out-of-balance',
});

/* -------------------------------------------------------------- column plan */

interface ColumnPoint {
  key: string;
  label: string;
  sublabel?: string;
  /** The as-of date the position is measured at. */
  asOf: CalendarDate;
  /** Start of the period whose net income is shown on its own line. */
  periodFrom: CalendarDate;
  emphasis?: boolean;
  group: ColumnDef['group'];
}

function planPoints(request: ReportRequest): { points: ColumnPoint[]; warnings: string[] } {
  const warnings: string[] = [];
  const points: ColumnPoint[] = [];

  if (request.columns === 'months' || request.columns === 'quarters') {
    const windows =
      request.columns === 'months'
        ? monthsBetween(request.from, request.to)
        : quartersBetween(request.from, request.to);
    for (const window of windows) {
      points.push({
        key: window.to,
        label:
          request.columns === 'months' ? monthLabel(window.from) : quarterLabel(window.from),
        sublabel: `as of ${window.to}`,
        asOf: window.to,
        periodFrom: window.from,
        group: 'current',
        emphasis: window.to === request.to,
      });
    }
  } else {
    if (request.columns === 'channels') {
      warnings.push(
        'A balance sheet cannot be cut by channel: a channel carries revenue and cost, not ' +
          'cash, receivables or equity. The position as of the end date is shown instead.',
      );
    }
    points.push({
      key: 'current',
      label: 'Balance',
      sublabel: `as of ${request.to}`,
      asOf: request.to,
      periodFrom: request.from,
      emphasis: true,
      group: 'current',
    });

    const compare = resolveCompareWindow(request);
    if (compare !== null) {
      points.push({
        key: 'compare',
        label: 'Comparison',
        sublabel: `as of ${compare.to}`,
        asOf: compare.to,
        periodFrom: compare.from,
        group: 'compare',
      });
    }
  }

  return { points, warnings };
}

/* --------------------------------------------------------------- the report */

export interface BalanceSheetReport extends Report {
  totals: {
    assets: number[];
    liabilities: number[];
    equity: number[];
    retainedPrior: number[];
    netIncome: number[];
    /** Assets less liabilities and equity. Zero in a ledger that balances. */
    outOfBalance: number[];
  };
}

export async function balanceSheetReport(
  request: ReportRequest,
  exec: LedgerDb = db,
): Promise<BalanceSheetReport> {
  const strategy = basisStrategy(request.basis);
  const accounts = await listAccounts({}, exec);
  const index = indexAccounts(accounts);

  const { points, warnings: planWarnings } = planPoints(request);
  const width = points.length;

  // Two buckets per column: the position since inception, and the period whose
  // result is broken out of retained earnings.
  const buckets: BalanceBucket[] = [];
  for (const point of points) buckets.push({ key: `${point.key}:position`, from: null, to: point.asOf });
  for (const point of points) {
    buckets.push({ key: `${point.key}:period`, from: point.periodFrom, to: point.asOf });
  }

  const balances = await fetchBalances(
    buckets,
    { basis: request.basis, channelIds: request.channelIds },
    exec,
  );

  /** Position values for an account, trimmed to the column width. */
  const position = (accountId: string): number[] => {
    const all = balances.valuesFor(accountId);
    if (all === undefined) return zeros(width);
    return all.slice(0, width);
  };

  const periodOnly = (accountId: string): number[] => {
    const all = balances.valuesFor(accountId);
    if (all === undefined) return zeros(width);
    return all.slice(width, width * 2);
  };

  // Net income, cumulative and for the period, straight from the ledger.
  const cumulativeEarnings = zeros(width);
  const periodEarnings = zeros(width);
  for (const account of accounts) {
    if (account.type !== 'revenue' && account.type !== 'expense') continue;
    const sign = account.type === 'revenue' ? 1 : -1;
    addInto(cumulativeEarnings, scale(position(account.id), sign));
    addInto(periodEarnings, scale(periodOnly(account.id), sign));
  }
  const retainedPrior = subtract(cumulativeEarnings, periodEarnings);

  const rows: ReportRow[] = [];
  const drilldown = (account: Account) => ({
    accountId: account.id,
    from: request.from,
    to: request.to,
  });

  const emitBlock = (
    label: string,
    idPrefix: string,
    roots: readonly Account[],
    include: (account: Account) => boolean,
  ): number[] => {
    const blockRows: ReportRow[] = [];
    const total = emitTree(roots, {
      index,
      values: position,
      width,
      displaySign: 1,
      include,
      includeZeroRows: request.includeZeroRows,
      drilldown,
      idPrefix,
      baseLevel: 2,
      out: blockRows,
    });
    if (blockRows.length === 0) return total;

    rows.push(sectionRow(`${idPrefix}:head`, label, width, 1));
    rows.push(...blockRows);
    rows.push(
      row({ id: `${idPrefix}:total`, label: `Total ${label}`, level: 1, values: total, style: 'subtotal' }),
    );
    return total;
  };

  const rootsOfType = (type: Account['type']): Account[] =>
    index.roots.filter((root) => root.type === type);

  // ---- Assets
  rows.push(sectionRow('bs:assets', 'Assets', width));
  const assetRoots = rootsOfType('asset');
  const currentAssets = emitBlock(
    'Current Assets',
    'bs:assets:current',
    assetRoots,
    (account) => classify(account, index) === 'current',
  );
  const nonCurrentAssets = emitBlock(
    'Non-Current Assets',
    'bs:assets:non-current',
    assetRoots,
    (account) => classify(account, index) === 'non_current',
  );
  const assets = add(currentAssets, nonCurrentAssets);
  rows.push(
    row({ id: BS_ROWS.totalAssets, label: 'TOTAL ASSETS', level: 0, values: assets, style: 'total' }),
  );

  // ---- Liabilities
  rows.push(sectionRow('bs:liabilities', 'Liabilities', width));
  const liabilityRoots = rootsOfType('liability');
  const currentLiabilities = emitBlock(
    'Current Liabilities',
    'bs:liabilities:current',
    liabilityRoots,
    (account) => classify(account, index) === 'current',
  );
  const nonCurrentLiabilities = emitBlock(
    'Non-Current Liabilities',
    'bs:liabilities:non-current',
    liabilityRoots,
    (account) => classify(account, index) === 'non_current',
  );
  const liabilities = add(currentLiabilities, nonCurrentLiabilities);
  rows.push(
    row({
      id: BS_ROWS.totalLiabilities,
      label: 'Total Liabilities',
      level: 0,
      values: liabilities,
      style: 'subtotal',
    }),
  );

  // ---- Equity
  rows.push(sectionRow('bs:equity', 'Equity', width));
  const postedEquity = emitTree(rootsOfType('equity'), {
    index,
    values: position,
    width,
    displaySign: 1,
    includeZeroRows: request.includeZeroRows,
    drilldown,
    idPrefix: 'bs:equity',
    baseLevel: 1,
    out: rows,
  });

  rows.push(
    row({
      id: BS_ROWS.retainedPrior,
      label: 'Earnings Retained from Prior Periods',
      level: 1,
      values: retainedPrior,
      style: 'detail',
      note: 'revenue less expenses before the period start, not yet closed to 3900',
    }),
  );
  rows.push(
    row({
      id: BS_ROWS.netIncome,
      label: 'Net Income (Current Period)',
      level: 1,
      values: periodEarnings,
      style: 'detail',
    }),
  );

  const equity = add(postedEquity, add(retainedPrior, periodEarnings));
  rows.push(
    row({ id: BS_ROWS.totalEquity, label: 'Total Equity', level: 0, values: equity, style: 'subtotal' }),
  );

  const liabilitiesAndEquity = add(liabilities, equity);
  rows.push(
    row({
      id: BS_ROWS.totalLiabilitiesAndEquity,
      label: 'TOTAL LIABILITIES & EQUITY',
      level: 0,
      values: liabilitiesAndEquity,
      style: 'total',
    }),
  );

  const outOfBalance = subtract(assets, liabilitiesAndEquity);
  const warnings = [...planWarnings, ...strategy.caveats];

  if (!isAllZero(outOfBalance)) {
    rows.push(
      row({
        id: BS_ROWS.outOfBalance,
        label: 'OUT OF BALANCE — assets do not equal liabilities plus equity',
        level: 0,
        values: outOfBalance,
        style: 'error',
        note: 'Every posted entry balances by database constraint, so this figure should be impossible. Do not file anything off this statement until it is explained.',
      }),
    );
    warnings.push(
      `The balance sheet does not balance: assets exceed liabilities and equity by ${outOfBalance.join(', ')} cents.`,
    );
  }

  const columns: ColumnDef[] = points.map((point) => ({
    key: point.key,
    label: point.label,
    sublabel: point.sublabel,
    kind: 'amount',
    from: null,
    to: point.asOf,
    emphasis: point.emphasis,
    group: point.group,
  }));

  return {
    columns,
    rows,
    meta: {
      title: 'Balance Sheet',
      subtitle: `As of ${formatLongDate(request.to)}`,
      from: request.from,
      to: request.to,
      basis: request.basis,
      columns: request.columns,
      generatedAt: today(),
      warnings,
    },
    totals: {
      assets,
      liabilities,
      equity,
      retainedPrior,
      netIncome: periodEarnings,
      outOfBalance,
    },
  };
}

/** The day the retained-earnings split falls on, for callers that need to explain it. */
export function retainedEarningsCutoff(request: ReportRequest): CalendarDate {
  return dayBefore(request.from);
}

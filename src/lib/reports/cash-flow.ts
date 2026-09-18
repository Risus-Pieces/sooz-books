/**
 * The statement of cash flows, indirect method.
 *
 * It starts from net income and walks every other balance-sheet account's
 * movement over the window into operating, investing or financing activity:
 *
 *     NET INCOME
 *   + depreciation (the movement in accumulated depreciation)
 *   − increases in operating assets     (receivables, clearing, inventory, prepaids)
 *   + increases in operating liabilities (payables, cards, accruals, taxes, deposits)
 *   = NET CASH FROM OPERATING ACTIVITIES
 *   − purchases of fixed assets          = INVESTING
 *   + member contributions − owner draws ± loans = FINANCING
 *   = NET CHANGE IN CASH
 *
 * Every account in the chart lands in exactly one line, decided by its root
 * ancestor and its subtype, never by a code range. Because a posted ledger
 * balances, the sum of all those lines is exactly the movement in the cash
 * accounts; the statement checks that identity against the cash accounts'
 * balances and prints an error row if it ever fails, rather than a plug.
 *
 * Cash is the Cash & Bank block (bank accounts, petty cash, undeposited funds).
 * Channel clearing is not cash: a Square payout the processor still holds is a
 * receivable from Square until it lands in the bank.
 */

import { type Account } from '@/db/schema';
import { today } from '@/lib/dates';
import { db } from '@/db/client';
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
  formatLongDate,
  formatWindow,
  indexAccounts,
  isAllZero,
  monthLabel,
  monthsBetween,
  row,
  sectionRow,
  spacerRow,
  subtract,
  zeros,
} from './types';

export type CashFlowLine =
  | 'cash'
  | 'net_income'
  | 'depreciation'
  | 'receivables'
  | 'clearing'
  | 'inventory'
  | 'prepaid'
  | 'other_assets'
  | 'payables'
  | 'credit_cards'
  | 'accrued'
  | 'taxes'
  | 'deferred'
  | 'other_liabilities'
  | 'retained_earnings'
  | 'fixed_assets'
  | 'contributions'
  | 'draws'
  | 'debt'
  | 'opening_equity';

type Activity = 'operating' | 'investing' | 'financing';

interface LineSpec {
  line: Exclude<CashFlowLine, 'cash'>;
  label: string;
  activity: Activity;
  /** Shown even at zero: the statement's anchors. */
  always?: boolean;
}

const LINES: readonly LineSpec[] = [
  { line: 'net_income', label: 'Net income', activity: 'operating', always: true },
  { line: 'depreciation', label: 'Depreciation & amortization', activity: 'operating' },
  { line: 'receivables', label: '(Increase) decrease in receivables', activity: 'operating' },
  { line: 'clearing', label: '(Increase) decrease in channel clearing', activity: 'operating' },
  { line: 'inventory', label: '(Increase) decrease in inventory', activity: 'operating' },
  { line: 'prepaid', label: '(Increase) decrease in prepaid expenses & deposits', activity: 'operating' },
  { line: 'other_assets', label: '(Increase) decrease in other assets', activity: 'operating' },
  { line: 'payables', label: 'Increase (decrease) in accounts payable', activity: 'operating' },
  { line: 'credit_cards', label: 'Increase (decrease) in credit cards', activity: 'operating' },
  { line: 'accrued', label: 'Increase (decrease) in accrued liabilities', activity: 'operating' },
  { line: 'taxes', label: 'Increase (decrease) in taxes payable', activity: 'operating' },
  { line: 'deferred', label: 'Increase (decrease) in customer deposits & deferred revenue', activity: 'operating' },
  { line: 'other_liabilities', label: 'Increase (decrease) in other liabilities', activity: 'operating' },
  { line: 'retained_earnings', label: 'Entries posted directly to retained earnings', activity: 'operating' },
  { line: 'fixed_assets', label: 'Purchases of fixed assets, net of disposals', activity: 'investing' },
  { line: 'contributions', label: 'Member contributions', activity: 'financing' },
  { line: 'draws', label: 'Owner draws & distributions', activity: 'financing' },
  { line: 'debt', label: 'Proceeds from (repayment of) loans & notes', activity: 'financing' },
  { line: 'opening_equity', label: 'Opening balance equity', activity: 'financing' },
];

const ACTIVITY_LABEL: Readonly<Record<Activity, string>> = Object.freeze({
  operating: 'Operating Activities',
  investing: 'Investing Activities',
  financing: 'Financing Activities',
});

const ACTIVITY_TOTAL_LABEL: Readonly<Record<Activity, string>> = Object.freeze({
  operating: 'Net cash from operating activities',
  investing: 'Net cash from investing activities',
  financing: 'Net cash from financing activities',
});

/** Stable row ids, so a caller can read a specific line without matching labels. */
export const CF_ROWS = Object.freeze({
  netIncome: 'cf:net_income',
  operating: 'cf:operating:total',
  investing: 'cf:investing:total',
  financing: 'cf:financing:total',
  netChange: 'cf:net-change',
  beginningCash: 'cf:beginning-cash',
  endingCash: 'cf:ending-cash',
  tieOutFailed: 'cf:tie-out-failed',
});

/** The line an account's movement belongs to. Pure, and exported so the mapping is testable. */
export function classifyAccount(account: Account, index: AccountIndex): CashFlowLine {
  const root = index.rootOf(account.id).code;
  const subtype = account.subtype ?? '';

  switch (account.type) {
    case 'revenue':
    case 'expense':
      return 'net_income';
    case 'asset':
      if (root === ACCOUNTS.CASH_AND_BANK || ['cash', 'bank', 'undeposited_funds'].includes(subtype)) return 'cash';
      if (root === ACCOUNTS.FIXED_ASSETS) return subtype === 'contra_asset' ? 'depreciation' : 'fixed_assets';
      if (subtype === 'fixed_asset') return 'fixed_assets';
      if (root === ACCOUNTS.CLEARING || subtype === 'clearing') return 'clearing';
      if (root === ACCOUNTS.INVENTORY || subtype === 'inventory') return 'inventory';
      if (root === ACCOUNTS.PREPAID_AND_OTHER_ASSETS || subtype === 'prepaid' || subtype === 'deposit') return 'prepaid';
      if (['accounts_receivable', 'other_receivable', 'contra_asset'].includes(subtype)) return 'receivables';
      return 'other_assets';
    case 'liability':
      if (subtype === 'accounts_payable') return 'payables';
      if (subtype === 'credit_card') return 'credit_cards';
      if (subtype === 'accrued_liability') return 'accrued';
      if (subtype === 'tax_payable') return 'taxes';
      if (subtype === 'customer_deposit' || subtype === 'deferred_revenue') return 'deferred';
      if (subtype === 'debt' || root === ACCOUNTS.NOTES_PAYABLE) return 'debt';
      return 'other_liabilities';
    case 'equity':
      if (subtype === 'contra_equity') return 'draws';
      if (subtype === 'retained_earnings') return 'retained_earnings';
      if (subtype === 'opening_balance') return 'opening_equity';
      return 'contributions';
  }
}

export interface CashFlowTotals {
  netIncome: number[];
  operating: number[];
  investing: number[];
  financing: number[];
  netChange: number[];
  beginningCash: number[];
  endingCash: number[];
  /** endingCash − beginningCash, read straight off the cash accounts. */
  cashAccountChange: number[];
}

export interface CashFlowReport extends Report {
  totals: CashFlowTotals;
}

interface Window {
  key: string;
  label: string;
  from: string;
  to: string;
  emphasis: boolean;
}

export async function cashFlowReport(request: ReportRequest, exec: LedgerDb = db): Promise<CashFlowReport> {
  const strategy = basisStrategy(request.basis);
  const accounts = await listAccounts({}, exec);
  const index = indexAccounts(accounts);
  const warnings: string[] = [...strategy.caveats];

  const windows: Window[] = [];
  if (request.columns === 'months') {
    for (const m of monthsBetween(request.from, request.to)) {
      windows.push({ key: m.from, label: monthLabel(m.from), from: m.from, to: m.to, emphasis: false });
    }
  } else if (request.columns !== 'total') {
    warnings.push('The cash flow statement is shown as a single total or by month; other column modes are not used.');
  }
  windows.push({ key: 'total', label: 'Total', from: request.from, to: request.to, emphasis: true });
  if (request.compareTo !== undefined) warnings.push('A comparison period is not shown on the cash flow statement.');
  if (request.channelIds !== undefined) {
    warnings.push('Cash is not held by channel, so the channel filter is not applied to this statement.');
  }

  const width = windows.length;
  const buckets: BalanceBucket[] = [];
  for (const w of windows) buckets.push({ key: `m:${w.key}`, from: w.from, to: w.to });
  for (const w of windows) buckets.push({ key: `b:${w.key}`, from: null, to: dayBefore(w.from) });
  for (const w of windows) buckets.push({ key: `e:${w.key}`, from: null, to: w.to });
  const balances = await fetchBalances(buckets, { basis: request.basis }, exec);

  const movement = new Map<CashFlowLine, number[]>();
  const beginningCash = zeros(width);
  const endingCash = zeros(width);
  for (const account of accounts) {
    const values = balances.valuesFor(account.id);
    if (values === undefined) continue;
    const line = classifyAccount(account, index);
    const moved = values.slice(0, width);
    if (line === 'cash') {
      addInto(beginningCash, values.slice(width, 2 * width));
      addInto(endingCash, values.slice(2 * width, 3 * width));
    }
    // Normal-signed movement → cash effect. An asset rising (or a contra asset
    // falling) uses cash; a liability, equity or income account rising provides
    // it; an expense is income with the sign turned over.
    const effect =
      account.type === 'asset' || account.type === 'expense' ? moved.map((v) => (v === 0 ? 0 : -v)) : moved;
    const slot = movement.get(line) ?? zeros(width);
    addInto(slot, effect);
    movement.set(line, slot);
  }

  const rows: ReportRow[] = [];
  const activityTotals: Record<Activity, number[]> = {
    operating: zeros(width),
    investing: zeros(width),
    financing: zeros(width),
  };

  for (const activity of ['operating', 'investing', 'financing'] as const) {
    rows.push(sectionRow(`cf:${activity}`, ACTIVITY_LABEL[activity], width));
    for (const spec of LINES.filter((l) => l.activity === activity)) {
      const values = movement.get(spec.line) ?? zeros(width);
      addInto(activityTotals[activity], values);
      if (isAllZero(values) && spec.always !== true && !request.includeZeroRows) continue;
      rows.push(row({ id: `cf:${spec.line}`, label: spec.label, level: 1, values: [...values] }));
    }
    rows.push(
      row({
        id: `cf:${activity}:total`,
        label: ACTIVITY_TOTAL_LABEL[activity],
        values: [...activityTotals[activity]],
        style: 'subtotal',
      }),
    );
    rows.push(spacerRow(`cf:${activity}:spacer`, width));
  }

  const netChange = add(add(activityTotals.operating, activityTotals.investing), activityTotals.financing);
  const cashAccountChange = subtract(endingCash, beginningCash);
  rows.push(row({ id: CF_ROWS.netChange, label: 'NET CHANGE IN CASH', values: netChange, style: 'total' }));
  rows.push(
    row({
      id: CF_ROWS.beginningCash,
      label: 'Cash at beginning of period',
      values: beginningCash,
      note: formatLongDate(dayBefore(request.from)),
    }),
  );
  rows.push(
    row({
      id: CF_ROWS.endingCash,
      label: 'CASH AT END OF PERIOD',
      values: add(beginningCash, netChange),
      style: 'total',
      note: formatLongDate(request.to),
    }),
  );

  if (!isAllZero(subtract(netChange, cashAccountChange))) {
    rows.push(
      row({
        id: CF_ROWS.tieOutFailed,
        label: 'STATEMENT DOES NOT TIE TO THE CASH ACCOUNTS',
        values: subtract(cashAccountChange, netChange),
        style: 'error',
        note: 'The movement in the cash accounts differs from the net change above by this amount.',
      }),
    );
    warnings.push('The net change in cash does not agree with the cash accounts. The statement is unreliable.');
  }

  const columns: ColumnDef[] = windows.map((w) => ({
    key: w.key,
    label: w.label,
    sublabel: w.emphasis && width === 1 ? formatWindow(w.from, w.to) : undefined,
    kind: 'amount',
    from: w.from,
    to: w.to,
    emphasis: w.emphasis,
    group: 'current',
  }));

  return {
    columns,
    rows,
    totals: {
      netIncome: movement.get('net_income') ?? zeros(width),
      operating: activityTotals.operating,
      investing: activityTotals.investing,
      financing: activityTotals.financing,
      netChange,
      beginningCash,
      endingCash,
      cashAccountChange,
    },
    meta: {
      title: 'Statement of Cash Flows',
      subtitle: formatWindow(request.from, request.to),
      from: request.from,
      to: request.to,
      basis: request.basis,
      columns: request.columns === 'months' ? 'months' : 'total',
      generatedAt: today(),
      warnings,
    },
  };
}

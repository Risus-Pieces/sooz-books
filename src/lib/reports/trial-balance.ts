/**
 * The trial balance: every account with a balance as of a date, in two columns
 * that must agree.
 *
 * It is the report the other three are checked against. If this one does not
 * tie, nothing else on the reporting surface can be trusted, so the failure is
 * rendered as an error row rather than left for the reader to notice.
 */

import { db } from '@/db/client';
import type { Account, AccountType } from '@/db/schema';
import { today } from '@/lib/dates';
import { listAccounts } from '@/lib/ledger/accounts';
import type { LedgerDb } from '@/lib/ledger/post';

import { basisStrategy, fetchBalances } from './basis';
import {
  type ColumnDef,
  type Report,
  type ReportRequest,
  type ReportRow,
  formatLongDate,
  row,
} from './types';

/** Accounts that live on the opposite side of their type by design. */
const CONTRA_SUBTYPES: ReadonlySet<string> = new Set([
  'contra_asset',
  'contra_equity',
  'contra_revenue',
]);

const NORMAL_SIDE: Readonly<Record<AccountType, 'debit' | 'credit'>> = {
  asset: 'debit',
  expense: 'debit',
  liability: 'credit',
  equity: 'credit',
  revenue: 'credit',
};

const TYPE_LABEL: Readonly<Record<AccountType, string>> = {
  asset: 'asset',
  liability: 'liability',
  equity: 'equity',
  revenue: 'revenue',
  expense: 'expense',
};

function isContra(account: Account): boolean {
  return account.subtype !== null && CONTRA_SUBTYPES.has(account.subtype);
}

export interface TrialBalanceLine {
  account: Account;
  /** Net debit for the account, 0 when it nets to a credit. */
  debitCents: number;
  creditCents: number;
  /** Signed by the account's normal balance: negative means it sits on the wrong side. */
  balanceCents: number;
  flagged: boolean;
}

export interface TrialBalanceData {
  asOf: string;
  lines: TrialBalanceLine[];
  debitTotalCents: number;
  creditTotalCents: number;
}

/**
 * The numbers behind the report, without the presentation. Tests and the balance
 * sheet's tie-out read this rather than picking rows apart.
 */
export async function trialBalanceData(
  request: ReportRequest,
  exec: LedgerDb = db,
): Promise<TrialBalanceData> {
  const accounts = await listAccounts({}, exec);
  const balances = await fetchBalances(
    [{ key: 'asOf', from: null, to: request.to }],
    { basis: request.basis, channelIds: request.channelIds },
    exec,
  );

  const lines: TrialBalanceLine[] = [];
  let debitTotalCents = 0;
  let creditTotalCents = 0;

  for (const account of accounts) {
    const signed = balances.valuesFor(account.id)?.[0] ?? 0;
    if (signed === 0 && !request.includeZeroRows) continue;

    // `signed` is already in the account's normal sign, so undoing that sign
    // recovers the raw debit-minus-credit the two columns are cut from.
    const net = NORMAL_SIDE[account.type] === 'debit' ? signed : -signed;
    const debitCents = net > 0 ? net : 0;
    const creditCents = net < 0 ? -net : 0;
    debitTotalCents += debitCents;
    creditTotalCents += creditCents;

    lines.push({
      account,
      debitCents,
      creditCents,
      balanceCents: signed,
      flagged: signed < 0 && !isContra(account),
    });
  }

  return { asOf: request.to, lines, debitTotalCents, creditTotalCents };
}

function flagNote(account: Account): string {
  const side = NORMAL_SIDE[account.type] === 'debit' ? 'credit' : 'debit';
  return `${side} balance in a ${TYPE_LABEL[account.type]} account`;
}

/**
 * The trial balance as a report matrix. Only the as-of date is used; a trial
 * balance is a position, not a movement, so column modes other than a single
 * total are reported as ignored rather than quietly reinterpreted.
 */
export async function trialBalanceReport(
  request: ReportRequest,
  exec: LedgerDb = db,
): Promise<Report> {
  const strategy = basisStrategy(request.basis);
  const data = await trialBalanceData(request, exec);

  const columns: ColumnDef[] = [
    { key: 'debit', label: 'Debit', kind: 'amount', to: request.to, group: 'current' },
    { key: 'credit', label: 'Credit', kind: 'amount', to: request.to, group: 'current' },
  ];

  const rows: ReportRow[] = [];
  for (const line of data.lines) {
    rows.push(
      row({
        id: `tb:${line.account.code}`,
        accountId: line.account.id,
        code: line.account.code,
        label: line.account.name,
        level: 1,
        values: [line.debitCents, line.creditCents],
        style: 'detail',
        drilldown: { accountId: line.account.id, from: request.from, to: request.to },
        note: line.flagged ? flagNote(line.account) : undefined,
      }),
    );
  }

  rows.push(
    row({
      id: 'tb:total',
      label: 'Total',
      level: 0,
      values: [data.debitTotalCents, data.creditTotalCents],
      style: 'total',
    }),
  );

  const warnings = [...strategy.caveats];
  if (request.columns !== 'total') {
    warnings.push(
      'A trial balance is a position as of one date, so the column mode was ignored.',
    );
  }

  const outOfBalance = data.debitTotalCents - data.creditTotalCents;
  if (outOfBalance !== 0) {
    rows.push(
      row({
        id: 'tb:out-of-balance',
        label: 'OUT OF BALANCE — debits do not equal credits',
        level: 0,
        values: [outOfBalance > 0 ? outOfBalance : 0, outOfBalance < 0 ? -outOfBalance : 0],
        style: 'error',
        note: 'Every posted entry is balanced by a database constraint, so this can only mean the ledger was written around it. Stop and investigate.',
      }),
    );
    warnings.push(
      `Debits and credits differ by ${outOfBalance} cents as of ${request.to}. The trial balance does not tie.`,
    );
  }

  const flagged = data.lines.filter((line) => line.flagged);
  if (flagged.length > 0) {
    warnings.push(
      `${flagged.length} ${flagged.length === 1 ? 'account is' : 'accounts are'} on the wrong side of their normal balance: ` +
        `${flagged.map((line) => line.account.code).join(', ')}.`,
    );
  }

  return {
    columns,
    rows,
    meta: {
      title: 'Trial Balance',
      subtitle: `As of ${formatLongDate(request.to)}`,
      from: request.from,
      to: request.to,
      basis: request.basis,
      columns: 'total',
      generatedAt: today(),
      warnings,
    },
  };
}

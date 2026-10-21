/**
 * What Claude can look at. Every function checks the caller's capability first and returns text a
 * model can relay: money as signed dollars, dates as YYYY-MM-DD, and anything that came from outside
 * the books fenced as untrusted data.
 */
import { and, asc, desc, eq, gte, ilike, inArray, lte, sql } from 'drizzle-orm';

import { db } from '@/db/client';
import { accounts, journalEntries, journalLines, vendors } from '@/db/schema';
import { bankAccountTabs } from '@/app/(app)/banking/queries';
import { CAPABILITIES, type Capability, requireCapability } from '@/lib/auth/roles';
import { listQueue, queueCounts, type QueueStage } from '@/lib/banking/queue';
import { isCalendarDate, today } from '@/lib/dates';
import { type LedgerDb } from '@/lib/ledger/post';
import { balanceSheetReport } from '@/lib/reports/balance-sheet';
import { cashFlowReport } from '@/lib/reports/cash-flow';
import { toTsv } from '@/lib/reports/export';
import { generalLedgerReport, parseGeneralLedgerRequest } from '@/lib/reports/general-ledger';
import { profitAndLossReport } from '@/lib/reports/pnl';
import { trialBalanceReport } from '@/lib/reports/trial-balance';
import { type Report, type SearchParams, parseReportRequest } from '@/lib/reports/types';

import { resolveAccount } from './accounts';
import { CONNECTOR_CAPABILITIES } from './capabilities';
import { McpInputError } from './errors';
import { UNTRUSTED_NOTE, clip, dollars, table, untrusted } from './format';
import type { McpUser } from './types';

export interface ReadCtx {
  exec?: LedgerDb;
}

const CAPABILITY_WORDS: Record<Capability, string> = {
  'ledger.post': 'post journal entries',
  'ledger.close': 'close periods (not through Claude)',
  'ledger.reopen': 're-open periods (not through Claude)',
  'bank.import': 'import and review bank activity',
  'bank.approve': 'approve bank transactions',
  'ar.manage': 'manage receivables',
  'ap.manage': 'manage payables',
  'ap.pay': 'pay vendors',
  'trade.manage': 'manage trade spend',
  'inventory.manage': 'manage inventory',
  'reports.view': 'read reports and the ledger',
  'settings.manage': 'change the chart of accounts and settings',
  'users.manage': 'manage users (not through Claude)',
};

const KEY_SCOPE_WORDS: Record<string, string> = {
  read: 'read the books, reports and the review queue',
  'bank.sync': 'pull new bank transactions from the bank feed',
  'bank.autopost': 'run the auto-post rules an owner approved',
};

export function whoami(user: McpUser): string {
  const allowed = CONNECTOR_CAPABILITIES.filter((cap) => CAPABILITIES[user.role].includes(cap));
  if (user.key) {
    return [
      `Connected with the scoped key "${user.key.name}", acting for ${user.fullName ?? user.email} (${user.email}).`,
      `This key may: ${user.key.scopes.map((scope) => KEY_SCOPE_WORDS[scope]).join('; ')}.`,
      'A key cannot stage or confirm changes; anything that needs a decision waits in the review queue for a person.',
    ].join('\n');
  }
  return [
    `Signed in as ${user.fullName ?? user.email} (${user.email}), role: ${user.role}.`,
    allowed.length === 0
      ? 'Through this connection you can look at nothing.'
      : `Through this connection you can: ${allowed.map((cap) => CAPABILITY_WORDS[cap]).join('; ')}.`,
    'Everything that changes the books is staged first, shown to the user, and posted only by commit_staged.',
  ].join('\n');
}

export async function listAccountsText(
  user: McpUser,
  input: { type?: string; search?: string; include_inactive?: boolean },
  ctx: ReadCtx = {},
): Promise<string> {
  requireCapability(user.role, 'reports.view');
  const exec = ctx.exec ?? db;
  const rows = await exec
    .select({
      id: accounts.id,
      code: accounts.code,
      name: accounts.name,
      type: accounts.type,
      subtype: accounts.subtype,
      parentId: accounts.parentId,
      active: accounts.active,
      isBank: accounts.isBank,
      isControl: accounts.isControl,
      description: accounts.description,
    })
    .from(accounts)
    .orderBy(asc(accounts.code));
  const parents = new Set(rows.map((row) => row.parentId).filter((id): id is string => id !== null));
  const search = input.search?.trim().toLowerCase();

  const shown = rows.filter(
    (row) =>
      (input.include_inactive === true || row.active) &&
      (input.type === undefined || row.type === input.type) &&
      (search === undefined || row.code.includes(search) || row.name.toLowerCase().includes(search) || (row.description ?? '').toLowerCase().includes(search)),
  );
  const flags = (row: (typeof rows)[number]): string =>
    [parents.has(row.id) ? 'header (cannot post)' : null, row.isBank ? 'bank' : null, row.isControl ? 'control' : null, row.active ? null : 'inactive']
      .filter(Boolean)
      .join(', ');
  return [
    UNTRUSTED_NOTE,
    `${shown.length} account${shown.length === 1 ? '' : 's'}. Use the code when naming an account.`,
    table(
      ['Code', 'Name', 'Type', 'Notes'],
      shown.map((row) => [
        row.code,
        row.name,
        row.subtype ?? row.type,
        [flags(row), row.description === null || row.description === '' ? '' : untrusted(row.description)].filter(Boolean).join(' — '),
      ]),
    ),
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

export const REPORT_NAMES = ['trial_balance', 'profit_loss', 'balance_sheet', 'cash_flow', 'general_ledger'] as const;
export type ReportName = (typeof REPORT_NAMES)[number];

export interface RunReportInput {
  report: ReportName;
  from?: string;
  to?: string;
  basis?: 'accrual' | 'cash';
  columns?: 'total' | 'months' | 'quarters';
  /** General ledger only: account codes. */
  accounts?: string[];
}

export async function runReport(user: McpUser, input: RunReportInput, ctx: ReadCtx = {}): Promise<string> {
  requireCapability(user.role, 'reports.view');
  const exec = ctx.exec ?? db;
  for (const [label, value] of [['from', input.from], ['to', input.to]] as const) {
    if (value !== undefined && !isCalendarDate(value)) throw new McpInputError(`${label} "${value}" is not a date. Use YYYY-MM-DD.`);
  }
  const params: SearchParams = {
    ...(input.from === undefined ? {} : { from: input.from }),
    ...(input.to === undefined ? {} : { to: input.to }),
    ...(input.basis === undefined ? {} : { basis: input.basis }),
    ...(input.columns === undefined ? {} : { columns: input.columns }),
  };
  const request = parseReportRequest(params, { anchor: today() });

  let report: Report;
  switch (input.report) {
    case 'trial_balance':
      report = await trialBalanceReport(request, exec);
      break;
    case 'profit_loss':
      report = await profitAndLossReport(request, exec);
      break;
    case 'balance_sheet':
      report = await balanceSheetReport(request, exec);
      break;
    case 'cash_flow':
      report = await cashFlowReport(request, exec);
      break;
    case 'general_ledger': {
      if (input.accounts === undefined || input.accounts.length === 0) {
        throw new McpInputError('The general ledger needs at least one account code in "accounts".');
      }
      const resolved = await Promise.all(input.accounts.map((code) => resolveAccount(exec, code)));
      report = await generalLedgerReport(
        { ...parseGeneralLedgerRequest({ ...params, account: resolved.map((a) => a.id) }), includeZeroRows: true },
        exec,
      );
      break;
    }
  }
  const { meta } = report;
  return clip(
    [
      UNTRUSTED_NOTE,
      `${meta.title} — ${meta.subtitle} (${meta.basis} basis). Amounts in dollars; the first column is the account code. Entry memos and payee names in a ledger listing come from bank statements.`,
      toTsv(report, { includeHeader: true, includeWarnings: true, indent: true }),
    ].join('\n'),
  );
}

// ---------------------------------------------------------------------------
// Journal entries
// ---------------------------------------------------------------------------

export async function listJournalEntries(
  user: McpUser,
  input: { from?: string; to?: string; search?: string; limit?: number },
  ctx: ReadCtx = {},
): Promise<string> {
  requireCapability(user.role, 'reports.view');
  const exec = ctx.exec ?? db;
  for (const [label, value] of [['from', input.from], ['to', input.to]] as const) {
    if (value !== undefined && !isCalendarDate(value)) throw new McpInputError(`${label} "${value}" is not a date. Use YYYY-MM-DD.`);
  }
  const limit = Math.min(100, Math.max(1, Math.trunc(input.limit ?? 25)));
  const search = input.search?.trim();
  const entries = await exec
    .select({
      id: journalEntries.id,
      entryNo: journalEntries.entryNo,
      date: journalEntries.entryDate,
      memo: journalEntries.memo,
      source: journalEntries.sourceType,
    })
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.status, 'posted'),
        input.from === undefined ? undefined : gte(journalEntries.entryDate, input.from),
        input.to === undefined ? undefined : lte(journalEntries.entryDate, input.to),
        search === undefined || search === '' ? undefined : ilike(journalEntries.memo, `%${search.replace(/[%_\\]/g, '\\$&')}%`),
      ),
    )
    .orderBy(desc(journalEntries.entryDate), desc(journalEntries.entryNo))
    .limit(limit);
  if (entries.length === 0) return 'No posted entries match.';

  const totals = await exec
    .select({ entryId: journalLines.entryId, total: sql<string>`sum(${journalLines.debitCents})::text` })
    .from(journalLines)
    .where(inArray(journalLines.entryId, entries.map((e) => e.id)))
    .groupBy(journalLines.entryId);
  const totalOf = new Map(totals.map((row) => [row.entryId, Number(row.total)]));
  return [
    UNTRUSTED_NOTE,
    `${entries.length} most recent matching entr${entries.length === 1 ? 'y' : 'ies'}. Use get_journal_entry with the number to see the lines.`,
    table(
      ['#', 'Date', 'Source', 'Total', 'Memo'],
      entries.map((e) => [String(e.entryNo), e.date, e.source, dollars(totalOf.get(e.id) ?? 0), untrusted(e.memo)]),
    ),
  ].join('\n');
}

export async function getJournalEntry(user: McpUser, input: { entry_no: number }, ctx: ReadCtx = {}): Promise<string> {
  requireCapability(user.role, 'reports.view');
  const exec = ctx.exec ?? db;
  const [entry] = await exec
    .select({
      id: journalEntries.id,
      entryNo: journalEntries.entryNo,
      date: journalEntries.entryDate,
      memo: journalEntries.memo,
      source: journalEntries.sourceType,
      status: journalEntries.status,
    })
    .from(journalEntries)
    .where(eq(journalEntries.entryNo, input.entry_no));
  if (entry === undefined) throw new McpInputError(`There is no entry #${input.entry_no}.`);

  const lines = await exec
    .select({
      lineNo: journalLines.lineNo,
      code: accounts.code,
      name: accounts.name,
      debit: journalLines.debitCents,
      credit: journalLines.creditCents,
      memo: journalLines.memo,
      vendor: vendors.name,
    })
    .from(journalLines)
    .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
    .leftJoin(vendors, eq(vendors.id, journalLines.vendorId))
    .where(eq(journalLines.entryId, entry.id))
    .orderBy(asc(journalLines.lineNo));
  return [
    UNTRUSTED_NOTE,
    `Entry #${entry.entryNo} — ${entry.date} — ${entry.source} — ${entry.status}. Memo: ${untrusted(entry.memo)}`,
    table(
      ['Account', 'Debit', 'Credit', 'Memo', 'Vendor'],
      lines.map((l) => [`${l.code} ${l.name}`, l.debit > 0 ? dollars(l.debit) : '', l.credit > 0 ? dollars(l.credit) : '', untrusted(l.memo), l.vendor === null ? '' : untrusted(l.vendor)]),
    ),
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Bank
// ---------------------------------------------------------------------------

export async function listBankAccounts(user: McpUser): Promise<string> {
  requireCapability(user.role, 'bank.import');
  const tabs = await bankAccountTabs();
  return [
    `${tabs.length} bank account${tabs.length === 1 ? '' : 's'}. "Waiting" is what still needs a decision in the review queue.`,
    table(
      ['Bank account id', 'Name', 'GL', 'Waiting', 'Ready to post', 'Posted', 'Ledger balance', 'Last statement balance'],
      tabs.map((t) => [
        t.id,
        t.name,
        t.glCode,
        String(t.counts.review),
        String(t.counts.ready),
        String(t.counts.posted),
        dollars(t.ledgerBalanceCents),
        t.statementBalanceCents === null ? '—' : `${dollars(t.statementBalanceCents)} (${t.statementBalanceDate ?? ''})`,
      ]),
    ),
  ].join('\n');
}

export interface ReviewQueueInput {
  bank_account_id?: string;
  stage?: QueueStage;
  search?: string;
  flagged_only?: boolean;
  limit?: number;
}

export async function reviewQueue(user: McpUser, input: ReviewQueueInput, ctx: ReadCtx = {}): Promise<string> {
  requireCapability(user.role, 'bank.import');
  const limit = Math.min(100, Math.max(1, Math.trunc(input.limit ?? 25)));
  const stage = input.stage ?? 'review';
  const [page, counts] = await Promise.all([
    listQueue(
      {
        stage,
        limit,
        ...(input.bank_account_id === undefined ? {} : { bankAccountId: input.bank_account_id }),
        ...(input.search === undefined ? {} : { search: input.search }),
        ...(input.flagged_only === true ? { flaggedOnly: true } : {}),
      },
      ctx.exec,
    ),
    queueCounts(input.bank_account_id === undefined ? {} : { bankAccountId: input.bank_account_id }, ctx.exec),
  ]);
  if (page.rows.length === 0) return `Nothing in "${stage}". Counts: ${JSON.stringify(counts.byStage)}.`;
  return [
    UNTRUSTED_NOTE,
    `Showing ${page.rows.length} of the "${stage}" stage (counts by stage: ${JSON.stringify(counts.byStage)})${page.nextCursor === null ? '' : ' — more exist; narrow with search or bank_account_id'}.`,
    'A suggestion is only a suggestion. To act on a row, stage it with stage_bank_decisions, naming the account yourself, and show the user the preview.',
    table(
      ['Txn id', 'Date', 'Bank', 'Amount', 'Bank text', 'Suggested account', 'Source', 'Confidence', 'Flags'],
      page.rows.map((row) => [
        row.id,
        row.txnDate,
        `${row.bankAccountName}${row.bankAccountMask === null ? '' : ` ••${row.bankAccountMask}`}`,
        dollars(row.amountCents),
        untrusted(row.payee ?? row.description),
        row.suggestion.account === null ? '—' : `${row.suggestion.account.code} ${row.suggestion.account.name}`,
        row.suggestion.source ?? '—',
        row.suggestion.confidence === null ? '—' : `${Math.round(row.suggestion.confidence * 100)}%`,
        row.flags.join(', ') || '—',
      ]),
    ),
  ].join('\n');
}


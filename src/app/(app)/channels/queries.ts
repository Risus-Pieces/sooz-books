/**
 * The reads behind the channel screens: each clearing account's state, the settlement
 * register, one settlement with the exact entry posting it would write, the sales tax
 * register and its filings.
 *
 * Nothing here writes. The entry shown for an unposted settlement is built by the same pure
 * function `postPayout` posts from (`buildPayoutEntry`), fed the same lines and memo, so the
 * screen cannot show one entry and post another.
 */

import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';

import { accounts, bankTransactions, channels, journalEntries, journalLines, payoutImports, payoutLines, salesTaxFilings } from '@/db/schema';
import type { PayoutImport, PayoutLine } from '@/db/schema';
import { BOOKS_TIME_ZONE, type CalendarDate, daysBetween, today } from '@/lib/dates';
import { PROVIDER_LABEL, SETTLEMENT_PROVIDERS, accountForRole, roleOfLine } from '@/lib/channels/accounts';
import { IN_TRANSIT_DAYS, STALE_DAYS, clearingStatus } from '@/lib/channels/clearing';
import { buildPayoutEntry } from '@/lib/channels/entry';
import { isChannelError } from '@/lib/channels/errors';
import { PAYOUT_MATCH_TYPE, depositCandidates } from '@/lib/channels/post';
import { HOME_STATE, salesTaxLiability } from '@/lib/channels/sales-tax';
import type { LedgerDb } from '@/lib/ledger/post';
import { formatMoney, sumCents } from '@/lib/money';

import {
  type BankOptionView,
  type ChannelCardView,
  type DepositCandidateView,
  type DepositState,
  type FilingView,
  type LiabilityView,
  type ProviderKey,
  type SettlementDetailView,
  type SettlementIssueView,
  type SettlementLineView,
  type SettlementRowView,
  isProviderKey,
} from '@/components/channels/types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function database(exec?: LedgerDb): Promise<LedgerDb> {
  return exec ?? (await import('@/db/client')).db;
}

function cents(value: unknown): number {
  if (value === null || value === undefined) return 0;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(n)) throw new Error(`Expected whole cents from the database, got ${String(value)}`);
  return n;
}

const STAMP = new Intl.DateTimeFormat('en-US', {
  timeZone: BOOKS_TIME_ZONE,
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

function stamp(value: Date | string | null): string | null {
  if (value === null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : STAMP.format(date);
}

function rawString(raw: PayoutLine['raw'], key: string): string | null {
  const value = raw?.[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

function providerOf(value: string): ProviderKey {
  if (!isProviderKey(value)) throw new Error(`"${value}" is not a settlement channel this screen shows.`);
  return value;
}

// ---------------------------------------------------------------------------
// Clearing, per channel
// ---------------------------------------------------------------------------

/** One card per settlement channel: what its clearing account holds, and why. */
export async function channelCards(exec?: LedgerDb): Promise<ChannelCardView[]> {
  const db = await database(exec);
  const cards: ChannelCardView[] = [];
  for (const provider of SETTLEMENT_PROVIDERS) {
    const status = await clearingStatus(provider, {}, db);
    const last = status.settlements.length === 0 ? null : status.settlements[status.settlements.length - 1];
    const unmatched = status.unmatchedDeposits;
    cards.push({
      provider,
      accountCode: status.account.code,
      accountName: status.account.name,
      asOf: status.asOf,
      balanceCents: status.balanceCents,
      projectedBalanceCents: status.projectedBalanceCents,
      pendingDepositsCents: status.pendingDepositsCents,
      settlements: status.settlements.map((s) => ({
        id: s.id,
        key: s.key,
        date: s.date,
        netCents: s.netCents,
        posted: s.posted,
        depositCents: s.depositCents,
      })),
      deposits: status.deposits.map((d) => ({ ...d })),
      unmatchedDepositCount: unmatched.length,
      unmatchedDepositCents: sumCents(unmatched.map((d) => d.amountCents)),
      unmatchedSettlementCount: status.unmatchedSettlements.length,
      exceptions: status.exceptions.map((e) => ({
        severity: e.severity,
        code: e.code,
        message: e.message,
        amountCents: e.amountCents,
        date: e.date,
      })),
      blocking: status.blocking,
      explanation: status.explanation,
      lastSettlement:
        last === null ? null : { id: last.id, key: last.key, date: last.date, netCents: last.netCents, posted: last.posted },
      connected: status.settlements.length > 0 || status.deposits.length > 0 || status.balanceCents !== 0,
    });
  }
  return cards;
}

// ---------------------------------------------------------------------------
// The settlement register
// ---------------------------------------------------------------------------

function depositState(netCents: number, depositCents: number, date: CalendarDate | null, asOf: CalendarDate): DepositState {
  if (netCents === 0) return 'none';
  if (depositCents === netCents) return 'matched';
  const age = date === null ? 0 : daysBetween(date, asOf);
  if (age <= IN_TRANSIT_DAYS) return 'waiting';
  return age <= STALE_DAYS ? 'late' : 'stale';
}

interface RowExtras {
  linesCents: number;
  lineCount: number;
  depositCents: number;
  entryNo: number | null;
}

function toRow(payout: PayoutImport, extras: RowExtras, asOf: CalendarDate): SettlementRowView {
  const date = payout.periodEnd ?? payout.periodStart;
  return {
    id: payout.id,
    provider: providerOf(payout.provider),
    key: payout.externalId,
    periodStart: payout.periodStart,
    periodEnd: payout.periodEnd,
    grossCents: payout.grossCents,
    feesCents: payout.feesCents,
    netCents: payout.netCents,
    reportedCents: payout.reportedTotalCents,
    linesCents: extras.linesCents,
    lineCount: extras.lineCount,
    depositState: depositState(payout.netCents, extras.depositCents, date, asOf),
    depositDate: payout.depositDate,
    depositCents: extras.depositCents,
    entryId: payout.journalEntryId,
    entryNo: extras.entryNo,
    filename: payout.filename,
    importedAt: stamp(payout.createdAt) ?? '',
  };
}

async function extrasFor(db: LedgerDb, payouts: readonly PayoutImport[]): Promise<Map<string, RowExtras>> {
  const ids = payouts.map((p) => p.id);
  const out = new Map<string, RowExtras>();
  if (ids.length === 0) return out;
  const entryIds = payouts.flatMap((p) => (p.journalEntryId === null ? [] : [p.journalEntryId]));
  const [lineSums, depositSums, entries] = await Promise.all([
    db
      .select({
        id: payoutLines.payoutImportId,
        total: sql<string>`coalesce(sum(${payoutLines.amountCents}), 0)::text`,
        count: sql<number>`count(*)::int`,
      })
      .from(payoutLines)
      .where(inArray(payoutLines.payoutImportId, ids))
      .groupBy(payoutLines.payoutImportId),
    db
      .select({ id: bankTransactions.matchedId, total: sql<string>`coalesce(sum(${bankTransactions.amountCents}), 0)::text` })
      .from(bankTransactions)
      .where(and(eq(bankTransactions.matchedType, PAYOUT_MATCH_TYPE), inArray(bankTransactions.matchedId, ids)))
      .groupBy(bankTransactions.matchedId),
    entryIds.length === 0
      ? Promise.resolve([] as { id: string; entryNo: number }[])
      : db
          .select({ id: journalEntries.id, entryNo: journalEntries.entryNo })
          .from(journalEntries)
          .where(inArray(journalEntries.id, entryIds)),
  ]);
  const lineBy = new Map(lineSums.map((r) => [r.id, r]));
  const depositBy = new Map(depositSums.map((r) => [r.id, cents(r.total)]));
  const entryBy = new Map(entries.map((r) => [r.id, Number(r.entryNo)]));
  for (const p of payouts) {
    const line = lineBy.get(p.id);
    out.set(p.id, {
      linesCents: cents(line?.total ?? 0),
      lineCount: line?.count ?? 0,
      depositCents: depositBy.get(p.id) ?? 0,
      entryNo: p.journalEntryId === null ? null : entryBy.get(p.journalEntryId) ?? null,
    });
  }
  return out;
}

/** Every imported settlement for the four channels, newest first. */
export async function settlementRows(provider: ProviderKey | null, exec?: LedgerDb): Promise<SettlementRowView[]> {
  const db = await database(exec);
  const payouts = await db
    .select()
    .from(payoutImports)
    .where(
      provider === null
        ? inArray(payoutImports.provider, [...SETTLEMENT_PROVIDERS])
        : eq(payoutImports.provider, provider),
    )
    .orderBy(desc(payoutImports.periodEnd), desc(payoutImports.createdAt))
    .limit(500);
  const extras = await extrasFor(db, payouts);
  const asOf = today();
  return payouts.map((p) => toRow(p, extras.get(p.id) ?? { linesCents: 0, lineCount: 0, depositCents: 0, entryNo: null }, asOf));
}

/** How many settlements each channel has, for the filter tabs. */
export async function settlementCounts(exec?: LedgerDb): Promise<Record<ProviderKey, number>> {
  const db = await database(exec);
  const rows = await db
    .select({ provider: payoutImports.provider, count: sql<number>`count(*)::int` })
    .from(payoutImports)
    .groupBy(payoutImports.provider);
  const out: Record<ProviderKey, number> = { square: 0, shopify: 0, amazon: 0, faire: 0 };
  for (const row of rows) if (isProviderKey(row.provider)) out[row.provider] = row.count;
  return out;
}

// ---------------------------------------------------------------------------
// One settlement
// ---------------------------------------------------------------------------

function issueList(payout: PayoutImport): SettlementIssueView[] {
  return payout.warnings
    .filter((w) => w.severity !== 'info' || !/source_file$/.test(w.code))
    .map((w) => ({ severity: w.severity, code: w.code, message: w.message, remedy: w.remedy ?? null }));
}

/**
 * A settlement, its lines, the account each line lands on, and the journal entry: the one
 * the ledger holds once posted, or exactly the one posting would write before then (or why
 * posting would be refused).
 */
export async function settlementDetail(id: string, exec?: LedgerDb): Promise<SettlementDetailView | null> {
  if (!UUID.test(id)) return null;
  const db = await database(exec);
  const [payout] = await db.select().from(payoutImports).where(eq(payoutImports.id, id));
  if (payout === undefined || !isProviderKey(payout.provider)) return null;

  const [lines, [channel], extras] = await Promise.all([
    db.select().from(payoutLines).where(eq(payoutLines.payoutImportId, id)).orderBy(asc(payoutLines.lineNo)),
    db.select({ code: channels.code }).from(channels).where(eq(channels.id, payout.channelId)),
    extrasFor(db, [payout]),
  ]);
  const row = toRow(payout, extras.get(payout.id) ?? { linesCents: 0, lineCount: 0, depositCents: 0, entryNo: null }, today());
  const provider = row.provider;
  const accountCtx = { provider: payout.provider, channelCode: channel?.code ?? null };

  // Account names for every code a line can land on.
  const lineCode = (line: PayoutLine): string | null => {
    const role = roleOfLine(line.lineType, rawString(line.raw, 'accountRole'));
    try {
      return accountForRole(role, accountCtx);
    } catch {
      return null;
    }
  };
  const codes = new Set<string>(lines.flatMap((l) => {
    const code = lineCode(l);
    return code === null ? [] : [code];
  }));

  // The entry.
  const memo = `${PROVIDER_LABEL[payout.provider]} settlement ${payout.externalId ?? payout.id} — net ${formatMoney(payout.reportedTotalCents ?? payout.netCents)}`;
  const date = payout.periodEnd ?? payout.periodStart ?? payout.depositDate;
  let entry: SettlementDetailView['entry'];
  let postedLines: { code: string; name: string; memo: string | null; debit: number; credit: number }[] = [];
  if (payout.journalEntryId !== null) {
    const rows = await db
      .select({
        code: accounts.code,
        name: accounts.name,
        memo: journalLines.memo,
        debit: journalLines.debitCents,
        credit: journalLines.creditCents,
        date: journalEntries.entryDate,
        entryMemo: journalEntries.memo,
      })
      .from(journalLines)
      .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
      .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
      .where(eq(journalLines.entryId, payout.journalEntryId))
      .orderBy(asc(journalLines.lineNo));
    postedLines = rows.map((r) => ({ code: r.code, name: r.name, memo: r.memo, debit: cents(r.debit), credit: cents(r.credit) }));
    const facilitator = sumCents(lines.filter((l) => l.lineType === 'facilitator_tax').map((l) => Math.abs(l.amountCents)));
    const clearingCode = rows.find((r) => /Clearing/i.test(r.name))?.code ?? null;
    entry = {
      kind: 'posted',
      date: rows[0]?.date ?? date,
      memo: rows[0]?.entryMemo ?? memo,
      lines: postedLines.map((l) => ({ accountCode: l.code, accountName: l.name, memo: l.memo, debitCents: l.debit, creditCents: l.credit })),
      clearingAccountCode: clearingCode,
      clearingCents: payout.netCents,
      facilitatorGrossCents: facilitator,
      suspenseCents: sumCents(postedLines.filter((l) => l.code === '7900').map((l) => l.credit - l.debit)),
      refusal: null,
    };
  } else {
    try {
      const plan = buildPayoutEntry(
        lines.map((line) => ({
          lineNo: line.lineNo,
          lineType: line.lineType,
          amountCents: line.amountCents,
          description: line.description,
          recordedRole: rawString(line.raw, 'accountRole'),
        })),
        { ...accountCtx, channelId: payout.channelId, memo },
      );
      for (const l of plan.lines) codes.add(l.accountCode);
      entry = {
        kind: 'planned',
        date,
        memo,
        lines: plan.lines.map((l) => ({
          accountCode: l.accountCode,
          accountName: '',
          memo: l.memo ?? null,
          debitCents: l.debitCents ?? 0,
          creditCents: l.creditCents ?? 0,
        })),
        clearingAccountCode: plan.clearingAccountCode,
        clearingCents: plan.clearingCents,
        facilitatorGrossCents: plan.facilitatorGrossCents,
        suspenseCents: plan.suspenseCents,
        refusal: null,
      };
    } catch (error) {
      if (!isChannelError(error)) throw error;
      entry = {
        kind: 'refused',
        date,
        memo,
        lines: [],
        clearingAccountCode: null,
        clearingCents: 0,
        facilitatorGrossCents: 0,
        suspenseCents: 0,
        refusal: { code: error.code, message: error.message, remedy: error.remedy },
      };
    }
  }

  const names =
    codes.size === 0
      ? new Map<string, string>()
      : new Map(
          (await db.select({ code: accounts.code, name: accounts.name }).from(accounts).where(inArray(accounts.code, [...codes]))).map((r) => [
            r.code,
            r.name,
          ]),
        );
  if (entry.kind === 'planned') {
    entry = { ...entry, lines: entry.lines.map((l) => ({ ...l, accountName: names.get(l.accountCode) ?? '' })) };
  }

  // The identity: the lines must add to what the provider reports.
  const linesCents = sumCents(lines.map((l) => l.amountCents));
  const reported = payout.reportedTotalCents;
  const identity = {
    reportedCents: reported,
    linesCents,
    differenceCents: reported === null ? null : linesCents - reported,
    ties: reported !== null && linesCents === reported,
  };
  if (entry.kind === 'planned' && !identity.ties) {
    entry = {
      ...entry,
      kind: 'refused',
      refusal:
        reported === null
          ? { code: 'no_reported_total', message: 'This settlement has no reported total, so nothing proves its lines are complete. It cannot post.', remedy: 'Import it from the provider’s own export, which states its total.' }
          : {
              code: 'unbalanced',
              message: `The lines add to ${formatMoney(linesCents)} but the provider reports ${formatMoney(reported)} (off by ${formatMoney(linesCents - reported)}). Nothing can post until they agree.`,
              remedy: 'Re-import the settlement from a fresh export; never adjust a line to make it tie.',
            },
    };
  }

  const lineViews: SettlementLineView[] = lines.map((line) => {
    const role = roleOfLine(line.lineType, rawString(line.raw, 'accountRole'));
    const code = line.accountId !== null && payout.journalEntryId !== null ? null : lineCode(line);
    const side = rawString(line.raw, 'taxSide');
    return {
      lineNo: line.lineNo,
      lineType: line.lineType,
      label: line.description ?? line.lineType,
      externalRef: line.externalRef,
      sku: line.sku,
      postedDate: line.postedDate,
      amountCents: line.amountCents,
      jurisdiction: line.jurisdiction,
      accountCode: code,
      accountName: code === null ? null : names.get(code) ?? null,
      facilitator: role === 'facilitator_tax',
      taxSide: side === 'collected' || side === 'withheld' ? side : null,
      suspense: role === 'ask_my_accountant',
    };
  });
  // A posted line carries the account it actually landed on.
  if (payout.journalEntryId !== null) {
    const ids = [...new Set(lines.flatMap((l) => (l.accountId === null ? [] : [l.accountId])))];
    const byId =
      ids.length === 0
        ? new Map<string, { code: string; name: string }>()
        : new Map((await db.select({ id: accounts.id, code: accounts.code, name: accounts.name }).from(accounts).where(inArray(accounts.id, ids))).map((r) => [r.id, r]));
    lines.forEach((line, index) => {
      const hit = line.accountId === null ? undefined : byId.get(line.accountId);
      if (hit !== undefined) lineViews[index] = { ...lineViews[index], accountCode: hit.code, accountName: hit.name };
    });
  }

  // Tax, by state.
  const byState = new Map<string, { state: string | null; collectedCents: number; facilitatorCents: number; foreignCents: number }>();
  let needsTaxState = false;
  for (const line of lines) {
    const role = roleOfLine(line.lineType, rawString(line.raw, 'accountRole'));
    if (role !== 'sales_tax_payable' && role !== 'facilitator_tax') continue;
    const facilitator = role === 'facilitator_tax';
    const side = rawString(line.raw, 'taxSide');
    if (facilitator && side === 'withheld') continue;
    const regime = rawString(line.raw, 'taxRegime');
    const key = regime === 'foreign' ? 'foreign' : line.jurisdiction ?? '';
    const group = byState.get(key) ?? { state: regime === 'foreign' ? 'Non-US' : line.jurisdiction, collectedCents: 0, facilitatorCents: 0, foreignCents: 0 };
    if (regime === 'foreign') group.foreignCents += line.amountCents;
    else if (facilitator) group.facilitatorCents += line.amountCents;
    else {
      group.collectedCents += line.amountCents;
      if (line.jurisdiction === null && provider !== 'square') needsTaxState = true;
    }
    byState.set(key, group);
  }

  const linkedRows = await db
    .select({ id: bankTransactions.id, date: bankTransactions.txnDate, amountCents: bankTransactions.amountCents, description: bankTransactions.description })
    .from(bankTransactions)
    .where(and(eq(bankTransactions.matchedType, PAYOUT_MATCH_TYPE), eq(bankTransactions.matchedId, payout.id)))
    .orderBy(asc(bankTransactions.txnDate));
  const linkedDeposits: DepositCandidateView[] = linkedRows.map((r) => ({ ...r, amountCents: cents(r.amountCents) }));
  const candidates: DepositCandidateView[] =
    linkedDeposits.length > 0 ? [] : (await depositCandidates(payout.id, db)).map((c) => ({ id: c.id, date: c.txnDate, amountCents: c.amountCents, description: c.description }));

  return {
    row,
    lines: lineViews,
    entry,
    identity,
    taxLines: [...byState.values()],
    issues: issueList(payout),
    linkedDeposits,
    candidates,
    defaultTaxState: provider === 'square' ? HOME_STATE : null,
    needsTaxState,
  };
}

// ---------------------------------------------------------------------------
// Sales tax
// ---------------------------------------------------------------------------

export async function liability(filter: { from?: CalendarDate; to?: CalendarDate; state?: string }, exec?: LedgerDb): Promise<LiabilityView> {
  const report = await salesTaxLiability(filter, await database(exec));
  return {
    rows: report.rows.map((r) => ({ ...r })),
    totals: { ...report.totals },
    ledgerPayableCents: report.ledgerPayableCents,
    registerOwedCents: report.registerOwedCents,
    differenceCents: report.differenceCents,
  };
}

export async function filings(exec?: LedgerDb): Promise<FilingView[]> {
  const db = await database(exec);
  const rows = await db
    .select({ filing: salesTaxFilings, entryNo: journalEntries.entryNo })
    .from(salesTaxFilings)
    .leftJoin(journalEntries, eq(journalEntries.id, salesTaxFilings.journalEntryId))
    .orderBy(desc(salesTaxFilings.periodEnd), asc(salesTaxFilings.state));
  return rows.map(({ filing, entryNo }) => ({
    id: filing.id,
    state: filing.state,
    periodStart: filing.periodStart,
    periodEnd: filing.periodEnd,
    grossSalesCents: filing.grossSalesCents,
    taxableCents: filing.taxableCents,
    taxDueCents: filing.taxDueCents,
    taxPaidCents: filing.taxPaidCents,
    filedAt: stamp(filing.filedAt),
    paidAt: filing.paidAt,
    confirmation: filing.confirmation,
    entryId: filing.journalEntryId,
    entryNo: entryNo === null ? null : Number(entryNo),
  }));
}

/** Bank accounts a tax payment can leave from: active bank accounts with nothing under them. */
export async function bankOptions(exec?: LedgerDb): Promise<BankOptionView[]> {
  const db = await database(exec);
  const rows = await db.execute<{ id: string; code: string; name: string }>(sql`
    select a.id, a.code, a.name
      from accounts a
     where a.is_bank and a.active and a.type = 'asset'
       and not exists (select 1 from accounts c where c.parent_id = a.id)
     order by a.code`);
  return rows.map((r) => ({ id: r.id, code: r.code, name: r.name }));
}

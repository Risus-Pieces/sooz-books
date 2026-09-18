/**
 * Channel clearing: what each clearing account holds, and why.
 *
 * A settlement debits clearing for its net; the bank deposit credits it. When both halves
 * of every payout are in, clearing is zero. Anything else is one of a short list of
 * readings (`docs/formats/README.md` §4.4), and this module names which:
 *
 *   - a settlement whose deposit has not landed yet — normal for a few days, a problem after;
 *   - a deposit with no settlement behind it — revenue, tax and fees missing from the books;
 *   - a settlement imported but not posted, or a deposit coded to clearing but not posted;
 *   - a residual after both halves are in — a dropped or mis-signed line. Blocks the close.
 *
 * Sooz today: seven Square deposits (Jan 26 – Aug 31, $272.00) are coded to 1150 by the
 * owner's auto-post rule and no Square settlement has been imported. 1150 therefore carries
 * the deposit side alone — a $272.00 credit once they post — and 4015 sales, 2200 sales tax
 * and 5540 fees are all missing the gross behind that cash. `clearingStatus('square')` says
 * exactly that, and the close checklist blocks on it until the settlements are imported.
 */

import { and, asc, eq, inArray, isNull, lte, ne, sql as sqlTag } from 'drizzle-orm';

import { accounts, bankTransactions, journalEntries, journalLines, payoutImports } from '@/db/schema';
import { type CalendarDate, daysBetween, formatDateUS, isCalendarDate, today } from '@/lib/dates';
import type { LedgerDb } from '@/lib/ledger/post';
import { formatMoney, sumCents } from '@/lib/money';

import { PROVIDER_CLEARING_ACCOUNT, PROVIDER_LABEL, SETTLEMENT_PROVIDERS, type SettlementProvider } from './accounts';
import { ChannelError } from './errors';
import { PAYOUT_MATCH_TYPE } from './post';

/** A deposit this many days past its settlement is late, not in transit. */
export const IN_TRANSIT_DAYS = 5;
/** Past this, an unmatched settlement blocks the close (README §4.4). */
export const STALE_DAYS = 15;

export type ExceptionSeverity = 'block' | 'warn' | 'info';

export type ExceptionCode =
  | 'deposit_without_settlement'
  | 'deposit_not_posted'
  | 'deposit_posted_elsewhere'
  | 'settlement_not_posted'
  | 'settlement_in_transit'
  | 'settlement_late'
  | 'settlement_stale'
  | 'unexplained_balance';

export interface ClearingException {
  readonly provider: SettlementProvider;
  readonly severity: ExceptionSeverity;
  readonly code: ExceptionCode;
  readonly message: string;
  readonly amountCents: number;
  readonly date: CalendarDate | null;
  /** `payout_imports.id` or `bank_transactions.id`, for a link to the row. */
  readonly refId: string | null;
}

export interface ClearingSettlement {
  readonly id: string;
  readonly key: string | null;
  readonly date: CalendarDate | null;
  readonly netCents: number;
  readonly posted: boolean;
  readonly depositCents: number;
  readonly depositIds: readonly string[];
  readonly ageDays: number | null;
}

export interface ClearingDeposit {
  readonly id: string;
  readonly date: CalendarDate;
  readonly amountCents: number;
  readonly description: string;
  /** Posted to the ledger against clearing; false while it waits for approval or the auto-post run. */
  readonly posted: boolean;
  readonly payoutImportId: string | null;
}

export interface ClearingStatus {
  readonly provider: SettlementProvider;
  readonly account: { readonly id: string; readonly code: string; readonly name: string };
  readonly asOf: CalendarDate;
  /** Posted balance, debit-positive: a credit means cash landed that no settlement explains. */
  readonly balanceCents: number;
  /** What the balance becomes once the deposits already coded to clearing post. */
  readonly projectedBalanceCents: number;
  readonly postedSettlementsCents: number;
  readonly postedDepositsCents: number;
  readonly pendingDepositsCents: number;
  readonly settlements: readonly ClearingSettlement[];
  readonly deposits: readonly ClearingDeposit[];
  readonly unmatchedSettlements: readonly ClearingSettlement[];
  readonly unmatchedDeposits: readonly ClearingDeposit[];
  readonly exceptions: readonly ClearingException[];
  /** True when any exception blocks the close. */
  readonly blocking: boolean;
  /** One paragraph a bookkeeper reads first. */
  readonly explanation: string;
}

function span(dates: readonly CalendarDate[]): string {
  if (dates.length === 0) return '';
  const sorted = [...dates].sort();
  const first = formatDateUS(sorted[0]);
  const last = formatDateUS(sorted[sorted.length - 1]);
  return first === last ? first : `${first} – ${last}`;
}

/**
 * The state of one provider's clearing account.
 *
 * @throws {ChannelError} `invalid_input` for an unknown provider or date.
 */
export async function clearingStatus(
  provider: SettlementProvider,
  options: { readonly asOf?: CalendarDate } = {},
  exec?: LedgerDb,
): Promise<ClearingStatus> {
  if (!(SETTLEMENT_PROVIDERS as readonly string[]).includes(provider)) {
    throw new ChannelError('invalid_input', `"${provider}" is not a settlement channel.`);
  }
  const asOf = options.asOf ?? today();
  if (!isCalendarDate(asOf)) throw new ChannelError('invalid_input', 'asOf must be a YYYY-MM-DD date.');
  const db = exec ?? (await import('@/db/client')).db;
  const label = PROVIDER_LABEL[provider];
  const code = PROVIDER_CLEARING_ACCOUNT[provider];

  const [account] = await db.select({ id: accounts.id, code: accounts.code, name: accounts.name }).from(accounts).where(eq(accounts.code, code));
  if (account === undefined) throw new ChannelError('not_found', `Clearing account ${code} does not exist.`);

  // Posted movement on clearing, split by what posted it.
  const movement = await db
    .select({
      sourceType: journalEntries.sourceType,
      cents: sqlTag<string>`coalesce(sum(${journalLines.debitCents}) - sum(${journalLines.creditCents}), 0)::text`,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
    .where(and(eq(journalLines.accountId, account.id), eq(journalEntries.status, 'posted'), lte(journalEntries.entryDate, asOf)))
    .groupBy(journalEntries.sourceType);
  const bySource = new Map(movement.map((row) => [row.sourceType, Number(row.cents)]));
  const balance = sumCents([...bySource.values()]);

  // Settlements, with the deposits linked to each.
  const payouts = await db
    .select()
    .from(payoutImports)
    .where(and(eq(payoutImports.provider, provider), sqlTag`coalesce(${payoutImports.periodEnd}, ${payoutImports.periodStart}) <= ${asOf}::date`))
    .orderBy(asc(payoutImports.periodEnd));
  const payoutIds = payouts.map((p) => p.id);
  const linked =
    payoutIds.length === 0
      ? []
      : await db
          .select({ id: bankTransactions.id, matchedId: bankTransactions.matchedId, amountCents: bankTransactions.amountCents })
          .from(bankTransactions)
          .where(and(eq(bankTransactions.matchedType, PAYOUT_MATCH_TYPE), inArray(bankTransactions.matchedId, payoutIds)));

  const settlements: ClearingSettlement[] = payouts.map((payout) => {
    const mine = linked.filter((row) => row.matchedId === payout.id);
    const date = payout.periodEnd ?? payout.periodStart;
    return {
      id: payout.id,
      key: payout.externalId,
      date,
      netCents: payout.netCents,
      posted: payout.journalEntryId !== null,
      depositCents: sumCents(mine.map((row) => row.amountCents)),
      depositIds: mine.map((row) => row.id),
      ageDays: date === null ? null : daysBetween(date, asOf),
    };
  });

  // Deposits posted against clearing from the bank side.
  const postedDepositRows = await db
    .select({
      id: bankTransactions.id,
      date: bankTransactions.txnDate,
      amountCents: bankTransactions.amountCents,
      description: bankTransactions.description,
      matchedType: bankTransactions.matchedType,
      matchedId: bankTransactions.matchedId,
    })
    .from(bankTransactions)
    .innerJoin(journalEntries, eq(journalEntries.id, bankTransactions.journalEntryId))
    .where(
      and(
        eq(journalEntries.status, 'posted'),
        lte(bankTransactions.txnDate, asOf),
        sqlTag`exists (select 1 from journal_lines jl where jl.entry_id = ${journalEntries.id} and jl.account_id = ${account.id})`,
      ),
    );
  // Deposits coded to clearing — by a rule, a suggestion or the auto-post rule — not yet posted.
  const pendingDepositRows = await db
    .select({
      id: bankTransactions.id,
      date: bankTransactions.txnDate,
      amountCents: bankTransactions.amountCents,
      description: bankTransactions.description,
      matchedType: bankTransactions.matchedType,
      matchedId: bankTransactions.matchedId,
    })
    .from(bankTransactions)
    .where(
      and(
        isNull(bankTransactions.journalEntryId),
        eq(bankTransactions.suggestedAccountId, account.id),
        ne(bankTransactions.status, 'excluded'),
        lte(bankTransactions.txnDate, asOf),
      ),
    );

  const payoutIdSet = new Set(payoutIds);
  const toDeposit = (posted: boolean) => (row: (typeof postedDepositRows)[number]): ClearingDeposit => ({
    id: row.id,
    date: row.date,
    amountCents: row.amountCents,
    description: row.description,
    posted,
    payoutImportId: row.matchedType === PAYOUT_MATCH_TYPE && row.matchedId !== null && payoutIdSet.has(row.matchedId) ? row.matchedId : null,
  });
  const deposits = [...postedDepositRows.map(toDeposit(true)), ...pendingDepositRows.map(toDeposit(false))].sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : 0,
  );

  const unmatchedSettlements = settlements.filter((s) => s.netCents !== 0 && s.depositCents !== s.netCents);
  const unmatchedDeposits = deposits.filter((d) => d.payoutImportId === null);
  const pendingCents = sumCents(pendingDepositRows.map((row) => row.amountCents));
  const postedDepositIds = new Set(postedDepositRows.map((row) => row.id));

  const exceptions: ClearingException[] = [];
  for (const deposit of unmatchedDeposits) {
    exceptions.push({
      provider,
      severity: 'block',
      code: 'deposit_without_settlement',
      message: `${formatMoney(deposit.amountCents)} ${label} deposit on ${formatDateUS(deposit.date)} has no settlement behind it: the sales, sales tax and fees it nets are not in the books.`,
      amountCents: deposit.amountCents,
      date: deposit.date,
      refId: deposit.id,
    });
  }
  for (const deposit of deposits.filter((d) => !d.posted)) {
    exceptions.push({
      provider,
      severity: 'warn',
      code: 'deposit_not_posted',
      message: `${formatMoney(deposit.amountCents)} deposit on ${formatDateUS(deposit.date)} is coded to ${account.code} ${account.name} but not yet posted.`,
      amountCents: deposit.amountCents,
      date: deposit.date,
      refId: deposit.id,
    });
  }
  for (const settlement of settlements) {
    const where = `${label} settlement ${settlement.key ?? settlement.id}${settlement.date === null ? '' : ` (${formatDateUS(settlement.date)})`}`;
    if (!settlement.posted) {
      exceptions.push({
        provider,
        severity: 'block',
        code: 'settlement_not_posted',
        message: `${where} is imported but not posted: its gross sales, tax and fees are missing from the ledger.`,
        amountCents: settlement.netCents,
        date: settlement.date,
        refId: settlement.id,
      });
    }
    for (const id of settlement.depositIds) {
      if (postedDepositIds.has(id)) continue;
      const pending = pendingDepositRows.some((row) => row.id === id);
      if (!pending) {
        exceptions.push({
          provider,
          severity: 'block',
          code: 'deposit_posted_elsewhere',
          message: `A deposit linked to ${where} is not coded to ${account.code}; it must post to clearing or the settlement's net is counted twice.`,
          amountCents: settlement.netCents,
          date: settlement.date,
          refId: id,
        });
      }
    }
    if (settlement.netCents === 0 || settlement.depositCents === settlement.netCents) continue;
    const age = settlement.ageDays ?? 0;
    const missing = settlement.netCents - settlement.depositCents;
    const [severity, code, reading]: [ExceptionSeverity, ExceptionCode, string] =
      age <= IN_TRANSIT_DAYS
        ? ['info', 'settlement_in_transit', 'in transit']
        : age <= STALE_DAYS
          ? ['warn', 'settlement_late', `${age} days without its deposit`]
          : ['block', 'settlement_stale', `${age} days without its deposit — a missing bank file, a failed payout, or a deposit not yet linked`];
    exceptions.push({
      provider,
      severity,
      code,
      message: `${where}: ${formatMoney(missing)} ${reading}.`,
      amountCents: missing,
      date: settlement.date,
      refId: settlement.id,
    });
  }

  const everythingIn = unmatchedSettlements.length === 0 && unmatchedDeposits.length === 0 && deposits.every((d) => d.posted) && settlements.every((s) => s.posted);
  if (everythingIn && balance !== 0) {
    exceptions.push({
      provider,
      severity: 'block',
      code: 'unexplained_balance',
      message: `${account.code} ${account.name} holds ${formatMoney(balance)} after every settlement and deposit matched: a line was dropped, mis-signed or posted here by hand.`,
      amountCents: balance,
      date: asOf,
      refId: null,
    });
  }

  const postedSettlements = bySource.get('payout') ?? 0;
  const postedDeposits = bySource.get('bank') ?? 0;
  const status: ClearingStatus = {
    provider,
    account,
    asOf,
    balanceCents: balance,
    projectedBalanceCents: balance - pendingCents,
    postedSettlementsCents: postedSettlements,
    postedDepositsCents: -postedDeposits,
    pendingDepositsCents: pendingCents,
    settlements,
    deposits,
    unmatchedSettlements,
    unmatchedDeposits,
    exceptions,
    blocking: exceptions.some((e) => e.severity === 'block'),
    explanation: '',
  };
  return { ...status, explanation: explain(status, label) };
}

function explain(status: ClearingStatus, label: string): string {
  const account = `${status.account.code} ${status.account.name}`;
  const depositTotal = sumCents(status.deposits.map((d) => d.amountCents));
  const posted = status.deposits.filter((d) => d.posted);
  const pending = status.deposits.filter((d) => !d.posted);

  if (status.settlements.length === 0 && status.deposits.length === 0) {
    return `${account} has no activity: no ${label} settlements imported and no deposits coded to it.`;
  }
  if (status.settlements.length === 0) {
    const parts = [
      `No ${label} settlements have been imported, so ${account} carries only the deposit side: ${status.deposits.length} deposit${status.deposits.length === 1 ? '' : 's'} totalling ${formatMoney(depositTotal)} (${span(status.deposits.map((d) => d.date))}).`,
      posted.length > 0 ? `${posted.length} ${posted.length === 1 ? 'is' : 'are'} posted, leaving a ${formatMoney(Math.abs(status.balanceCents))} ${status.balanceCents < 0 ? 'credit' : 'debit'} balance.` : '',
      pending.length > 0 ? `${pending.length} ${pending.length === 1 ? 'is' : 'are'} coded to ${status.account.code} and will post with the auto-post run or on approval, taking the balance to ${formatMoney(status.projectedBalanceCents)}.` : '',
      `That balance is not an error in the deposits; it is the settlements that are missing. Until they are imported and posted, sales, sales tax and ${label} fees behind ${formatMoney(depositTotal)} of net deposits are absent from the books. Import the ${label} settlement export covering ${span(status.deposits.map((d) => d.date))}.`,
    ];
    return parts.filter((p) => p !== '').join(' ');
  }
  if (!status.blocking && status.projectedBalanceCents === 0 && status.balanceCents === 0) {
    return `${account} is clear: every ${label} settlement is posted and matched to its deposit.`;
  }
  const blocks = status.exceptions.filter((e) => e.severity === 'block').length;
  const inTransit = status.exceptions.filter((e) => e.code === 'settlement_in_transit');
  return [
    `${account} stands at ${formatMoney(status.balanceCents)}${status.pendingDepositsCents !== 0 ? ` (${formatMoney(status.projectedBalanceCents)} once coded deposits post)` : ''}.`,
    inTransit.length > 0 ? `${formatMoney(sumCents(inTransit.map((e) => e.amountCents)))} is settlements whose deposits are still in transit, which is normal.` : '',
    status.unmatchedDeposits.length > 0 ? `${status.unmatchedDeposits.length} deposit(s) (${formatMoney(sumCents(status.unmatchedDeposits.map((d) => d.amountCents)))}) have no settlement behind them.` : '',
    blocks > 0 ? `${blocks} exception(s) block the close.` : 'Nothing blocks the close.',
  ]
    .filter((p) => p !== '')
    .join(' ');
}

export interface ClearingExceptionReport {
  readonly asOf: CalendarDate;
  readonly statuses: readonly ClearingStatus[];
  readonly exceptions: readonly ClearingException[];
  readonly blocking: boolean;
}

/** Every clearing account's exceptions, for the close checklist. */
export async function clearingExceptions(options: { readonly asOf?: CalendarDate } = {}, exec?: LedgerDb): Promise<ClearingExceptionReport> {
  const asOf = options.asOf ?? today();
  const statuses: ClearingStatus[] = [];
  for (const provider of SETTLEMENT_PROVIDERS) statuses.push(await clearingStatus(provider, { asOf }, exec));
  const exceptions = statuses.flatMap((s) => s.exceptions);
  return { asOf, statuses, exceptions, blocking: exceptions.some((e) => e.severity === 'block') };
}


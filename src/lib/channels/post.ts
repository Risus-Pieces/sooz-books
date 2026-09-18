/**
 * Posting a channel settlement to the ledger.
 *
 * One balanced entry per settlement, against the provider's clearing account (1150
 * Square, 1110 Shopify, 1120 Amazon, 1130 Faire). Every line of the settlement lands on
 * the account its role names (`./accounts`); the clearing account takes the net, which
 * is exactly what the provider says it paid. The bank deposit, posted from the bank
 * side, then takes the clearing account back to zero — that zero is the proof nothing
 * was dropped.
 *
 * Refused, with nothing written:
 *   - a settlement whose lines do not sum to its reported total (`payout_is_balanced`);
 *   - a settlement with no reported total to check against;
 *   - one already posted;
 *   - one whose marketplace-facilitator tax does not net to zero. Facilitator tax is
 *     never posted — it is the marketplace's to remit — so a residual would leave the
 *     clearing account out by that amount, and it has to be explained first.
 *
 * In the same transaction the settlement's sales tax is written to the register
 * (`./sales-tax`), and the payout's lines are stamped with the accounts they posted to.
 */

import { and, asc, eq, inArray, isNull, sql as sqlTag } from 'drizzle-orm';

import {
  accounts,
  bankTransactions,
  channels,
  payoutImports,
  payoutLines,
  type PayoutImport,
  type PayoutLine,
} from '@/db/schema';
import type { CalendarDate } from '@/lib/dates';
import { type LedgerDb, postJournalEntry } from '@/lib/ledger/post';
import { reverseEntry } from '@/lib/ledger/reverse';
import { formatMoney, sumCents } from '@/lib/money';

import { PROVIDER_LABEL, roleOfLine } from './accounts';
import { type ChannelCtx, inChannelTx } from './context';
import { buildPayoutEntry } from './entry';
import { ChannelError } from './errors';
import { HOME_STATE, type SettlementTaxLine, normalizeState, recordSettlementTax, removeSettlementTax } from './sales-tax';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function rawString(raw: PayoutLine['raw'], key: string): string | null {
  const value = raw?.[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

function rawCents(raw: PayoutLine['raw'], key: string): number | null {
  const text = rawString(raw, key);
  if (text === null || !/^-?\d+$/.test(text)) return null;
  return Number(text);
}

export interface PostPayoutOptions {
  /** The state for tax lines whose source names none. Square defaults to `HOME_STATE`. */
  readonly taxState?: string;
}

export interface PostedPayout {
  readonly payoutImportId: string;
  readonly entryId: string;
  readonly entryNo: number;
  readonly date: CalendarDate;
  readonly clearingAccountCode: string;
  readonly netCents: number;
  readonly salesTaxEntries: number;
  /** Facilitator tax the settlement carried (both halves), which never posted. */
  readonly facilitatorGrossCents: number;
  /** Facilitator tax the register could not hold because the source names no state. */
  readonly facilitatorUnrecordedCents: number;
  /** Non-US tax posted to 2200 but reported on no state return. */
  readonly foreignTaxCents: number;
  /** Posted to 7900 Ask My Accountant; reclassify before close. */
  readonly suspenseCents: number;
}

async function lockPayout(tx: LedgerDb, id: string): Promise<PayoutImport> {
  const [payout] = await tx.select().from(payoutImports).where(eq(payoutImports.id, id)).for('update');
  if (payout === undefined) throw new ChannelError('not_found', 'That settlement does not exist.');
  return payout;
}

function describe(payout: PayoutImport): string {
  return `${PROVIDER_LABEL[payout.provider]} settlement ${payout.externalId ?? payout.id}`;
}

/**
 * Posts one imported settlement. See the head of this file for what is refused.
 *
 * @throws {ChannelError} `not_found`, `already_posted`, `no_reported_total`, `unbalanced`,
 *   `no_lines`, `no_date`, `facilitator_not_netted`, `unmapped_line`, `tax_state_unknown`
 * @throws {ClosedPeriodError} the settlement date is in a closed period
 */
export async function postPayout(
  payoutImportId: string,
  ctx: ChannelCtx,
  options: PostPayoutOptions = {},
): Promise<PostedPayout> {
  if (!UUID.test(payoutImportId)) throw new ChannelError('invalid_input', 'That settlement id is not valid.');
  const explicitState = options.taxState === undefined ? null : normalizeState(options.taxState);
  if (options.taxState !== undefined && explicitState === null) {
    throw new ChannelError('invalid_input', `"${options.taxState}" is not a US state.`);
  }

  return inChannelTx(ctx, async (tx) => {
    const payout = await lockPayout(tx, payoutImportId);
    const name = describe(payout);
    if (payout.journalEntryId !== null) {
      throw new ChannelError('already_posted', `${name} is already posted to the ledger.`);
    }
    if (payout.reportedTotalCents === null) {
      throw new ChannelError(
        'no_reported_total',
        `${name} has no reported total, so there is nothing to prove its lines complete. It cannot post.`,
        'Import the settlement from the provider’s own export, which states its total.',
      );
    }

    const [check] = await tx.execute<{ balanced: boolean; computed: string }>(
      sqlTag`select payout_is_balanced(${payout.id}::uuid) as balanced,
                    (select coalesce(sum(amount_cents), 0)::text from payout_lines where payout_import_id = ${payout.id}::uuid) as computed`,
    );
    if (check === undefined || check.balanced !== true) {
      const computed = Number(check?.computed ?? '0');
      throw new ChannelError(
        'unbalanced',
        `${name} does not tie: its lines add to ${formatMoney(computed)} but the provider reports ${formatMoney(payout.reportedTotalCents)} (off by ${formatMoney(computed - payout.reportedTotalCents)}). Nothing was posted.`,
        'Re-import the settlement from a fresh export; never adjust a line to make it tie.',
      );
    }

    const lines = await tx
      .select()
      .from(payoutLines)
      .where(eq(payoutLines.payoutImportId, payout.id))
      .orderBy(asc(payoutLines.lineNo));
    if (lines.length === 0) {
      throw new ChannelError('no_lines', `${name} has no lines to post.`);
    }

    const date = payout.periodEnd ?? payout.periodStart ?? payout.depositDate;
    if (date === null) throw new ChannelError('no_date', `${name} carries no settlement date to post on.`);

    const [channel] = await tx.select({ code: channels.code }).from(channels).where(eq(channels.id, payout.channelId));
    const memo = `${name} — net ${formatMoney(payout.reportedTotalCents)}`;
    const plan = buildPayoutEntry(
      lines.map((line) => ({
        lineNo: line.lineNo,
        lineType: line.lineType,
        amountCents: line.amountCents,
        description: line.description,
        recordedRole: rawString(line.raw, 'accountRole'),
      })),
      { provider: payout.provider, channelCode: channel?.code ?? null, channelId: payout.channelId, memo },
    );

    const posted = await postJournalEntry(
      { date, memo, sourceType: 'payout', sourceId: payout.id, lines: plan.lines },
      { userId: ctx.userId, tx },
    );

    // Stamp each line with the account it landed on, before the payout is frozen.
    const codes = [...new Set([...plan.lineAccounts.values()].filter((code): code is string => code !== null)), plan.clearingAccountCode];
    const idRows = await tx.select({ id: accounts.id, code: accounts.code }).from(accounts).where(inArray(accounts.code, codes));
    const idByCode = new Map(idRows.map((row) => [row.code, row.id]));
    for (const line of lines) {
      const code = plan.lineAccounts.get(line.lineNo) ?? null;
      const accountId = code === null ? null : idByCode.get(code) ?? null;
      if (line.accountId !== accountId) {
        await tx.update(payoutLines).set({ accountId }).where(eq(payoutLines.id, line.id));
      }
    }

    const taxLines: SettlementTaxLine[] = lines
      .filter((line) => {
        const role = roleOfLine(line.lineType, rawString(line.raw, 'accountRole'));
        return role === 'sales_tax_payable' || role === 'facilitator_tax';
      })
      .map((line) => {
        const regime = rawString(line.raw, 'taxRegime');
        const side = rawString(line.raw, 'taxSide');
        return {
          side: side === 'collected' || side === 'withheld' ? side : null,
          facilitator: roleOfLine(line.lineType, rawString(line.raw, 'accountRole')) === 'facilitator_tax',
          amountCents: line.amountCents,
          state: line.jurisdiction,
          regime: regime === 'us_state' || regime === 'foreign' || regime === 'unknown' ? regime : null,
          taxableCents: rawCents(line.raw, 'taxableCents'),
          label: line.description ?? line.lineType,
        };
      });
    const netSales = sumCents(
      lines
        .filter((line) => {
          const role = roleOfLine(line.lineType, rawString(line.raw, 'accountRole'));
          return role === 'channel_sales' || role === 'discounts_promotions' || role === 'returns_allowances';
        })
        .map((line) => line.amountCents),
    );
    const tax = await recordSettlementTax(tx, {
      payoutImportId: payout.id,
      channelId: payout.channelId,
      date,
      lines: taxLines,
      netSalesCents: netSales,
      defaultState: explicitState ?? (payout.provider === 'square' ? HOME_STATE : null),
    });

    const clearingId = idByCode.get(plan.clearingAccountCode) ?? null;
    await tx
      .update(payoutImports)
      .set({
        journalEntryId: posted.entryId,
        clearingAccountId: clearingId,
        status: payout.status === 'deposited' ? 'deposited' : 'posted',
      })
      .where(and(eq(payoutImports.id, payout.id), isNull(payoutImports.journalEntryId)));

    return {
      payoutImportId: payout.id,
      entryId: posted.entryId,
      entryNo: posted.entryNo,
      date,
      clearingAccountCode: plan.clearingAccountCode,
      netCents: plan.clearingCents,
      salesTaxEntries: tax.entriesWritten,
      facilitatorGrossCents: plan.facilitatorGrossCents,
      facilitatorUnrecordedCents: tax.facilitatorUnrecordedCents,
      foreignTaxCents: tax.foreignTaxCents,
      suspenseCents: plan.suspenseCents,
    };
  });
}

export interface UnpostedPayout {
  readonly payoutImportId: string;
  readonly reversalEntryId: string;
  readonly reversalEntryNo: number;
  readonly salesTaxEntriesRemoved: number;
}

/**
 * Undoes a settlement's posting: reverses its entry, removes its (unfiled) sales tax
 * entries, and returns it to review. A settlement whose tax a filed return has already
 * reported cannot be unposted.
 */
export async function unpostPayout(
  payoutImportId: string,
  ctx: ChannelCtx,
  options: { readonly date?: CalendarDate; readonly reason?: string } = {},
): Promise<UnpostedPayout> {
  if (!UUID.test(payoutImportId)) throw new ChannelError('invalid_input', 'That settlement id is not valid.');
  return inChannelTx(ctx, async (tx) => {
    const payout = await lockPayout(tx, payoutImportId);
    if (payout.journalEntryId === null) {
      throw new ChannelError('not_posted', `${describe(payout)} is not posted.`);
    }
    const removed = await removeSettlementTax(tx, payout.id);
    const reversal = await reverseEntry(payout.journalEntryId, {
      ...(options.date === undefined ? {} : { date: options.date }),
      memo: `Unpost ${describe(payout)}${options.reason ? ` — ${options.reason.trim()}` : ''}`,
      userId: ctx.userId,
      tx,
      owner: 'payout',
    });
    await tx
      .update(payoutImports)
      .set({ journalEntryId: null, status: payout.status === 'deposited' ? 'deposited' : 'imported' })
      .where(eq(payoutImports.id, payout.id));
    return {
      payoutImportId: payout.id,
      reversalEntryId: reversal.entryId,
      reversalEntryNo: reversal.entryNo,
      salesTaxEntriesRemoved: removed,
    };
  });
}

// ---------------------------------------------------------------------------
// Deposits
// ---------------------------------------------------------------------------

/** `bank_transactions.matched_type` for a deposit that clears a settlement. */
export const PAYOUT_MATCH_TYPE = 'payout';

export interface LinkedDeposits {
  readonly payoutImportId: string;
  readonly bankTransactionIds: readonly string[];
  readonly depositDate: CalendarDate;
}

/**
 * Links the bank deposit(s) that pay out a settlement. They must add up to the settlement's
 * net to the cent, and none may already clear another settlement or sit in a completed
 * reconciliation. Linking records the match; the deposit itself posts to the clearing
 * account from the bank side, where a human (or an `auto_post` rule) approves it.
 */
export async function linkDepositsToPayout(
  payoutImportId: string,
  bankTransactionIds: readonly string[],
  ctx: ChannelCtx,
): Promise<LinkedDeposits> {
  if (!UUID.test(payoutImportId)) throw new ChannelError('invalid_input', 'That settlement id is not valid.');
  if (bankTransactionIds.length === 0 || bankTransactionIds.some((id) => !UUID.test(id))) {
    throw new ChannelError('invalid_input', 'Choose the bank deposit(s) that paid this settlement.');
  }
  return inChannelTx(ctx, async (tx) => {
    const payout = await lockPayout(tx, payoutImportId);
    const rows = await tx
      .select()
      .from(bankTransactions)
      .where(inArray(bankTransactions.id, [...bankTransactionIds]))
      .for('update');
    if (rows.length !== new Set(bankTransactionIds).size) {
      throw new ChannelError('deposit_unavailable', 'One of those bank transactions does not exist.');
    }
    const taken = rows.find((row) => row.matchedId !== null && row.matchedId !== payout.id);
    if (taken !== undefined) {
      throw new ChannelError('deposit_unavailable', `The ${formatMoney(taken.amountCents)} deposit on ${taken.txnDate} already clears something else.`);
    }
    if (rows.some((row) => row.reconciliationId !== null || row.status === 'excluded')) {
      throw new ChannelError('deposit_unavailable', 'A reconciled or excluded bank transaction cannot be linked to a settlement.');
    }
    const total = sumCents(rows.map((row) => row.amountCents));
    const net = payout.netCents;
    if (total !== net) {
      throw new ChannelError(
        'deposit_mismatch',
        `Those deposits add to ${formatMoney(total)}; ${describe(payout)} paid out ${formatMoney(net)}.`,
      );
    }
    await tx
      .update(bankTransactions)
      .set({ matchedType: PAYOUT_MATCH_TYPE, matchedId: payout.id })
      .where(inArray(bankTransactions.id, rows.map((row) => row.id)));
    const depositDate = rows.map((row) => row.txnDate).reduce((a, b) => (a > b ? a : b));
    await tx
      .update(payoutImports)
      .set({
        depositDate,
        bankTransactionId: rows.length === 1 ? rows[0].id : null,
        status: 'deposited',
      })
      .where(eq(payoutImports.id, payout.id));
    return { payoutImportId: payout.id, bankTransactionIds: rows.map((row) => row.id), depositDate };
  });
}

/** The provider name a bank feed puts on its deposits. */
export const DEPOSIT_PATTERN: Readonly<Record<string, RegExp>> = Object.freeze({
  square: /\bSQUARE\b|\bSQ\d{6}\b/i,
  shopify: /\bSHOPIFY\b/i,
  amazon: /\bAMAZON\b|\bAMZN\b/i,
  faire: /\bFAIRE\b/i,
});

/** Days after a settlement's date that its deposit may still arrive (Amazon: up to five business days). */
export const DEPOSIT_WINDOW_DAYS = 10;

export interface DepositCandidate {
  readonly id: string;
  readonly txnDate: CalendarDate;
  readonly amountCents: number;
  readonly description: string;
}

/**
 * Unclaimed bank rows that could be a settlement's deposit: the exact net, from the
 * provider, dated within the deposit window of `from`. Square's own `SQ` matcher, with its
 * one-to-many split deposits, lives in the Square intake.
 */
export async function findDepositCandidates(
  exec: LedgerDb,
  provider: string,
  netCents: number,
  from: CalendarDate,
): Promise<DepositCandidate[]> {
  if (netCents === 0) return [];
  const pattern = DEPOSIT_PATTERN[provider];
  const rows = await exec
    .select({
      id: bankTransactions.id,
      txnDate: bankTransactions.txnDate,
      amountCents: bankTransactions.amountCents,
      description: bankTransactions.description,
      counterparty: bankTransactions.counterparty,
    })
    .from(bankTransactions)
    .where(
      and(
        eq(bankTransactions.amountCents, netCents),
        isNull(bankTransactions.matchedId),
        isNull(bankTransactions.reconciliationId),
        sqlTag`${bankTransactions.status} <> 'excluded'`,
        sqlTag`${bankTransactions.txnDate} between ${from}::date and (${from}::date + ${DEPOSIT_WINDOW_DAYS}::int)`,
      ),
    )
    .orderBy(asc(bankTransactions.txnDate));
  return rows
    .filter((row) => pattern === undefined || pattern.test(`${row.description} ${row.counterparty ?? ''}`))
    .map((row) => ({ id: row.id, txnDate: row.txnDate, amountCents: row.amountCents, description: row.description }));
}

/** The deposits that could pay out an imported settlement, for the screen that links them. */
export async function depositCandidates(payoutImportId: string, exec?: LedgerDb): Promise<DepositCandidate[]> {
  if (!UUID.test(payoutImportId)) throw new ChannelError('invalid_input', 'That settlement id is not valid.');
  const db = exec ?? (await import('@/db/client')).db;
  const [payout] = await db.select().from(payoutImports).where(eq(payoutImports.id, payoutImportId));
  if (payout === undefined) throw new ChannelError('not_found', 'That settlement does not exist.');
  const from = payout.periodEnd ?? payout.periodStart;
  if (from === null) return [];
  return findDepositCandidates(db, payout.provider, payout.netCents, from);
}

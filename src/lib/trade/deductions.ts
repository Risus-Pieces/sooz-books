/**
 * The deduction workbench: every transition a deduction can make after it
 * arrives, each one a correct posting (docs/formats/distributor-deductions.md §7.3).
 *
 * A deduction that lands in Deductions Receivable (1210) — a disputable claim or
 * an unmapped code — stays there until one of these resolves it:
 *
 *  validate   the distributor was right. Reclassify out of 1210:
 *                 Dr 2120 Accrued Trade Spend   (up to what the promotion still has accrued)
 *                 Dr 45xx contra revenue        (trade spend beyond the accrual)
 *                 Dr 40xx gross sales           (instead, for a valid shortage or pricing claim:
 *                                                a billing correction, not trade spend)
 *                    Cr 1210 Deductions Receivable
 *  dispute    no posting; records the case and the deadline from the reason code's window
 *  recover    cash back:   Dr cash / Cr 1210
 *  write off  conceded:    Dr 4590 Unauthorized Deductions Written Off / Cr 1210
 *  partial    both in one entry: Dr cash + Dr 4590 / Cr 1210
 *
 * Recovered plus written off can never exceed the deduction: checked here with a
 * readable error, and by `deduction_resolution_within_amount` in the database.
 * Every entry is sourced to the deduction (`source_type = 'deduction'`) so its
 * history reads in order from the ledger.
 */

import { and, eq, sql } from 'drizzle-orm';

import {
  type Deduction,
  type DeductionTreatment,
  channels,
  customers,
  deductionReasonCodes,
  deductions,
  promotions,
} from '@/db/schema';
import { accountByCode, accountById, appliedAtFor, isMoneyAccount } from '@/lib/arap/common';
import { type CalendarDate, addDays, daysBetween, today } from '@/lib/dates';
import { ACCOUNTS, CHANNEL_REVENUE_ACCOUNT, type ChannelCode } from '@/lib/ledger/coa';
import { type DraftLine, postJournalEntry } from '@/lib/ledger/post';
import { formatMoney } from '@/lib/money';

import {
  type LedgerDb,
  type TradeContext,
  optionalText,
  requireDate,
  requirePositiveCents,
  requireUuid,
  runTrade,
} from './common';
import { TradeError, invalidInput, invalidState, notFound } from './errors';
import { recordPromotionCharge, remainingAccrualCents } from './promotions';
import { RECEIVABLE_TREATMENTS, type ReasonCodeInfo, loadReasonCodes, reasonCodeByKey } from './reason-codes';

/** The window assumed when a deduction has no mapped reason code yet. */
export const DEFAULT_DISPUTE_WINDOW_DAYS = 90;

export function openCentsOf(d: Pick<Deduction, 'amountCents' | 'recoveredCents' | 'writtenOffCents'>): number {
  return d.amountCents - d.recoveredCents - d.writtenOffCents;
}

/** Still sitting in Deductions Receivable with money open. */
export function isInReceivable(d: Pick<Deduction, 'treatment' | 'status' | 'amountCents' | 'recoveredCents' | 'writtenOffCents'>): boolean {
  return (
    RECEIVABLE_TREATMENTS.has(d.treatment) &&
    (d.status === 'open' || d.status === 'disputed' || d.status === 'partially_recovered') &&
    openCentsOf(d) > 0
  );
}

async function lockDeduction(tx: LedgerDb, deductionId: string): Promise<Deduction> {
  requireUuid('deductionId', deductionId);
  const [row] = await tx.select().from(deductions).where(eq(deductions.id, deductionId)).for('update');
  if (row === undefined) throw notFound('Deduction', deductionId);
  return row;
}

function assertInReceivable(d: Deduction, action: string): number {
  if (!isInReceivable(d)) {
    throw invalidState(
      `Deduction ${d.deductionNo} is ${d.status} (${d.treatment}) with ${formatMoney(openCentsOf(d))} open; it cannot be ${action}.`,
    );
  }
  return openCentsOf(d);
}

async function channelOf(tx: LedgerDb, customerId: string): Promise<{ channelId: string | null; code: string | null }> {
  const [row] = await tx
    .select({ channelId: customers.channelId, code: channels.code })
    .from(customers)
    .leftJoin(channels, eq(channels.id, customers.channelId))
    .where(eq(customers.id, customerId));
  return { channelId: row?.channelId ?? null, code: row?.code ?? null };
}

async function reasonFor(tx: LedgerDb, code: string | null): Promise<ReasonCodeInfo | null> {
  if (code === null) return null;
  return reasonCodeByKey(await loadReasonCodes(tx), code);
}

// ---------------------------------------------------------------------------
// Dispute
// ---------------------------------------------------------------------------

export interface DisputeInput {
  /** The day the dispute is filed. Defaults to today. */
  date?: CalendarDate;
  /** The distributor's case number (K-Solve, Dispute Center). */
  reference?: string;
  notes?: string;
  /** Classify an unmapped deduction while disputing it. */
  reasonCode?: string;
}

/**
 * Files a dispute. No money moves — the deduction is already in 1210 — but the
 * case is recorded and the deadline is fixed from the reason code's window. A
 * deduction whose window has closed cannot be disputed; write it off instead.
 */
export async function disputeDeduction(deductionId: string, input: DisputeInput, ctx: TradeContext): Promise<Deduction> {
  const date = input.date === undefined ? today() : requireDate('date', input.date);
  return runTrade(ctx, async (tx) => {
    const d = await lockDeduction(tx, deductionId);
    assertInReceivable(d, 'disputed');

    let reasonCode = d.reasonCode;
    if (input.reasonCode !== undefined) {
      const info = await reasonFor(tx, input.reasonCode);
      if (info === null) throw invalidInput(`Reason code ${input.reasonCode} is not in the reason-code table.`);
      reasonCode = info.code;
    }
    const info = await reasonFor(tx, reasonCode);
    const windowDays = info !== null && info.windowDays > 0 ? info.windowDays : DEFAULT_DISPUTE_WINDOW_DAYS;
    const deadline = d.disputeDeadline ?? addDays(d.deductionDate, windowDays);
    if (date > deadline) {
      throw new TradeError(
        'window_closed',
        `The dispute window for ${d.deductionNo} closed on ${deadline}; it can only be written off or recovered.`,
      );
    }

    const [updated] = await tx
      .update(deductions)
      .set({
        status: d.status === 'partially_recovered' ? 'partially_recovered' : 'disputed',
        treatment: 'dispute',
        reasonCode,
        disputedAt: d.disputedAt ?? appliedAtFor(date),
        disputeDeadline: deadline,
        disputeReference: optionalText(input.reference) ?? d.disputeReference,
        disputeNotes: optionalText(input.notes) ?? d.disputeNotes,
        assignedTo: d.assignedTo ?? ctx.userId,
      })
      .where(eq(deductions.id, d.id))
      .returning();
    return updated;
  });
}

// ---------------------------------------------------------------------------
// Validate
// ---------------------------------------------------------------------------

export interface ValidateInput {
  date: CalendarDate;
  /** Reclassify under this reason code (namespaced, or a GEN code such as `MCB`). */
  reasonCode?: string;
  /** Charge the accrual of this promotion first. Defaults to the deduction's own, or its deal number's. */
  promotionId?: string;
  /** Book to this account instead of the reason code's default (a revenue or expense account). */
  accountId?: string;
  memo?: string;
}

export interface ResolutionResult {
  deduction: Deduction;
  entryId: string;
  entryNo: number;
}

/**
 * Concedes that the distributor was entitled to the deduction and moves what is
 * still open out of Deductions Receivable to where it belongs. Trade spend is
 * charged to its promotion's accrual first; a disputable claim (shortage,
 * pricing) that turns out valid is a billing correction to gross sales on the
 * customer's channel, never trade spend.
 */
export async function validateDeduction(deductionId: string, input: ValidateInput, ctx: TradeContext): Promise<ResolutionResult> {
  const date = requireDate('date', input.date);
  return runTrade(ctx, async (tx) => {
    const d = await lockDeduction(tx, deductionId);
    const open = assertInReceivable(d, 'validated');
    if (date < d.deductionDate) throw invalidInput(`Validation cannot be dated before the deduction (${d.deductionDate}).`);

    let info = await reasonFor(tx, d.reasonCode);
    if (input.reasonCode !== undefined) {
      info = await reasonFor(tx, input.reasonCode);
      if (info === null) throw invalidInput(`Reason code ${input.reasonCode} is not in the reason-code table.`);
    }
    const { channelId, code: channelCode } = await channelOf(tx, d.customerId);

    // Where the open amount goes.
    let accountId: string;
    let treatment: DeductionTreatment;
    let tradeSpend = false;
    if (input.accountId !== undefined) {
      const account = await accountById(tx, input.accountId);
      if (account.type !== 'revenue' && account.type !== 'expense') {
        throw invalidInput(`${account.code} ${account.name} is not a revenue or expense account.`);
      }
      accountId = account.id;
      treatment = account.subtype === 'contra_revenue' ? 'contra_revenue' : account.type === 'expense' ? 'expense' : 'billing_correction';
      tradeSpend = account.subtype === 'contra_revenue' && (info?.isTradeSpend ?? true);
    } else if (info === null || info.treatment === 'suspense' || info.treatment === 'recovery') {
      throw new TradeError(
        'needs_classification',
        `Deduction ${d.deductionNo} has no usable reason code${d.sourceReasonCode ? ` (the distributor printed "${d.sourceReasonCode}")` : ''}. Choose a reason code or an account to validate it.`,
      );
    } else if (info.treatment === 'dispute' || info.treatment === 'billing_correction') {
      // A valid shortage or pricing claim corrects the sale, it is not trade spend (§7.4).
      const salesCode =
        info.treatment === 'billing_correction' && info.accountCode !== null
          ? info.accountCode
          : channelCode !== null && channelCode in CHANNEL_REVENUE_ACCOUNT
            ? CHANNEL_REVENUE_ACCOUNT[channelCode as ChannelCode]
            : ACCOUNTS.SALES_DISTRIBUTOR;
      accountId = (await accountByCode(tx, salesCode)).id;
      treatment = 'billing_correction';
    } else {
      if (info.accountId === null) throw invalidState(`Reason code ${info.code} has no default account.`);
      accountId = info.accountId;
      treatment = info.treatment;
      tradeSpend = info.treatment !== 'expense' && info.isTradeSpend;
    }

    // Charge the promotion's accrual first, when this is trade spend against one.
    let promotionId = input.promotionId ?? d.promotionId;
    if (promotionId === null && d.dealNumber !== null) {
      const [promo] = await tx
        .select({ id: promotions.id })
        .from(promotions)
        .where(and(eq(promotions.customerId, d.customerId), sql`upper(${promotions.authorizationNo}) = ${d.dealNumber.toUpperCase()}`))
        .limit(1);
      if (promo !== undefined) promotionId = promo.id;
    }
    if (promotionId !== null) requireUuid('promotionId', promotionId);
    const charged = tradeSpend && promotionId !== null ? Math.min(open, await remainingAccrualCents(tx, promotionId)) : 0;
    if (treatment === 'accrual' || treatment === 'contra_revenue') treatment = charged > 0 ? 'accrual' : 'contra_revenue';

    const memo = optionalText(input.memo) ?? `Validate deduction ${d.deductionNo}`;
    const lines: DraftLine[] = [];
    if (charged > 0) {
      lines.push({ accountCode: ACCOUNTS.ACCRUED_TRADE_SPEND, debitCents: charged, customerId: d.customerId, channelId, memo: `${memo} (charged to accrual)` });
    }
    if (open - charged > 0) lines.push({ accountId, debitCents: open - charged, customerId: d.customerId, channelId, memo });
    lines.push({ accountCode: ACCOUNTS.DEDUCTIONS_RECEIVABLE, creditCents: open, customerId: d.customerId, channelId, memo });

    const entry = await postJournalEntry({ date, memo, sourceType: 'deduction', sourceId: d.id, lines }, { userId: ctx.userId, tx });
    if (tradeSpend && promotionId !== null) {
      await recordPromotionCharge(tx, promotionId, { chargedCents: charged, actualCents: open });
    }

    const [updated] = await tx
      .update(deductions)
      .set({
        status: 'validated',
        treatment,
        reasonCode: info?.code ?? d.reasonCode,
        accountId: charged === open ? d.accountId : accountId,
        promotionId: tradeSpend ? promotionId : d.promotionId,
        resolutionEntryId: entry.entryId,
        resolvedAt: appliedAtFor(date),
        resolvedBy: ctx.userId,
      })
      .where(eq(deductions.id, d.id))
      .returning();
    return { deduction: updated, entryId: entry.entryId, entryNo: entry.entryNo };
  });
}

// ---------------------------------------------------------------------------
// Recover, write off
// ---------------------------------------------------------------------------

export interface RecoverInput {
  date: CalendarDate;
  amountCents: number;
  /** Where the money arrived. Defaults to 1040 Undeposited Funds until the bank line matches. */
  depositAccountId?: string;
  /** Write off whatever is left open after this recovery, in the same entry. */
  writeOffRemainder?: boolean;
  reference?: string;
}

function finalStatus(amount: number, recovered: number, writtenOff: number, previous: Deduction['status']): Deduction['status'] {
  const open = amount - recovered - writtenOff;
  if (open > 0) return recovered > 0 ? 'partially_recovered' : previous;
  if (recovered === amount) return 'recovered';
  if (recovered === 0) return 'written_off';
  return 'partially_recovered';
}

/**
 * Money back from the distributor on a disputed deduction:
 *
 *     Dr  cash (1040 until the bank line matches)   recovered
 *     Dr  4590 Unauthorized Deductions Written Off  the remainder, when writing it off
 *         Cr  1210 Deductions Receivable
 *
 * No revenue is recognised: revenue was never reduced for this item.
 */
export async function recoverDeduction(deductionId: string, input: RecoverInput, ctx: TradeContext): Promise<ResolutionResult> {
  const date = requireDate('date', input.date);
  const amount = requirePositiveCents('amountCents', input.amountCents);
  return runTrade(ctx, async (tx) => {
    const d = await lockDeduction(tx, deductionId);
    const open = assertInReceivable(d, 'recovered');
    if (amount > open) {
      throw new TradeError(
        'over_resolution',
        `Deduction ${d.deductionNo} has ${formatMoney(open)} open; ${formatMoney(amount)} cannot be recovered against it.`,
      );
    }
    if (date < d.deductionDate) throw invalidInput(`A recovery cannot be dated before the deduction (${d.deductionDate}).`);
    const deposit =
      input.depositAccountId === undefined ? await accountByCode(tx, ACCOUNTS.UNDEPOSITED_FUNDS) : await accountById(tx, input.depositAccountId);
    if (!isMoneyAccount(deposit) || deposit.subtype === 'credit_card' || deposit.isControl) {
      throw invalidInput(`${deposit.code} ${deposit.name} cannot receive a recovery.`);
    }
    const writeOff = input.writeOffRemainder === true ? open - amount : 0;
    const { channelId } = await channelOf(tx, d.customerId);

    const memo = `Recovery on deduction ${d.deductionNo}${input.reference ? ` — ${input.reference.trim()}` : ''}`;
    const lines: DraftLine[] = [{ accountId: deposit.id, debitCents: amount, customerId: d.customerId, channelId, memo }];
    if (writeOff > 0) {
      lines.push({ accountCode: ACCOUNTS.UNAUTHORIZED_DEDUCTIONS, debitCents: writeOff, customerId: d.customerId, channelId, memo: `Write off remainder of ${d.deductionNo}` });
    }
    lines.push({ accountCode: ACCOUNTS.DEDUCTIONS_RECEIVABLE, creditCents: amount + writeOff, customerId: d.customerId, channelId, memo });

    const entry = await postJournalEntry({ date, memo, sourceType: 'deduction', sourceId: d.id, lines }, { userId: ctx.userId, tx });
    const recovered = d.recoveredCents + amount;
    const writtenOff = d.writtenOffCents + writeOff;
    const closed = d.amountCents - recovered - writtenOff === 0;
    const [updated] = await tx
      .update(deductions)
      .set({
        recoveredCents: recovered,
        writtenOffCents: writtenOff,
        status: finalStatus(d.amountCents, recovered, writtenOff, d.status),
        resolutionEntryId: entry.entryId,
        resolvedAt: closed ? appliedAtFor(date) : d.resolvedAt,
        resolvedBy: closed ? ctx.userId : d.resolvedBy,
      })
      .where(eq(deductions.id, d.id))
      .returning();
    return { deduction: updated, entryId: entry.entryId, entryNo: entry.entryNo };
  });
}

export interface WriteOffInput {
  date: CalendarDate;
  /** Defaults to everything still open. */
  amountCents?: number;
  reason?: string;
}

/**
 * Concedes a disputed deduction — the dispute was denied, or the window closed:
 *
 *     Dr  4590 Unauthorized Deductions Written Off
 *         Cr  1210 Deductions Receivable
 *
 * Contra revenue, not bad debt: under ASC 606 it is consideration the customer
 * kept. A shortage that was real is a billing correction instead — validate it.
 */
export async function writeOffDeduction(deductionId: string, input: WriteOffInput, ctx: TradeContext): Promise<ResolutionResult> {
  const date = requireDate('date', input.date);
  return runTrade(ctx, async (tx) => {
    const d = await lockDeduction(tx, deductionId);
    const open = assertInReceivable(d, 'written off');
    const amount = input.amountCents === undefined ? open : requirePositiveCents('amountCents', input.amountCents);
    if (amount > open) {
      throw new TradeError(
        'over_resolution',
        `Deduction ${d.deductionNo} has ${formatMoney(open)} open; ${formatMoney(amount)} cannot be written off.`,
      );
    }
    if (date < d.deductionDate) throw invalidInput(`A write-off cannot be dated before the deduction (${d.deductionDate}).`);
    const { channelId } = await channelOf(tx, d.customerId);
    const memo = `Write off deduction ${d.deductionNo}${input.reason ? ` — ${input.reason.trim()}` : ''}`;
    const entry = await postJournalEntry(
      {
        date,
        memo,
        sourceType: 'deduction',
        sourceId: d.id,
        lines: [
          { accountCode: ACCOUNTS.UNAUTHORIZED_DEDUCTIONS, debitCents: amount, customerId: d.customerId, channelId, memo },
          { accountCode: ACCOUNTS.DEDUCTIONS_RECEIVABLE, creditCents: amount, customerId: d.customerId, channelId, memo },
        ],
      },
      { userId: ctx.userId, tx },
    );
    const writtenOff = d.writtenOffCents + amount;
    const closed = d.amountCents - d.recoveredCents - writtenOff === 0;
    const [updated] = await tx
      .update(deductions)
      .set({
        writtenOffCents: writtenOff,
        status: finalStatus(d.amountCents, d.recoveredCents, writtenOff, d.status),
        resolutionEntryId: entry.entryId,
        resolvedAt: closed ? appliedAtFor(date) : d.resolvedAt,
        resolvedBy: closed ? ctx.userId : d.resolvedBy,
      })
      .where(eq(deductions.id, d.id))
      .returning();
    return { deduction: updated, entryId: entry.entryId, entryNo: entry.entryNo };
  });
}

// ---------------------------------------------------------------------------
// Reading the workbench
// ---------------------------------------------------------------------------

export interface WorkbenchRow {
  deduction: Deduction;
  openCents: number;
  reasonLabel: string | null;
  /** (asOf − deduction date) ÷ window: past 0.6 alert, past 0.8 escalate (§9.3). Null without a deadline. */
  windowBurn: number | null;
  alert: 'none' | 'alert' | 'escalate' | 'expired';
}

/** Deductions still open in Deductions Receivable, oldest deadline first. */
export async function openDeductions(
  filter: { customerId?: string; asOf?: CalendarDate },
  ctx: TradeContext,
): Promise<WorkbenchRow[]> {
  const asOf = filter.asOf === undefined ? today() : requireDate('asOf', filter.asOf);
  return runTrade(ctx, async (tx) => {
    const rows = await tx
      .select({ deduction: deductions, reasonLabel: deductionReasonCodes.label })
      .from(deductions)
      .leftJoin(deductionReasonCodes, eq(deductionReasonCodes.code, deductions.reasonCode))
      .where(filter.customerId === undefined ? undefined : eq(deductions.customerId, requireUuid('customerId', filter.customerId)));
    return rows
      .filter((r) => isInReceivable(r.deduction))
      .map((r) => {
        const burn = windowBurn(r.deduction.deductionDate, r.deduction.disputeDeadline, asOf);
        return {
          deduction: r.deduction,
          openCents: openCentsOf(r.deduction),
          reasonLabel: r.reasonLabel,
          windowBurn: burn,
          alert: burnAlert(burn),
        };
      })
      .sort((a, b) => (a.deduction.disputeDeadline ?? '9999-12-31').localeCompare(b.deduction.disputeDeadline ?? '9999-12-31'));
  });
}

export function windowBurn(deductionDate: CalendarDate, deadline: CalendarDate | null, asOf: CalendarDate): number | null {
  if (deadline === null) return null;
  const window = daysBetween(deductionDate, deadline);
  if (window <= 0) return null;
  return Math.round((daysBetween(deductionDate, asOf) / window) * 1_000) / 1_000;
}

export function burnAlert(burn: number | null): WorkbenchRow['alert'] {
  if (burn === null) return 'none';
  if (burn > 1) return 'expired';
  if (burn >= 0.8) return 'escalate';
  if (burn >= 0.6) return 'alert';
  return 'none';
}

/**
 * Promotions and the trade-spend accrual (docs/formats/distributor-deductions.md §7.6).
 *
 * Under ASC 606 a promotion's cost is variable consideration: it is recognised
 * when the related revenue is, not when the distributor gets round to deducting
 * it months later. So a promotion is planned with its products, units and
 * allowance per unit (plus any fixed fee such as the MCB admin fee floor), and
 * the plan is accrued month by month across the promotion's ship window:
 *
 *     Dr  45xx Contra revenue (by promotion type)   the month's share of the allowance
 *     Dr  4560 Distributor Fees                     the month's share of fixed fees
 *         Cr  2120 Accrued Trade Spend
 *
 * When the deductions arrive they are charged against the accrual (Dr 2120)
 * rather than contra revenue — see ./plan.ts and ./deductions.ts — and when the
 * promotion closes the residual is released back to contra revenue as the
 * accrual-to-actual variance, with the promotion in the memo. Nothing is ever
 * released silently.
 */

import { and, asc, eq, inArray, sql } from 'drizzle-orm';

import {
  type Promotion,
  type PromoType,
  customers,
  products,
  promotionPerformance,
  promotionProducts,
  promotions,
  tradeAccruals,
} from '@/db/schema';
import { extendCents, parseQuantity } from '@/lib/arap/common';
import { type CalendarDate, addDays, daysBetween, monthEnd, periodOf } from '@/lib/dates';
import { ACCOUNTS, type AccountCode } from '@/lib/ledger/coa';
import { type DraftLine, postJournalEntry } from '@/lib/ledger/post';
import { allocateCents, sumCents } from '@/lib/money';

import {
  type LedgerDb,
  type TradeContext,
  optionalText,
  requireDate,
  requireNonNegativeCents,
  requireUuid,
  runTrade,
} from './common';
import { invalidInput, invalidState, notFound } from './errors';

/** Where each kind of promotion lands in contra revenue. */
export const PROMO_CONTRA_ACCOUNT: Readonly<Record<PromoType, AccountCode>> = Object.freeze({
  off_invoice: ACCOUNTS.TRADE_OFF_INVOICE,
  billback: ACCOUNTS.TRADE_BILLBACK,
  mcb: ACCOUNTS.TRADE_BILLBACK,
  scan_down: ACCOUNTS.TRADE_SCAN_DOWN,
  tpr: ACCOUNTS.TRADE_SCAN_DOWN,
  slotting: ACCOUNTS.TRADE_SLOTTING,
  free_fill: ACCOUNTS.TRADE_SLOTTING,
  new_item_allowance: ACCOUNTS.TRADE_SLOTTING,
  ad_fee: ACCOUNTS.COUPONS_AND_PROMOS,
  demo: ACCOUNTS.COUPONS_AND_PROMOS,
  sampling: ACCOUNTS.COUPONS_AND_PROMOS,
  spoils_allowance: ACCOUNTS.TRADE_SPOILAGE_ALLOWANCE,
  freight_allowance: ACCOUNTS.TRADE_OFF_INVOICE,
  early_pay_discount: ACCOUNTS.EARLY_PAYMENT_DISCOUNTS,
  other: ACCOUNTS.COUPONS_AND_PROMOS,
});

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

export interface PromotionProductInput {
  productId: string;
  /** Units (cases, eaches — whatever the allowance is quoted per), as an exact decimal. */
  plannedUnits: string | number;
  allowancePerUnitCents: number;
}

export interface NewPromotionInput {
  name: string;
  customerId: string;
  channelId?: string | null;
  promoType: PromoType;
  startDate: CalendarDate;
  endDate: CalendarDate;
  /** The window the accrual is spread over. Defaults to the performance window. */
  shipStartDate?: CalendarDate;
  shipEndDate?: CalendarDate;
  /** The deal / authorisation number the distributor will quote on its deductions. */
  authorizationNo?: string;
  products?: readonly PromotionProductInput[];
  /** Without products: a promotion-level quantity and allowance. */
  plannedUnits?: string | number;
  allowancePerUnitCents?: number;
  /** Fixed costs on top of the per-unit allowance: slotting, the MCB admin fee floor, an ad fee. */
  fixedFeeCents?: number;
  notes?: string;
}

export interface PromotionWithProducts {
  promotion: Promotion;
  products: { productId: string; plannedUnits: string | null; allowancePerUnitCents: number | null }[];
}

/** The per-unit part of a promotion's plan: Σ units × allowance, rounded per line. */
export function allowanceCents(
  lines: readonly { plannedUnits: string | number | null; allowancePerUnitCents: number | null }[],
): number {
  return sumCents(
    lines.map((line) => {
      if (line.plannedUnits === null || line.allowancePerUnitCents === null) return 0;
      return extendCents(parseQuantity(line.plannedUnits).scaled, line.allowancePerUnitCents);
    }),
  );
}

export async function createPromotion(input: NewPromotionInput, ctx: TradeContext): Promise<PromotionWithProducts> {
  const name = optionalText(input.name);
  if (name === null) throw invalidInput('A promotion needs a name.');
  requireUuid('customerId', input.customerId);
  const startDate = requireDate('startDate', input.startDate);
  const endDate = requireDate('endDate', input.endDate);
  if (endDate < startDate) throw invalidInput('The promotion ends before it starts.');
  const shipStartDate = input.shipStartDate === undefined ? null : requireDate('shipStartDate', input.shipStartDate);
  const shipEndDate = input.shipEndDate === undefined ? null : requireDate('shipEndDate', input.shipEndDate);
  if ((shipStartDate === null) !== (shipEndDate === null)) throw invalidInput('Give both ends of the ship window, or neither.');
  if (shipStartDate !== null && shipEndDate !== null && shipEndDate < shipStartDate) {
    throw invalidInput('The ship window ends before it starts.');
  }
  const fixedFee = requireNonNegativeCents('fixedFeeCents', input.fixedFeeCents ?? 0);

  const productLines = (input.products ?? []).map((line, index) => {
    requireUuid(`products[${index}].productId`, line.productId);
    requireNonNegativeCents(`products[${index}].allowancePerUnitCents`, line.allowancePerUnitCents);
    return { productId: line.productId, plannedUnits: parseQuantity(line.plannedUnits).text, allowancePerUnitCents: line.allowancePerUnitCents };
  });
  if (new Set(productLines.map((l) => l.productId)).size !== productLines.length) {
    throw invalidInput('A product appears twice in the promotion; combine its units.');
  }
  if (productLines.length > 0 && (input.plannedUnits !== undefined || input.allowancePerUnitCents !== undefined)) {
    throw invalidInput('Give units and allowance per product, or for the whole promotion — not both.');
  }
  const headerUnits = input.plannedUnits === undefined ? null : parseQuantity(input.plannedUnits).text;
  const headerAllowance =
    input.allowancePerUnitCents === undefined ? null : requireNonNegativeCents('allowancePerUnitCents', input.allowancePerUnitCents);

  const perUnit =
    productLines.length > 0
      ? allowanceCents(productLines)
      : allowanceCents([{ plannedUnits: headerUnits, allowancePerUnitCents: headerAllowance }]);
  const planned = perUnit + fixedFee;
  if (planned === 0) throw invalidInput('The promotion plans no spend: give units and an allowance, or a fixed fee.');

  const totalUnits =
    productLines.length > 0
      ? (() => {
          const scaled = productLines.reduce((acc, l) => acc + parseQuantity(l.plannedUnits).scaled, BigInt(0));
          const whole = scaled / BigInt(10_000);
          const frac = String(scaled % BigInt(10_000)).padStart(4, '0').slice(0, 2);
          return `${whole}.${frac}`;
        })()
      : headerUnits;
  const uniformAllowance =
    productLines.length > 0
      ? new Set(productLines.map((l) => l.allowancePerUnitCents)).size === 1
        ? productLines[0].allowancePerUnitCents
        : null
      : headerAllowance;

  return runTrade(ctx, async (tx) => {
    const [customer] = await tx.select({ id: customers.id, channelId: customers.channelId }).from(customers).where(eq(customers.id, input.customerId));
    if (customer === undefined) throw notFound('Customer', input.customerId);
    if (productLines.length > 0) {
      const found = await tx.select({ id: products.id }).from(products).where(inArray(products.id, productLines.map((l) => l.productId)));
      if (found.length !== productLines.length) throw invalidInput('A product on the promotion does not exist.');
    }

    const [promotion] = await tx
      .insert(promotions)
      .values({
        name,
        customerId: customer.id,
        channelId: input.channelId === undefined ? customer.channelId : input.channelId,
        promoType: input.promoType,
        startDate,
        endDate,
        shipStartDate,
        shipEndDate,
        plannedUnits: totalUnits,
        allowancePerUnitCents: uniformAllowance,
        plannedSpendCents: planned,
        authorizationNo: optionalText(input.authorizationNo),
        notes: optionalText(input.notes),
        createdBy: ctx.userId,
      })
      .returning();

    if (productLines.length > 0) {
      await tx.insert(promotionProducts).values(productLines.map((l) => ({ promotionId: promotion.id, ...l })));
    }
    return { promotion, products: productLines };
  });
}

// ---------------------------------------------------------------------------
// The accrual schedule
// ---------------------------------------------------------------------------

export interface AccrualMonth {
  year: number;
  month: number;
  /** The date the month's accrual is posted: the last day of the month. */
  periodEnd: CalendarDate;
  /** Days of the window inside this month — the allocation weight. */
  days: number;
  allowanceCents: number;
  feeCents: number;
}

/** The window a promotion accrues over: its ship window when it has one, else its dates. */
export function accrualWindow(p: Pick<Promotion, 'startDate' | 'endDate' | 'shipStartDate' | 'shipEndDate'>): {
  from: CalendarDate;
  to: CalendarDate;
} {
  return p.shipStartDate !== null && p.shipEndDate !== null
    ? { from: p.shipStartDate, to: p.shipEndDate }
    : { from: p.startDate, to: p.endDate };
}

/**
 * Spreads a promotion's allowance and fixed fees across the calendar months of
 * its window in proportion to the days in each, with `allocateCents` so the
 * months sum to the plan exactly.
 */
export function accrualSchedule(
  window: { from: CalendarDate; to: CalendarDate },
  allowanceTotalCents: number,
  feeTotalCents: number,
): AccrualMonth[] {
  if (window.to < window.from) throw invalidInput('The accrual window ends before it starts.');
  const months: Omit<AccrualMonth, 'allowanceCents' | 'feeCents'>[] = [];
  let cursor = window.from;
  while (cursor <= window.to) {
    const { year, month } = periodOf(cursor);
    const end = monthEnd(cursor);
    const last = end < window.to ? end : window.to;
    months.push({ year, month, periodEnd: end, days: daysBetween(cursor, last) + 1 });
    cursor = addDays(end, 1);
  }
  const weights = months.map((m) => m.days);
  const allowance = allocateCents(allowanceTotalCents, weights);
  const fees = allocateCents(feeTotalCents, weights);
  return months.map((m, i) => ({ ...m, allowanceCents: allowance[i], feeCents: fees[i] }));
}

async function lockPromotion(tx: LedgerDb, promotionId: string): Promise<Promotion> {
  requireUuid('promotionId', promotionId);
  const [row] = await tx.select().from(promotions).where(eq(promotions.id, promotionId)).for('update');
  if (row === undefined) throw notFound('Promotion', promotionId);
  return row;
}

async function planSplit(tx: LedgerDb, promotion: Promotion): Promise<{ allowance: number; fee: number }> {
  const lines = await tx
    .select({ plannedUnits: promotionProducts.plannedUnits, allowancePerUnitCents: promotionProducts.allowancePerUnitCents })
    .from(promotionProducts)
    .where(eq(promotionProducts.promotionId, promotion.id));
  const allowance =
    lines.length > 0
      ? allowanceCents(lines)
      : allowanceCents([{ plannedUnits: promotion.plannedUnits, allowancePerUnitCents: promotion.allowancePerUnitCents }]);
  const fee = promotion.plannedSpendCents - allowance;
  if (fee < 0) throw invalidState(`Promotion ${promotion.name}: its products plan more than its planned spend.`);
  return { allowance, fee };
}

export interface PostedAccrual {
  accrualId: string;
  year: number;
  month: number;
  amountCents: number;
  entryId: string;
}

/**
 * Posts every month of the promotion's schedule that has ended on or before
 * `through` and has not been accrued yet. Safe to run again: a month already
 * accrued is skipped (and a unique index backs that up).
 */
export async function accruePromotion(
  promotionId: string,
  options: { through: CalendarDate },
  ctx: TradeContext,
): Promise<PostedAccrual[]> {
  const through = requireDate('through', options.through);
  return runTrade(ctx, async (tx) => {
    const promotion = await lockPromotion(tx, promotionId);
    if (promotion.status === 'cancelled' || promotion.status === 'completed') return [];
    const { allowance, fee } = await planSplit(tx, promotion);
    const schedule = accrualSchedule(accrualWindow(promotion), allowance, fee);

    const existing = await tx
      .select({ year: tradeAccruals.periodYear, month: tradeAccruals.periodMonth })
      .from(tradeAccruals)
      .where(and(eq(tradeAccruals.promotionId, promotion.id), eq(tradeAccruals.basis, 'planned')));
    const done = new Set(existing.map((r) => `${r.year}-${r.month}`));

    const contra = PROMO_CONTRA_ACCOUNT[promotion.promoType];
    const posted: PostedAccrual[] = [];
    for (const month of schedule) {
      if (month.periodEnd > through || done.has(`${month.year}-${month.month}`)) continue;
      const amount = month.allowanceCents + month.feeCents;
      if (amount === 0) continue;

      const [accrual] = await tx
        .insert(tradeAccruals)
        .values({
          periodYear: month.year,
          periodMonth: month.month,
          promotionId: promotion.id,
          customerId: promotion.customerId,
          basis: 'planned',
          accruedCents: amount,
          notes: `${promotion.name}: ${month.days} of the window's days`,
          createdBy: ctx.userId,
        })
        .returning({ id: tradeAccruals.id });

      const memo = `Trade accrual ${promotion.name} ${month.year}-${String(month.month).padStart(2, '0')} [promotion ${promotion.id}]`;
      const lines: DraftLine[] = [];
      if (month.allowanceCents > 0) {
        lines.push({ accountCode: contra, debitCents: month.allowanceCents, customerId: promotion.customerId, channelId: promotion.channelId, memo });
      }
      if (month.feeCents > 0) {
        lines.push({
          accountCode: ACCOUNTS.DISTRIBUTOR_FEES,
          debitCents: month.feeCents,
          customerId: promotion.customerId,
          channelId: promotion.channelId,
          memo: `${memo} — fixed fees`,
        });
      }
      lines.push({ accountCode: ACCOUNTS.ACCRUED_TRADE_SPEND, creditCents: amount, customerId: promotion.customerId, channelId: promotion.channelId, memo });

      const entry = await postJournalEntry(
        { date: month.periodEnd, memo, sourceType: 'accrual', sourceId: accrual.id, lines },
        { userId: ctx.userId, tx },
      );
      await tx.update(tradeAccruals).set({ journalEntryId: entry.entryId }).where(eq(tradeAccruals.id, accrual.id));
      posted.push({ accrualId: accrual.id, year: month.year, month: month.month, amountCents: amount, entryId: entry.entryId });
    }

    if (posted.length > 0) {
      const added = sumCents(posted.map((p) => p.amountCents));
      await tx
        .update(promotions)
        .set({
          accruedCents: sql`${promotions.accruedCents} + ${added}`,
          status: promotion.status === 'planned' ? 'active' : promotion.status,
        })
        .where(eq(promotions.id, promotion.id));
    }
    return posted;
  });
}

/** Month-end: accrues every planned or active promotion through `through`. */
export async function accrueTradeSpend(options: { through: CalendarDate }, ctx: TradeContext): Promise<PostedAccrual[]> {
  const through = requireDate('through', options.through);
  return runTrade(ctx, async (tx) => {
    const open = await tx
      .select({ id: promotions.id })
      .from(promotions)
      .where(inArray(promotions.status, ['planned', 'active']))
      .orderBy(asc(promotions.startDate), asc(promotions.id));
    const posted: PostedAccrual[] = [];
    for (const { id } of open) posted.push(...(await accruePromotion(id, { through }, { userId: ctx.userId, tx })));
    return posted;
  });
}

// ---------------------------------------------------------------------------
// Relieving and releasing the accrual
// ---------------------------------------------------------------------------

/** What is still accrued and unclaimed on a promotion: Σ accrued − relieved − released. */
export async function remainingAccrualCents(tx: LedgerDb, promotionId: string): Promise<number> {
  const [row] = await tx
    .select({
      remaining: sql<string>`coalesce(sum(${tradeAccruals.accruedCents} - ${tradeAccruals.relievedCents} - ${tradeAccruals.reversedCents}), 0)`,
    })
    .from(tradeAccruals)
    .where(eq(tradeAccruals.promotionId, promotionId));
  return Number(row?.remaining ?? 0);
}

/**
 * Records `amountCents` of deductions against a promotion: relieves its accrual
 * rows oldest month first by up to `chargedCents` (the part the caller debited
 * to 2120), and adds the whole amount to the promotion's actual spend.
 */
export async function recordPromotionCharge(
  tx: LedgerDb,
  promotionId: string,
  amounts: { chargedCents: number; actualCents: number },
): Promise<void> {
  let left = amounts.chargedCents;
  if (left > 0) {
    const rows = await tx
      .select()
      .from(tradeAccruals)
      .where(eq(tradeAccruals.promotionId, promotionId))
      .orderBy(asc(tradeAccruals.periodYear), asc(tradeAccruals.periodMonth), asc(tradeAccruals.createdAt))
      .for('update');
    for (const row of rows) {
      if (left === 0) break;
      const open = row.accruedCents - row.relievedCents - row.reversedCents;
      if (open <= 0) continue;
      const take = Math.min(open, left);
      await tx.update(tradeAccruals).set({ relievedCents: row.relievedCents + take }).where(eq(tradeAccruals.id, row.id));
      left -= take;
    }
    if (left > 0) throw invalidState(`Promotion ${promotionId} has ${amounts.chargedCents - left} cents of accrual left, not ${amounts.chargedCents}.`);
  }
  await tx
    .update(promotions)
    .set({ actualSpendCents: sql`${promotions.actualSpendCents} + ${amounts.actualCents}` })
    .where(eq(promotions.id, promotionId));
}

export interface ClosePromotionResult {
  promotion: Promotion;
  /** The residual released back to contra revenue: the favourable accrual variance. */
  releasedCents: number;
  entryId: string | null;
}

/**
 * Closes a promotion (or cancels it) and releases whatever is still accrued and
 * unclaimed:
 *
 *     Dr  2120 Accrued Trade Spend
 *         Cr  45xx Contra revenue (accrual variance)
 *
 * The memo names the promotion. An unfavourable variance needs no release — the
 * deductions beyond the accrual were already charged to contra revenue as they
 * arrived.
 */
export async function closePromotion(
  promotionId: string,
  options: { date: CalendarDate; cancel?: boolean },
  ctx: TradeContext,
): Promise<ClosePromotionResult> {
  const date = requireDate('date', options.date);
  return runTrade(ctx, async (tx) => {
    const promotion = await lockPromotion(tx, promotionId);
    if (promotion.status === 'completed' || promotion.status === 'cancelled') {
      throw invalidState(`Promotion ${promotion.name} is already ${promotion.status}.`);
    }
    const rows = await tx
      .select()
      .from(tradeAccruals)
      .where(eq(tradeAccruals.promotionId, promotion.id))
      .orderBy(asc(tradeAccruals.periodYear), asc(tradeAccruals.periodMonth))
      .for('update');
    const open = rows.map((r) => ({ row: r, open: r.accruedCents - r.relievedCents - r.reversedCents })).filter((r) => r.open > 0);
    const released = sumCents(open.map((r) => r.open));

    let entryId: string | null = null;
    if (released > 0) {
      const memo = `Release trade accrual ${promotion.name} — accrual variance [promotion ${promotion.id}]`;
      const entry = await postJournalEntry(
        {
          date,
          memo,
          sourceType: 'accrual',
          sourceId: promotion.id,
          lines: [
            { accountCode: ACCOUNTS.ACCRUED_TRADE_SPEND, debitCents: released, customerId: promotion.customerId, channelId: promotion.channelId, memo },
            {
              accountCode: PROMO_CONTRA_ACCOUNT[promotion.promoType],
              creditCents: released,
              customerId: promotion.customerId,
              channelId: promotion.channelId,
              memo,
            },
          ],
        },
        { userId: ctx.userId, tx },
      );
      entryId = entry.entryId;
      for (const { row, open: amount } of open) {
        await tx
          .update(tradeAccruals)
          .set({ reversedCents: row.reversedCents + amount, reversalEntryId: entry.entryId })
          .where(eq(tradeAccruals.id, row.id));
      }
    }

    const [updated] = await tx
      .update(promotions)
      .set({ status: options.cancel === true ? 'cancelled' : 'completed' })
      .where(eq(promotions.id, promotion.id))
      .returning();
    return { promotion: updated, releasedCents: released, entryId };
  });
}

// ---------------------------------------------------------------------------
// Performance
// ---------------------------------------------------------------------------

export interface PromotionPerformance {
  id: string;
  name: string;
  promoType: PromoType;
  customerId: string | null;
  customerName: string | null;
  startDate: CalendarDate;
  endDate: CalendarDate;
  status: Promotion['status'];
  plannedCents: number;
  accruedCents: number;
  /** Accrual consumed by deductions charged against it. */
  relievedCents: number;
  /** Accrual released back to contra revenue on close. */
  releasedCents: number;
  /** Still accrued, not yet claimed or released. */
  openAccrualCents: number;
  /** Deductions attributed to the promotion. */
  deductedCents: number;
  /** Plan less deducted: negative is an overspend against plan. */
  planVarianceCents: number;
  /** Actual less accrued: positive is under-accrued (a margin surprise), negative over-accrued. */
  accrualVarianceCents: number;
  /** accrualVariance ÷ accrued, as a ratio (0.1 = 10 %); null before anything is accrued. */
  accrualVarianceRatio: number | null;
}

/** Planned vs accrued vs deducted, from the promotion_performance view plus the accrual ledger. */
export async function promotionPerformanceReport(
  filter: { customerId?: string; promotionIds?: readonly string[] },
  ctx: TradeContext,
): Promise<PromotionPerformance[]> {
  return runTrade(ctx, async (tx) => {
    const conditions = [];
    if (filter.customerId !== undefined) conditions.push(eq(promotionPerformance.customerId, requireUuid('customerId', filter.customerId)));
    if (filter.promotionIds !== undefined) {
      if (filter.promotionIds.length === 0) return [];
      conditions.push(inArray(promotionPerformance.id, [...filter.promotionIds]));
    }
    const rows = await tx
      .select()
      .from(promotionPerformance)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(asc(promotionPerformance.startDate), asc(promotionPerformance.name));
    if (rows.length === 0) return [];

    const sums = await tx
      .select({
        promotionId: tradeAccruals.promotionId,
        accrued: sql<string>`sum(${tradeAccruals.accruedCents})`,
        relieved: sql<string>`sum(${tradeAccruals.relievedCents})`,
        released: sql<string>`sum(${tradeAccruals.reversedCents})`,
      })
      .from(tradeAccruals)
      .where(inArray(tradeAccruals.promotionId, rows.map((r) => r.id)))
      .groupBy(tradeAccruals.promotionId);
    const byPromotion = new Map(sums.map((s) => [s.promotionId, s]));

    return rows.map((row) => {
      const s = byPromotion.get(row.id);
      const accrued = Number(s?.accrued ?? 0);
      const relieved = Number(s?.relieved ?? 0);
      const released = Number(s?.released ?? 0);
      const deducted = Number(row.deductedCents);
      const variance = deducted - accrued;
      return {
        id: row.id,
        name: row.name,
        promoType: row.promoType,
        customerId: row.customerId,
        customerName: row.customerName,
        startDate: row.startDate,
        endDate: row.endDate,
        status: row.status,
        plannedCents: row.plannedSpendCents,
        accruedCents: accrued,
        relievedCents: relieved,
        releasedCents: released,
        openAccrualCents: accrued - relieved - released,
        deductedCents: deducted,
        planVarianceCents: row.plannedSpendCents - deducted,
        accrualVarianceCents: variance,
        accrualVarianceRatio: accrued === 0 ? null : Math.round((variance / accrued) * 10_000) / 10_000,
      };
    });
  });
}

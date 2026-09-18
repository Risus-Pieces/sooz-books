/**
 * Inventory adjustments: spoilage, samples, demo product, count variances,
 * write-offs.
 *
 * An adjustment moves value between an inventory account (chosen by stage:
 * finished 1310, raw 1320, packaging 1330, in transit 1340) and its P&L side
 * (chosen by reason: samples, demo and donations 5070; everything lost or
 * miscounted 5060; an opening balance 3990). A negative quantity takes stock
 * out (Dr expense, Cr inventory); a positive one — a count that found more
 * than the books — puts it back (Dr inventory, Cr expense).
 *
 * Value is `|quantity| × unit cost`, rounded once. For finished goods the unit
 * cost defaults to the product's cost effective on the adjustment date; raw
 * materials and packaging carry no product cost here, so their unit cost (or the
 * total value) must be given.
 */

import { and, asc, eq, like, sql as sqlTag } from 'drizzle-orm';

import {
  inventoryAdjustments,
  products,
  type InventoryAdjustment,
  type InventoryAdjustmentReason,
} from '@/db/schema';
import { type CalendarDate, isCalendarDate } from '@/lib/dates';
import { isUniqueViolation } from '@/lib/db-errors';
import { type LedgerDb, postJournalEntry } from '@/lib/ledger/post';

import { ADJUSTMENT_EXPENSE_ACCOUNT, STAGE_ACCOUNT, type Stage } from './accounts';
import { accountIdsByCode, inTx, reader, type InventoryCtx } from './context';
import { InventoryError } from './errors';
import { toDraftLines } from './lines';
import { extendCost, formatQuantity, quantityToDb } from './quantity';

export interface AdjustmentInput {
  date: CalendarDate;
  productId: string;
  reason: InventoryAdjustmentReason;
  /** Hundredths of a unit; negative removes stock. */
  quantity: number;
  stage?: Stage;
  /** Defaults, for finished goods, to the product's unit cost at `date`. */
  unitCostCents?: number;
  /** Overrides `|quantity| × unit cost` when the value is known directly. */
  valueCents?: number;
  channelId?: string | null;
  memo?: string;
}

export interface AdjustmentPlan {
  stage: Stage;
  inventoryAccountCode: string;
  expenseAccountCode: string;
  unitCostCents: number;
  /** Signed like the quantity: negative takes value out of inventory. */
  valueCents: number;
}

/** Decides accounts and value without writing. Pure except for the cost lookup the caller does. */
export function planAdjustment(input: AdjustmentInput, unitCostAtDate: number | null): AdjustmentPlan {
  if (!Number.isSafeInteger(input.quantity) || input.quantity === 0) {
    throw new InventoryError('invalid_input', 'An adjustment needs a non-zero quantity.');
  }
  const stage = input.stage ?? 'finished';
  const unitCostCents = input.unitCostCents ?? (stage === 'finished' ? unitCostAtDate : null);
  let magnitude: number;
  if (input.valueCents !== undefined) {
    if (!Number.isSafeInteger(input.valueCents) || input.valueCents <= 0) {
      throw new InventoryError('invalid_input', 'An adjustment value must be a positive whole number of cents.');
    }
    magnitude = input.valueCents;
  } else {
    if (unitCostCents === null || unitCostCents === undefined) {
      throw new InventoryError(
        'missing_cost',
        stage === 'finished'
          ? 'This product has no unit cost on that date; give the unit cost or the value.'
          : `A ${stage} adjustment needs its unit cost or value given.`,
      );
    }
    magnitude = extendCost(Math.abs(input.quantity), unitCostCents);
  }
  if (magnitude === 0) throw new InventoryError('invalid_input', 'This adjustment is worth nothing to post.');
  return {
    stage,
    inventoryAccountCode: STAGE_ACCOUNT[stage],
    expenseAccountCode: ADJUSTMENT_EXPENSE_ACCOUNT[input.reason],
    unitCostCents: unitCostCents ?? 0,
    valueCents: input.quantity < 0 ? -magnitude : magnitude,
  };
}

async function unitCostAt(tx: LedgerDb, productId: string, date: CalendarDate): Promise<number | null> {
  const rows = await tx.execute<{ cost: string | number | null }>(
    sqlTag`select unit_cost_at(${productId}::uuid, ${date}::date) as cost`,
  );
  const cost = [...rows][0]?.cost;
  return cost === null || cost === undefined ? null : Number(cost);
}

async function nextAdjustmentNo(tx: LedgerDb, date: CalendarDate): Promise<string> {
  const prefix = `ADJ-${date.replaceAll('-', '')}-`;
  const [{ n }] = await tx
    .select({ n: sqlTag<string>`count(*)` })
    .from(inventoryAdjustments)
    .where(like(inventoryAdjustments.adjustmentNo, `${prefix}%`));
  return `${prefix}${String(Number(n) + 1).padStart(3, '0')}`;
}

export interface PostedAdjustment {
  adjustment: InventoryAdjustment;
  entryId: string;
}

/** Records and posts an adjustment in one transaction. */
export async function postInventoryAdjustment(
  input: AdjustmentInput,
  ctx: InventoryCtx,
): Promise<PostedAdjustment> {
  if (!isCalendarDate(input.date)) {
    throw new InventoryError('invalid_input', `${String(input.date)} is not YYYY-MM-DD.`);
  }
  return inTx(ctx, async (tx) => {
    const [product] = await tx
      .select({ id: products.id, sku: products.sku })
      .from(products)
      .where(eq(products.id, input.productId));
    if (!product) throw new InventoryError('not_found', `Product ${input.productId} does not exist.`);

    const plan = planAdjustment(input, await unitCostAt(tx, input.productId, input.date));
    const ids = await accountIdsByCode(tx, [plan.inventoryAccountCode, plan.expenseAccountCode]);
    const adjustmentNo = await nextAdjustmentNo(tx, input.date);
    const memo =
      input.memo?.trim() ||
      `${input.reason.replace('_', ' ')}: ${formatQuantity(input.quantity)} × ${product.sku}`;
    const dims = { productId: product.id, channelId: input.channelId ?? null };

    const posted = await postJournalEntry(
      {
        date: input.date,
        memo: `${adjustmentNo} ${memo}`,
        sourceType: 'inventory',
        lines: toDraftLines([
          { accountCode: plan.inventoryAccountCode, cents: plan.valueCents, ...dims },
          { accountCode: plan.expenseAccountCode, cents: -plan.valueCents, ...dims },
        ]),
      },
      { userId: ctx.userId, tx },
    );

    try {
      const [adjustment] = await tx
        .insert(inventoryAdjustments)
        .values({
          adjustmentNo,
          adjustmentDate: input.date,
          productId: product.id,
          reason: input.reason,
          quantity: quantityToDb(input.quantity),
          unitCostCents: plan.unitCostCents,
          valueCents: plan.valueCents,
          expenseAccountId: ids.get(plan.expenseAccountCode) ?? null,
          inventoryAccountId: ids.get(plan.inventoryAccountCode) ?? null,
          stage: plan.stage,
          channelId: input.channelId ?? null,
          memo,
          journalEntryId: posted.entryId,
          createdBy: ctx.userId,
        })
        .returning();
      return { adjustment, entryId: posted.entryId };
    } catch (error) {
      if (isUniqueViolation(error, 'inventory_adjustments_adjustment_no_key')) {
        throw new InventoryError('duplicate', 'Another adjustment was numbered at the same moment; try again.');
      }
      throw error;
    }
  });
}

export async function listInventoryAdjustments(
  range: { from?: CalendarDate; to?: CalendarDate } = {},
  exec?: LedgerDb,
): Promise<Array<InventoryAdjustment & { sku: string }>> {
  const rows = await reader(exec)
    .select({ adjustment: inventoryAdjustments, sku: products.sku })
    .from(inventoryAdjustments)
    .innerJoin(products, eq(products.id, inventoryAdjustments.productId))
    .where(
      and(
        range.from === undefined ? undefined : sqlTag`${inventoryAdjustments.adjustmentDate} >= ${range.from}`,
        range.to === undefined ? undefined : sqlTag`${inventoryAdjustments.adjustmentDate} <= ${range.to}`,
      ),
    )
    .orderBy(asc(inventoryAdjustments.adjustmentDate), asc(inventoryAdjustments.adjustmentNo));
  return rows.map((r) => ({ ...r.adjustment, sku: r.sku }));
}

/**
 * Production runs and landed cost.
 *
 * A run is one batch made for us at a co-manufacturer. While it is `open`, the
 * costs that belong to it are attached as `landed_costs`: the co-man's tolling
 * invoice, the ingredients and packaging it consumed, inbound freight, duty. One
 * bill often covers several runs (a single freight invoice for two runs, a
 * tolling invoice for a month); `allocateBillLine` spreads it with
 * `allocateCents`, so the shares always sum to the bill line exactly.
 *
 * `costRun` then strikes the unit cost and moves the value into Finished Goods.
 *
 * Unit cost and the remainder
 * ---------------------------
 *   good units  = units_produced − units_rejected (hundredths of a unit)
 *   unit cost   = total landed cost / good units, rounded half away from zero to a cent
 *   FG value    = unit cost × good units
 *   variance    = total − FG value   (|variance| ≤ good units / 2 cents)
 *
 * Finished Goods is debited exactly `unit cost × good units`, so that relieving
 * every unit at the struck cost empties it to the cent and the Peasy tie-out
 * (quantity × unit cost) agrees with the ledger. The rounding remainder is not
 * left to drift inside inventory: it is booked at costing to 5050 Co-Man
 * Overrun / Underrun Variance (a debit when the total exceeds FG value, a credit
 * when it falls short), and recorded on the run as `rounding_variance_cents`.
 *
 * The per-unit component breakdown (tolling / ingredients / packaging / freight
 * in / duty …) is the unit cost split by `allocateCents` in proportion to each
 * component's total, so its parts sum to the unit cost exactly.
 *
 * The reclassification entry
 * --------------------------
 * Each landed cost is relieved from its source account — the bill line's own
 * account when it came from a bill (ingredients billed to 1320, packaging to
 * 1330, tolling to 2160, freight expensed to 5030 …), otherwise the component's
 * default (`COMPONENT_DEFAULT_SOURCE`: consumed ingredients out of 1320, consumed
 * packaging out of 1330, un-invoiced tolling accrued to 2160). Costs already
 * sitting in 1310 are not moved. The entry is:
 *
 *   Dr 1310 Finished Goods        FG value − amounts already in 1310
 *   Dr/Cr 5050 rounding variance  variance
 *   Cr each source account        its landed cost
 */

import { and, asc, eq, inArray, sql as sqlTag } from 'drizzle-orm';

import {
  billLines,
  bills,
  cogsBatchLines,
  cogsBatches,
  landedCosts,
  productCosts,
  productionRuns,
  products,
  type CostBreakdown,
  type CostComponent,
  type LandedCost,
  type ProductionRun,
} from '@/db/schema';
import { type CalendarDate, isCalendarDate, periodOf } from '@/lib/dates';
import { isUniqueViolation } from '@/lib/db-errors';
import { ACCOUNTS } from '@/lib/ledger/coa';
import { type LedgerDb, postJournalEntry } from '@/lib/ledger/post';
import { reverseEntry } from '@/lib/ledger/reverse';
import { allocateCents } from '@/lib/money';

import { COMPONENT_DEFAULT_SOURCE, COMPONENT_ORDER } from './accounts';
import { accountIdsByCode, inTx, reader, type InventoryCtx } from './context';
import { InventoryError } from './errors';
import { toDraftLines, type SignedLine } from './lines';
import { extendCost, formatQuantity, quantityFromDb, quantityToDb, unitCostOf } from './quantity';

// ---------------------------------------------------------------------------
// Pure costing math
// ---------------------------------------------------------------------------

export interface CostInput {
  component: CostComponent;
  amountCents: number;
}

export interface RunCostMath {
  totalCents: number;
  goodUnits: number;
  unitCostCents: number;
  /** Per-unit cents by component; the parts sum to `unitCostCents`. */
  breakdown: CostBreakdown;
  /** Totals by component across the run; the parts sum to `totalCents`. */
  componentTotals: CostBreakdown;
  finishedGoodsValueCents: number;
  roundingVarianceCents: number;
}

/**
 * The unit-cost arithmetic of a run, with no database. `goodUnits` is in
 * hundredths of a unit.
 */
export function computeRunCost(costs: readonly CostInput[], goodUnits: number): RunCostMath {
  if (!Number.isSafeInteger(goodUnits) || goodUnits <= 0) {
    throw new InventoryError('invalid_input', 'A run needs more than zero good units to be costed.');
  }
  const componentTotals: CostBreakdown = {};
  for (const cost of costs) {
    if (!Number.isSafeInteger(cost.amountCents)) {
      throw new InventoryError('invalid_input', `Landed cost ${cost.amountCents} is not whole cents.`);
    }
    componentTotals[cost.component] = (componentTotals[cost.component] ?? 0) + cost.amountCents;
  }
  const totalCents = COMPONENT_ORDER.reduce((sum, c) => sum + (componentTotals[c] ?? 0), 0);
  if (totalCents <= 0) {
    throw new InventoryError('invalid_input', 'A run with no landed cost cannot be costed.');
  }
  const negative = COMPONENT_ORDER.filter((c) => (componentTotals[c] ?? 0) < 0);
  if (negative.length > 0) {
    throw new InventoryError(
      'invalid_input',
      `Component totals cannot be negative (${negative.join(', ')}); net the credit against the bill it corrects.`,
    );
  }

  const unitCostCents = unitCostOf(totalCents, goodUnits);
  const present = COMPONENT_ORDER.filter((c) => (componentTotals[c] ?? 0) > 0);
  const parts = allocateCents(
    unitCostCents,
    present.map((c) => componentTotals[c] ?? 0),
  );
  const breakdown: CostBreakdown = {};
  present.forEach((c, i) => {
    if (parts[i] !== 0) breakdown[c] = parts[i];
  });

  const finishedGoodsValueCents = extendCost(goodUnits, unitCostCents);
  return {
    totalCents,
    goodUnits,
    unitCostCents,
    breakdown,
    componentTotals,
    finishedGoodsValueCents,
    roundingVarianceCents: totalCents - finishedGoodsValueCents,
  };
}

/** Good units of a run, in hundredths: produced less rejected. */
export function goodUnitsOf(run: Pick<ProductionRun, 'unitsProduced' | 'unitsRejected'>): number {
  return quantityFromDb(run.unitsProduced) - quantityFromDb(run.unitsRejected);
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export interface CreateRunInput {
  runNo: string;
  productId: string;
  runDate: CalendarDate;
  coManVendorId?: string | null;
  lotCode?: string | null;
  /** Hundredths of a unit. */
  unitsPlanned?: number | null;
  unitsProduced?: number;
  unitsRejected?: number;
  peasyWorkOrderId?: string | null;
  notes?: string | null;
}

export async function createProductionRun(
  input: CreateRunInput,
  ctx: InventoryCtx,
): Promise<ProductionRun> {
  if (!isCalendarDate(input.runDate)) {
    throw new InventoryError('invalid_input', `Run date ${String(input.runDate)} is not YYYY-MM-DD.`);
  }
  const runNo = input.runNo.trim();
  if (runNo === '') throw new InventoryError('invalid_input', 'A run needs a run number.');
  return inTx(ctx, async (tx) => {
    try {
      const [row] = await tx
        .insert(productionRuns)
        .values({
          runNo,
          productId: input.productId,
          runDate: input.runDate,
          coManVendorId: input.coManVendorId ?? null,
          lotCode: input.lotCode ?? null,
          unitsPlanned: input.unitsPlanned == null ? null : quantityToDb(input.unitsPlanned),
          unitsProduced: quantityToDb(input.unitsProduced ?? 0),
          unitsRejected: quantityToDb(input.unitsRejected ?? 0),
          peasyWorkOrderId: input.peasyWorkOrderId ?? null,
          notes: input.notes ?? null,
        })
        .returning();
      return row;
    } catch (error) {
      if (isUniqueViolation(error, 'production_runs_run_no_key')) {
        throw new InventoryError('duplicate', `Run ${runNo} already exists.`);
      }
      throw error;
    }
  });
}

async function lockRun(tx: LedgerDb, runId: string): Promise<ProductionRun> {
  const [run] = await tx
    .select()
    .from(productionRuns)
    .where(eq(productionRuns.id, runId))
    .for('update');
  if (!run) throw new InventoryError('not_found', `Production run ${runId} does not exist.`);
  return run;
}

function assertOpen(run: ProductionRun): void {
  if (run.status !== 'open') {
    throw new InventoryError(
      'invalid_state',
      `Run ${run.runNo} is ${run.status}; reopen it before changing its output or costs.`,
    );
  }
}

/** Records what the co-man actually yielded. Hundredths of a unit. */
export async function recordRunOutput(
  runId: string,
  output: { unitsProduced: number; unitsRejected?: number },
  ctx: InventoryCtx,
): Promise<ProductionRun> {
  const rejected = output.unitsRejected ?? 0;
  if (output.unitsProduced < 0 || rejected < 0 || rejected > output.unitsProduced) {
    throw new InventoryError('invalid_input', 'Units rejected must be between zero and units produced.');
  }
  return inTx(ctx, async (tx) => {
    const run = await lockRun(tx, runId);
    assertOpen(run);
    const [row] = await tx
      .update(productionRuns)
      .set({ unitsProduced: quantityToDb(output.unitsProduced), unitsRejected: quantityToDb(rejected) })
      .where(eq(productionRuns.id, runId))
      .returning();
    return row;
  });
}

// ---------------------------------------------------------------------------
// Landed costs
// ---------------------------------------------------------------------------

export interface AddLandedCostInput {
  runId: string;
  component: CostComponent;
  amountCents: number;
  description?: string;
  /**
   * Where costing relieves this cost from. Defaults to the component's default
   * source (`COMPONENT_DEFAULT_SOURCE`): consumed ingredients out of 1320,
   * consumed packaging out of 1330, un-invoiced tolling accrued to 2160.
   */
  sourceAccountCode?: string;
}

/**
 * Attaches a cost that did not arrive on a bill line — most often material
 * consumed out of stock Sooz already owns (ingredients and packaging sitting in
 * 1320 and 1330 today).
 */
export async function addLandedCost(input: AddLandedCostInput, ctx: InventoryCtx): Promise<LandedCost> {
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) {
    throw new InventoryError('invalid_input', 'A landed cost must be a positive whole number of cents.');
  }
  const sourceCode = input.sourceAccountCode ?? COMPONENT_DEFAULT_SOURCE[input.component];
  return inTx(ctx, async (tx) => {
    const run = await lockRun(tx, input.runId);
    assertOpen(run);
    const ids = await accountIdsByCode(tx, [sourceCode]);
    const [row] = await tx
      .insert(landedCosts)
      .values({
        productionRunId: run.id,
        component: input.component,
        amountCents: input.amountCents,
        description: input.description ?? null,
        allocationBasis: 'manual',
        sourceAccountId: ids.get(sourceCode) ?? null,
      })
      .returning();
    return row;
  });
}

export async function removeLandedCost(landedCostId: string, ctx: InventoryCtx): Promise<void> {
  await inTx(ctx, async (tx) => {
    const [row] = await tx.select().from(landedCosts).where(eq(landedCosts.id, landedCostId));
    if (!row) throw new InventoryError('not_found', `Landed cost ${landedCostId} does not exist.`);
    assertOpen(await lockRun(tx, row.productionRunId));
    await tx.delete(landedCosts).where(eq(landedCosts.id, landedCostId));
  });
}

export type AllocationBasis = 'units' | 'value' | 'manual';

export interface AllocateBillLineInput {
  billLineId: string;
  component: CostComponent;
  /**
   * `units` weighs each run by its good units (planned units while nothing has
   * been produced yet); `value` and `manual` use the weights given.
   */
  basis: AllocationBasis;
  runs: ReadonlyArray<{ runId: string; weight?: number }>;
  /** Defaults to whatever of the bill line is not yet allocated. */
  amountCents?: number;
  description?: string;
}

export interface AllocationResult {
  billLineId: string;
  amountCents: number;
  shares: Array<{ runId: string; runNo: string; weight: number; amountCents: number; landedCostId: string | null }>;
}

/**
 * Spreads one bill line across one or more open runs. The shares are computed by
 * `allocateCents` and always sum to the amount exactly; the database refuses, at
 * COMMIT, any allocation that would draw more from a bill line than it holds.
 */
export async function allocateBillLine(
  input: AllocateBillLineInput,
  ctx: InventoryCtx,
): Promise<AllocationResult> {
  if (input.runs.length === 0) {
    throw new InventoryError('invalid_input', 'Choose at least one production run.');
  }
  const runIds = input.runs.map((r) => r.runId);
  if (new Set(runIds).size !== runIds.length) {
    throw new InventoryError('invalid_input', 'A run appears twice in the allocation.');
  }

  return inTx(ctx, async (tx) => {
    const [line] = await tx
      .select({
        id: billLines.id,
        billId: billLines.billId,
        accountId: billLines.accountId,
        amountCents: billLines.amountCents,
        description: billLines.description,
        billNo: bills.billNo,
        billStatus: bills.status,
        billEntryId: bills.journalEntryId,
      })
      .from(billLines)
      .innerJoin(bills, eq(bills.id, billLines.billId))
      .where(eq(billLines.id, input.billLineId));
    if (!line) throw new InventoryError('not_found', `Bill line ${input.billLineId} does not exist.`);
    if (line.billEntryId === null || line.billStatus === 'draft' || line.billStatus === 'void') {
      throw new InventoryError(
        'unposted_bill',
        `Bill ${line.billNo} is ${line.billStatus} and has not been posted; post it before allocating it to a run, or costing would relieve an amount the ledger never received.`,
      );
    }

    const [{ allocated }] = await tx
      .select({ allocated: sqlTag<string>`coalesce(sum(${landedCosts.amountCents}), 0)` })
      .from(landedCosts)
      .where(eq(landedCosts.billLineId, line.id));
    const remaining = line.amountCents - Number(allocated);
    const amount = input.amountCents ?? remaining;
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      throw new InventoryError('allocation', `Bill line ${line.description} has nothing left to allocate.`);
    }
    if (amount > remaining) {
      throw new InventoryError(
        'allocation',
        `Only ${remaining} cents of this bill line are unallocated; ${amount} were asked for.`,
      );
    }

    const runs = await tx
      .select()
      .from(productionRuns)
      .where(inArray(productionRuns.id, runIds))
      .for('update');
    const byId = new Map(runs.map((r) => [r.id, r]));
    const ordered = input.runs.map((r) => {
      const run = byId.get(r.runId);
      if (!run) throw new InventoryError('not_found', `Production run ${r.runId} does not exist.`);
      assertOpen(run);
      return { run, given: r.weight };
    });

    const weights = ordered.map(({ run, given }) => {
      if (input.basis === 'units') {
        const good = goodUnitsOf(run);
        const planned = run.unitsPlanned === null ? 0 : quantityFromDb(run.unitsPlanned);
        return good > 0 ? good : planned;
      }
      if (given === undefined || !Number.isFinite(given) || given < 0) {
        throw new InventoryError('invalid_input', `Run ${run.runNo} needs a non-negative weight.`);
      }
      return given;
    });
    if (weights.every((w) => w === 0)) {
      throw new InventoryError(
        'allocation',
        input.basis === 'units'
          ? 'None of these runs has produced or planned units to weigh the allocation by.'
          : 'Every weight is zero.',
      );
    }

    const parts = allocateCents(amount, weights);
    const shares: AllocationResult['shares'] = [];
    for (let i = 0; i < ordered.length; i += 1) {
      const { run } = ordered[i];
      let landedCostId: string | null = null;
      if (parts[i] !== 0) {
        const [row] = await tx
          .insert(landedCosts)
          .values({
            productionRunId: run.id,
            component: input.component,
            billId: line.billId,
            billLineId: line.id,
            description: input.description ?? line.description,
            amountCents: parts[i],
            allocationBasis: input.basis,
            sourceAccountId: line.accountId,
          })
          .returning({ id: landedCosts.id });
        landedCostId = row.id;
      }
      shares.push({ runId: run.id, runNo: run.runNo, weight: weights[i], amountCents: parts[i], landedCostId });
    }

    if (ordered.length === 1) {
      await tx
        .update(billLines)
        .set({ productionRunId: ordered[0].run.id })
        .where(eq(billLines.id, line.id));
    }

    return { billLineId: line.id, amountCents: amount, shares };
  });
}

// ---------------------------------------------------------------------------
// Costing
// ---------------------------------------------------------------------------

export interface CostRunOptions extends InventoryCtx {
  /** Date of the reclassification and of the unit cost. Defaults to the run date. */
  date?: CalendarDate;
}

export interface CostRunResult extends RunCostMath {
  runId: string;
  productCostId: string;
  /** Null when every cost already sat in Finished Goods and nothing needed moving. */
  entryId: string | null;
}

export async function costRun(runId: string, options: CostRunOptions): Promise<CostRunResult> {
  if (options.date !== undefined && !isCalendarDate(options.date)) {
    throw new InventoryError('invalid_input', `${String(options.date)} is not YYYY-MM-DD.`);
  }
  return inTx(options, async (tx) => {
    const run = await lockRun(tx, runId);
    assertOpen(run);
    const date = options.date ?? run.runDate;

    const costs = await tx
      .select({
        id: landedCosts.id,
        component: landedCosts.component,
        amountCents: landedCosts.amountCents,
        sourceAccountId: landedCosts.sourceAccountId,
        billId: landedCosts.billId,
        billNo: bills.billNo,
        billEntryId: bills.journalEntryId,
      })
      .from(landedCosts)
      .leftJoin(bills, eq(bills.id, landedCosts.billId))
      .where(eq(landedCosts.productionRunId, run.id))
      .orderBy(asc(landedCosts.createdAt));
    if (costs.length === 0) {
      throw new InventoryError('invalid_input', `Run ${run.runNo} has no landed costs to cost.`);
    }
    const unposted = costs.filter((c) => c.billId !== null && c.billEntryId === null);
    if (unposted.length > 0) {
      throw new InventoryError(
        'unposted_bill',
        `Run ${run.runNo} draws on bills that are not posted.`,
        [...new Set(unposted.map((c) => c.billNo ?? c.billId ?? ''))],
      );
    }

    const good = goodUnitsOf(run);
    if (good <= 0) {
      throw new InventoryError(
        'invalid_input',
        `Run ${run.runNo} has ${formatQuantity(good)} good units; record the output before costing.`,
      );
    }
    const math = computeRunCost(costs, good);

    const codes = await accountIdsByCode(tx, [
      ACCOUNTS.INVENTORY_FINISHED,
      ACCOUNTS.COGS_COMAN_VARIANCE,
      ...costs.filter((c) => c.sourceAccountId === null).map((c) => COMPONENT_DEFAULT_SOURCE[c.component]),
    ]);
    const fgId = codes.get(ACCOUNTS.INVENTORY_FINISHED) as string;
    const varianceId = codes.get(ACCOUNTS.COGS_COMAN_VARIANCE) as string;

    const memo = `Cost run ${run.runNo}`;
    const signed: SignedLine[] = [];
    let alreadyInFg = 0;
    for (const cost of costs) {
      const source = cost.sourceAccountId ?? (codes.get(COMPONENT_DEFAULT_SOURCE[cost.component]) as string);
      if (source === fgId) {
        alreadyInFg += cost.amountCents;
        continue;
      }
      signed.push({
        accountId: source,
        cents: -cost.amountCents,
        memo: `${memo} — ${cost.component.replace('_', ' ')}`,
        productId: run.productId,
        vendorId: run.coManVendorId,
      });
    }
    signed.unshift({
      accountId: fgId,
      cents: math.finishedGoodsValueCents - alreadyInFg,
      memo: `${memo} — ${formatQuantity(good)} units at ${math.unitCostCents}¢`,
      productId: run.productId,
    });
    signed.push({
      accountId: varianceId,
      cents: math.roundingVarianceCents,
      memo: `${memo} — unit cost rounding`,
      productId: run.productId,
    });

    const lines = toDraftLines(signed);
    let entryId: string | null = null;
    if (lines.length >= 2) {
      const posted = await postJournalEntry(
        { date, memo, sourceType: 'landed_cost', sourceId: run.id, lines },
        { userId: options.userId, tx },
      );
      entryId = posted.entryId;
    }

    let productCostId: string;
    try {
      const [pc] = await tx
        .insert(productCosts)
        .values({
          productId: run.productId,
          effectiveDate: date,
          unitCostCents: math.unitCostCents,
          method: 'actual_run',
          productionRunId: run.id,
          breakdown: math.breakdown,
          notes: `Run ${run.runNo}: ${math.totalCents}¢ over ${formatQuantity(good)} good units`,
          createdBy: options.userId,
        })
        .returning({ id: productCosts.id });
      productCostId = pc.id;
    } catch (error) {
      if (isUniqueViolation(error, 'product_costs_product_id_effective_date_key')) {
        throw new InventoryError(
          'duplicate',
          `This product already has a unit cost effective ${date}. Cost the second run on another date.`,
        );
      }
      throw error;
    }

    await tx
      .update(productionRuns)
      .set({
        status: 'costed',
        totalCostCents: math.totalCents,
        unitCostCents: math.unitCostCents,
        costedAt: new Date(),
        costEntryId: entryId,
        roundingVarianceCents: math.roundingVarianceCents,
      })
      .where(eq(productionRuns.id, run.id));

    return { ...math, runId: run.id, productCostId, entryId };
  });
}

/**
 * Un-costs a run so its costs can be corrected: reverses the reclassification,
 * withdraws the unit cost, and sets the run back to `open`. Refused once a
 * posted COGS batch on or after the run's cost date has relieved this product,
 * because that batch was valued at the cost being withdrawn.
 */
export async function reopenRun(runId: string, ctx: InventoryCtx): Promise<ProductionRun> {
  return inTx(ctx, async (tx) => {
    const run = await lockRun(tx, runId);
    if (run.status !== 'costed') {
      throw new InventoryError('invalid_state', `Run ${run.runNo} is ${run.status}, not costed.`);
    }
    const [pc] = await tx
      .select({ id: productCosts.id, effectiveDate: productCosts.effectiveDate })
      .from(productCosts)
      .where(eq(productCosts.productionRunId, run.id));

    if (pc) {
      const { year, month } = periodOf(pc.effectiveDate);
      const used = await tx
        .select({ id: cogsBatches.id, year: cogsBatches.periodYear, month: cogsBatches.periodMonth })
        .from(cogsBatches)
        .innerJoin(cogsBatchLines, eq(cogsBatchLines.batchId, cogsBatches.id))
        .where(
          and(
            eq(cogsBatches.status, 'posted'),
            eq(cogsBatchLines.productId, run.productId),
            sqlTag`(${cogsBatches.periodYear} * 12 + ${cogsBatches.periodMonth}) >= ${year * 12 + month}`,
          ),
        )
        .limit(1);
      if (used.length > 0) {
        throw new InventoryError(
          'invalid_state',
          `COGS for ${used[0].year}-${String(used[0].month).padStart(2, '0')} was posted at this run's cost. Reverse that batch first.`,
        );
      }
    }

    if (run.costEntryId !== null) {
      await reverseEntry(run.costEntryId, {
        userId: ctx.userId,
        tx,
        owner: 'landed_cost',
        memo: `Reopen run ${run.runNo}`,
      });
    }
    if (pc) await tx.delete(productCosts).where(eq(productCosts.id, pc.id));

    const [row] = await tx
      .update(productionRuns)
      .set({
        status: 'open',
        totalCostCents: 0,
        unitCostCents: null,
        costedAt: null,
        costEntryId: null,
        roundingVarianceCents: 0,
      })
      .where(eq(productionRuns.id, run.id))
      .returning();
    return row;
  });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface RunSummary {
  id: string;
  runNo: string;
  productId: string;
  sku: string;
  productName: string;
  runDate: CalendarDate;
  status: ProductionRun['status'];
  goodUnits: number;
  landedCostCents: number;
  unitCostCents: number | null;
}

export async function listProductionRuns(exec?: LedgerDb): Promise<RunSummary[]> {
  const rows = await reader(exec)
    .select({
      id: productionRuns.id,
      runNo: productionRuns.runNo,
      productId: productionRuns.productId,
      sku: products.sku,
      productName: products.name,
      runDate: productionRuns.runDate,
      status: productionRuns.status,
      unitsProduced: productionRuns.unitsProduced,
      unitsRejected: productionRuns.unitsRejected,
      unitCostCents: productionRuns.unitCostCents,
      landed: sqlTag<string>`(select coalesce(sum(lc.amount_cents), 0) from landed_costs lc where lc.production_run_id = ${productionRuns.id})`,
    })
    .from(productionRuns)
    .innerJoin(products, eq(products.id, productionRuns.productId))
    .orderBy(sqlTag`${productionRuns.runDate} desc`, asc(productionRuns.runNo));
  return rows.map((r) => ({
    id: r.id,
    runNo: r.runNo,
    productId: r.productId,
    sku: r.sku,
    productName: r.productName,
    runDate: r.runDate,
    status: r.status,
    goodUnits: goodUnitsOf(r),
    landedCostCents: Number(r.landed),
    unitCostCents: r.unitCostCents,
  }));
}

export async function landedCostsForRun(runId: string, exec?: LedgerDb): Promise<LandedCost[]> {
  return reader(exec)
    .select()
    .from(landedCosts)
    .where(eq(landedCosts.productionRunId, runId))
    .orderBy(asc(landedCosts.createdAt));
}

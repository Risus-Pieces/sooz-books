/**
 * The monthly COGS batch.
 *
 * Units shipped in a month (from the Peasy shipments import, per SKU × channel)
 * are valued at the product's weighted-average cost for the month and relieved
 * from Finished Goods in one entry:
 *
 *   Dr 5010 / 5015 / 5020 / 5030 / 5040   by cost component, per SKU × channel
 *   Cr 1310 Finished Goods                 per SKU × channel
 *
 * every line carrying the product and channel dimensions, so gross margin by
 * SKU and channel reads straight off the ledger.
 *
 * Weighted average, read off the ledger
 * -------------------------------------
 * Each costed production run capitalizes its own units into 1310 at its own
 * struck cost. Relieving every unit at the latest run's cost would neither match
 * what was capitalized nor any costing method: two runs at $1.00 and $1.50 would
 * relieve $300 against $250 and leave 1310 at -$50. So a month is valued from the
 * product's pool as of month end:
 *
 *   pool value  V = the product's 1310 balance (posted, dated by month end) —
 *                   every run capitalized, every earlier batch relieved, every
 *                   finished-goods adjustment
 *   pool units  U = good units of the runs costed by month end
 *                   − net units of earlier posted COGS batches
 *                   ± finished-goods adjustment quantities
 *
 * and the month's net units N relieve `N × V / U`, rounded once per product —
 * exactly V when the month ships the whole pool, so 1310 empties to the cent.
 * The product's total is spread over its SKU × channel lines by units with
 * `allocateCents`. A product with no costed pool yet (a standard cost set before
 * the first run) falls back to `product_cost_at(product, month end)`.
 *
 * A line's component split is its COGS spread by `allocateCents` in proportion
 * to the pool's components — each costed run's per-unit breakdown weighted by its
 * good units. Where there is no breakdown the whole line goes to 5010.
 *
 * Net units are shipped less returned. A month with more returns than shipments
 * of a SKU produces a negative line, which posts the other way round (Dr 1310,
 * Cr COGS) — the return goes back on the shelf at the same cost.
 *
 * The life of a batch: draft (recomputable, replaced on every redraft) → posted
 * (at most one per month, enforced by a unique index) → reversed.
 */

import { and, asc, eq, sql as sqlTag } from 'drizzle-orm';

import {
  channels,
  cogsBatchLines,
  cogsBatches,
  products,
  shipmentUnits,
  type CogsBatch,
  type CostBreakdown,
} from '@/db/schema';
import { type CalendarDate, daysInMonth } from '@/lib/dates';
import { isUniqueViolation } from '@/lib/db-errors';
import { ACCOUNTS } from '@/lib/ledger/coa';
import { type DraftEntry, type LedgerDb, postJournalEntry } from '@/lib/ledger/post';
import { reverseEntry } from '@/lib/ledger/reverse';
import { allocateCents } from '@/lib/money';

import { COMPONENT_COGS_ACCOUNT, UNSPLIT_COGS_ACCOUNT, breakdownEntries } from './accounts';
import { inTx, reader, type InventoryCtx } from './context';
import { InventoryError } from './errors';
import { toDraftLines, type SignedLine } from './lines';
import { extendCost, formatQuantity, quantityFromDb, quantityToDb, roundDiv, unitCostOf } from './quantity';

export interface Period {
  year: number;
  month: number;
}

function assertPeriod({ year, month }: Period): void {
  if (!Number.isInteger(year) || year < 2000 || year > 2999 || !Number.isInteger(month) || month < 1 || month > 12) {
    throw new InventoryError('invalid_input', `${year}-${month} is not a valid period.`);
  }
}

export function periodEndDate({ year, month }: Period): CalendarDate {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(daysInMonth(year, month)).padStart(2, '0')}`;
}

function periodLabel({ year, month }: Period): string {
  return `${year}-${String(month).padStart(2, '0')}`;
}

/** Splits a line's COGS over its per-unit breakdown; the parts sum to `cogsCents`. */
export function splitByComponent(cogsCents: number, unitBreakdown: CostBreakdown): CostBreakdown {
  const entries = breakdownEntries(unitBreakdown).filter(([, cents]) => cents > 0);
  if (entries.length === 0 || cogsCents === 0) return {};
  const parts = allocateCents(
    cogsCents,
    entries.map(([, cents]) => cents),
  );
  const out: CostBreakdown = {};
  entries.forEach(([component], i) => {
    if (parts[i] !== 0) out[component] = parts[i];
  });
  return out;
}

export interface CogsLinePlan {
  productId: string;
  sku: string;
  channelId: string | null;
  channelCode: string | null;
  /** Hundredths of a unit, net of returns. */
  units: number;
  unitCostCents: number;
  cogsCents: number;
  /** Line cents by component; sums to `cogsCents` when non-empty. */
  breakdown: CostBreakdown;
}

/** The journal lines for a batch's lines. Pure; exported so tests can inspect the shape. */
export function cogsEntryLines(lines: readonly CogsLinePlan[]): SignedLine[] {
  const signed: SignedLine[] = [];
  for (const line of lines) {
    const dims = { productId: line.productId, channelId: line.channelId };
    const label = `${line.sku}${line.channelCode ? ` · ${line.channelCode}` : ''}`;
    const parts = breakdownEntries(line.breakdown);
    if (parts.length === 0) {
      signed.push({ accountCode: UNSPLIT_COGS_ACCOUNT, cents: line.cogsCents, memo: `COGS ${label}`, ...dims });
    } else {
      for (const [component, cents] of parts) {
        signed.push({
          accountCode: COMPONENT_COGS_ACCOUNT[component],
          cents,
          memo: `COGS ${label}`,
          ...dims,
        });
      }
    }
    signed.push({
      accountCode: ACCOUNTS.INVENTORY_FINISHED,
      cents: -line.cogsCents,
      memo: `Relieve ${formatQuantity(line.units)} × ${label}`,
      ...dims,
    });
  }
  return signed;
}

async function postedBatchFor(tx: LedgerDb, period: Period): Promise<CogsBatch | undefined> {
  const [row] = await tx
    .select()
    .from(cogsBatches)
    .where(
      and(
        eq(cogsBatches.periodYear, period.year),
        eq(cogsBatches.periodMonth, period.month),
        eq(cogsBatches.status, 'posted'),
      ),
    );
  return row;
}

interface CostRow extends Record<string, unknown> {
  unit_cost_cents: string | number | null;
  breakdown: CostBreakdown | null;
}

interface PoolRow extends Record<string, unknown> {
  value_cents: string | number;
  run_units: string | number;
  relieved_units: string | number;
  adjusted_units: string | number;
}

interface LayerRow extends Record<string, unknown> {
  breakdown: CostBreakdown | null;
  good_units: string | number;
}

/** A product's Finished Goods pool as of a date: what it is carried at, and how many units that is. */
export interface CostPool {
  valueCents: number;
  /** Hundredths of a unit. */
  units: number;
  /** Component weights across the pool's costed runs; sums to nothing in particular. */
  componentWeights: CostBreakdown;
}

/**
 * The product's pool on 1310 at `asOf`, excluding the COGS of `period` itself
 * (only earlier batches have relieved it). Read-only.
 */
export async function costPoolAt(
  productId: string,
  asOf: CalendarDate,
  period: Period,
  exec?: LedgerDb,
): Promise<CostPool> {
  const x = reader(exec);
  const periodKey = period.year * 12 + period.month;
  const [pool] = [
    ...(await x.execute<PoolRow>(sqlTag`
      select
        (select coalesce(sum(jl.debit_cents - jl.credit_cents), 0)
           from journal_lines jl
           join journal_entries je on je.id = jl.entry_id
           join accounts a on a.id = jl.account_id
          where a.code = ${ACCOUNTS.INVENTORY_FINISHED}
            and jl.product_id = ${productId}::uuid
            and je.status = 'posted'
            and je.entry_date <= ${asOf}::date)::text as value_cents,
        (select coalesce(sum(pr.units_produced - pr.units_rejected), 0)
           from production_runs pr
           join product_costs pc on pc.production_run_id = pr.id
          where pr.product_id = ${productId}::uuid
            and pr.status in ('costed', 'closed')
            and pc.effective_date <= ${asOf}::date)::text as run_units,
        (select coalesce(sum(cbl.units), 0)
           from cogs_batch_lines cbl
           join cogs_batches cb on cb.id = cbl.batch_id
          where cbl.product_id = ${productId}::uuid
            and cb.status = 'posted'
            and cb.period_year * 12 + cb.period_month < ${periodKey})::text as relieved_units,
        (select coalesce(sum(ia.quantity), 0)
           from inventory_adjustments ia
           join journal_entries je on je.id = ia.journal_entry_id
          where ia.product_id = ${productId}::uuid
            and ia.stage = 'finished'
            and ia.adjustment_date <= ${asOf}::date
            and je.status = 'posted'
            and not exists (select 1 from journal_entries rv where rv.reverses_id = je.id))::text as adjusted_units`)),
  ];
  const layers = await x.execute<LayerRow>(sqlTag`
    select pc.breakdown, (pr.units_produced - pr.units_rejected)::text as good_units
      from product_costs pc
      join production_runs pr on pr.id = pc.production_run_id
     where pc.product_id = ${productId}::uuid
       and pr.status in ('costed', 'closed')
       and pc.effective_date <= ${asOf}::date`);
  const componentWeights: CostBreakdown = {};
  for (const layer of layers) {
    const good = quantityFromDb(layer.good_units);
    for (const [component, cents] of breakdownEntries(layer.breakdown ?? {})) {
      componentWeights[component] = (componentWeights[component] ?? 0) + cents * good;
    }
  }
  return {
    valueCents: Number(pool.value_cents),
    units:
      quantityFromDb(pool.run_units) - quantityFromDb(pool.relieved_units) + quantityFromDb(pool.adjusted_units),
    componentWeights,
  };
}

/**
 * Cents to relieve for `units` out of a pool of `poolUnits` carried at `poolValueCents`:
 * `units × value / pool units`, rounded once, half away from zero. Relieving the whole
 * pool returns the whole value. Pure.
 */
export function averageRelief(units: number, poolValueCents: number, poolUnits: number): number {
  if (poolUnits <= 0) throw new InventoryError('invalid_input', 'An average needs units on hand.');
  if (units === poolUnits) return poolValueCents;
  const cents = Number(roundDiv(BigInt(units) * BigInt(poolValueCents), BigInt(poolUnits)));
  if (!Number.isSafeInteger(cents)) throw new InventoryError('invalid_input', 'The relief is out of range.');
  return cents === 0 ? 0 : cents;
}

/** Spreads a product's relief over its lines by units; exact to the cent. Pure. */
export function spreadRelief(totalCents: number, lineUnits: readonly number[], poolValueCents: number, poolUnits: number): number[] {
  if (lineUnits.every((units) => units >= 0)) return allocateCents(totalCents, lineUnits);
  // Returns net against shipments on other lines: value each line on its own.
  return lineUnits.map((units) => averageRelief(units, poolValueCents, poolUnits));
}

interface ShippedRow {
  productId: string;
  sku: string;
  channelId: string | null;
  channelCode: string | null;
  units: number;
}

/**
 * Plans the batch for a month without writing: every SKU × channel shipped, its
 * cost, its split. Throws `missing_cost` naming every SKU with no costed pool and
 * no unit cost at month end, so the whole list can be fixed at once.
 */
export async function planCogs(period: Period, exec?: LedgerDb): Promise<CogsLinePlan[]> {
  assertPeriod(period);
  const x = reader(exec);
  const costDate = periodEndDate(period);

  const shipped = await x
    .select({
      productId: shipmentUnits.productId,
      sku: products.sku,
      channelId: shipmentUnits.channelId,
      channelCode: channels.code,
      units: sqlTag<string>`sum(${shipmentUnits.units} - ${shipmentUnits.returnsUnits})`,
    })
    .from(shipmentUnits)
    .innerJoin(products, eq(products.id, shipmentUnits.productId))
    .leftJoin(channels, eq(channels.id, shipmentUnits.channelId))
    .where(and(eq(shipmentUnits.periodYear, period.year), eq(shipmentUnits.periodMonth, period.month)))
    .groupBy(shipmentUnits.productId, products.sku, shipmentUnits.channelId, channels.code)
    .orderBy(asc(products.sku), asc(channels.code));

  const byProduct = new Map<string, ShippedRow[]>();
  for (const row of shipped) {
    const units = quantityFromDb(row.units);
    if (units === 0) continue;
    const list = byProduct.get(row.productId) ?? [];
    list.push({ ...row, units });
    byProduct.set(row.productId, list);
  }

  const plans: CogsLinePlan[] = [];
  const missing: string[] = [];
  for (const [productId, lines] of byProduct) {
    const pool = await costPoolAt(productId, costDate, period, x);
    if (pool.units > 0 && pool.valueCents >= 0) {
      const netUnits = lines.reduce((sum, line) => sum + line.units, 0);
      const total = averageRelief(netUnits, pool.valueCents, pool.units);
      const parts = spreadRelief(
        total,
        lines.map((line) => line.units),
        pool.valueCents,
        pool.units,
      );
      const unitCostCents = unitCostOf(pool.valueCents, pool.units);
      lines.forEach((line, i) => {
        plans.push({
          productId,
          sku: line.sku,
          channelId: line.channelId,
          channelCode: line.channelCode,
          units: line.units,
          unitCostCents,
          cogsCents: parts[i],
          breakdown: splitByComponent(parts[i], pool.componentWeights),
        });
      });
      continue;
    }

    // Nothing costed on hand yet: a standard cost, if one is set.
    const costs = await x.execute<CostRow>(
      sqlTag`select unit_cost_cents, breakdown from product_cost_at(${productId}::uuid, ${costDate}::date)`,
    );
    const cost = [...costs][0];
    if (cost === undefined || cost.unit_cost_cents === null) {
      missing.push(lines[0].sku);
      continue;
    }
    const unitCostCents = Number(cost.unit_cost_cents);
    for (const line of lines) {
      const cogsCents = extendCost(line.units, unitCostCents);
      plans.push({
        productId,
        sku: line.sku,
        channelId: line.channelId,
        channelCode: line.channelCode,
        units: line.units,
        unitCostCents,
        cogsCents,
        breakdown: splitByComponent(cogsCents, cost.breakdown ?? {}),
      });
    }
  }

  if (missing.length > 0) {
    throw new InventoryError(
      'missing_cost',
      `No unit cost effective by ${costDate} for ${[...new Set(missing)].join(', ')}. Cost a production run or set a standard cost first.`,
      [...new Set(missing)],
    );
  }
  // Products and their lines arrive in the query's SKU × channel order, and keep it.
  return plans;
}

export interface CogsBatchDetail {
  batch: CogsBatch;
  lines: CogsLinePlan[];
}

/**
 * Drafts the month's batch, replacing any earlier draft for the same month.
 * Refused when the month already has a posted batch.
 */
export async function draftCogsBatch(period: Period, ctx: InventoryCtx): Promise<CogsBatchDetail> {
  assertPeriod(period);
  return inTx(ctx, async (tx) => {
    if (await postedBatchFor(tx, period)) {
      throw new InventoryError(
        'duplicate',
        `COGS for ${periodLabel(period)} is already posted. Reverse it before drafting again.`,
      );
    }
    const plans = await planCogs(period, tx);
    if (plans.length === 0) {
      throw new InventoryError(
        'invalid_input',
        `No shipped units are recorded for ${periodLabel(period)}. Import the Peasy shipments for the month first.`,
      );
    }

    await tx
      .delete(cogsBatches)
      .where(
        and(
          eq(cogsBatches.periodYear, period.year),
          eq(cogsBatches.periodMonth, period.month),
          eq(cogsBatches.status, 'draft'),
        ),
      );

    const [batch] = await tx
      .insert(cogsBatches)
      .values({
        periodYear: period.year,
        periodMonth: period.month,
        status: 'draft',
        totalUnits: quantityToDb(plans.reduce((s, p) => s + p.units, 0)),
        totalCogsCents: plans.reduce((s, p) => s + p.cogsCents, 0),
        createdBy: ctx.userId,
      })
      .returning();

    await tx.insert(cogsBatchLines).values(
      plans.map((p) => ({
        batchId: batch.id,
        productId: p.productId,
        channelId: p.channelId,
        units: quantityToDb(p.units),
        unitCostCents: p.unitCostCents,
        cogsCents: p.cogsCents,
        breakdown: p.breakdown,
      })),
    );
    return { batch, lines: plans };
  });
}

export async function getCogsBatch(batchId: string, exec?: LedgerDb): Promise<CogsBatchDetail> {
  const x = reader(exec);
  const [batch] = await x.select().from(cogsBatches).where(eq(cogsBatches.id, batchId));
  if (!batch) throw new InventoryError('not_found', `COGS batch ${batchId} does not exist.`);
  const rows = await x
    .select({
      productId: cogsBatchLines.productId,
      sku: products.sku,
      channelId: cogsBatchLines.channelId,
      channelCode: channels.code,
      units: cogsBatchLines.units,
      unitCostCents: cogsBatchLines.unitCostCents,
      cogsCents: cogsBatchLines.cogsCents,
      breakdown: cogsBatchLines.breakdown,
    })
    .from(cogsBatchLines)
    .innerJoin(products, eq(products.id, cogsBatchLines.productId))
    .leftJoin(channels, eq(channels.id, cogsBatchLines.channelId))
    .where(eq(cogsBatchLines.batchId, batchId))
    .orderBy(asc(products.sku), asc(channels.code));
  return {
    batch,
    lines: rows.map((r) => ({ ...r, units: quantityFromDb(r.units) })),
  };
}

/** The entry a draft batch would post, for review before posting. */
export async function previewCogsEntry(batchId: string, exec?: LedgerDb): Promise<DraftEntry> {
  const { batch, lines } = await getCogsBatch(batchId, exec);
  const period = { year: batch.periodYear, month: batch.periodMonth };
  return {
    date: periodEndDate(period),
    memo: `COGS ${periodLabel(period)}`,
    sourceType: 'cogs',
    sourceId: batch.id,
    lines: toDraftLines(cogsEntryLines(lines)),
  };
}

export async function postCogsBatch(
  batchId: string,
  ctx: InventoryCtx,
): Promise<{ batchId: string; entryId: string; entryNo: number }> {
  return inTx(ctx, async (tx) => {
    const [locked] = await tx.select().from(cogsBatches).where(eq(cogsBatches.id, batchId)).for('update');
    if (!locked) throw new InventoryError('not_found', `COGS batch ${batchId} does not exist.`);
    if (locked.status !== 'draft') {
      throw new InventoryError('invalid_state', `COGS batch is ${locked.status}; only a draft can be posted.`);
    }
    const period = { year: locked.periodYear, month: locked.periodMonth };
    if (await postedBatchFor(tx, period)) {
      throw new InventoryError('duplicate', `COGS for ${periodLabel(period)} is already posted.`);
    }
    const entry = await previewCogsEntry(batchId, tx);
    if (entry.lines.length < 2) {
      throw new InventoryError('invalid_input', 'This batch has no cost to post.');
    }
    const posted = await postJournalEntry(entry, { userId: ctx.userId, tx });
    try {
      await tx
        .update(cogsBatches)
        .set({ status: 'posted', journalEntryId: posted.entryId })
        .where(eq(cogsBatches.id, batchId));
    } catch (error) {
      if (isUniqueViolation(error, 'cogs_batch_posted_idx')) {
        throw new InventoryError('duplicate', `COGS for ${periodLabel(period)} is already posted.`);
      }
      throw error;
    }
    return { batchId, entryId: posted.entryId, entryNo: posted.entryNo };
  });
}

export async function reverseCogsBatch(
  batchId: string,
  ctx: InventoryCtx & { date?: CalendarDate; memo?: string },
): Promise<{ batchId: string; reversalEntryId: string }> {
  return inTx(ctx, async (tx) => {
    const [locked] = await tx.select().from(cogsBatches).where(eq(cogsBatches.id, batchId)).for('update');
    if (!locked) throw new InventoryError('not_found', `COGS batch ${batchId} does not exist.`);
    if (locked.status !== 'posted' || locked.journalEntryId === null) {
      throw new InventoryError('invalid_state', `COGS batch is ${locked.status}; only a posted batch can be reversed.`);
    }
    const reversal = await reverseEntry(locked.journalEntryId, {
      userId: ctx.userId,
      tx,
      owner: 'cogs',
      ...(ctx.date === undefined ? {} : { date: ctx.date }),
      memo:
        ctx.memo ??
        `Reverse COGS ${periodLabel({ year: locked.periodYear, month: locked.periodMonth })}`,
    });
    await tx
      .update(cogsBatches)
      .set({ status: 'reversed', reversalEntryId: reversal.entryId })
      .where(eq(cogsBatches.id, batchId));
    return { batchId, reversalEntryId: reversal.entryId };
  });
}

export async function listCogsBatches(exec?: LedgerDb): Promise<CogsBatch[]> {
  return reader(exec)
    .select()
    .from(cogsBatches)
    .orderBy(sqlTag`${cogsBatches.periodYear} desc, ${cogsBatches.periodMonth} desc, ${cogsBatches.createdAt} desc`);
}

/**
 * The reads behind the inventory screens.
 *
 * The inventory library (`@/lib/inventory`) owns every rule about what inventory
 * is worth and how it moves; this file only gathers what a page needs to show,
 * shaped for the components in `@/components/inventory`. Nothing here writes.
 */

import { and, asc, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';

import { db } from '@/db/client';
import {
  accounts,
  billLines,
  bills,
  channels,
  cogsBatches,
  inventoryImports,
  journalEntries,
  landedCosts,
  productCosts,
  productionRuns,
  products,
  shipmentImports,
  shipmentUnits,
  vendors,
  type CostBreakdown,
} from '@/db/schema';
import { today, type CalendarDate } from '@/lib/dates';
import { ACCOUNTS } from '@/lib/ledger/coa';
import type { DraftLine } from '@/lib/ledger/post';
import { COMPONENT_DEFAULT_SOURCE, COMPONENT_ORDER, STAGE_ACCOUNT } from '@/lib/inventory/accounts';
import { getCogsBatch, listCogsBatches, previewCogsEntry } from '@/lib/inventory/cogs';
import { isInventoryError } from '@/lib/inventory/errors';
import { listInventoryAdjustments } from '@/lib/inventory/adjustments';
import { computeRunCost, goodUnitsOf, listProductionRuns, type RunSummary } from '@/lib/inventory/production';
import { quantityFromDb } from '@/lib/inventory/quantity';
import { computeTieout, listTieouts, proposeTieoutAdjustment, type TieoutComputation } from '@/lib/inventory/tieout';
import type {
  ChannelOption,
  CostComponentKey,
  EntryPreviewData,
  PreviewLine,
  ProductOption,
  StageKey,
  VendorOption,
} from '@/components/inventory/types';

/* ------------------------------------------------------------------ shared */

/** `sum(bigint)` widens to numeric, which postgres.js hands back as a string. */
function cents(value: unknown): number {
  if (value === null || value === undefined) return 0;
  const amount = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(amount)) {
    throw new Error(`The books returned an amount that is not whole cents: ${String(value)}`);
  }
  return amount;
}

interface AccountEntry {
  id: string;
  code: string;
  name: string;
}

export interface AccountDirectory {
  byId: Map<string, AccountEntry>;
  byCode: Map<string, AccountEntry>;
}

export async function accountDirectory(): Promise<AccountDirectory> {
  const rows = await db.select({ id: accounts.id, code: accounts.code, name: accounts.name }).from(accounts);
  return {
    byId: new Map(rows.map((r) => [r.id, r])),
    byCode: new Map(rows.map((r) => [r.code, r])),
  };
}

async function skuMap(ids: readonly string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: products.id, sku: products.sku })
    .from(products)
    .where(inArray(products.id, [...new Set(ids)]));
  return new Map(rows.map((r) => [r.id, r.sku]));
}

async function channelCodeMap(): Promise<Map<string, string>> {
  const rows = await db.select({ id: channels.id, code: channels.code }).from(channels);
  return new Map(rows.map((r) => [r.id, r.code]));
}

/** Turns draft lines (by account id or code) into rows a person can read. */
export async function previewLines(lines: readonly DraftLine[], dir?: AccountDirectory): Promise<PreviewLine[]> {
  const directory = dir ?? (await accountDirectory());
  const [skus, channelCodes] = await Promise.all([
    skuMap(lines.flatMap((l) => (l.productId ? [l.productId] : []))),
    channelCodeMap(),
  ]);
  return lines.map((line) => {
    const account =
      (line.accountId ? directory.byId.get(line.accountId) : undefined) ??
      (line.accountCode ? directory.byCode.get(line.accountCode) : undefined);
    return {
      accountCode: account?.code ?? line.accountCode ?? '—',
      accountName: account?.name ?? 'Unknown account',
      debitCents: line.debitCents ?? 0,
      creditCents: line.creditCents ?? 0,
      memo: line.memo ?? null,
      sku: line.productId ? (skus.get(line.productId) ?? null) : null,
      channelCode: line.channelId ? (channelCodes.get(line.channelId) ?? null) : null,
    };
  });
}

/** Posted balances of the inventory accounts on a date. */
export async function inventoryBalances(asOf: CalendarDate): Promise<Map<string, number>> {
  const codes = [
    ACCOUNTS.INVENTORY_FINISHED,
    ACCOUNTS.INVENTORY_INGREDIENTS,
    ACCOUNTS.INVENTORY_PACKAGING,
    ACCOUNTS.INVENTORY_IN_TRANSIT,
    ACCOUNTS.INVENTORY_RESERVE,
  ];
  const rows = await db.execute<{ code: string; balance: string | number }>(sql`
    select a.code as code, coalesce(sum(l.debit_cents - l.credit_cents), 0) as balance
      from accounts a
      left join journal_lines l on l.account_id = a.id
      left join journal_entries e on e.id = l.entry_id
     where a.code in (${sql.join(codes.map((c) => sql`${c}`), sql`, `)})
       and (l.id is null or (e.status = 'posted' and e.entry_date <= ${asOf}))
     group by a.code
  `);
  return new Map([...rows].map((r) => [String(r.code), cents(r.balance)]));
}

export async function productOptions(asOf: CalendarDate = today()): Promise<ProductOption[]> {
  const rows = await db.execute<{
    id: string;
    sku: string;
    name: string;
    unit: string;
    cost: string | number | null;
  }>(sql`
    select p.id, p.sku, p.name, p.unit, unit_cost_at(p.id, ${asOf}::date) as cost
      from products p
     where p.active
     order by p.sku
  `);
  return [...rows].map((r) => ({
    id: r.id,
    sku: r.sku,
    name: r.name,
    unit: r.unit,
    unitCostCents: r.cost === null ? null : cents(r.cost),
  }));
}

export async function vendorOptions(): Promise<VendorOption[]> {
  const rows = await db
    .select({ id: vendors.id, name: vendors.name, type: vendors.vendorType })
    .from(vendors)
    .where(eq(vendors.active, true))
    .orderBy(asc(vendors.name));
  return rows
    .map((r) => ({ id: r.id, name: r.name, isCoMan: r.type === 'co_manufacturer' }))
    .sort((a, b) => Number(b.isCoMan) - Number(a.isCoMan) || a.name.localeCompare(b.name));
}

export async function channelOptions(): Promise<ChannelOption[]> {
  return db
    .select({ id: channels.id, code: channels.code, name: channels.name })
    .from(channels)
    .where(eq(channels.active, true))
    .orderBy(asc(channels.sortOrder));
}

async function entryNos(ids: readonly (string | null)[]): Promise<Map<string, number>> {
  const present = [...new Set(ids.filter((id): id is string => id !== null))];
  if (present.length === 0) return new Map();
  const rows = await db
    .select({ id: journalEntries.id, entryNo: journalEntries.entryNo })
    .from(journalEntries)
    .where(inArray(journalEntries.id, present));
  return new Map(rows.map((r) => [r.id, r.entryNo]));
}

export interface EntryRef {
  id: string;
  entryNo: number;
}

function ref(id: string | null, nos: Map<string, number>): EntryRef | null {
  if (id === null) return null;
  const entryNo = nos.get(id);
  return entryNo === undefined ? null : { id, entryNo };
}

/* ---------------------------------------------------------------- overview */

export interface StageRow {
  stage: 'raw' | 'packaging' | 'finished' | 'in_transit';
  label: string;
  accountCode: string;
  accountName: string;
  ledgerCents: number;
  /** Null when there is no snapshot to compare. */
  snapshotCents: number | null;
  /** Peasy less ledger, both on the snapshot date. */
  varianceCents: number | null;
}

export interface BankQueueInventory {
  count: number;
  byAccount: Array<{ code: string; name: string; cents: number; count: number }>;
  totalCents: number;
}

export interface OverviewData {
  asOf: CalendarDate;
  stages: StageRow[];
  reserveCents: number;
  snapshot: { date: CalendarDate; varianceCents: number; snapshotCents: number; ledgerCents: number } | null;
  bankQueue: BankQueueInventory;
  runs: { open: number; costed: number; latest: RunSummary | null };
  cogs: { lastPosted: { year: number; month: number; cogsCents: number } | null; drafts: number };
  shipmentsMonths: number;
  adjustments: number;
  productCount: number;
}

const OVERVIEW_STAGES: ReadonlyArray<{ stage: StageRow['stage']; label: string }> = [
  { stage: 'raw', label: 'Raw ingredients' },
  { stage: 'packaging', label: 'Packaging' },
  { stage: 'finished', label: 'Finished goods' },
  { stage: 'in_transit', label: 'In transit' },
];

async function latestTieout(asOf: CalendarDate): Promise<TieoutComputation | null> {
  try {
    return await computeTieout(asOf);
  } catch (error) {
    if (isInventoryError(error) && error.code === 'not_found') return null;
    throw error;
  }
}

/**
 * Money the bank queue will capitalise into inventory once someone approves it:
 * unposted bank lines whose suggestion is an inventory account.
 */
export async function bankQueueInventory(): Promise<BankQueueInventory> {
  const codes = [
    ACCOUNTS.INVENTORY_FINISHED,
    ACCOUNTS.INVENTORY_INGREDIENTS,
    ACCOUNTS.INVENTORY_PACKAGING,
    ACCOUNTS.INVENTORY_IN_TRANSIT,
  ];
  const rows = await db.execute<{ code: string; name: string; total: string | number; n: string | number }>(sql`
    select a.code, a.name, coalesce(sum(-t.amount_cents), 0) as total, count(*) as n
      from bank_transactions t
      join accounts a on a.id = t.suggested_account_id
     where t.journal_entry_id is null
       and t.status in ('unreviewed', 'categorized')
       and a.code in (${sql.join(codes.map((c) => sql`${c}`), sql`, `)})
     group by a.code, a.name
     order by a.code
  `);
  const byAccount = [...rows].map((r) => ({
    code: String(r.code),
    name: String(r.name),
    cents: cents(r.total),
    count: Number(r.n),
  }));
  return {
    count: byAccount.reduce((s, r) => s + r.count, 0),
    byAccount,
    totalCents: byAccount.reduce((s, r) => s + r.cents, 0),
  };
}

export async function overviewData(): Promise<OverviewData> {
  const asOf = today();
  const [balances, tieout, dir, queue, runs, batches, shipmentMonths, adjustments, productCount] =
    await Promise.all([
      inventoryBalances(asOf),
      latestTieout(asOf),
      accountDirectory(),
      bankQueueInventory(),
      listProductionRuns(),
      listCogsBatches(),
      db
        .selectDistinct({ y: shipmentUnits.periodYear, m: shipmentUnits.periodMonth })
        .from(shipmentUnits),
      listInventoryAdjustments(),
      db.select({ n: sql<string>`count(*)` }).from(products),
    ]);

  const stages: StageRow[] = OVERVIEW_STAGES.map(({ stage, label }) => {
    const code = STAGE_ACCOUNT[stage];
    const detail = tieout?.byStage.find((d) => d.accountCode === code);
    return {
      stage,
      label,
      accountCode: code,
      accountName: dir.byCode.get(code)?.name ?? label,
      ledgerCents: balances.get(code) ?? 0,
      snapshotCents: detail ? detail.snapshotValueCents : null,
      varianceCents: detail ? detail.varianceCents : null,
    };
  }).filter((row) => row.stage !== 'in_transit' || row.ledgerCents !== 0 || (row.snapshotCents ?? 0) !== 0);

  const lastPosted = batches.find((b) => b.status === 'posted');
  return {
    asOf,
    stages,
    reserveCents: balances.get(ACCOUNTS.INVENTORY_RESERVE) ?? 0,
    snapshot: tieout
      ? {
          date: tieout.snapshotDate,
          varianceCents: tieout.varianceCents,
          snapshotCents: tieout.snapshotValueCents,
          ledgerCents: tieout.ledgerValueCents,
        }
      : null,
    bankQueue: queue,
    runs: {
      open: runs.filter((r) => r.status === 'open').length,
      costed: runs.filter((r) => r.status !== 'open').length,
      latest: runs[0] ?? null,
    },
    cogs: {
      lastPosted: lastPosted
        ? { year: lastPosted.periodYear, month: lastPosted.periodMonth, cogsCents: lastPosted.totalCogsCents }
        : null,
      drafts: batches.filter((b) => b.status === 'draft').length,
    },
    shipmentsMonths: shipmentMonths.length,
    adjustments: adjustments.length,
    productCount: Number(productCount[0]?.n ?? 0),
  };
}

/* -------------------------------------------------------------- production */

export interface RunListRow extends RunSummary {
  coManName: string | null;
}

export async function productionRunRows(): Promise<RunListRow[]> {
  const [runs, coMen] = await Promise.all([
    listProductionRuns(),
    db
      .select({ id: productionRuns.id, name: vendors.name })
      .from(productionRuns)
      .innerJoin(vendors, eq(vendors.id, productionRuns.coManVendorId)),
  ]);
  const names = new Map(coMen.map((r) => [r.id, r.name]));
  return runs.map((r) => ({ ...r, coManName: names.get(r.id) ?? null }));
}

export interface LandedCostRow {
  id: string;
  component: CostComponentKey;
  description: string | null;
  amountCents: number;
  basis: string | null;
  sourceCode: string;
  sourceName: string;
  billNo: string | null;
  billVendor: string | null;
}

export interface CostingPreview {
  totalCents: number;
  goodUnits: number;
  unitCostCents: number;
  finishedGoodsValueCents: number;
  roundingVarianceCents: number;
  /** Per-unit cents by component, and each component's total over the run. */
  components: Array<{ component: CostComponentKey; perUnitCents: number; totalCents: number }>;
  entry: EntryPreviewData;
}

export interface RunDetail {
  id: string;
  runNo: string;
  status: 'open' | 'costed' | 'closed';
  runDate: CalendarDate;
  product: { id: string; sku: string; name: string; unit: string };
  coManName: string | null;
  lotCode: string | null;
  notes: string | null;
  unitsPlanned: number | null;
  unitsProduced: number;
  unitsRejected: number;
  goodUnits: number;
  totalCostCents: number;
  unitCostCents: number | null;
  roundingVarianceCents: number;
  costEntry: EntryRef | null;
  costedBreakdown: Array<{ component: CostComponentKey; perUnitCents: number }>;
  costDate: CalendarDate | null;
  landedCosts: LandedCostRow[];
  /** What costing would do now, or why it cannot. */
  preview: CostingPreview | null;
  previewBlocker: string | null;
}

/**
 * The reclassification `costRun` will post, laid out before it happens. It
 * follows the same arithmetic (`computeRunCost`) and the same sourcing rule
 * (the bill line's own account, else `COMPONENT_DEFAULT_SOURCE`); costing itself
 * recomputes everything inside its transaction, so this is a view, never a plan
 * that gets posted.
 */
function costingPreview(
  run: { runNo: string; runDate: CalendarDate; productId: string },
  costs: ReadonlyArray<{ component: CostComponentKey; amountCents: number; sourceId: string | null }>,
  good: number,
  dir: AccountDirectory,
): { preview: CostingPreview | null; blocker: string | null } {
  if (costs.length === 0) {
    return { preview: null, blocker: 'Attach the run’s costs — a bill line or materials from stock — to see its unit cost.' };
  }
  if (good <= 0) {
    return { preview: null, blocker: 'Record the units the co-packer produced to strike a unit cost.' };
  }
  let math;
  try {
    math = computeRunCost(costs, good);
  } catch (error) {
    if (isInventoryError(error)) return { preview: null, blocker: error.message };
    throw error;
  }

  const fg = dir.byCode.get(ACCOUNTS.INVENTORY_FINISHED);
  const variance = dir.byCode.get(ACCOUNTS.COGS_COMAN_VARIANCE);
  const memo = `Cost run ${run.runNo}`;
  const credits = new Map<string, number>();
  const creditParts = new Map<string, Set<string>>();
  let alreadyInFg = 0;
  for (const cost of costs) {
    const sourceId = cost.sourceId ?? dir.byCode.get(COMPONENT_DEFAULT_SOURCE[cost.component])?.id ?? null;
    if (sourceId !== null && sourceId === fg?.id) {
      alreadyInFg += cost.amountCents;
      continue;
    }
    const key = sourceId ?? `code:${COMPONENT_DEFAULT_SOURCE[cost.component]}`;
    credits.set(key, (credits.get(key) ?? 0) + cost.amountCents);
    creditParts.set(key, (creditParts.get(key) ?? new Set()).add(cost.component.replace('_', ' ')));
  }
  const lines: PreviewLine[] = [];
  const fgDebit = math.finishedGoodsValueCents - alreadyInFg;
  if (fgDebit !== 0) {
    lines.push({
      accountCode: fg?.code ?? ACCOUNTS.INVENTORY_FINISHED,
      accountName: fg?.name ?? 'Finished Goods',
      debitCents: Math.max(fgDebit, 0),
      creditCents: Math.max(-fgDebit, 0),
      memo: 'Good units at the struck unit cost',
      sku: null,
      channelCode: null,
    });
  }
  for (const [key, amount] of credits) {
    const account = key.startsWith('code:') ? dir.byCode.get(key.slice(5)) : dir.byId.get(key);
    lines.push({
      accountCode: account?.code ?? key.replace('code:', ''),
      accountName: account?.name ?? 'Unknown account',
      debitCents: 0,
      creditCents: amount,
      memo: `Relieve ${[...(creditParts.get(key) ?? [])].join(', ')}`,
      sku: null,
      channelCode: null,
    });
  }
  if (math.roundingVarianceCents !== 0) {
    lines.push({
      accountCode: variance?.code ?? ACCOUNTS.COGS_COMAN_VARIANCE,
      accountName: variance?.name ?? 'Co-Man Variance',
      debitCents: Math.max(math.roundingVarianceCents, 0),
      creditCents: Math.max(-math.roundingVarianceCents, 0),
      memo: 'Unit cost rounding',
      sku: null,
      channelCode: null,
    });
  }

  return {
    blocker: null,
    preview: {
      totalCents: math.totalCents,
      goodUnits: math.goodUnits,
      unitCostCents: math.unitCostCents,
      finishedGoodsValueCents: math.finishedGoodsValueCents,
      roundingVarianceCents: math.roundingVarianceCents,
      components: COMPONENT_ORDER.filter((c) => (math.componentTotals[c] ?? 0) > 0).map((c) => ({
        component: c,
        perUnitCents: math.breakdown[c] ?? 0,
        totalCents: math.componentTotals[c] ?? 0,
      })),
      entry: { date: run.runDate, memo, lines },
    },
  };
}

function breakdownRows(breakdown: CostBreakdown | null): Array<{ component: CostComponentKey; perUnitCents: number }> {
  if (!breakdown) return [];
  return COMPONENT_ORDER.filter((c) => (breakdown[c] ?? 0) !== 0).map((c) => ({
    component: c,
    perUnitCents: breakdown[c] ?? 0,
  }));
}

export async function runDetail(runId: string): Promise<RunDetail | null> {
  const [row] = await db
    .select({
      run: productionRuns,
      sku: products.sku,
      productName: products.name,
      unit: products.unit,
      coManName: vendors.name,
    })
    .from(productionRuns)
    .innerJoin(products, eq(products.id, productionRuns.productId))
    .leftJoin(vendors, eq(vendors.id, productionRuns.coManVendorId))
    .where(eq(productionRuns.id, runId));
  if (!row) return null;
  const run = row.run;

  const [costs, dir, pc] = await Promise.all([
    db
      .select({
        id: landedCosts.id,
        component: landedCosts.component,
        description: landedCosts.description,
        amountCents: landedCosts.amountCents,
        basis: landedCosts.allocationBasis,
        sourceId: landedCosts.sourceAccountId,
        billNo: bills.billNo,
        billVendor: vendors.name,
      })
      .from(landedCosts)
      .leftJoin(bills, eq(bills.id, landedCosts.billId))
      .leftJoin(vendors, eq(vendors.id, bills.vendorId))
      .where(eq(landedCosts.productionRunId, run.id))
      .orderBy(asc(landedCosts.createdAt)),
    accountDirectory(),
    db
      .select({ breakdown: productCosts.breakdown, effectiveDate: productCosts.effectiveDate })
      .from(productCosts)
      .where(eq(productCosts.productionRunId, run.id)),
  ]);
  const nos = await entryNos([run.costEntryId]);
  const good = goodUnitsOf(run);

  const landed: LandedCostRow[] = costs.map((c) => {
    const source =
      (c.sourceId ? dir.byId.get(c.sourceId) : undefined) ??
      dir.byCode.get(COMPONENT_DEFAULT_SOURCE[c.component]);
    return {
      id: c.id,
      component: c.component,
      description: c.description,
      amountCents: c.amountCents,
      basis: c.basis,
      sourceCode: source?.code ?? '—',
      sourceName: source?.name ?? 'Unknown account',
      billNo: c.billNo,
      billVendor: c.billVendor,
    };
  });

  const { preview, blocker } =
    run.status === 'open'
      ? costingPreview(
          { runNo: run.runNo, runDate: run.runDate, productId: run.productId },
          costs.map((c) => ({ component: c.component, amountCents: c.amountCents, sourceId: c.sourceId })),
          good,
          dir,
        )
      : { preview: null, blocker: null };

  return {
    id: run.id,
    runNo: run.runNo,
    status: run.status,
    runDate: run.runDate,
    product: { id: run.productId, sku: row.sku, name: row.productName, unit: row.unit },
    coManName: row.coManName,
    lotCode: run.lotCode,
    notes: run.notes,
    unitsPlanned: run.unitsPlanned === null ? null : quantityFromDb(run.unitsPlanned),
    unitsProduced: quantityFromDb(run.unitsProduced),
    unitsRejected: quantityFromDb(run.unitsRejected),
    goodUnits: good,
    totalCostCents: run.totalCostCents,
    unitCostCents: run.unitCostCents,
    roundingVarianceCents: run.roundingVarianceCents,
    costEntry: ref(run.costEntryId, nos),
    costedBreakdown: breakdownRows(pc[0]?.breakdown ?? null),
    costDate: pc[0]?.effectiveDate ?? null,
    landedCosts: landed,
    preview,
    previewBlocker: blocker,
  };
}

export interface OpenBillLine {
  id: string;
  billNo: string;
  billDate: CalendarDate;
  vendorName: string;
  description: string;
  accountCode: string;
  accountName: string;
  amountCents: number;
  remainingCents: number;
}

/** Lines of posted bills with something left to allocate to a run. */
export async function openBillLines(): Promise<OpenBillLine[]> {
  const rows = await db
    .select({
      id: billLines.id,
      billNo: bills.billNo,
      billDate: bills.billDate,
      vendorName: vendors.name,
      description: billLines.description,
      accountCode: accounts.code,
      accountName: accounts.name,
      amountCents: billLines.amountCents,
      allocated: sql<string>`(select coalesce(sum(lc.amount_cents), 0) from landed_costs lc where lc.bill_line_id = ${billLines.id})`,
    })
    .from(billLines)
    .innerJoin(bills, eq(bills.id, billLines.billId))
    .innerJoin(vendors, eq(vendors.id, bills.vendorId))
    .innerJoin(accounts, eq(accounts.id, billLines.accountId))
    .where(and(isNotNull(bills.journalEntryId), inArray(bills.status, ['open', 'partial', 'paid'])))
    .orderBy(desc(bills.billDate), asc(bills.billNo), asc(billLines.lineNo));
  return rows
    .map((r) => ({
      id: r.id,
      billNo: r.billNo,
      billDate: r.billDate,
      vendorName: r.vendorName,
      description: r.description,
      accountCode: r.accountCode,
      accountName: r.accountName,
      amountCents: r.amountCents,
      remainingCents: r.amountCents - cents(r.allocated),
    }))
    .filter((r) => r.remainingCents > 0);
}

export interface OpenRunOption {
  id: string;
  runNo: string;
  sku: string;
  /** Hundredths: good units, else planned units — the `units` allocation weight. */
  unitsWeight: number;
}

export async function openRunOptions(): Promise<OpenRunOption[]> {
  const rows = await db
    .select({
      id: productionRuns.id,
      runNo: productionRuns.runNo,
      sku: products.sku,
      unitsProduced: productionRuns.unitsProduced,
      unitsRejected: productionRuns.unitsRejected,
      unitsPlanned: productionRuns.unitsPlanned,
    })
    .from(productionRuns)
    .innerJoin(products, eq(products.id, productionRuns.productId))
    .where(eq(productionRuns.status, 'open'))
    .orderBy(desc(productionRuns.runDate), asc(productionRuns.runNo));
  return rows.map((r) => {
    const good = goodUnitsOf(r);
    const planned = r.unitsPlanned === null ? 0 : quantityFromDb(r.unitsPlanned);
    return { id: r.id, runNo: r.runNo, sku: r.sku, unitsWeight: good > 0 ? good : planned };
  });
}

/** Balances of the accounts a from-stock cost can be relieved from. */
export async function stockBalances(): Promise<Array<{ code: string; name: string; cents: number }>> {
  const [balances, dir] = await Promise.all([inventoryBalances(today()), accountDirectory()]);
  return [ACCOUNTS.INVENTORY_INGREDIENTS, ACCOUNTS.INVENTORY_PACKAGING].map((code) => ({
    code,
    name: dir.byCode.get(code)?.name ?? code,
    cents: balances.get(code) ?? 0,
  }));
}

/* -------------------------------------------------------------------- COGS */

export interface BatchRow {
  id: string;
  year: number;
  month: number;
  status: 'draft' | 'posted' | 'reversed';
  totalUnits: number;
  totalCogsCents: number;
  entry: EntryRef | null;
  reversal: EntryRef | null;
  createdAt: string;
}

export async function batchRows(): Promise<BatchRow[]> {
  const batches = await listCogsBatches();
  const nos = await entryNos(batches.flatMap((b) => [b.journalEntryId, b.reversalEntryId]));
  return batches.map((b) => ({
    id: b.id,
    year: b.periodYear,
    month: b.periodMonth,
    status: b.status,
    totalUnits: quantityFromDb(b.totalUnits),
    totalCogsCents: b.totalCogsCents,
    entry: ref(b.journalEntryId, nos),
    reversal: ref(b.reversalEntryId, nos),
    createdAt: b.createdAt.toISOString(),
  }));
}

export interface ShipmentMonthRow {
  year: number;
  month: number;
  units: number;
  returns: number;
  skus: number;
  channels: number;
  filename: string | null;
  batchStatus: 'draft' | 'posted' | null;
}

export async function shipmentMonths(): Promise<ShipmentMonthRow[]> {
  const [rows, files, batches] = await Promise.all([
    db
      .select({
        year: shipmentUnits.periodYear,
        month: shipmentUnits.periodMonth,
        units: sql<string>`sum(${shipmentUnits.units})`,
        returns: sql<string>`sum(${shipmentUnits.returnsUnits})`,
        skus: sql<string>`count(distinct ${shipmentUnits.productId})`,
        channels: sql<string>`count(distinct ${shipmentUnits.channelId})`,
      })
      .from(shipmentUnits)
      .groupBy(shipmentUnits.periodYear, shipmentUnits.periodMonth)
      .orderBy(desc(shipmentUnits.periodYear), desc(shipmentUnits.periodMonth)),
    db
      .select({
        year: shipmentImports.periodYear,
        month: shipmentImports.periodMonth,
        filename: shipmentImports.filename,
      })
      .from(shipmentImports)
      .where(eq(shipmentImports.status, 'imported'))
      .orderBy(desc(shipmentImports.createdAt)),
    db
      .select({ year: cogsBatches.periodYear, month: cogsBatches.periodMonth, status: cogsBatches.status })
      .from(cogsBatches)
      .where(inArray(cogsBatches.status, ['draft', 'posted'])),
  ]);
  return rows.map((r) => {
    const file = files.find((f) => f.year === r.year && f.month === r.month);
    const states = batches.filter((b) => b.year === r.year && b.month === r.month).map((b) => b.status);
    return {
      year: r.year,
      month: r.month,
      units: quantityFromDb(r.units),
      returns: quantityFromDb(r.returns),
      skus: Number(r.skus),
      channels: Number(r.channels),
      filename: file?.filename ?? null,
      batchStatus: states.includes('posted') ? 'posted' : states.includes('draft') ? 'draft' : null,
    };
  });
}

export interface BatchLineRow {
  sku: string;
  productName: string;
  channelCode: string | null;
  channelName: string | null;
  units: number;
  unitCostCents: number;
  cogsCents: number;
  components: Partial<Record<CostComponentKey, number>>;
}

export interface BatchDetail {
  batch: BatchRow;
  lines: BatchLineRow[];
  /** The components present on any line, in presentation order. */
  components: CostComponentKey[];
  entry: EntryPreviewData;
}

export async function batchDetail(batchId: string): Promise<BatchDetail | null> {
  let detail;
  try {
    detail = await getCogsBatch(batchId);
  } catch (error) {
    if (isInventoryError(error) && error.code === 'not_found') return null;
    throw error;
  }
  const productIds = [...new Set(detail.lines.map((l) => l.productId))];
  const [rows, draftEntry, names, channelRows] = await Promise.all([
    batchRows(),
    previewCogsEntry(batchId),
    productIds.length === 0
      ? Promise.resolve([])
      : db
          .select({ id: products.id, name: products.name })
          .from(products)
          .where(inArray(products.id, productIds)),
    db.select({ id: channels.id, name: channels.name }).from(channels),
  ]);
  const batch = rows.find((b) => b.id === batchId);
  if (!batch) return null;
  const productNames = new Map(names.map((n) => [n.id, n.name]));
  const channelNames = new Map(channelRows.map((c) => [c.id, c.name]));
  const present = new Set<CostComponentKey>();
  const lines: BatchLineRow[] = detail.lines.map((l) => {
    for (const c of COMPONENT_ORDER) if ((l.breakdown[c] ?? 0) !== 0) present.add(c);
    return {
      sku: l.sku,
      productName: productNames.get(l.productId) ?? l.sku,
      channelCode: l.channelCode,
      channelName: l.channelId ? (channelNames.get(l.channelId) ?? null) : null,
      units: l.units,
      unitCostCents: l.unitCostCents,
      cogsCents: l.cogsCents,
      components: l.breakdown,
    };
  });
  return {
    batch,
    lines,
    components: COMPONENT_ORDER.filter((c) => present.has(c)),
    entry: {
      date: draftEntry.date,
      memo: draftEntry.memo ?? '',
      lines: await previewLines(draftEntry.lines),
    },
  };
}

/* --------------------------------------------------------------- valuation */

export interface TieoutRow {
  id: string;
  asOfDate: CalendarDate;
  snapshotValueCents: number;
  ledgerValueCents: number;
  varianceCents: number;
  explanation: string | null;
  resolved: boolean;
  adjustment: EntryRef | null;
  byStage: Array<{
    stage: string;
    accountCode: string | null;
    accountName: string;
    snapshotValueCents: number;
    ledgerValueCents: number;
    varianceCents: number;
  }>;
  /** The correcting entry, for an unadjusted tie-out with a variance. */
  proposal: EntryPreviewData | null;
}

export async function tieoutRows(): Promise<TieoutRow[]> {
  const [rows, dir] = await Promise.all([listTieouts(), accountDirectory()]);
  const nos = await entryNos(rows.map((r) => r.adjustmentEntryId));
  return Promise.all(
    rows.map(async (r) => {
      const draft =
        r.adjustmentEntryId === null && r.varianceCents !== 0
          ? proposeTieoutAdjustment({ asOfDate: r.asOfDate, byStage: r.byStage })
          : null;
      return {
        id: r.id,
        asOfDate: r.asOfDate,
        snapshotValueCents: r.snapshotValueCents,
        ledgerValueCents: r.ledgerValueCents,
        varianceCents: r.varianceCents,
        explanation: r.explanation,
        resolved: r.resolved,
        adjustment: ref(r.adjustmentEntryId, nos),
        byStage: r.byStage.map((d) => ({
          ...d,
          accountName: d.accountCode ? (dir.byCode.get(d.accountCode)?.name ?? d.accountCode) : '—',
        })),
        proposal:
          draft && draft.lines.length > 0
            ? { date: draft.date, memo: draft.memo ?? '', lines: await previewLines(draft.lines, dir) }
            : null,
      };
    }),
  );
}

export interface CurrentTieout {
  snapshotDate: CalendarDate;
  snapshotValueCents: number;
  ledgerValueCents: number;
  varianceCents: number;
  reserveCents: number;
  byStage: TieoutRow['byStage'];
  /** A tie-out is already recorded for this snapshot date. */
  recorded: boolean;
}

export async function currentTieout(): Promise<CurrentTieout | null> {
  const [t, dir, recorded] = await Promise.all([latestTieout(today()), accountDirectory(), listTieouts()]);
  if (!t) return null;
  return {
    snapshotDate: t.snapshotDate,
    snapshotValueCents: t.snapshotValueCents,
    ledgerValueCents: t.ledgerValueCents,
    varianceCents: t.varianceCents,
    reserveCents: t.reserveCents,
    byStage: t.byStage.map((d) => ({
      ...d,
      accountName: d.accountCode ? (dir.byCode.get(d.accountCode)?.name ?? d.accountCode) : '—',
    })),
    recorded: recorded.some((r) => r.asOfDate === t.snapshotDate),
  };
}

export interface SnapshotImportRow {
  id: string;
  snapshotDate: CalendarDate;
  filename: string | null;
  rowCount: number;
  totalValueCents: number;
  status: string;
  warnings: number;
  createdAt: string;
}

export async function snapshotImports(): Promise<SnapshotImportRow[]> {
  const rows = await db
    .select()
    .from(inventoryImports)
    .where(inArray(inventoryImports.status, ['imported', 'cancelled']))
    .orderBy(desc(inventoryImports.snapshotDate), desc(inventoryImports.createdAt))
    .limit(24);
  return rows.map((r) => ({
    id: r.id,
    snapshotDate: r.snapshotDate,
    filename: r.filename,
    rowCount: r.rowCount,
    totalValueCents: r.totalValueCents,
    status: r.status,
    warnings: r.warnings.length,
    createdAt: r.createdAt.toISOString(),
  }));
}

/* ------------------------------------------------------------- adjustments */

export interface AdjustmentRow {
  id: string;
  adjustmentNo: string;
  date: CalendarDate;
  sku: string;
  reason: string;
  stage: StageKey;
  quantity: number;
  valueCents: number;
  memo: string | null;
  entry: EntryRef | null;
}

export async function adjustmentRows(): Promise<AdjustmentRow[]> {
  const rows = await listInventoryAdjustments();
  const nos = await entryNos(rows.map((r) => r.journalEntryId));
  return rows
    .map((r) => ({
      id: r.id,
      adjustmentNo: r.adjustmentNo,
      date: r.adjustmentDate,
      sku: r.sku,
      reason: r.reason,
      stage: r.stage,
      quantity: quantityFromDb(r.quantity),
      valueCents: r.valueCents,
      memo: r.memo,
      entry: ref(r.journalEntryId, nos),
    }))
    .reverse();
}

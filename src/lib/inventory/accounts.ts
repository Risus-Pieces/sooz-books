/**
 * Where inventory value lives and where it goes when it leaves.
 *
 * Every account is named through `ACCOUNTS`; this file only decides which one.
 */

import type { CostBreakdown, CostComponent, InventoryAdjustmentReason } from '@/db/schema';
import { ACCOUNTS, type AccountCode } from '@/lib/ledger/coa';

export const STAGES = ['raw', 'packaging', 'wip', 'finished', 'in_transit'] as const;
export type Stage = (typeof STAGES)[number];

export function isStage(value: string): value is Stage {
  return (STAGES as readonly string[]).includes(value);
}

/**
 * The balance-sheet account that carries a Peasy stage.
 *
 * `wip` has no account of its own: at a co-manufacturer, material issued to a run
 * stays in Raw Ingredients until the run is costed and reclassified into
 * Finished Goods, so work in process is compared against 1320.
 */
export const STAGE_ACCOUNT: Readonly<Record<Stage, AccountCode>> = Object.freeze({
  raw: ACCOUNTS.INVENTORY_INGREDIENTS,
  packaging: ACCOUNTS.INVENTORY_PACKAGING,
  wip: ACCOUNTS.INVENTORY_INGREDIENTS,
  finished: ACCOUNTS.INVENTORY_FINISHED,
  in_transit: ACCOUNTS.INVENTORY_IN_TRANSIT,
});

/**
 * The COGS account a landed-cost component is relieved to. Components without a
 * dedicated line (labor, overhead, other) fall into 5010 Product Cost, which is
 * also where a unit cost with no breakdown at all is relieved.
 */
export const COMPONENT_COGS_ACCOUNT: Readonly<Record<CostComponent, AccountCode>> = Object.freeze({
  tolling: ACCOUNTS.COGS_PRODUCT,
  ingredients: ACCOUNTS.COGS_INGREDIENTS,
  packaging: ACCOUNTS.COGS_PACKAGING,
  freight_in: ACCOUNTS.COGS_FREIGHT_IN,
  duty: ACCOUNTS.COGS_DUTY,
  labor: ACCOUNTS.COGS_PRODUCT,
  overhead: ACCOUNTS.COGS_PRODUCT,
  other: ACCOUNTS.COGS_PRODUCT,
});

export const UNSPLIT_COGS_ACCOUNT: AccountCode = ACCOUNTS.COGS_PRODUCT;

/**
 * Where a landed cost is relieved FROM at costing, when it was not billed on a
 * bill line that already names its account: materials consumed out of stock come
 * out of the inventory account they sat in; services the co-man performed with no
 * invoice yet are accrued.
 */
export const COMPONENT_DEFAULT_SOURCE: Readonly<Record<CostComponent, AccountCode>> = Object.freeze({
  ingredients: ACCOUNTS.INVENTORY_INGREDIENTS,
  packaging: ACCOUNTS.INVENTORY_PACKAGING,
  tolling: ACCOUNTS.ACCRUED_COMAN_COSTS,
  freight_in: ACCOUNTS.ACCRUED_FREIGHT,
  duty: ACCOUNTS.ACCRUED_EXPENSES,
  labor: ACCOUNTS.ACCRUED_COMAN_COSTS,
  overhead: ACCOUNTS.ACCRUED_EXPENSES,
  other: ACCOUNTS.ACCRUED_EXPENSES,
});

/**
 * The P&L side of an inventory adjustment. Product given away on purpose is a
 * sample (5070); product lost, spoiled, miscounted or revalued is a write-off
 * (5060). An opening balance is not a P&L event at all.
 */
export const ADJUSTMENT_EXPENSE_ACCOUNT: Readonly<Record<InventoryAdjustmentReason, AccountCode>> =
  Object.freeze({
    samples: ACCOUNTS.COGS_SAMPLES,
    demo: ACCOUNTS.COGS_SAMPLES,
    donation: ACCOUNTS.COGS_SAMPLES,
    spoilage: ACCOUNTS.COGS_WRITE_OFF,
    damage: ACCOUNTS.COGS_WRITE_OFF,
    expiry: ACCOUNTS.COGS_WRITE_OFF,
    theft: ACCOUNTS.COGS_WRITE_OFF,
    count_variance: ACCOUNTS.COGS_WRITE_OFF,
    rework: ACCOUNTS.COGS_WRITE_OFF,
    revaluation: ACCOUNTS.COGS_WRITE_OFF,
    opening_balance: ACCOUNTS.OPENING_BALANCE_EQUITY,
  });

/** The components in a fixed order, so every split is deterministic. */
export const COMPONENT_ORDER: readonly CostComponent[] = [
  'tolling',
  'ingredients',
  'packaging',
  'freight_in',
  'duty',
  'labor',
  'overhead',
  'other',
];

/** Non-zero components of a breakdown, in `COMPONENT_ORDER`. */
export function breakdownEntries(breakdown: CostBreakdown): Array<[CostComponent, number]> {
  return COMPONENT_ORDER.filter((c) => (breakdown[c] ?? 0) !== 0).map((c) => [c, breakdown[c] ?? 0]);
}

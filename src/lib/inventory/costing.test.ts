import { afterAll, describe, expect, it } from 'vitest';

// First: loads .env.local before '@/db/client' is imported by the modules below.
import { closeTestDb } from '@/lib/ledger/test-support';

import { ACCOUNTS } from '@/lib/ledger/coa';
import { allocateCents } from '@/lib/money';

import { planAdjustment } from './adjustments';
import { cogsEntryLines, splitByComponent, type CogsLinePlan } from './cogs';
import { InventoryError } from './errors';
import { toDraftLines, totalCredits, totalDebits } from './lines';
import { computeRunCost } from './production';
import { extendCost, parseQuantity, quantityToDb, roundDiv, unitCostOf } from './quantity';
import { compareByAccount, proposeTieoutAdjustment } from './tieout';

afterAll(closeTestDb);

describe('quantities', () => {
  it('reads quantities exactly into hundredths', () => {
    expect(parseQuantity('1,234.5').hundredths).toBe(123450);
    expect(parseQuantity('(12)').hundredths).toBe(-1200);
    expect(parseQuantity('-0.005')).toEqual({ hundredths: -1, rounded: true });
    expect(parseQuantity('12.344')).toEqual({ hundredths: 1234, rounded: true });
    expect(() => parseQuantity('twelve')).toThrow();
    expect(quantityToDb(-1250)).toBe('-12.50');
  });

  it('rounds half away from zero, once', () => {
    expect(roundDiv(BigInt(5), BigInt(2))).toBe(BigInt(3));
    expect(roundDiv(BigInt(-5), BigInt(2))).toBe(BigInt(-3));
    expect(extendCost(150, 333)).toBe(500); // 1.5 × 333 = 499.5 -> 500
    expect(unitCostOf(1000, 300)).toBe(333); // $10 over 3 units
  });
});

describe('allocation across runs', () => {
  it('always sums exactly to the bill line', () => {
    for (const [total, weights] of [
      [100_00, [1, 1, 1]],
      [99_99, [2400, 1200, 600]],
      [1, [5, 5]],
      [1234_57, [0, 3, 7, 11]],
    ] as Array<[number, number[]]>) {
      const parts = allocateCents(total, weights);
      expect(parts.reduce((a, b) => a + b, 0)).toBe(total);
    }
  });
});

describe('computeRunCost', () => {
  it('strikes unit cost = total / good units and books the remainder as variance', () => {
    const math = computeRunCost(
      [
        { component: 'tolling', amountCents: 1200_00 },
        { component: 'ingredients', amountCents: 2345_67 },
        { component: 'packaging', amountCents: 890_12 },
        { component: 'freight_in', amountCents: 150_00 },
      ],
      2995_00, // 2,995 good units
    );
    expect(math.totalCents).toBe(4585_79);
    // 458579 / 2995 = 153.114... -> 153
    expect(math.unitCostCents).toBe(153);
    expect(math.finishedGoodsValueCents).toBe(153 * 2995);
    expect(math.roundingVarianceCents).toBe(4585_79 - 153 * 2995);
    expect(math.finishedGoodsValueCents + math.roundingVarianceCents).toBe(math.totalCents);
    expect(Math.abs(math.roundingVarianceCents)).toBeLessThanOrEqual(2995 / 2);
    const parts = Object.values(math.breakdown);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(153);
    expect(Object.keys(math.breakdown).sort()).toEqual(['freight_in', 'ingredients', 'packaging', 'tolling']);
  });

  it('handles fractional good units and rounds up at half a cent', () => {
    // $10.00 over 8 units = 125 exactly; over 7.5 units = 133.33 -> 133
    expect(computeRunCost([{ component: 'tolling', amountCents: 1000 }], 800).unitCostCents).toBe(125);
    const m = computeRunCost([{ component: 'tolling', amountCents: 1000 }], 750);
    expect(m.unitCostCents).toBe(133);
    expect(m.finishedGoodsValueCents).toBe(998); // 7.5 × 133 = 997.5 -> 998
    expect(m.roundingVarianceCents).toBe(2);
  });

  it('refuses a run with no good units or no cost', () => {
    expect(() => computeRunCost([{ component: 'tolling', amountCents: 100 }], 0)).toThrow(InventoryError);
    expect(() => computeRunCost([], 100)).toThrow(InventoryError);
  });
});

describe('COGS entry', () => {
  const lines: CogsLinePlan[] = [
    {
      productId: '00000000-0000-4000-8000-000000000001',
      sku: 'MANGO-12',
      channelId: '00000000-0000-4000-8000-0000000000c1',
      channelCode: 'DTC',
      units: 12300,
      unitCostCents: 153,
      cogsCents: extendCost(12300, 153),
      breakdown: splitByComponent(extendCost(12300, 153), { tolling: 40, ingredients: 78, packaging: 30, freight_in: 5 }),
    },
    {
      productId: '00000000-0000-4000-8000-000000000002',
      sku: 'PLAIN-12',
      channelId: null,
      channelCode: null,
      units: -200,
      unitCostCents: 99,
      cogsCents: extendCost(-200, 99),
      breakdown: {},
    },
  ];

  it('splits each line by component, the split summing to the line', () => {
    const b = lines[0].breakdown;
    expect(Object.values(b).reduce((a, c) => a + c, 0)).toBe(lines[0].cogsCents);
    expect(Object.keys(b).sort()).toEqual(['freight_in', 'ingredients', 'packaging', 'tolling']);
  });

  it('balances, relieves 1310, and routes components to 5010/5015/5020/5030', () => {
    const draft = toDraftLines(cogsEntryLines(lines));
    expect(totalDebits(draft)).toBe(totalCredits(draft));
    const byAccount = (code: string): number =>
      draft.filter((l) => l.accountCode === code).reduce((s, l) => s + (l.debitCents ?? 0) - (l.creditCents ?? 0), 0);
    expect(byAccount(ACCOUNTS.INVENTORY_FINISHED)).toBe(-(lines[0].cogsCents + lines[1].cogsCents));
    expect(byAccount(ACCOUNTS.COGS_PRODUCT)).toBe((lines[0].breakdown.tolling ?? 0) + lines[1].cogsCents);
    expect(byAccount(ACCOUNTS.COGS_INGREDIENTS)).toBe(lines[0].breakdown.ingredients);
    expect(byAccount(ACCOUNTS.COGS_PACKAGING)).toBe(lines[0].breakdown.packaging);
    expect(byAccount(ACCOUNTS.COGS_FREIGHT_IN)).toBe(lines[0].breakdown.freight_in);
    for (const l of draft) {
      expect(l.productId).not.toBeNull();
    }
    // A net return posts the other way round: Dr 1310, Cr COGS.
    const ret = draft.filter((l) => l.productId === lines[1].productId);
    expect(ret.find((l) => l.accountCode === ACCOUNTS.INVENTORY_FINISHED)?.debitCents).toBe(198);
  });
});

describe('tie-out', () => {
  it('compares by account, folding wip into raw, and proposes a balanced true-up', () => {
    const detail = compareByAccount(
      new Map([
        ['finished', 10_000],
        ['raw', 5_000],
        ['wip', 1_000],
        ['packaging', 2_500],
      ]),
      new Map([
        [ACCOUNTS.INVENTORY_FINISHED, 10_300],
        [ACCOUNTS.INVENTORY_INGREDIENTS, 6_000],
        [ACCOUNTS.INVENTORY_PACKAGING, 2_000],
      ]),
    );
    const fg = detail.find((d) => d.accountCode === ACCOUNTS.INVENTORY_FINISHED);
    const raw = detail.find((d) => d.accountCode === ACCOUNTS.INVENTORY_INGREDIENTS);
    const pkg = detail.find((d) => d.accountCode === ACCOUNTS.INVENTORY_PACKAGING);
    expect(fg?.varianceCents).toBe(-300);
    expect(raw?.stage).toBe('raw+wip');
    expect(raw?.varianceCents).toBe(0);
    expect(pkg?.varianceCents).toBe(500);

    const proposal = proposeTieoutAdjustment({ asOfDate: '2026-08-31', byStage: detail });
    expect(totalDebits(proposal.lines)).toBe(totalCredits(proposal.lines));
    expect(proposal.lines.find((l) => l.accountCode === ACCOUNTS.INVENTORY_FINISHED)?.creditCents).toBe(300);
    expect(proposal.lines.find((l) => l.accountCode === ACCOUNTS.INVENTORY_PACKAGING)?.debitCents).toBe(500);
    const writeOff = proposal.lines
      .filter((l) => l.accountCode === ACCOUNTS.COGS_WRITE_OFF)
      .reduce((s, l) => s + (l.debitCents ?? 0) - (l.creditCents ?? 0), 0);
    expect(writeOff).toBe(-200);
  });
});

describe('adjustments', () => {
  const base = { date: '2026-08-15', productId: '00000000-0000-4000-8000-000000000001' };

  it('samples and demo go to 5070; spoilage and count variance to 5060', () => {
    expect(planAdjustment({ ...base, reason: 'samples', quantity: -600 }, 153).expenseAccountCode).toBe(
      ACCOUNTS.COGS_SAMPLES,
    );
    expect(planAdjustment({ ...base, reason: 'demo', quantity: -100 }, 153).expenseAccountCode).toBe(
      ACCOUNTS.COGS_SAMPLES,
    );
    const spoil = planAdjustment({ ...base, reason: 'spoilage', quantity: -250 }, 153);
    expect(spoil.expenseAccountCode).toBe(ACCOUNTS.COGS_WRITE_OFF);
    expect(spoil.inventoryAccountCode).toBe(ACCOUNTS.INVENTORY_FINISHED);
    expect(spoil.valueCents).toBe(-extendCost(250, 153));
  });

  it('uses the stage to pick the inventory account and needs a cost for raw materials', () => {
    const pkg = planAdjustment({ ...base, reason: 'damage', quantity: -1000, stage: 'packaging', unitCostCents: 12 }, null);
    expect(pkg.inventoryAccountCode).toBe(ACCOUNTS.INVENTORY_PACKAGING);
    expect(pkg.valueCents).toBe(-120);
    expect(() => planAdjustment({ ...base, reason: 'spoilage', quantity: -100, stage: 'raw' }, 153)).toThrow(
      InventoryError,
    );
    const gain = planAdjustment({ ...base, reason: 'count_variance', quantity: 300 }, 100);
    expect(gain.valueCents).toBe(300);
  });
});

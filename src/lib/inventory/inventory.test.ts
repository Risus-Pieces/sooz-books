import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// First: loads .env.local before '@/db/client' is imported anywhere below.
import { closeTestDb, hasDatabase, withRollback } from '@/lib/ledger/test-support';

import { eq, sql as sqlTag } from 'drizzle-orm';

import {
  billLines,
  bills,
  cogsBatches,
  inventoryTieouts,
  journalEntries,
  journalLines,
  landedCosts,
  productCosts,
  productionRuns,
  products,
  vendors,
} from '@/db/schema';
import { ACCOUNTS } from '@/lib/ledger/coa';
import { type LedgerDb, postJournalEntry } from '@/lib/ledger/post';

import { postInventoryAdjustment } from './adjustments';
import { averageRelief, draftCogsBatch, postCogsBatch, reverseCogsBatch, spreadRelief } from './cogs';
import { accountIdsByCode } from './context';
import { InventoryError } from './errors';
import { grossMarginBy } from './margin';
import { commitPeasyInventory, commitPeasyShipments, previewPeasyInventory } from './peasy-intake';
import { allocateBillLine, addLandedCost, costRun, createProductionRun, reopenRun } from './production';
import { extendCost } from './quantity';
import { computeTieout, recordTieout, postTieoutAdjustment } from './tieout';

const CTX = { userId: null };
const RUN_DATE = '2026-08-05';

/**
 * Every transaction in the owner's four Relay accounts, fingerprinted so the suite
 * can prove it never touched them. Scoped to those accounts because other suites
 * running alongside this one commit and delete rows in throwaway bank accounts of
 * their own, which would otherwise change a table-wide fingerprint mid-run.
 */
async function relayFingerprint(): Promise<string> {
  const { sql } = await import('@/db/client');
  const [row] = await sql<{ h: string | null; n: string }[]>`
    select md5(string_agg(t::text, '|' order by t.id)) as h, count(*)::text as n
      from bank_transactions t
      join bank_accounts a on a.id = t.bank_account_id
     where a.institution = 'Relay' and a.mask in ('9726', '9727', '9972', '9973')`;
  return `${row.n}:${row.h ?? ''}`;
}

let relayBefore = '';
beforeAll(async () => {
  if (hasDatabase) relayBefore = await relayFingerprint();
});

afterAll(async () => {
  if (hasDatabase) {
    // Nothing in this suite may touch the owner's real Relay rows.
    expect(await relayFingerprint()).toBe(relayBefore);
  }
  await closeTestDb();
});

async function balance(tx: LedgerDb, code: string): Promise<number> {
  const rows = await tx.execute<{ b: string }>(sqlTag`
    select coalesce(sum(l.debit_cents - l.credit_cents), 0) as b
      from journal_lines l join journal_entries e on e.id = l.entry_id and e.status = 'posted'
      join accounts a on a.id = l.account_id where a.code = ${code}`);
  return Number([...rows][0].b);
}

/** Forces the deferred balance and allocation checks to run now, inside the test transaction. */
async function checkDeferred(tx: LedgerDb): Promise<void> {
  await tx.execute(sqlTag`set constraints all immediate`);
  await tx.execute(sqlTag`set constraints all deferred`);
}

interface Fixture {
  productId: string;
  sku: string;
  vendorId: string;
  suffix: string;
}

async function fixture(tx: LedgerDb): Promise<Fixture> {
  const suffix = Math.random().toString(36).slice(2, 8).toUpperCase();
  const sku = `ZZTEST-MANGO-${suffix}`;
  const [p] = await tx.insert(products).values({ sku, name: `Test Mango ${suffix}` }).returning();
  const [v] = await tx.insert(vendors).values({ name: `ZZ Test Co-Man ${suffix}` }).returning();
  return { productId: p.id, sku, vendorId: v.id, suffix };
}

/** A posted vendor bill: Dr each line's account, Cr AP, through the posting engine. */
async function postedBill(
  tx: LedgerDb,
  f: Fixture,
  billNo: string,
  lines: Array<{ description: string; accountCode: string; amountCents: number }>,
): Promise<{ billId: string; lineIds: string[] }> {
  const ids = await accountIdsByCode(tx, lines.map((l) => l.accountCode));
  const total = lines.reduce((s, l) => s + l.amountCents, 0);
  const entry = await postJournalEntry(
    {
      date: '2026-08-01',
      memo: `Bill ${billNo}`,
      sourceType: 'bill',
      lines: [
        ...lines.map((l) => ({ accountCode: l.accountCode, debitCents: l.amountCents, vendorId: f.vendorId })),
        { accountCode: ACCOUNTS.AP, creditCents: total, vendorId: f.vendorId },
      ],
    },
    { userId: null, tx },
  );
  const [bill] = await tx
    .insert(bills)
    .values({
      billNo: `${billNo}-${f.suffix}`,
      vendorId: f.vendorId,
      billDate: '2026-08-01',
      dueDate: '2026-08-31',
      status: 'open',
      subtotalCents: total,
      totalCents: total,
      journalEntryId: entry.entryId,
    })
    .returning();
  const inserted = await tx
    .insert(billLines)
    .values(
      lines.map((l, i) => ({
        billId: bill.id,
        lineNo: i + 1,
        description: l.description,
        accountId: ids.get(l.accountCode) as string,
        amountCents: l.amountCents,
      })),
    )
    .returning({ id: billLines.id });
  return { billId: bill.id, lineIds: inserted.map((r) => r.id) };
}

function csv(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe.skipIf(!hasDatabase)('production runs and landed cost', { timeout: 180_000 }, () => {
  it('allocates one bill across two runs exactly, costs a run, and reclassifies into 1310', async () => {
    await withRollback(async (tx) => {
      const f = await fixture(tx);
      const run1 = await createProductionRun(
        { runNo: `R1-${f.suffix}`, productId: f.productId, runDate: RUN_DATE, coManVendorId: f.vendorId, unitsProduced: 3000_00, unitsRejected: 5_00 },
        { ...CTX, tx },
      );
      const run2 = await createProductionRun(
        { runNo: `R2-${f.suffix}`, productId: f.productId, runDate: '2026-08-20', unitsProduced: 1500_00 },
        { ...CTX, tx },
      );

      const materials = await postedBill(tx, f, 'MAT', [
        { description: 'Mango puree', accountCode: ACCOUNTS.INVENTORY_INGREDIENTS, amountCents: 2345_67 },
        { description: 'Pouches', accountCode: ACCOUNTS.INVENTORY_PACKAGING, amountCents: 890_12 },
      ]);
      const tolling = await postedBill(tx, f, 'TOLL', [
        { description: 'Tolling, August', accountCode: ACCOUNTS.INVENTORY_FINISHED, amountCents: 3600_01 },
      ]);
      const freight = await postedBill(tx, f, 'FRT', [
        { description: 'Inbound freight', accountCode: ACCOUNTS.COGS_FREIGHT_IN, amountCents: 150_00 },
      ]);

      // One tolling invoice over both runs, by good units: 2995 vs 1500.
      const split = await allocateBillLine(
        { billLineId: tolling.lineIds[0], component: 'tolling', basis: 'units', runs: [{ runId: run1.id }, { runId: run2.id }] },
        { ...CTX, tx },
      );
      expect(split.shares.reduce((s, x) => s + x.amountCents, 0)).toBe(3600_01);
      expect(split.shares[0].amountCents).toBe(Math.round((3600_01 * 2995) / 4495));

      await allocateBillLine(
        { billLineId: materials.lineIds[0], component: 'ingredients', basis: 'manual', runs: [{ runId: run1.id, weight: 1 }] },
        { ...CTX, tx },
      );
      await allocateBillLine(
        { billLineId: materials.lineIds[1], component: 'packaging', basis: 'manual', runs: [{ runId: run1.id, weight: 1 }] },
        { ...CTX, tx },
      );
      await allocateBillLine(
        { billLineId: freight.lineIds[0], component: 'freight_in', basis: 'manual', runs: [{ runId: run1.id, weight: 1 }] },
        { ...CTX, tx },
      );

      // Nothing is left on a fully allocated line.
      await expect(
        allocateBillLine(
          { billLineId: freight.lineIds[0], component: 'freight_in', basis: 'manual', runs: [{ runId: run2.id, weight: 1 }] },
          { ...CTX, tx },
        ),
      ).rejects.toBeInstanceOf(InventoryError);
      // And the database refuses an over-allocation written behind the module's back.
      await expect(
        tx.transaction(async (sp) => {
          await sp.insert(landedCosts).values({
            productionRunId: run2.id,
            component: 'freight_in',
            billLineId: freight.lineIds[0],
            amountCents: 1,
          });
          await sp.execute(sqlTag`set constraints all immediate`);
        }),
      ).rejects.toThrow();

      const fgBefore = await balance(tx, ACCOUNTS.INVENTORY_FINISHED);
      const rawBefore = await balance(tx, ACCOUNTS.INVENTORY_INGREDIENTS);
      const pkgBefore = await balance(tx, ACCOUNTS.INVENTORY_PACKAGING);
      const freightBefore = await balance(tx, ACCOUNTS.COGS_FREIGHT_IN);

      const costed = await costRun(run1.id, { ...CTX, tx });
      await checkDeferred(tx);

      const toll1 = split.shares[0].amountCents;
      const total = toll1 + 2345_67 + 890_12 + 150_00;
      expect(costed.totalCents).toBe(total);
      expect(costed.goodUnits).toBe(2995_00);
      expect(costed.unitCostCents).toBe(Math.round(total / 2995));
      expect(costed.finishedGoodsValueCents).toBe(costed.unitCostCents * 2995);
      expect(costed.roundingVarianceCents).toBe(total - costed.unitCostCents * 2995);
      expect(Object.values(costed.breakdown).reduce((a, b) => a + b, 0)).toBe(costed.unitCostCents);

      // Materials leave 1320/1330, freight is capitalised out of 5030, and 1310 ends at
      // exactly unit cost × good units for this run (tolling was billed straight into 1310).
      expect(await balance(tx, ACCOUNTS.INVENTORY_INGREDIENTS)).toBe(rawBefore - 2345_67);
      expect(await balance(tx, ACCOUNTS.INVENTORY_PACKAGING)).toBe(pkgBefore - 890_12);
      expect(await balance(tx, ACCOUNTS.COGS_FREIGHT_IN)).toBe(freightBefore - 150_00);
      expect(await balance(tx, ACCOUNTS.INVENTORY_FINISHED)).toBe(
        fgBefore - toll1 + costed.finishedGoodsValueCents,
      );

      const [entry] = await tx.select().from(journalEntries).where(eq(journalEntries.id, costed.entryId as string));
      expect(entry.status).toBe('posted');
      expect(entry.sourceType).toBe('landed_cost');

      const [pc] = await tx.select().from(productCosts).where(eq(productCosts.id, costed.productCostId));
      expect(pc.unitCostCents).toBe(costed.unitCostCents);
      expect(pc.breakdown).toEqual(costed.breakdown);
      const at = await tx.execute<{ c: string }>(sqlTag`select unit_cost_at(${f.productId}::uuid, '2026-08-31'::date) as c`);
      expect(Number([...at][0].c)).toBe(costed.unitCostCents);
      const before = await tx.execute<{ c: string | null }>(sqlTag`select unit_cost_at(${f.productId}::uuid, '2026-08-04'::date) as c`);
      expect([...before][0].c).toBeNull();

      // A costed run's costs are frozen.
      await expect(
        addLandedCost({ runId: run1.id, component: 'other', amountCents: 100 }, { ...CTX, tx }),
      ).rejects.toBeInstanceOf(InventoryError);

      // Reopening reverses the reclassification and withdraws the unit cost.
      await reopenRun(run1.id, { ...CTX, tx });
      await checkDeferred(tx);
      expect(await balance(tx, ACCOUNTS.INVENTORY_INGREDIENTS)).toBe(rawBefore);
      expect(await balance(tx, ACCOUNTS.INVENTORY_FINISHED)).toBe(fgBefore);
      const [reopened] = await tx.select().from(productionRuns).where(eq(productionRuns.id, run1.id));
      expect(reopened.status).toBe('open');
      expect(await tx.select().from(productCosts).where(eq(productCosts.productionRunId, run1.id))).toHaveLength(0);
    });
  });

  it('refuses to allocate a bill that was never posted', async () => {
    await withRollback(async (tx) => {
      const f = await fixture(tx);
      const run = await createProductionRun(
        { runNo: `R-${f.suffix}`, productId: f.productId, runDate: RUN_DATE, unitsProduced: 100_00 },
        { ...CTX, tx },
      );
      const ids = await accountIdsByCode(tx, [ACCOUNTS.INVENTORY_INGREDIENTS]);
      const [bill] = await tx
        .insert(bills)
        .values({ billNo: `DRAFT-${f.suffix}`, vendorId: f.vendorId, billDate: RUN_DATE, dueDate: RUN_DATE })
        .returning();
      const [line] = await tx
        .insert(billLines)
        .values({ billId: bill.id, lineNo: 1, description: 'x', accountId: ids.get(ACCOUNTS.INVENTORY_INGREDIENTS) as string, amountCents: 100 })
        .returning();
      await expect(
        allocateBillLine({ billLineId: line.id, component: 'ingredients', basis: 'units', runs: [{ runId: run.id }] }, { ...CTX, tx }),
      ).rejects.toMatchObject({ code: 'unposted_bill' });
    });
  });
});

describe.skipIf(!hasDatabase)('COGS, adjustments, tie-out and margin', { timeout: 180_000 }, () => {
  it('runs a month end to end on fixtures', async () => {
    await withRollback(async (tx) => {
      const f = await fixture(tx);
      const run = await createProductionRun(
        { runNo: `R-${f.suffix}`, productId: f.productId, runDate: RUN_DATE, unitsProduced: 1000_00 },
        { ...CTX, tx },
      );
      // Sooz today: ingredients and packaging already sit in 1320/1330. Seed them, then consume.
      await postJournalEntry(
        {
          date: '2026-08-01',
          memo: 'fixture stock',
          sourceType: 'manual',
          lines: [
            { accountCode: ACCOUNTS.INVENTORY_INGREDIENTS, debitCents: 600_00 },
            { accountCode: ACCOUNTS.INVENTORY_PACKAGING, debitCents: 250_00 },
            { accountCode: ACCOUNTS.PAID_IN_CAPITAL, creditCents: 850_00 },
          ],
        },
        { userId: null, tx },
      );
      await addLandedCost({ runId: run.id, component: 'ingredients', amountCents: 600_00 }, { ...CTX, tx });
      await addLandedCost({ runId: run.id, component: 'packaging', amountCents: 250_00 }, { ...CTX, tx });
      await addLandedCost({ runId: run.id, component: 'tolling', amountCents: 400_00 }, { ...CTX, tx }); // accrued to 2160
      const costed = await costRun(run.id, { ...CTX, tx });
      expect(costed.unitCostCents).toBe(125); // $1,250 / 1,000
      expect(costed.breakdown).toEqual({ tolling: 40, ingredients: 60, packaging: 25 });
      expect(await balance(tx, ACCOUNTS.ACCRUED_COMAN_COSTS)).toBe(-400_00);

      // Peasy shipments for August: 123 DTC (Square), 40 Amazon, 2 Amazon returns.
      const shipments = csv(
        [
          'Month,SKU,Item Name,Channel,Units Shipped,Units Returned',
          `2026-08,${f.sku},Test Mango,Square,100,0`,
          `2026-08,${f.sku},Test Mango,Square,23,0`,
          `2026-08,${f.sku},Test Mango,Amazon,40,2`,
        ].join('\n'),
      );
      const imported = await commitPeasyShipments({ filename: `ship-${f.suffix}.csv`, bytes: shipments }, { ...CTX, tx });
      expect(imported.imports).toHaveLength(1);

      const draft = await draftCogsBatch({ year: 2026, month: 8 }, { ...CTX, tx });
      const dtc = draft.lines.find((l) => l.channelCode === 'DTC');
      const amz = draft.lines.find((l) => l.channelCode === 'AMAZON');
      expect(dtc?.units).toBe(123_00);
      expect(dtc?.cogsCents).toBe(123 * 125);
      expect(amz?.units).toBe(38_00);
      expect(draft.batch.totalCogsCents).toBe(161 * 125);

      const fgBefore = await balance(tx, ACCOUNTS.INVENTORY_FINISHED);
      const posted = await postCogsBatch(draft.batch.id, { ...CTX, tx });
      await checkDeferred(tx);
      expect(await balance(tx, ACCOUNTS.INVENTORY_FINISHED)).toBe(fgBefore - 161 * 125);
      expect(await balance(tx, ACCOUNTS.COGS_PRODUCT)).toBeGreaterThanOrEqual(161 * 40);
      const lines = await tx.select().from(journalLines).where(eq(journalLines.entryId, posted.entryId));
      const debits = lines.reduce((s, l) => s + l.debitCents, 0);
      const credits = lines.reduce((s, l) => s + l.creditCents, 0);
      expect(debits).toBe(credits);
      expect(debits).toBe(161 * 125);
      expect(lines.every((l) => l.productId === f.productId && l.channelId !== null)).toBe(true);
      const codeIds = await accountIdsByCode(tx, [ACCOUNTS.COGS_PRODUCT, ACCOUNTS.COGS_INGREDIENTS, ACCOUNTS.COGS_PACKAGING]);
      const sumFor = (code: string): number =>
        lines.filter((l) => l.accountId === codeIds.get(code)).reduce((s, l) => s + l.debitCents, 0);
      expect(sumFor(ACCOUNTS.COGS_PRODUCT)).toBe(161 * 40);
      expect(sumFor(ACCOUNTS.COGS_INGREDIENTS)).toBe(161 * 60);
      expect(sumFor(ACCOUNTS.COGS_PACKAGING)).toBe(161 * 25);

      // One posted batch per month.
      const again = await tx.insert(cogsBatches).values({ periodYear: 2026, periodMonth: 8 }).returning();
      await expect(postCogsBatch(again[0].id, { ...CTX, tx })).rejects.toMatchObject({ code: 'duplicate' });
      await expect(draftCogsBatch({ year: 2026, month: 8 }, { ...CTX, tx })).rejects.toMatchObject({ code: 'duplicate' });

      // Samples: 6 units given away at cost, to 5070.
      const samplesBefore = await balance(tx, ACCOUNTS.COGS_SAMPLES);
      const adj = await postInventoryAdjustment(
        { date: '2026-08-20', productId: f.productId, reason: 'samples', quantity: -6_00 },
        { ...CTX, tx },
      );
      expect(adj.adjustment.valueCents).toBe(-750);
      expect(await balance(tx, ACCOUNTS.COGS_SAMPLES)).toBe(samplesBefore + 750);
      // Spoilage of packaging, at a given cost, to 5060 out of 1330.
      const pkgBefore = await balance(tx, ACCOUNTS.INVENTORY_PACKAGING);
      await postInventoryAdjustment(
        { date: '2026-08-21', productId: f.productId, reason: 'spoilage', quantity: -10_00, stage: 'packaging', unitCostCents: 25 },
        { ...CTX, tx },
      );
      expect(await balance(tx, ACCOUNTS.INVENTORY_PACKAGING)).toBe(pkgBefore - 250);

      // Margin by product × channel: sell the DTC units.
      const channelIds = await tx.execute<{ id: string; code: string }>(sqlTag`select id, code from channels`);
      const dtcId = [...channelIds].find((c) => c.code === 'DTC')?.id as string;
      await postJournalEntry(
        {
          date: '2026-08-31',
          memo: 'fixture DTC sales',
          sourceType: 'manual',
          lines: [
            { accountCode: ACCOUNTS.CLEARING_SHOPIFY, debitCents: 123 * 400 },
            { accountCode: ACCOUNTS.SALES_DTC, creditCents: 123 * 400, productId: f.productId, channelId: dtcId },
          ],
        },
        { userId: null, tx },
      );
      const margin = await grossMarginBy({ from: '2026-08-01', to: '2026-08-31', groupBy: 'product_channel' }, tx);
      const row = margin.rows.find((r) => r.productId === f.productId && r.channelCode === 'DTC');
      expect(row?.netSalesCents).toBe(123 * 400);
      expect(row?.cogsCents).toBe(123 * 125);
      expect(row?.grossMarginCents).toBe(123 * 275);
      expect(row?.grossMarginBps).toBe(6875);
      const byProduct = await grossMarginBy({ from: '2026-08-01', to: '2026-08-31', groupBy: 'product' }, tx);
      const prod = byProduct.rows.find((r) => r.productId === f.productId);
      // COGS by product includes the Amazon relief and the samples (5070 is in COGS).
      expect(prod?.cogsCents).toBe(161 * 125 + 750 + 250);
      expect(margin.report.rows.at(-1)?.style).toBe('total');

      // Tie-out: Peasy counts 832 finished units at $1.25 (= $1,040.00) while the ledger holds
      // 1000 − 161 − 6 = 833 units ($1,041.25): a $1.25 shortage.
      const fgLedger = await balance(tx, ACCOUNTS.INVENTORY_FINISHED);
      const snapshot = csv(
        [
          'Item Name,SKU,Category,Location,Lot,Quantity,Unit Cost,Total Value',
          `Test Mango,${f.sku},Finished Goods,Co-man,L1,500,1.25,2000.00`,
          `Test Mango,${f.sku},Finished Goods,Co-man,L2,332,1.25,1328.00`,
        ].join('\n'),
      );
      const preview = await previewPeasyInventory(
        { filename: `inv-${f.suffix}.csv`, bytes: snapshot, snapshotDate: '2026-08-31' },
        tx,
      );
      expect(preview.blockers).toEqual([]);
      expect(preview.lines).toHaveLength(1);
      expect(preview.totalsByStage.finished).toBe(832 * 125);
      await commitPeasyInventory(
        { filename: `inv-${f.suffix}.csv`, bytes: snapshot, snapshotDate: '2026-08-31', replaceExisting: true },
        { ...CTX, tx },
      );

      const entriesBefore = await tx.select({ id: journalEntries.id }).from(journalEntries);
      const t = await recordTieout('2026-09-15', { ...CTX, tx });
      const fg = t.computation.byStage.find((d) => d.accountCode === ACCOUNTS.INVENTORY_FINISHED);
      expect(t.computation.snapshotDate).toBe('2026-08-31');
      expect(fg?.ledgerValueCents).toBe(fgLedger);
      expect(fg?.snapshotValueCents).toBe(832 * 125);
      expect(fg?.varianceCents).toBe(832 * 125 - fgLedger);
      const [stored] = await tx.select().from(inventoryTieouts).where(eq(inventoryTieouts.id, t.tieout.id));
      expect(stored.varianceCents).toBe(t.computation.varianceCents);
      expect(stored.resolved).toBe(false);
      // Proposed, not posted.
      expect(t.proposal.lines.length).toBeGreaterThanOrEqual(2);
      expect(await tx.select({ id: journalEntries.id }).from(journalEntries)).toHaveLength(entriesBefore.length);

      // A person approves it; the finished-goods line then ties.
      await postTieoutAdjustment(t.tieout.id, { ...CTX, tx });
      await checkDeferred(tx);
      const after = await computeTieout('2026-08-31', tx);
      expect(after.byStage.find((d) => d.accountCode === ACCOUNTS.INVENTORY_FINISHED)?.varianceCents).toBe(0);

      // Reversal of the COGS batch puts the relief back.
      const fgBeforeReverse = await balance(tx, ACCOUNTS.INVENTORY_FINISHED);
      await reverseCogsBatch(posted.batchId, { ...CTX, tx });
      await checkDeferred(tx);
      expect(await balance(tx, ACCOUNTS.INVENTORY_FINISHED)).toBe(fgBeforeReverse + 161 * 125);
      const [reversed] = await tx.select().from(cogsBatches).where(eq(cogsBatches.id, posted.batchId));
      expect(reversed.status).toBe('reversed');
      expect(reversed.reversalEntryId).not.toBeNull();
      // With the batch reversed the month can be drafted again.
      const redraft = await draftCogsBatch({ year: 2026, month: 8 }, { ...CTX, tx });
      expect(redraft.batch.totalCogsCents).toBe(161 * 125);
      expect(extendCost(161_00, 125)).toBe(161 * 125);
    });
  });

  it('relieves Finished Goods at the weighted-average cost of the runs capitalized, never the latest run alone', async () => {
    await withRollback(async (tx) => {
      const f = await fixture(tx);
      const productFg = async (): Promise<number> => {
        const rows = await tx.execute<{ b: string }>(sqlTag`
          select coalesce(sum(l.debit_cents - l.credit_cents), 0) as b
            from journal_lines l join journal_entries e on e.id = l.entry_id and e.status = 'posted'
            join accounts a on a.id = l.account_id
           where a.code = ${ACCOUNTS.INVENTORY_FINISHED} and l.product_id = ${f.productId}::uuid`);
        return Number([...rows][0].b);
      };
      // Two runs in one month at different costs: 100 units at $1.00, then 100 at $1.50.
      for (const [n, date, cents] of [
        [1, '2026-09-02', 100_00],
        [2, '2026-09-20', 150_00],
      ] as const) {
        const run = await createProductionRun(
          { runNo: `R${n}-${f.suffix}`, productId: f.productId, runDate: date, unitsProduced: 100_00 },
          { ...CTX, tx },
        );
        await addLandedCost({ runId: run.id, component: 'tolling', amountCents: cents }, { ...CTX, tx });
        await costRun(run.id, { ...CTX, tx });
      }
      expect(await productFg()).toBe(250_00);

      await commitPeasyShipments(
        {
          filename: `ship-sep-${f.suffix}.csv`,
          bytes: csv(`Month,SKU,Channel,Units Shipped\n2026-09,${f.sku},Square,100\n`),
        },
        { ...CTX, tx },
      );
      const september = await draftCogsBatch({ year: 2026, month: 9 }, { ...CTX, tx });
      const line = september.lines.find((l) => l.productId === f.productId);
      // $250 over 200 units is $1.25 each — not the latest run's $1.50.
      expect(line?.unitCostCents).toBe(125);
      expect(line?.cogsCents).toBe(125_00);
      await postCogsBatch(september.batch.id, { ...CTX, tx });
      await checkDeferred(tx);
      expect(await productFg()).toBe(125_00);

      // The rest ships next month: the relief is exactly what is left, and 1310 empties to the cent.
      await commitPeasyShipments(
        {
          filename: `ship-oct-${f.suffix}.csv`,
          bytes: csv(`Month,SKU,Channel,Units Shipped\n2026-10,${f.sku},Square,100\n`),
        },
        { ...CTX, tx },
      );
      const october = await draftCogsBatch({ year: 2026, month: 10 }, { ...CTX, tx });
      expect(october.lines.find((l) => l.productId === f.productId)?.cogsCents).toBe(125_00);
      await postCogsBatch(october.batch.id, { ...CTX, tx });
      await checkDeferred(tx);
      expect(await productFg()).toBe(0);
    });
  });

  it('averages exactly: the whole pool relieves the whole value, a part rounds once', () => {
    expect(averageRelief(3_00, 1000, 3_00)).toBe(1000);
    expect(averageRelief(1_00, 1000, 3_00)).toBe(333);
    expect(averageRelief(2_00, 1000, 3_00)).toBe(667);
    expect(averageRelief(-1_00, 1000, 3_00)).toBe(-333);
    expect(spreadRelief(1000, [1_00, 2_00], 1000, 3_00)).toEqual([333, 667]);
  });

  it('refuses COGS for a SKU with no unit cost, naming it', async () => {
    await withRollback(async (tx) => {
      const f = await fixture(tx);
      await commitPeasyShipments(
        {
          filename: `ship-${f.suffix}.csv`,
          bytes: csv(`Month,SKU,Channel,Units Shipped\n2026-07,${f.sku},Shopify,5\n`),
        },
        { ...CTX, tx },
      );
      await expect(draftCogsBatch({ year: 2026, month: 7 }, { ...CTX, tx })).rejects.toMatchObject({
        code: 'missing_cost',
        details: [f.sku],
      });
    });
  });

  it('creates products for unknown Peasy items only when confirmed', async () => {
    await withRollback(async (tx) => {
      const suffix = Math.random().toString(36).slice(2, 8).toUpperCase();
      const file = csv(`Item Name,Category,Quantity,Unit Cost\nZZ Allulose ${suffix},Ingredients,12.5,4.00\n`);
      const input = { filename: `inv-${suffix}.csv`, bytes: file, snapshotDate: '2026-06-30' };
      const preview = await previewPeasyInventory(input, tx);
      expect(preview.unknownItems).toHaveLength(1);
      expect(preview.lines[0].stage).toBe('raw');
      expect(preview.lines[0].valueCents).toBe(50_00);

      await expect(commitPeasyInventory(input, { ...CTX, tx })).rejects.toMatchObject({ code: 'import_refused' });
      const none = await tx.select().from(products).where(eq(products.name, `ZZ Allulose ${suffix}`));
      expect(none).toHaveLength(0);

      const key = preview.unknownItems[0].key;
      const done = await commitPeasyInventory(
        { ...input, createProducts: [{ key, sku: `ZZ-ALLU-${suffix}`, name: `ZZ Allulose ${suffix}` }] },
        { ...CTX, tx },
      );
      expect(done.createdProducts).toHaveLength(1);
      expect(done.totalValueCents).toBe(50_00);
      const rows = await tx.execute<{ n: string }>(
        sqlTag`select count(*) as n from inventory_snapshots where import_id = ${done.importId}::uuid`,
      );
      expect(Number([...rows][0].n)).toBe(1);

      // The same file again is refused.
      await expect(commitPeasyInventory(input, { ...CTX, tx })).rejects.toMatchObject({ code: 'import_refused' });
    });
  });
});

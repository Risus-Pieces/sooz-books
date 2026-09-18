/**
 * The trade engine against the live database: remittance import, the deduction
 * workbench, promotions and their accruals, and the KPIs.
 *
 * Every fixture is SYNTHETIC — Sooz has no distributor yet — and reproduces
 * docs/formats/distributor-deductions.md §7.3 / §7.6: invoice INV4471001 for
 * $10,000.00 paid by KeHE ACH 0009941177 with $9,150.00 and three deductions
 * (H $420 MCB promo, IA $65 MCB admin fee, C $365 case cuts). Each test runs in
 * a transaction that is rolled back, so every customer, invoice, promotion,
 * remittance and entry made here disappears; the seeded chart of accounts,
 * reason codes and the real Relay rows are only read.
 */

import { afterAll, describe, expect, it } from 'vitest';

// First: loads .env.local before '@/db/client' is imported anywhere below.
import { closeTestDb, hasDatabase, withRollback } from '@/lib/ledger/test-support';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { asc, eq, sql } from 'drizzle-orm';

import {
  accounts,
  deductions,
  invoices,
  journalLines,
  products,
  receipts,
  remittanceLines,
  remittances,
  tradeAccruals,
} from '@/db/schema';
import { arAging } from '@/lib/arap/aging';
import { createAndIssueInvoice } from '@/lib/arap/invoices';
import { channelId, checkNow, makeCustomer } from '@/lib/arap/test-support';
import { readFile } from '@/lib/banking/read-file';
import { type RemittanceAdvice, parseRemittance } from '@/lib/importers/remittance';
import { ACCOUNTS } from '@/lib/ledger/coa';
import type { LedgerDb } from '@/lib/ledger/post';

import {
  disputeDeduction,
  openDeductions,
  recoverDeduction,
  validateDeduction,
  writeOffDeduction,
} from './deductions';
import { TradeError } from './errors';
import { tradeKpis } from './kpis';
import { accruePromotion, closePromotion, createPromotion, promotionPerformanceReport } from './promotions';
import { type AdviceOutcome, postRemittanceAdvice } from './remittances';

afterAll(closeTestDb);

const FIXTURES = join(__dirname, '__fixtures__');
const ctx = (tx: LedgerDb) => ({ userId: null, tx });

async function advicesOf(name: string): Promise<RemittanceAdvice[]> {
  const parsed = parseRemittance(await readFile(readFileSync(join(FIXTURES, name)), name));
  expect(parsed.issues).toEqual([]);
  return [...parsed.advices];
}

async function inlineAdvice(text: string): Promise<RemittanceAdvice> {
  const parsed = parseRemittance(await readFile(Buffer.from(text, 'utf8'), 'inline.csv'));
  expect(parsed.issues).toEqual([]);
  expect(parsed.advices).toHaveLength(1);
  return parsed.advices[0];
}

/** Lines of an entry, summed by account code, as [code, debit, credit]. */
async function entryByAccount(tx: LedgerDb, entryId: string): Promise<[string, number, number][]> {
  const rows = await tx
    .select({ code: accounts.code, debit: journalLines.debitCents, credit: journalLines.creditCents })
    .from(journalLines)
    .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
    .where(eq(journalLines.entryId, entryId))
    .orderBy(asc(journalLines.lineNo));
  const sums = new Map<string, [number, number]>();
  for (const r of rows) {
    const s = sums.get(r.code) ?? [0, 0];
    sums.set(r.code, [s[0] + r.debit, s[1] + r.credit]);
  }
  return [...sums.entries()].map(([code, [d, c]]) => [code, d, c] as [string, number, number]).sort((a, b) => a[0].localeCompare(b[0]));
}

async function kehe(tx: LedgerDb) {
  const distributor = await channelId(tx, 'DISTRIBUTOR');
  const customer = await makeCustomer(tx, { name: `ZZ KeHE test ${Date.now().toString(36)}`, customerType: 'distributor', channelId: distributor });
  return { customer, distributor };
}

async function invoice(tx: LedgerDb, customerId: string, externalId: string, invoiceDate: string, cents: number) {
  return createAndIssueInvoice(
    {
      customerId,
      invoiceDate,
      source: 'trade-test',
      externalId,
      lines: [{ description: `Sooz sparkling — ${externalId}`, unitPriceCents: cents }],
    },
    ctx(tx),
  );
}

function posted(outcome: AdviceOutcome) {
  if (outcome.status !== 'posted') {
    throw new Error(`Expected the advice to post; it was ${outcome.status}: ${JSON.stringify(outcome.issues)}`);
  }
  return outcome;
}

async function deductionByNo(tx: LedgerDb, deductionNo: string) {
  const [row] = await tx.select().from(deductions).where(eq(deductions.deductionNo, deductionNo));
  if (row === undefined) throw new Error(`No deduction ${deductionNo}`);
  return row;
}

async function refusal(tx: LedgerDb, work: (sp: LedgerDb) => Promise<unknown>): Promise<unknown> {
  let caught: unknown = null;
  try {
    await tx.transaction(async (sp) => {
      await work(sp);
    });
  } catch (error) {
    caught = error;
  }
  expect(caught).not.toBeNull();
  return caught;
}

describe.skipIf(!hasDatabase)('remittance import — the §7.3 worked example', { timeout: 120_000 }, () => {
  it('Entry A: no accrual — one balanced entry, AR relieved at gross, three deductions, a receipt', async () => {
    await withRollback(async (tx) => {
      const { customer } = await kehe(tx);
      const inv = await invoice(tx, customer.id, 'INV4471001', '2026-08-28', 1_000_000);
      const [advice] = await advicesOf('kehe_worked_example_2026-09-11.csv');

      const result = posted(await postRemittanceAdvice(advice, { customerId: customer.id }, ctx(tx)));
      await checkNow(tx);

      expect(await entryByAccount(tx, result.entryId)).toEqual([
        [ACCOUNTS.UNDEPOSITED_FUNDS, 915_000, 0],
        [ACCOUNTS.AR, 0, 1_000_000],
        [ACCOUNTS.DEDUCTIONS_RECEIVABLE, 36_500, 0],
        [ACCOUNTS.TRADE_BILLBACK, 42_000, 0],
        [ACCOUNTS.DISTRIBUTOR_FEES, 6_500, 0],
      ]);

      const rows = await tx.select().from(deductions).where(eq(deductions.remittanceId, result.remittanceId)).orderBy(asc(deductions.deductionNo));
      expect(rows.map((d) => [d.deductionNo, d.reasonCode, d.sourceReasonCode, d.amountCents, d.treatment, d.status, d.disputeDeadline])).toEqual([
        ['KEHE-INV4471001C', 'KEHE:C', 'C', 36_500, 'dispute', 'open', '2027-03-10'],
        ['KEHE-INV4471001H', 'KEHE:H', 'H', 42_000, 'contra_revenue', 'validated', null],
        ['KEHE-INV4471001IA', 'KEHE:IA', 'IA', 6_500, 'contra_revenue', 'validated', null],
      ]);
      for (const d of rows) {
        expect(d.invoiceId).toBe(inv.id);
        expect(d.journalEntryId).toBe(result.entryId);
        expect(d.invoiceDate).toBe('2026-08-28');
        expect(d.remittanceLineId).not.toBeNull();
      }

      const [receipt] = await tx.select().from(receipts).where(eq(receipts.remittanceId, result.remittanceId));
      expect([receipt.amountCents, receipt.appliedCents, receipt.journalEntryId]).toEqual([915_000, 915_000, result.entryId]);

      const [after] = await tx.select().from(invoices).where(eq(invoices.id, inv.id));
      expect([after.paidCents, after.deductedCents, after.status]).toEqual([915_000, 85_000, 'paid']);

      const [remittance] = await tx.select().from(remittances).where(eq(remittances.id, result.remittanceId));
      expect([remittance.totalCents, remittance.invoicesGrossCents, remittance.deductionsCents, remittance.status]).toEqual([
        915_000, 1_000_000, 85_000, 'posted',
      ]);
      expect(await tx.select().from(remittanceLines).where(eq(remittanceLines.remittanceId, remittance.id))).toHaveLength(4);

      // The AR sub-ledger agrees with the ledger: nothing is left open for this customer.
      const aging = await arAging('2026-09-30', tx);
      expect(aging.parties.find((p) => p.partyId === customer.id)).toBeUndefined();

      // §5.2 level 2: the same payment again is skipped, never merged.
      const again = await postRemittanceAdvice(advice, { customerId: customer.id }, ctx(tx));
      expect(again.status).toBe('skipped');
      if (again.status === 'skipped') expect(again.message).toMatch(/already imported on \d{4}-\d{2}-\d{2} as JE #\d+/);
    });
  });

  it("Entry A′ and §7.6: the accrual is charged first, and the $80 residual is released on close", async () => {
    await withRollback(async (tx) => {
      const { customer, distributor } = await kehe(tx);
      await invoice(tx, customer.id, 'INV4471001', '2026-08-28', 1_000_000);
      const [product] = await tx
        .insert(products)
        .values({ sku: `ZZ-TRADE-${Date.now().toString(36)}`, name: 'ZZ Sooz test SKU', unit: 'case' })
        .returning();

      const { promotion } = await createPromotion(
        {
          name: 'KeHE Sprouts SW MCB Aug 2026',
          customerId: customer.id,
          promoType: 'mcb',
          startDate: '2026-08-01',
          endDate: '2026-08-28',
          authorizationNo: '88214',
          products: [{ productId: product.id, plannedUnits: '500', allowancePerUnitCents: 100 }],
          // max(8% × $500, $65) — the MCB admin fee floor binds.
          fixedFeeCents: 6_500,
        },
        ctx(tx),
      );
      expect(promotion.plannedSpendCents).toBe(56_500);
      expect(promotion.channelId).toBe(distributor);

      // ① The promotion runs in August.
      const accruals = await accruePromotion(promotion.id, { through: '2026-08-31' }, ctx(tx));
      expect(accruals.map((a) => [a.year, a.month, a.amountCents])).toEqual([[2026, 8, 56_500]]);
      expect(await entryByAccount(tx, accruals[0].entryId)).toEqual([
        [ACCOUNTS.ACCRUED_TRADE_SPEND, 0, 56_500],
        [ACCOUNTS.TRADE_BILLBACK, 50_000, 0],
        [ACCOUNTS.DISTRIBUTOR_FEES, 6_500, 0],
      ]);
      expect(await accruePromotion(promotion.id, { through: '2026-12-31' }, ctx(tx))).toEqual([]);

      // ② The September remittance: both valid trade lines hit the liability, not contra revenue.
      const [advice] = await advicesOf('kehe_worked_example_2026-09-11.csv');
      const result = posted(await postRemittanceAdvice(advice, { customerId: customer.id }, ctx(tx)));
      await checkNow(tx);
      expect(await entryByAccount(tx, result.entryId)).toEqual([
        [ACCOUNTS.UNDEPOSITED_FUNDS, 915_000, 0],
        [ACCOUNTS.AR, 0, 1_000_000],
        [ACCOUNTS.DEDUCTIONS_RECEIVABLE, 36_500, 0],
        [ACCOUNTS.ACCRUED_TRADE_SPEND, 48_500, 0],
      ]);
      const h = await deductionByNo(tx, 'KEHE-INV4471001H');
      expect([h.treatment, h.promotionId, h.dealNumber]).toEqual(['accrual', promotion.id, '88214']);

      const [row] = await tx.select().from(tradeAccruals).where(eq(tradeAccruals.promotionId, promotion.id));
      expect([row.accruedCents, row.relievedCents, row.reversedCents]).toEqual([56_500, 48_500, 0]);

      // ③ Close: $565.00 accrued − $485.00 actual = $80.00 favourable, released to contra revenue.
      const closed = await closePromotion(promotion.id, { date: '2026-09-30' }, ctx(tx));
      await checkNow(tx);
      expect(closed.releasedCents).toBe(8_000);
      expect(closed.promotion.status).toBe('completed');
      expect(await entryByAccount(tx, closed.entryId ?? '')).toEqual([
        [ACCOUNTS.ACCRUED_TRADE_SPEND, 8_000, 0],
        [ACCOUNTS.TRADE_BILLBACK, 0, 8_000],
      ]);

      const [performance] = await promotionPerformanceReport({ promotionIds: [promotion.id] }, ctx(tx));
      expect(performance).toMatchObject({
        plannedCents: 56_500,
        accruedCents: 56_500,
        relievedCents: 48_500,
        releasedCents: 8_000,
        openAccrualCents: 0,
        deductedCents: 48_500,
        planVarianceCents: 8_000,
        accrualVarianceCents: -8_000,
        accrualVarianceRatio: -0.1416,
      });

      // KPIs over August–September for this customer.
      const kpis = await tradeKpis({ from: '2026-08-01', to: '2026-09-30', customerId: customer.id, asOf: '2026-09-30' }, ctx(tx));
      expect(kpis.totals.grossSalesCents).toBe(1_000_000);
      // Accrued $565 in August, $80 released in September: $485 of trade spend, 4.85 %.
      expect(kpis.totals.tradeSpendCents).toBe(48_500);
      expect(kpis.totals.tradeSpendRatio).toBe(0.0485);
      expect(kpis.byCustomerMonth.map((c) => [c.month, c.tradeSpendCents])).toEqual([
        [8, 56_500],
        [9, -8_000],
      ]);
      expect(kpis.totals.deductionsCents).toBe(85_000);
      expect(kpis.totals.deductionRate).toBe(0.085);
      expect(kpis.daysToDeduction).toMatchObject({ count: 3, meanDays: 14, p50Days: 14, p90Days: 14 });
      expect(kpis.accrualVariance).toEqual([
        {
          promotionId: promotion.id,
          name: 'KeHE Sprouts SW MCB Aug 2026',
          customerId: customer.id,
          accruedCents: 56_500,
          actualCents: 48_500,
          varianceCents: -8_000,
          varianceRatio: -0.1416,
        },
      ]);
      expect(kpis.openReceivable.totalCents).toBe(36_500);
      expect(kpis.openReceivable.buckets['0-30']).toBe(36_500);
    });
  });
});

describe.skipIf(!hasDatabase)('deduction workbench', { timeout: 120_000 }, () => {
  async function imported(tx: LedgerDb) {
    const { customer } = await kehe(tx);
    await invoice(tx, customer.id, 'INV4471001', '2026-08-28', 1_000_000);
    const [advice] = await advicesOf('kehe_worked_example_2026-09-11.csv');
    posted(await postRemittanceAdvice(advice, { customerId: customer.id }, ctx(tx)));
    const c = await deductionByNo(tx, 'KEHE-INV4471001C');
    return { customer, c };
  }

  it('Entry B: dispute, then full recovery — cash in, Cr 1210, no revenue', async () => {
    await withRollback(async (tx) => {
      const { customer, c } = await imported(tx);

      const disputed = await disputeDeduction(c.id, { date: '2026-09-15', reference: 'KSOLVE 771204' }, ctx(tx));
      expect([disputed.status, disputed.disputeDeadline, disputed.disputeReference]).toEqual(['disputed', '2027-03-10', 'KSOLVE 771204']);

      const queue = await openDeductions({ customerId: customer.id, asOf: '2026-09-15' }, ctx(tx));
      expect(queue.map((r) => [r.deduction.deductionNo, r.openCents, r.alert])).toEqual([['KEHE-INV4471001C', 36_500, 'none']]);

      const over = await refusal(tx, (sp) => recoverDeduction(c.id, { date: '2026-10-01', amountCents: 40_000 }, ctx(sp)));
      expect(over).toBeInstanceOf(TradeError);
      expect((over as TradeError).code).toBe('over_resolution');

      const recovered = await recoverDeduction(c.id, { date: '2026-10-01', amountCents: 36_500 }, ctx(tx));
      await checkNow(tx);
      expect(await entryByAccount(tx, recovered.entryId)).toEqual([
        [ACCOUNTS.UNDEPOSITED_FUNDS, 36_500, 0],
        [ACCOUNTS.DEDUCTIONS_RECEIVABLE, 0, 36_500],
      ]);
      expect([recovered.deduction.status, recovered.deduction.recoveredCents, recovered.deduction.writtenOffCents]).toEqual(['recovered', 36_500, 0]);
      expect(recovered.deduction.resolvedAt).not.toBeNull();

      const again = await refusal(tx, (sp) => writeOffDeduction(c.id, { date: '2026-10-02' }, ctx(sp)));
      expect((again as TradeError).code).toBe('invalid_state');

      const kpis = await tradeKpis({ from: '2026-09-01', to: '2026-12-31', customerId: customer.id, asOf: '2026-10-01' }, ctx(tx));
      expect(kpis.disputes).toMatchObject({ casesClosed: 1, casesWon: 1, closedCents: 36_500, recoveredCents: 36_500, recoveryRate: 1, winRate: 1 });
      expect(kpis.openReceivable.totalCents).toBe(0);
    });
  });

  it('partial recovery: $250 allowed, $115 written off, one entry', async () => {
    await withRollback(async (tx) => {
      const { c } = await imported(tx);
      const result = await recoverDeduction(c.id, { date: '2026-10-01', amountCents: 25_000, writeOffRemainder: true }, ctx(tx));
      await checkNow(tx);
      expect(await entryByAccount(tx, result.entryId)).toEqual([
        [ACCOUNTS.UNDEPOSITED_FUNDS, 25_000, 0],
        [ACCOUNTS.DEDUCTIONS_RECEIVABLE, 0, 36_500],
        [ACCOUNTS.UNAUTHORIZED_DEDUCTIONS, 11_500, 0],
      ]);
      expect([result.deduction.status, result.deduction.recoveredCents, result.deduction.writtenOffCents]).toEqual([
        'partially_recovered',
        25_000,
        11_500,
      ]);
      // Nothing left open, so it drops out of the aging view.
      const aging = await tx.execute<{ n: number }>(sql`select count(*)::int as n from deduction_aging where id = ${c.id}`);
      expect(aging[0].n).toBe(0);
    });
  });

  it('partial recovery in two steps, then write-off of the rest', async () => {
    await withRollback(async (tx) => {
      const { c } = await imported(tx);
      const first = await recoverDeduction(c.id, { date: '2026-10-01', amountCents: 10_000 }, ctx(tx));
      expect([first.deduction.status, first.deduction.recoveredCents]).toEqual(['partially_recovered', 10_000]);
      const rest = await writeOffDeduction(c.id, { date: '2026-11-01', reason: 'K-Solve denied' }, ctx(tx));
      await checkNow(tx);
      expect(await entryByAccount(tx, rest.entryId)).toEqual([
        [ACCOUNTS.DEDUCTIONS_RECEIVABLE, 0, 26_500],
        [ACCOUNTS.UNAUTHORIZED_DEDUCTIONS, 26_500, 0],
      ]);
      expect([rest.deduction.recoveredCents, rest.deduction.writtenOffCents, rest.deduction.status]).toEqual([10_000, 26_500, 'partially_recovered']);
    });
  });

  it('Entry C: write-off — Dr 4590 / Cr 1210', async () => {
    await withRollback(async (tx) => {
      const { c } = await imported(tx);
      const result = await writeOffDeduction(c.id, { date: '2027-03-11', reason: 'window closed' }, ctx(tx));
      await checkNow(tx);
      expect(await entryByAccount(tx, result.entryId)).toEqual([
        [ACCOUNTS.DEDUCTIONS_RECEIVABLE, 0, 36_500],
        [ACCOUNTS.UNAUTHORIZED_DEDUCTIONS, 36_500, 0],
      ]);
      expect([result.deduction.status, result.deduction.writtenOffCents]).toEqual(['written_off', 36_500]);
    });
  });

  it('refuses a dispute after the window, and the database refuses over-resolution too', async () => {
    await withRollback(async (tx) => {
      const { c } = await imported(tx);
      const late = await refusal(tx, (sp) => disputeDeduction(c.id, { date: '2027-03-11' }, ctx(sp)));
      expect((late as TradeError).code).toBe('window_closed');

      const db = await refusal(tx, (sp) =>
        sp.update(deductions).set({ recoveredCents: 30_000, writtenOffCents: 10_000 }).where(eq(deductions.id, c.id)),
      );
      expect(String((db as { cause?: unknown }).cause ?? db)).toMatch(/deduction_resolution_within_amount/);
    });
  });

  it('validate a valid shortage: a billing correction to gross sales, not trade spend', async () => {
    await withRollback(async (tx) => {
      const { c } = await imported(tx);
      const result = await validateDeduction(c.id, { date: '2026-10-01' }, ctx(tx));
      await checkNow(tx);
      expect(await entryByAccount(tx, result.entryId)).toEqual([
        [ACCOUNTS.DEDUCTIONS_RECEIVABLE, 0, 36_500],
        [ACCOUNTS.SALES_DISTRIBUTOR, 36_500, 0],
      ]);
      expect([result.deduction.status, result.deduction.treatment]).toEqual(['validated', 'billing_correction']);
    });
  });
});

describe.skipIf(!hasDatabase)('remittance import — what is surfaced, never dropped', { timeout: 120_000 }, () => {
  const HEAD =
    'source_system,payment_number,payment_date,payment_method,payment_total,region_dc,line_type,document_number,reference_invoice_number,invoice_date,reason_code,reason_description,deal_number,line_amount,currency';

  it('an unknown reason code lands in 1210 as unapplied, and validates once classified', async () => {
    await withRollback(async (tx) => {
      const { customer } = await kehe(tx);
      await invoice(tx, customer.id, 'INV9001', '2026-09-01', 50_000);
      const advice = await inlineAdvice(
        [
          HEAD,
          'KEHE,ZZ-P1,09/20/2026,ACH,480.00,05,INVOICE,,INV9001,09/01/2026,,,,500.00,USD',
          'KEHE,ZZ-P1,09/20/2026,ACH,480.00,05,DEDUCTION,INV9001XQZ,INV9001,09/01/2026,XQZ,MYSTERY CHARGE,,-20.00,USD',
        ].join('\n'),
      );
      const result = posted(await postRemittanceAdvice(advice, { customerId: customer.id }, ctx(tx)));
      expect(result.issues.map((i) => i.code)).toContain('reason.unmapped');
      expect(await entryByAccount(tx, result.entryId)).toEqual([
        [ACCOUNTS.UNDEPOSITED_FUNDS, 48_000, 0],
        [ACCOUNTS.AR, 0, 50_000],
        [ACCOUNTS.DEDUCTIONS_RECEIVABLE, 2_000, 0],
      ]);
      const d = await deductionByNo(tx, 'KEHE-INV9001XQZ');
      expect([d.reasonCode, d.sourceReasonCode, d.treatment, d.status]).toEqual([null, 'XQZ', 'suspense', 'open']);
      const [line] = await tx.select().from(remittanceLines).where(eq(remittanceLines.id, d.remittanceLineId ?? ''));
      expect([line.reasonCode, line.sourceReasonCode]).toEqual([null, 'XQZ']);

      const unclassified = await refusal(tx, (sp) => validateDeduction(d.id, { date: '2026-09-30' }, ctx(sp)));
      expect((unclassified as TradeError).code).toBe('needs_classification');

      const validated = await validateDeduction(d.id, { date: '2026-09-30', reasonCode: 'KEHE:G' }, ctx(tx));
      await checkNow(tx);
      expect(await entryByAccount(tx, validated.entryId)).toEqual([
        [ACCOUNTS.DEDUCTIONS_RECEIVABLE, 0, 2_000],
        [ACCOUNTS.TRADE_SPOILAGE_ALLOWANCE, 2_000, 0],
      ]);
      expect([validated.deduction.reasonCode, validated.deduction.treatment]).toEqual(['KEHE:G', 'contra_revenue']);
    });
  });

  it('an unknown invoice number posts its cash as an unapplied customer credit', async () => {
    await withRollback(async (tx) => {
      const { customer } = await kehe(tx);
      const advice = await inlineAdvice(
        [
          HEAD,
          'KEHE,ZZ-P2,09/20/2026,ACH,90.00,05,INVOICE,,INV-NOT-HERE,09/01/2026,,,,100.00,USD',
          'KEHE,ZZ-P2,09/20/2026,ACH,90.00,05,DEDUCTION,INV-NOT-HEREG,INV-NOT-HERE,09/01/2026,G,SPOILS,,-10.00,USD',
        ].join('\n'),
      );
      const result = posted(await postRemittanceAdvice(advice, { customerId: customer.id }, ctx(tx)));
      await checkNow(tx);
      expect(result.issues.map((i) => i.code)).toEqual(expect.arrayContaining(['invoice.unknown', 'deduction.invoice_unknown']));
      expect(result.plan.unappliedCents).toBe(9_000);
      expect(await entryByAccount(tx, result.entryId)).toEqual([
        [ACCOUNTS.UNDEPOSITED_FUNDS, 9_000, 0],
        [ACCOUNTS.AR, 0, 10_000],
        [ACCOUNTS.TRADE_SPOILAGE_ALLOWANCE, 1_000, 0],
      ]);
      const [receipt] = await tx.select().from(receipts).where(eq(receipts.remittanceId, result.remittanceId));
      expect([receipt.amountCents, receipt.appliedCents]).toEqual([9_000, 0]);

      // The customer's AR nets to zero: a $90 unapplied receipt and a $10 unlinked deduction, against $100 of AR relief.
      const aging = await arAging('2026-09-30', tx);
      const party = aging.parties.find((p) => p.partyId === customer.id);
      expect(party?.buckets.total).toBe(-10_000);
    });
  });

  it('a repayment line recovers the matching open deduction', async () => {
    await withRollback(async (tx) => {
      const { customer } = await kehe(tx);
      await invoice(tx, customer.id, 'INV4471001', '2026-08-28', 1_000_000);
      await invoice(tx, customer.id, 'INV4471002', '2026-09-02', 10_000);
      const [first] = await advicesOf('kehe_worked_example_2026-09-11.csv');
      posted(await postRemittanceAdvice(first, { customerId: customer.id }, ctx(tx)));

      const second = await inlineAdvice(
        [
          HEAD,
          'KEHE,ZZ-P3,10/02/2026,ACH,465.00,05,INVOICE,,INV4471002,09/02/2026,,,,100.00,USD',
          'KEHE,ZZ-P3,10/02/2026,ACH,465.00,05,REPAYMENT,INV4471001PB,INV4471001,08/28/2026,RP,REPAYMENT KSOLVE 771204,,365.00,USD',
        ].join('\n'),
      );
      const result = posted(await postRemittanceAdvice(second, { customerId: customer.id }, ctx(tx)));
      await checkNow(tx);
      expect(result.issues.filter((i) => i.severity !== 'info')).toEqual([]);
      expect(await entryByAccount(tx, result.entryId)).toEqual([
        [ACCOUNTS.UNDEPOSITED_FUNDS, 46_500, 0],
        [ACCOUNTS.AR, 0, 10_000],
        [ACCOUNTS.DEDUCTIONS_RECEIVABLE, 0, 36_500],
      ]);
      const c = await deductionByNo(tx, 'KEHE-INV4471001C');
      expect([c.status, c.recoveredCents, c.resolutionEntryId]).toEqual(['recovered', 36_500, result.entryId]);
    });
  });

  it('the full §8.1 KeHE advice posts: 15 lines, 11 deductions, $17,242.31 cash', async () => {
    await withRollback(async (tx) => {
      const { customer } = await kehe(tx);
      await invoice(tx, customer.id, 'INV4471001', '2026-08-28', 1_000_000);
      await invoice(tx, customer.id, 'INV4471002', '2026-09-02', 642_050);
      await invoice(tx, customer.id, 'INV4471003', '2026-09-04', 318_725);
      const [advice] = await advicesOf('kehe_remittance_2026-09-11.csv');
      const result = posted(await postRemittanceAdvice(advice, { customerId: customer.id }, ctx(tx)));
      await checkNow(tx);

      expect(result.deductionIds).toHaveLength(11);
      // The repayment's original deduction predates the books: surfaced, and still credited to 1210.
      expect(result.issues.map((i) => i.code)).toEqual(expect.arrayContaining(['recovery.unmatched', 'reason.by_line_type']));
      const lines = await entryByAccount(tx, result.entryId);
      expect(lines).toEqual([
        [ACCOUNTS.UNDEPOSITED_FUNDS, 1_724_231, 0],
        [ACCOUNTS.AR, 0, 1_960_775],
        [ACCOUNTS.DEDUCTIONS_RECEIVABLE, 36_500, 36_500],
        [ACCOUNTS.TRADE_OFF_INVOICE, 15_800, 0],
        [ACCOUNTS.TRADE_BILLBACK, 42_000, 0],
        [ACCOUNTS.TRADE_SCAN_DOWN, 21_240, 0],
        [ACCOUNTS.TRADE_SLOTTING, 75_000, 0],
        [ACCOUNTS.TRADE_SPOILAGE_ALLOWANCE, 9_675 + 4_710, 0],
        [ACCOUNTS.DISTRIBUTOR_FEES, 6_500 + 12_841 + 9_562, 0],
        [ACCOUNTS.EARLY_PAYMENT_DISCOUNTS, 39_216, 0],
      ]);
      const total = lines.reduce((acc, [, d, c]) => acc + d - c, 0);
      expect(total).toBe(0);

      // The terms discount has no invoice: an account-level deduction, and the customer still nets to zero.
      const aging = await arAging('2026-09-30', tx);
      const party = aging.parties.find((p) => p.partyId === customer.id);
      expect(party?.buckets.total ?? 0).toBe(0);
    });
  });

  it('quarantines an advice that does not tie, and one whose invoice is already paid', async () => {
    await withRollback(async (tx) => {
      const { customer } = await kehe(tx);
      const inv = await invoice(tx, customer.id, 'INV9100', '2026-09-01', 10_000);
      const parsed = parseRemittance(
        await readFile(
          Buffer.from(
            [HEAD, 'KEHE,ZZ-P4,09/20/2026,ACH,99.00,05,INVOICE,,INV9100,09/01/2026,,,,100.00,USD'].join('\n'),
            'utf8',
          ),
          'bad.csv',
        ),
      );
      const bad = await postRemittanceAdvice(parsed.advices[0], { customerId: customer.id }, ctx(tx));
      expect(bad.status).toBe('quarantined');
      expect(bad.issues.map((i) => i.code)).toContain('advice.identity');

      await tx.update(invoices).set({ paidCents: 10_000, status: 'paid' }).where(eq(invoices.id, inv.id));
      const paid = await inlineAdvice([HEAD, 'KEHE,ZZ-P5,09/20/2026,ACH,100.00,05,INVOICE,,INV9100,09/01/2026,,,,100.00,USD'].join('\n'));
      const refused = await postRemittanceAdvice(paid, { customerId: customer.id }, ctx(tx));
      expect(refused.status).toBe('quarantined');
      expect(refused.issues.map((i) => i.code)).toContain('invoice.not_open');
      expect(await tx.select().from(remittances).where(eq(remittances.customerId, customer.id))).toEqual([]);
    });
  });
});

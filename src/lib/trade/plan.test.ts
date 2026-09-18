/**
 * Pure parts of the trade engine: the remittance plan, reason-code resolution,
 * the accrual schedule and the KPI arithmetic. Nothing here queries the
 * database; the test-support import only loads .env.local, because the modules
 * under test share files with code that does.
 */

import { afterAll, describe, expect, it } from 'vitest';

// First: loads .env.local before '@/db/client' is imported anywhere below.
import { closeTestDb } from '@/lib/ledger/test-support';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { DeductionTreatment } from '@/db/schema';
import { readFile } from '@/lib/banking/read-file';
import { type RemittanceAdvice, parseRemittance } from '@/lib/importers/remittance';
import { ACCOUNTS } from '@/lib/ledger/coa';

import { burnAlert, windowBurn } from './deductions';
import { agingBucket, percentile, ratio } from './kpis';
import { type PlanContext, planRemittance } from './plan';
import { accrualSchedule, allowanceCents } from './promotions';
import { type ReasonCodeBook, type ReasonCodeInfo, resolveReasonCode } from './reason-codes';

afterAll(closeTestDb);

const CUSTOMER = '00000000-0000-4000-8000-000000000001';
const DEPOSIT = '00000000-0000-4000-8000-0000000000d1';
const INVOICE = '00000000-0000-4000-8000-0000000000a1';
const PROMO = '00000000-0000-4000-8000-0000000000b1';

function code(key: string, treatment: DeductionTreatment, accountCode: string | null, windowDays: number, isTradeSpend: boolean): ReasonCodeInfo {
  const [sourceSystem, sourceCode] = key.split(':');
  return {
    code: key,
    sourceSystem,
    sourceCode,
    label: key,
    category: 'test',
    treatment,
    accountId: accountCode === null ? null : `acct-${accountCode}`,
    accountCode,
    windowDays,
    isTradeSpend,
  };
}

const BOOK: ReasonCodeBook = new Map(
  [
    code('KEHE:H', 'accrual', ACCOUNTS.TRADE_BILLBACK, 180, true),
    code('KEHE:IA', 'contra_revenue', ACCOUNTS.DISTRIBUTOR_FEES, 180, true),
    code('KEHE:C', 'dispute', ACCOUNTS.DEDUCTIONS_RECEIVABLE, 180, false),
    code('KEHE:RP', 'recovery', ACCOUNTS.DEDUCTIONS_RECEIVABLE, 0, false),
    code('X12:59', 'dispute', ACCOUNTS.DEDUCTIONS_RECEIVABLE, 90, false),
    code('UNFI:UOI', 'accrual', ACCOUNTS.TRADE_BILLBACK, 60, true),
    code('UNFI:LCBOL', 'contra_revenue', ACCOUNTS.DISTRIBUTOR_FEES, 60, false),
    code('UNFI:LCP', 'contra_revenue', ACCOUNTS.DISTRIBUTOR_FEES, 60, false),
    code('UNFI:30', 'contra_revenue', ACCOUNTS.DISTRIBUTOR_FEES, 60, false),
    code('GEN:EPD', 'contra_revenue', ACCOUNTS.EARLY_PAYMENT_DISCOUNTS, 60, true),
    code('GEN:RECOVERY', 'recovery', ACCOUNTS.DEDUCTIONS_RECEIVABLE, 0, false),
  ].map((c) => [c.code, c]),
);

async function workedExample(): Promise<RemittanceAdvice> {
  const name = 'kehe_worked_example_2026-09-11.csv';
  const parsed = parseRemittance(await readFile(readFileSync(join(__dirname, '__fixtures__', name)), name));
  return parsed.advices[0];
}

function context(overrides: Partial<PlanContext> = {}): PlanContext {
  return {
    customerId: CUSTOMER,
    customerChannelId: null,
    depositAccountId: DEPOSIT,
    reasonCodes: BOOK,
    invoices: [
      {
        id: INVOICE,
        invoiceNo: 'INV-001001',
        externalId: 'INV4471001',
        customerId: CUSTOMER,
        channelId: null,
        invoiceDate: '2026-08-28',
        status: 'open',
        openCents: 1_000_000,
      },
    ],
    promotions: [],
    openDeductions: [],
    existingDeductionNos: new Set(),
    ...overrides,
  };
}

function byAccount(lines: ReturnType<typeof planRemittance>['lines']) {
  const sums = new Map<string, [number, number]>();
  for (const l of lines) {
    const k = l.accountCode ?? l.accountId ?? '?';
    const s = sums.get(k) ?? [0, 0];
    sums.set(k, [s[0] + (l.debitCents ?? 0), s[1] + (l.creditCents ?? 0)]);
  }
  return Object.fromEntries(sums);
}

describe('planRemittance — §7.3 to the cent', () => {
  it('Entry A: no accrual', async () => {
    const plan = planRemittance(await workedExample(), context());
    expect(plan.postable).toBe(true);
    expect(byAccount(plan.lines)).toEqual({
      [DEPOSIT]: [915_000, 0],
      [`acct-${ACCOUNTS.TRADE_BILLBACK}`]: [42_000, 0],
      [`acct-${ACCOUNTS.DISTRIBUTOR_FEES}`]: [6_500, 0],
      [ACCOUNTS.DEDUCTIONS_RECEIVABLE]: [36_500, 0],
      [ACCOUNTS.AR]: [0, 1_000_000],
    });
    expect(plan.applications).toEqual([{ invoiceId: INVOICE, amountCents: 915_000 }]);
    expect(plan.invoiceDeductions).toEqual([{ invoiceId: INVOICE, amountCents: 85_000 }]);
    expect([plan.receiptCents, plan.unappliedCents, plan.deductionsCents]).toEqual([915_000, 0, 85_000]);
    expect(plan.deductions.map((d) => [d.deductionNo, d.treatment, d.status, d.disputeDeadline])).toEqual([
      ['KEHE-INV4471001H', 'contra_revenue', 'validated', null],
      ['KEHE-INV4471001IA', 'contra_revenue', 'validated', null],
      ['KEHE-INV4471001C', 'dispute', 'open', '2027-03-10'],
    ]);
  });

  it("Entry A′: the $565 accrual absorbs the $420 promo and the $65 fee", async () => {
    const plan = planRemittance(
      await workedExample(),
      context({ promotions: [{ id: PROMO, name: 'MCB', authorizationNo: '88214', remainingAccrualCents: 56_500 }] }),
    );
    expect(byAccount(plan.lines)).toEqual({
      [DEPOSIT]: [915_000, 0],
      [ACCOUNTS.ACCRUED_TRADE_SPEND]: [48_500, 0],
      [ACCOUNTS.DEDUCTIONS_RECEIVABLE]: [36_500, 0],
      [ACCOUNTS.AR]: [0, 1_000_000],
    });
    expect(plan.accrualCharges).toEqual([{ promotionId: PROMO, amountCents: 48_500 }]);
  });

  it('an accrual smaller than the deductions: the excess goes to contra revenue', async () => {
    const plan = planRemittance(
      await workedExample(),
      context({ promotions: [{ id: PROMO, name: 'MCB', authorizationNo: '88214', remainingAccrualCents: 30_000 }] }),
    );
    expect(byAccount(plan.lines)).toMatchObject({
      [ACCOUNTS.ACCRUED_TRADE_SPEND]: [30_000, 0],
      [`acct-${ACCOUNTS.TRADE_BILLBACK}`]: [12_000, 0],
      [`acct-${ACCOUNTS.DISTRIBUTOR_FEES}`]: [6_500, 0],
    });
  });

  it('refuses an invoice of another customer and a paid invoice', async () => {
    const other = planRemittance(
      await workedExample(),
      context({ invoices: [{ ...context().invoices[0], customerId: '00000000-0000-4000-8000-000000000002' }] }),
    );
    expect(other.postable).toBe(false);
    expect(other.issues.map((i) => i.code)).toContain('invoice.other_customer');

    const paid = planRemittance(await workedExample(), context({ invoices: [{ ...context().invoices[0], status: 'paid', openCents: 0 }] }));
    expect(paid.issues.map((i) => i.code)).toEqual(expect.arrayContaining(['invoice.not_open']));
  });

  it('suffixes a re-issued document number rather than colliding', async () => {
    const plan = planRemittance(await workedExample(), context({ existingDeductionNos: new Set(['KEHE-INV4471001C']) }));
    expect(plan.deductions.find((d) => d.sourceReasonCode === 'C')?.deductionNo).toBe('KEHE-INV4471001C#2');
    expect(plan.issues.map((i) => i.code)).toContain('deduction.number_reused');
  });
});

describe('resolveReasonCode', () => {
  it('matches exactly within the source, then UNFI patterns, then X12, then by line type', () => {
    expect(resolveReasonCode(BOOK, 'KEHE', 'H', 'DEDUCTION')?.info.code).toBe('KEHE:H');
    expect(resolveReasonCode(BOOK, 'UNFI', 'UOI0826', 'DEDUCTION')).toMatchObject({ via: 'pattern', info: { code: 'UNFI:UOI' } });
    expect(resolveReasonCode(BOOK, 'UNFI', 'LCBOL(4471882)', 'DEDUCTION')?.info.code).toBe('UNFI:LCBOL');
    expect(resolveReasonCode(BOOK, 'UNFI', 'LCP4471882', 'DEDUCTION')?.info.code).toBe('UNFI:LCP');
    expect(resolveReasonCode(BOOK, 'UNFI', '37', 'DEDUCTION')?.info.code).toBe('UNFI:30');
    expect(resolveReasonCode(BOOK, 'KEHE', '59', 'DEDUCTION')).toMatchObject({ via: 'x12', info: { code: 'X12:59' } });
    expect(resolveReasonCode(BOOK, 'KEHE', 'CD', 'DISCOUNT')).toMatchObject({ via: 'line_type', info: { code: 'GEN:EPD' } });
    expect(resolveReasonCode(BOOK, 'KEHE', 'PB', 'REPAYMENT')?.info.code).toBe('GEN:RECOVERY');
    expect(resolveReasonCode(BOOK, 'KEHE', 'XQZ', 'DEDUCTION')).toBeNull();
  });
});

describe('accrualSchedule', () => {
  it('puts a one-month promotion in its month', () => {
    expect(accrualSchedule({ from: '2026-08-01', to: '2026-08-28' }, 50_000, 6_500)).toEqual([
      { year: 2026, month: 8, periodEnd: '2026-08-31', days: 28, allowanceCents: 50_000, feeCents: 6_500 },
    ]);
  });

  it('spreads across months by days and sums to the plan exactly', () => {
    const months = accrualSchedule({ from: '2026-08-15', to: '2026-10-14' }, 100_001, 3_333);
    expect(months.map((m) => [m.month, m.days])).toEqual([
      [8, 17],
      [9, 30],
      [10, 14],
    ]);
    expect(months.reduce((a, m) => a + m.allowanceCents, 0)).toBe(100_001);
    expect(months.reduce((a, m) => a + m.feeCents, 0)).toBe(3_333);
  });

  it('extends units × allowance exactly', () => {
    expect(allowanceCents([{ plannedUnits: '500', allowancePerUnitCents: 100 }])).toBe(50_000);
    expect(allowanceCents([{ plannedUnits: '2.5', allowancePerUnitCents: 333 }, { plannedUnits: 3, allowancePerUnitCents: 125 }])).toBe(833 + 375);
  });
});

describe('KPI arithmetic', () => {
  it('ratios, percentiles, buckets and window burn', () => {
    expect(ratio(85_000, 1_000_000)).toBe(0.085);
    expect(ratio(1, 0)).toBeNull();
    expect(percentile([14, 3, 30, 60, 7], 0.5)).toBe(14);
    expect(percentile([14, 3, 30, 60, 7], 0.9)).toBe(60);
    expect(percentile([], 0.5)).toBeNull();
    expect([agingBucket(0), agingBucket(31), agingBucket(90), agingBucket(181)]).toEqual(['0-30', '31-60', '61-90', '180+']);
    expect(windowBurn('2026-09-11', '2027-03-10', '2026-12-31')).toBe(0.617);
    expect(burnAlert(windowBurn('2026-09-11', '2027-03-10', '2026-12-31'))).toBe('alert');
    expect(burnAlert(0.85)).toBe('escalate');
    expect(burnAlert(1.2)).toBe('expired');
    expect(burnAlert(null)).toBe('none');
  });
});

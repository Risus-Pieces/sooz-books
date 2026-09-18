import { afterAll, describe, expect, it } from 'vitest';

// First: loads .env.local before '@/db/client' is imported anywhere below.
import { closeTestDb, hasDatabase, withRollback } from '@/lib/ledger/test-support';

import { accountId, makeBankAccount, makeBankLine, makeCustomer, makeVendor } from '@/lib/arap/test-support';
import { createAndApproveBill } from '@/lib/arap/bills';
import { createAndIssueInvoice } from '@/lib/arap/invoices';
import { ACCOUNTS } from '@/lib/ledger/coa';
import { postJournalEntry } from '@/lib/ledger/post';

import { actualCashFlows, cashPosition } from './cash-position';
import { actualWeeks, buildCashForecast, createForecastItem, scoreSnapshot, snapshotForecast } from './forecast';

/** A Wednesday far from any real or fixture activity. */
const AS_OF = '2031-03-05';

afterAll(closeTestDb);

describe.skipIf(!hasDatabase)('cash position against the real Relay data', () => {
  it(
    'agrees with the bank running balance on every account (the books and the bank say the same)',
    async () => {
      await withRollback(async (tx) => {
        const position = await cashPosition('2026-09-18', tx);
        expect(position.asOf).toBe('2026-09-18');
        for (const account of position.accounts) {
          if (account.statementBalanceCents === null) continue;
          expect(account.cashCents, account.name).toBe(account.statementBalanceCents);
        }
        expect(position.cashCents).toBe(
          position.ledgerCents + position.unpostedOpeningCents + position.unpostedActivityCents,
        );
      });
    },
    30_000,
  );
});

describe.skipIf(!hasDatabase)('thirteen-week forecast', () => {
  it(
    'adds open AR, open AP and weighted, recurring forecast items to opening cash exactly',
    async () => {
      await withRollback(async (tx) => {
        const baseline = await buildCashForecast({ asOf: AS_OF }, tx);
        const ctx = { userId: null, tx };

        // An overdue receivable (due 20 Feb) and a payable due 15 April.
        const customer = await makeCustomer(tx);
        await createAndIssueInvoice(
          {
            customerId: customer.id,
            invoiceDate: '2031-01-21',
            dueDate: '2031-02-20',
            lines: [{ description: 'Cases', unitPriceCents: 20_000 }],
          },
          ctx,
        );
        const vendor = await makeVendor(tx);
        await createAndApproveBill(
          {
            vendorId: vendor.id,
            billNo: `FC-${Date.now()}`,
            billDate: '2031-03-01',
            dueDate: '2031-04-15',
            lines: [{ description: 'Software', accountId: await accountId(tx, ACCOUNTS.SOFTWARE), amountCents: 40_000 }],
          },
          ctx,
        );

        await createForecastItem(
          { label: 'Founder top-up', category: 'financing', direction: 'inflow', amountCents: 150_001, expectedDate: '2031-03-10', confidence: '0.500' },
          ctx,
        );
        await createForecastItem(
          { label: 'Kitchen rent', category: 'rent', direction: 'outflow', amountCents: 30_000, expectedDate: '2031-01-31', recurrence: 'monthly' },
          ctx,
        );
        await createForecastItem(
          { label: 'Demo staff', category: 'payroll', direction: 'outflow', amountCents: 5_000, expectedDate: '2031-02-26', recurrence: 'weekly', endDate: '2031-03-26' },
          ctx,
        );
        await createForecastItem(
          { label: 'Late label deposit', category: 'inventory', direction: 'outflow', amountCents: 1_000, expectedDate: '2031-03-01' },
          ctx,
        );

        const forecast = await buildCashForecast({ asOf: AS_OF }, tx);
        expect(forecast.horizonEnd).toBe('2031-06-01');
        expect(forecast.opening.cashCents).toBe(baseline.opening.cashCents);

        const expectedIn = [20_000, 75_001, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
        const expectedOut = [1_000, 5_000, 5_000, 5_000, 30_000, 0, 40_000, 0, 30_000, 0, 0, 0, 30_000];
        let cumulative = 0;
        forecast.weeks.forEach((week, i) => {
          const base = baseline.weeks[i];
          expect(week.inflowCents - base.inflowCents, `inflow ${week.weekStart}`).toBe(expectedIn[i]);
          expect(week.outflowCents - base.outflowCents, `outflow ${week.weekStart}`).toBe(expectedOut[i]);
          cumulative += expectedIn[i] - expectedOut[i];
          expect(week.closingCents - base.closingCents, `closing ${week.weekStart}`).toBe(cumulative);
          expect(week.closingCents).toBe(week.openingCents + week.inflowCents - week.outflowCents);
        });
        expect(forecast.weeks[0].arInflowCents - baseline.weeks[0].arInflowCents).toBe(20_000);
        expect(forecast.weeks[6].apOutflowCents - baseline.weeks[6].apOutflowCents).toBe(40_000);
        expect(forecast.overdueInflowCents - baseline.overdueInflowCents).toBe(20_000);
        expect(forecast.overdueOutflowCents - baseline.overdueOutflowCents).toBe(1_000);
        expect(forecast.warnings.some((w) => w.includes('past due'))).toBe(true);
      });
    },
    60_000,
  );

  it(
    'computes the burn runway from operating cash only, leaving founder money out',
    async () => {
      await withRollback(async (tx) => {
        const bank = await makeBankAccount(tx);
        const asOf = '2031-09-30';
        const before = await buildCashForecast({ asOf, burnWindowDays: 30 }, tx);

        // Inside the 30-day window: $900 of spend, $100 of sales, $2,000 from the founder.
        await makeBankLine(tx, bank.id, { date: '2031-09-10', amountCents: -90_000, description: 'CO-MAN DEPOSIT' });
        await makeBankLine(tx, bank.id, { date: '2031-09-12', amountCents: 10_000, description: 'SQUARE INC' });
        await postJournalEntry(
          {
            date: '2031-09-15',
            sourceType: 'manual',
            memo: 'Founder contribution',
            lines: [
              { accountId: bank.accountId, debitCents: 200_000 },
              { accountCode: ACCOUNTS.MEMBER_CONTRIBUTIONS, creditCents: 200_000 },
            ],
          },
          { userId: null, tx },
        );

        const after = await buildCashForecast({ asOf, burnWindowDays: 30 }, tx);
        expect(after.opening.cashCents - before.opening.cashCents).toBe(120_000);
        expect(after.burn.operatingOutflowCents - before.burn.operatingOutflowCents).toBe(90_000);
        expect(after.burn.operatingInflowCents - before.burn.operatingInflowCents).toBe(10_000);
        expect(after.burn.financingInflowCents - before.burn.financingInflowCents).toBe(200_000);
        expect(after.burn.netBurnCents - before.burn.netBurnCents).toBe(80_000);

        // The runway figure is exactly floor(cash × window ÷ burn).
        expect(after.burn.netBurnCents).toBeGreaterThan(0);
        expect(after.burn.runwayDays).toBe(Math.floor((after.opening.cashCents * 30) / after.burn.netBurnCents));
      });
    },
    60_000,
  );
});

describe.skipIf(!hasDatabase)('forecast snapshots', () => {
  it(
    'freezes a forecast once and scores it against what the bank and ledger show',
    async () => {
      await withRollback(async (tx) => {
        const ctx = { userId: null, tx };
        const bank = await makeBankAccount(tx);
        const baselineActual = await actualWeeks(AS_OF, '2031-03-23', tx);
        const baselineForecast = await buildCashForecast({ asOf: AS_OF }, tx);

        await createForecastItem(
          { label: 'Expected wholesale payment', category: 'other', direction: 'inflow', amountCents: 12_000, expectedDate: '2031-03-12' },
          ctx,
        );
        const snapshot = await snapshotForecast(AS_OF, ctx);
        expect(snapshot.weeks).toHaveLength(13);
        await expect(snapshotForecast(AS_OF, ctx)).rejects.toThrow(/already snapshotted/);

        // What happened: $100 in on the 12th, a $30 card-less software charge posted on
        // the 11th, a $25 debit on the 20th not yet in the ledger.
        await makeBankLine(tx, bank.id, { date: '2031-03-12', amountCents: 10_000, description: 'WHOLESALE ACH' });
        await makeBankLine(tx, bank.id, { date: '2031-03-20', amountCents: -2_500, description: 'FEDEX' });
        await postJournalEntry(
          {
            date: '2031-03-11',
            sourceType: 'manual',
            lines: [
              { accountCode: ACCOUNTS.SOFTWARE, debitCents: 3_000 },
              { accountId: bank.accountId, creditCents: 3_000 },
            ],
          },
          ctx,
        );

        const score = await scoreSnapshot(snapshot.id, { through: '2031-03-23' }, tx);
        expect(score.weeks.map((w) => w.weekStart)).toEqual(['2031-03-03', '2031-03-10', '2031-03-17']);
        expect(score.unscoredWeeks).toBe(10);

        const actual = score.weeks.map((w, i) => ({
          in: w.actual.inflowCents - baselineActual[i].inflowCents,
          out: w.actual.outflowCents - baselineActual[i].outflowCents,
        }));
        expect(actual).toEqual([
          { in: 0, out: 0 },
          { in: 10_000, out: 3_000 },
          { in: 0, out: 2_500 },
        ]);
        // Projected 12,000 in during week two; 10,000 arrived.
        expect(score.weeks[1].projected.inflowCents - baselineForecast.weeks[1].inflowCents).toBe(12_000);
        expect(score.weeks[1].inflowVarianceCents).toBe(
          score.weeks[1].actual.inflowCents - score.weeks[1].projected.inflowCents,
        );

        // The actual weeks roll forward to exactly the cash the books show at the end.
        const end = await cashPosition('2031-03-23', tx);
        expect(score.weeks[2].actual.closingCents).toBe(end.cashCents);
        const flows = await actualCashFlows(AS_OF, '2031-03-23', tx);
        const start = await cashPosition(AS_OF, tx);
        expect(start.cashCents + flows.reduce((s, f) => s + f.amountCents, 0)).toBe(end.cashCents);
      });
    },
    60_000,
  );
});

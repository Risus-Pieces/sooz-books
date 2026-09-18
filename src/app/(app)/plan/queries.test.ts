import { afterAll, describe, expect, it } from 'vitest';

// First: loads .env.local before '@/db/client' is imported anywhere below.
import { closeTestDb, hasDatabase, withRollback } from '@/lib/ledger/test-support';

import { ACCOUNTS } from '@/lib/ledger/coa';
import { createBudgetVersion, setBudgetLines } from '@/lib/planning/budget';
import { BVA_ROWS, budgetVsActual } from '@/lib/planning/budget-vs-actual';

import { budgetGrid, varianceRows } from './queries';

afterAll(closeTestDb);

describe.skipIf(!hasDatabase)('plan queries', () => {
  it(
    'lays out the budget grid by account and month, and colours variance by favourability',
    async () => {
      await withRollback(async (tx) => {
        const ctx = { userId: null, tx };
        const version = await createBudgetVersion({ name: 'queries test', fiscalYear: 2041 }, ctx);
        await setBudgetLines(
          version.id,
          [
            { accountCode: ACCOUNTS.SALES_DTC, month: 1, amountCents: 50_000 },
            { accountCode: ACCOUNTS.SALES_DTC, month: 3, amountCents: 70_001 },
            { accountCode: ACCOUNTS.RENT, month: 1, amountCents: 20_000 },
          ],
          ctx,
        );

        const grid = await budgetGrid(version.id, tx);
        expect(grid.channelCells).toBe(0);
        const sales = grid.rows.find((r) => r.code === ACCOUNTS.SALES_DTC);
        expect(sales?.type).toBe('revenue');
        expect(sales?.months).toEqual([50_000, null, 70_001, null, null, null, null, null, null, null, null, null]);
        const rent = grid.rows.find((r) => r.code === ACCOUNTS.RENT);
        expect(rent?.type).toBe('expense');
        expect(rent?.months[0]).toBe(20_000);

        const report = await budgetVsActual({ versionId: version.id, from: '2041-01-01', to: '2041-03-31' }, tx);
        const rows = varianceRows(report);
        const salesRow = rows.find((r) => r.code === ACCOUNTS.SALES_DTC);
        const rentRow = rows.find((r) => r.code === ACCOUNTS.RENT);
        const net = rows.find((r) => r.id === BVA_ROWS.netIncome);

        // Nothing posted in 2041: actual 0, so revenue is under budget (unfavourable) and
        // rent is under budget (favourable). The sign stays arithmetic; favourability is a flag.
        expect(salesRow).toMatchObject({ actualCents: 0, budgetCents: 120_001, varianceCents: -120_001, incomeLike: true });
        expect(rentRow).toMatchObject({ actualCents: 0, budgetCents: 20_000, varianceCents: -20_000, incomeLike: false });
        expect(net).toMatchObject({ budgetCents: 100_001, varianceCents: -100_001, incomeLike: true, style: 'total' });
        expect(salesRow?.drilldownHref).toMatch(/^\/reports\/general-ledger\?account=/);
      });
    },
    60_000,
  );
});

import { afterAll, describe, expect, it } from 'vitest';

// First: loads .env.local before '@/db/client' is imported anywhere below.
import { closeTestDb, hasDatabase, withRollback } from '@/lib/ledger/test-support';

import { and, eq, sql } from 'drizzle-orm';

import { closeChecklists } from '@/db/schema';
import { closeMonth, createCloseChecklist, reopenMonth, skipCloseTask } from '@/lib/close/checklist';
import { NotPermittedError } from '@/lib/ledger/errors';
import { isPeriodOpen } from '@/lib/ledger/periods';

afterAll(closeTestDb);

const YEAR = 2042;
const MONTH = 2;

describe.skipIf(!hasDatabase)('reopening a month closed through its checklist', () => {
  it(
    'reopens the period and puts the checklist back in progress, owner only',
    async () => {
      await withRollback(async (tx) => {
        const [owner] = await tx.execute<{ id: string }>(
          sql`select id from app_users where role = 'owner' and active order by created_at limit 1`,
        );
        expect(owner).toBeDefined();
        const ctx = { userId: owner.id, tx };

        const created = await createCloseChecklist(YEAR, MONTH, ctx);
        for (const task of created.tasks) {
          await skipCloseTask(task.id, 'reopen test: skipped on purpose', ctx);
        }
        const closed = await closeMonth(created.checklist.id, ctx);
        expect(closed.periodStatus).toBe('closed');
        expect(closed.checklist.status).toBe('complete');

        await expect(reopenMonth(YEAR, MONTH, { userId: null, tx })).rejects.toBeInstanceOf(NotPermittedError);

        const reopened = await reopenMonth(YEAR, MONTH, ctx);
        expect(reopened?.periodStatus).toBe('open');
        expect(reopened?.checklist.status).toBe('in_progress');
        expect(await isPeriodOpen(`${YEAR}-0${MONTH}-15`, tx)).toBe(true);

        const [row] = await tx
          .select({ status: closeChecklists.status, completedAt: closeChecklists.completedAt })
          .from(closeChecklists)
          .where(and(eq(closeChecklists.year, YEAR), eq(closeChecklists.month, MONTH)));
        expect(row).toEqual({ status: 'in_progress', completedAt: null });
      });
    },
    120_000,
  );

  it(
    'reopens a month that was closed without a checklist and returns no checklist',
    async () => {
      await withRollback(async (tx) => {
        const [owner] = await tx.execute<{ id: string }>(
          sql`select id from app_users where role = 'owner' and active order by created_at limit 1`,
        );
        await tx.execute(sql`insert into periods (year, month, status, closed_at) values (${YEAR}, 3, 'closed', now())`);
        expect(await reopenMonth(YEAR, 3, { userId: owner.id, tx })).toBeNull();
        expect(await isPeriodOpen(`${YEAR}-03-15`, tx)).toBe(true);
      });
    },
    60_000,
  );
});

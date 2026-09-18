/**
 * The month-end close checklist.
 *
 * A checklist is created for a month with the standard tasks. Most are
 * automatic: the system runs the check (`./checks`) and the task is `done` when
 * it passes and `blocked` when it does not, with what it found in `result`. The
 * rest are ticked by a person. Any task can be skipped, but only with a reason —
 * the database refuses a skipped task with no note (0040) — because a skipped
 * blocking task is a decision to close over something, and the reason is the
 * record of that decision.
 *
 * `closeMonth` re-runs every automatic check first, so a period is never closed
 * on a stale pass, then closes it with `periods.closePeriod` only when every
 * blocking task is done or skipped. Otherwise it refuses and lists what is left.
 */

import { and, asc, eq } from 'drizzle-orm';

import { type CloseChecklist, type CloseTask, type CloseTaskStatus, closeChecklists, closeTasks } from '@/db/schema';
import { db, withActor } from '@/db/client';
import { closePeriod, periodEnd, periodFor, periodStart, reopenPeriod } from '@/lib/ledger/periods';
import type { LedgerDb } from '@/lib/ledger/post';

import { type AutoCheck, type CheckOptions, isAutoCheck, runCheck } from './checks';
import { CloseError, type OutstandingTask } from './errors';

export interface CloseCtx {
  userId: string | null;
  /** An open transaction with `app.user_id` already set (see `withActor`). */
  tx?: LedgerDb;
}

function inTx<T>(ctx: CloseCtx, fn: (tx: LedgerDb) => Promise<T>): Promise<T> {
  return ctx.tx ? fn(ctx.tx) : withActor(ctx.userId, fn);
}

export interface StandardTask {
  key: string;
  label: string;
  description: string;
  blocking: boolean;
  autoCheck: AutoCheck | null;
}

/** The standard close, in the order it is worked. */
export const STANDARD_TASKS: readonly StandardTask[] = [
  {
    key: 'bank_transactions_reviewed',
    label: 'Review every bank transaction',
    description: 'No bank line dated in the month is still unreviewed. Mixed-use payees default to a business expense; re-tag personal purchases to Owner Draws.',
    blocking: true,
    autoCheck: 'bank_unreviewed_zero',
  },
  {
    key: 'recurring_raised',
    label: 'Raise recurring entries',
    description: 'Rent, depreciation and standing accruals due in the month have been generated.',
    blocking: true,
    autoCheck: 'recurring_raised',
  },
  {
    key: 'accruals_booked',
    label: 'Book accruals and prepaid amortisation',
    description: 'Expenses incurred but not billed are accrued; prepaid amounts used in the month are expensed.',
    blocking: true,
    autoCheck: null,
  },
  {
    key: 'no_draft_entries',
    label: 'No draft entries in the month',
    description: 'Every draft dated in the month is posted or deleted. A draft cannot post once the month is closed.',
    blocking: true,
    autoCheck: 'no_draft_entries',
  },
  {
    key: 'bank_recs_complete',
    label: 'Reconcile every bank account',
    description: 'A completed reconciliation covers the month end for every active bank account with activity.',
    blocking: true,
    autoCheck: 'bank_recs_complete',
  },
  {
    key: 'clearing_zero',
    label: 'Clearing accounts at zero',
    description: 'Square, Shopify, Amazon and Faire clearing accounts are cleared by their deposits. A payout in transit over month end is an acceptable exception, skipped with that reason.',
    blocking: true,
    autoCheck: 'clearing_zero',
  },
  {
    key: 'ar_ties',
    label: 'Receivables aging ties to AR',
    description: 'The AR aging total equals the Accounts Receivable control account.',
    blocking: true,
    autoCheck: 'ar_ties',
  },
  {
    key: 'ap_ties',
    label: 'Payables aging ties to AP',
    description: 'The AP aging total equals the Accounts Payable control account.',
    blocking: true,
    autoCheck: 'ap_ties',
  },
  {
    key: 'cogs_posted',
    label: 'Post the COGS batch',
    description: 'If anything shipped in the month, its cost of goods sold batch is posted.',
    blocking: true,
    autoCheck: 'cogs_posted',
  },
  {
    key: 'inventory_tieout',
    label: 'Inventory ties to the count',
    description: 'The Peasy count for the month end is within tolerance of the ledger inventory accounts.',
    blocking: true,
    autoCheck: 'inventory_tieout',
  },
  {
    key: 'trial_balance_balances',
    label: 'Trial balance balances',
    description: 'Debits equal credits at the month end.',
    blocking: true,
    autoCheck: 'trial_balance_balances',
  },
  {
    key: 'review_statements',
    label: 'Review the statements',
    description: 'Read the P&L, balance sheet and cash flow for the month and investigate anything unexpected.',
    blocking: true,
    autoCheck: null,
  },
];

export interface ChecklistView {
  checklist: CloseChecklist;
  tasks: CloseTask[];
  periodStatus: 'open' | 'closed';
  /** Blocking tasks neither done nor skipped. Empty means the month can close. */
  outstanding: OutstandingTask[];
}

function outstandingOf(tasks: readonly CloseTask[]): OutstandingTask[] {
  return tasks
    .filter((t) => t.blocking && t.status !== 'done' && t.status !== 'skipped')
    .map((t) => ({ key: t.key, label: t.label, status: t.status, message: t.result?.message ?? null }));
}

async function view(exec: LedgerDb, checklist: CloseChecklist): Promise<ChecklistView> {
  const tasks = await exec
    .select()
    .from(closeTasks)
    .where(eq(closeTasks.checklistId, checklist.id))
    .orderBy(asc(closeTasks.sortOrder), asc(closeTasks.key));
  const period = await periodFor(periodStart(checklist.year, checklist.month), exec);
  return { checklist, tasks, periodStatus: period.status, outstanding: outstandingOf(tasks) };
}

/**
 * Creates the checklist for a month with the standard tasks, or returns the one
 * that exists, adding any standard task it is missing. Safe to call repeatedly.
 */
export async function createCloseChecklist(year: number, month: number, ctx: CloseCtx): Promise<ChecklistView> {
  periodStart(year, month); // validates the year and month before anything is written
  return inTx(ctx, async (tx) => {
    await tx
      .insert(closeChecklists)
      .values({ year, month, status: 'open' })
      .onConflictDoNothing({ target: [closeChecklists.year, closeChecklists.month] });
    const [checklist] = await tx
      .select()
      .from(closeChecklists)
      .where(and(eq(closeChecklists.year, year), eq(closeChecklists.month, month)))
      .for('update');
    await tx
      .insert(closeTasks)
      .values(
        STANDARD_TASKS.map((task, index) => ({
          checklistId: checklist.id,
          key: task.key,
          label: task.label,
          description: task.description,
          sortOrder: (index + 1) * 10,
          blocking: task.blocking,
          autoCheck: task.autoCheck,
        })),
      )
      .onConflictDoNothing({ target: [closeTasks.checklistId, closeTasks.key] });
    return view(tx, checklist);
  });
}

export async function getCloseChecklist(year: number, month: number, exec: LedgerDb = db): Promise<ChecklistView | null> {
  const [checklist] = await exec
    .select()
    .from(closeChecklists)
    .where(and(eq(closeChecklists.year, year), eq(closeChecklists.month, month)));
  return checklist === undefined ? null : view(exec, checklist);
}

async function lockChecklist(tx: LedgerDb, checklistId: string): Promise<CloseChecklist> {
  const [checklist] = await tx.select().from(closeChecklists).where(eq(closeChecklists.id, checklistId)).for('update');
  if (checklist === undefined) throw new CloseError('not_found', 'That close checklist does not exist.');
  return checklist;
}

async function lockTask(tx: LedgerDb, taskId: string): Promise<{ task: CloseTask; checklist: CloseChecklist }> {
  const [task] = await tx.select().from(closeTasks).where(eq(closeTasks.id, taskId)).for('update');
  if (task === undefined) throw new CloseError('not_found', 'That close task does not exist.');
  const checklist = await lockChecklist(tx, task.checklistId);
  if (checklist.status === 'complete') {
    throw new CloseError('invalid_state', 'The month is already closed. Reopen the period to change its checklist.');
  }
  return { task, checklist };
}

async function markStarted(tx: LedgerDb, checklist: CloseChecklist): Promise<void> {
  if (checklist.status !== 'open') return;
  await tx
    .update(closeChecklists)
    .set({ status: 'in_progress', startedAt: new Date() })
    .where(eq(closeChecklists.id, checklist.id));
}

/**
 * Runs every automatic task that has not been skipped: `done` when it passes,
 * `blocked` when it does not. A skipped task keeps its skip — the reason given
 * still stands — and is not re-run.
 */
export async function runCloseChecks(
  checklistId: string,
  ctx: CloseCtx,
  options: CheckOptions = {},
): Promise<ChecklistView> {
  return inTx(ctx, async (tx) => {
    const checklist = await lockChecklist(tx, checklistId);
    if (checklist.status === 'complete') {
      throw new CloseError('invalid_state', 'The month is already closed.');
    }
    const tasks = await tx.select().from(closeTasks).where(eq(closeTasks.checklistId, checklistId));
    const checkCtx = {
      year: checklist.year,
      month: checklist.month,
      start: periodStart(checklist.year, checklist.month),
      end: periodEnd(checklist.year, checklist.month),
      exec: tx,
      options,
    };
    for (const task of tasks) {
      if (task.autoCheck === null || task.status === 'skipped') continue;
      if (!isAutoCheck(task.autoCheck)) {
        await tx
          .update(closeTasks)
          .set({
            status: 'blocked',
            result: { ok: false, checkedAt: new Date().toISOString(), message: `Unknown automatic check "${task.autoCheck}".` },
          })
          .where(eq(closeTasks.id, task.id));
        continue;
      }
      const result = await runCheck(task.autoCheck, checkCtx);
      await tx
        .update(closeTasks)
        .set({
          status: result.ok ? 'done' : 'blocked',
          result,
          completedBy: result.ok ? ctx.userId : null,
          completedAt: result.ok ? new Date() : null,
        })
        .where(eq(closeTasks.id, task.id));
    }
    await markStarted(tx, checklist);
    const [fresh] = await tx.select().from(closeChecklists).where(eq(closeChecklists.id, checklistId));
    return view(tx, fresh);
  });
}

/** Ticks a manual task. An automatic task is done by passing its check, not by hand. */
export async function completeCloseTask(taskId: string, ctx: CloseCtx, notes?: string): Promise<CloseTask> {
  return inTx(ctx, async (tx) => {
    const { task, checklist } = await lockTask(tx, taskId);
    if (task.autoCheck !== null) {
      throw new CloseError(
        'invalid_state',
        `"${task.label}" is checked automatically. Run the checks, or skip it with a reason if it does not apply.`,
      );
    }
    const [updated] = await tx
      .update(closeTasks)
      .set({
        status: 'done',
        completedBy: ctx.userId,
        completedAt: new Date(),
        ...(notes === undefined || notes.trim() === '' ? {} : { notes: notes.trim() }),
      })
      .where(eq(closeTasks.id, taskId))
      .returning();
    await markStarted(tx, checklist);
    return updated;
  });
}

/** Skips a task. The reason is required and is kept as the task's note. */
export async function skipCloseTask(taskId: string, reason: string, ctx: CloseCtx): Promise<CloseTask> {
  const why = reason.trim();
  if (why === '') throw new CloseError('invalid_input', 'Say why this task is being skipped.');
  return inTx(ctx, async (tx) => {
    const { checklist } = await lockTask(tx, taskId);
    const [updated] = await tx
      .update(closeTasks)
      .set({ status: 'skipped', notes: why, completedBy: ctx.userId, completedAt: new Date() })
      .where(eq(closeTasks.id, taskId))
      .returning();
    await markStarted(tx, checklist);
    return updated;
  });
}

/** Puts a task back to pending: undoes a tick or a skip. */
export async function reopenCloseTask(taskId: string, ctx: CloseCtx): Promise<CloseTask> {
  return inTx(ctx, async (tx) => {
    await lockTask(tx, taskId);
    const status: CloseTaskStatus = 'pending';
    const [updated] = await tx
      .update(closeTasks)
      .set({ status, completedBy: null, completedAt: null })
      .where(eq(closeTasks.id, taskId))
      .returning();
    return updated;
  });
}

/**
 * Reopens a closed month (owner only, enforced by `reopenPeriod`) and puts its
 * checklist, if it has one, back in progress so the month can be worked and
 * closed again. Returns the checklist as it now stands, or null if none exists.
 */
export async function reopenMonth(year: number, month: number, ctx: CloseCtx): Promise<ChecklistView | null> {
  return inTx(ctx, async (tx) => {
    await reopenPeriod(year, month, ctx.userId, { tx });
    const [checklist] = await tx
      .update(closeChecklists)
      .set({ status: 'in_progress', completedAt: null, completedBy: null })
      .where(and(eq(closeChecklists.year, year), eq(closeChecklists.month, month)))
      .returning();
    return checklist === undefined ? null : view(tx, checklist);
  });
}

/**
 * Closes the month. Re-runs every automatic check, then closes the period only
 * if every blocking task is done or skipped with a reason.
 *
 * @throws {CloseError} code `blocked`, listing every outstanding task
 */
export async function closeMonth(
  checklistId: string,
  ctx: CloseCtx,
  options: CheckOptions = {},
): Promise<ChecklistView> {
  await runCloseChecks(checklistId, ctx, options);
  return inTx(ctx, async (tx) => {
    const checklist = await lockChecklist(tx, checklistId);
    const tasks = await tx.select().from(closeTasks).where(eq(closeTasks.checklistId, checklistId));
    const outstanding = outstandingOf(tasks);
    if (outstanding.length > 0) {
      throw new CloseError(
        'blocked',
        `${outstanding.length} blocking ${outstanding.length === 1 ? 'task is' : 'tasks are'} not done: ` +
          `${outstanding.map((t) => t.label).join('; ')}. Finish each, or skip it with a reason.`,
        outstanding,
      );
    }
    await closePeriod(checklist.year, checklist.month, ctx.userId, { tx });
    const [closed] = await tx
      .update(closeChecklists)
      .set({ status: 'complete', completedAt: new Date(), completedBy: ctx.userId })
      .where(eq(closeChecklists.id, checklistId))
      .returning();
    return view(tx, closed);
  });
}

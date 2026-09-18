'use server';

/**
 * Every mutation the close screen can make. Each checks the capability, hands
 * the work to `@/lib/close`, returns `{ ok:false, error }` rather than throwing
 * at the UI, and revalidates the screens whose status just moved.
 */

import { revalidatePath } from 'next/cache';

import type { ActionResult } from '@/components/planning/types';
import { requireCapability } from '@/lib/auth/session';
import {
  closeMonth,
  completeCloseTask,
  createCloseChecklist,
  reopenCloseTask,
  reopenMonth,
  runCloseChecks,
  skipCloseTask,
} from '@/lib/close/checklist';

import { fail, isUuid, ok, refused } from '../plan/failure';

function refresh(): void {
  revalidatePath('/close');
  revalidatePath('/dashboard');
  revalidatePath('/ledger');
}

function validMonth(year: number, month: number): boolean {
  return Number.isInteger(year) && year >= 2000 && year <= 2999 && Number.isInteger(month) && month >= 1 && month <= 12;
}

/** Creates the month's checklist with the standard tasks and records a first run of its checks. */
export async function startClose(year: number, month: number): Promise<ActionResult<{ checklistId: string }>> {
  try {
    const user = await requireCapability('ledger.close');
    if (!validMonth(year, month)) return refused('That is not a month.');
    const created = await createCloseChecklist(year, month, { userId: user.id });
    await runCloseChecks(created.checklist.id, { userId: user.id });
    refresh();
    return ok({ checklistId: created.checklist.id });
  } catch (error) {
    return fail(error);
  }
}

export async function rerunCloseChecks(checklistId: string): Promise<ActionResult<{ outstanding: number }>> {
  try {
    const user = await requireCapability('ledger.close');
    if (!isUuid(checklistId)) return refused('That checklist does not exist.');
    const view = await runCloseChecks(checklistId, { userId: user.id });
    refresh();
    return ok({ outstanding: view.outstanding.length });
  } catch (error) {
    return fail(error);
  }
}

export async function markCloseTaskDone(taskId: string, notes: string): Promise<ActionResult<null>> {
  try {
    const user = await requireCapability('ledger.close');
    if (!isUuid(taskId)) return refused('That task does not exist.');
    await completeCloseTask(taskId, { userId: user.id }, notes);
    refresh();
    return ok(null);
  } catch (error) {
    return fail(error);
  }
}

export async function skipTask(taskId: string, reason: string): Promise<ActionResult<null>> {
  try {
    const user = await requireCapability('ledger.close');
    if (!isUuid(taskId)) return refused('That task does not exist.');
    await skipCloseTask(taskId, reason, { userId: user.id });
    refresh();
    return ok(null);
  } catch (error) {
    return fail(error);
  }
}

export async function undoCloseTask(taskId: string): Promise<ActionResult<null>> {
  try {
    const user = await requireCapability('ledger.close');
    if (!isUuid(taskId)) return refused('That task does not exist.');
    await reopenCloseTask(taskId, { userId: user.id });
    refresh();
    return ok(null);
  } catch (error) {
    return fail(error);
  }
}

/** Re-runs every check and closes the period only if nothing blocking is left. */
export async function closeMonthFromChecklist(checklistId: string): Promise<ActionResult<null>> {
  try {
    const user = await requireCapability('ledger.close');
    if (!isUuid(checklistId)) return refused('That checklist does not exist.');
    await closeMonth(checklistId, { userId: user.id });
    refresh();
    return ok(null);
  } catch (error) {
    // The refusal re-ran the checks, so the screen has new results to show either way.
    refresh();
    return fail(error);
  }
}

/**
 * Reopens a closed month. Owner only, and the period has to be typed back —
 * the server checks the same string the dialog asked for.
 */
export async function reopenClosedMonth(
  year: number,
  month: number,
  confirmation: string,
): Promise<ActionResult<null>> {
  try {
    const user = await requireCapability('ledger.reopen');
    if (!validMonth(year, month)) return refused('That is not a month.');
    const expected = `${year}-${String(month).padStart(2, '0')}`;
    if (confirmation.trim() !== expected) return refused(`Type ${expected} to confirm reopening that month.`);
    await reopenMonth(year, month, { userId: user.id });
    refresh();
    return ok(null);
  } catch (error) {
    return fail(error);
  }
}

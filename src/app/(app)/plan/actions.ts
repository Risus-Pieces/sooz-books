'use server';

/**
 * Every mutation the Plan screens can make: budget versions and cells, budget
 * import and copy-from-actuals, forecast items and forecast snapshots.
 *
 * Planning changes no figure in the books, but it is still the business's
 * committed plan, so it takes the same capability as running the close: the
 * owner and the bookkeeper. Each action checks it, hands the work to
 * `@/lib/planning`, returns `{ ok:false, error }` rather than throwing, and
 * revalidates the screens that read what moved.
 */

import { revalidatePath } from 'next/cache';

import type { ActionResult, BudgetCellChange, ForecastItemForm } from '@/components/planning/types';
import { withActor } from '@/db/client';
import { requireCapability } from '@/lib/auth/session';
import { isCalendarDate, today } from '@/lib/dates';
import {
  activateBudgetVersion,
  archiveBudgetVersion,
  copyBudgetFromActuals,
  createBudgetVersion,
  importBudgetCsv,
  setBudgetLines,
} from '@/lib/planning/budget';
import {
  type ForecastItemInput,
  createForecastItem,
  deactivateForecastItem,
  snapshotForecast,
} from '@/lib/planning/forecast';
import { RECURRENCES, type Recurrence } from '@/lib/planning/forecast-math';

import { fail, isUuid, ok, refused } from './failure';

const CAPABILITY = 'ledger.close' as const;

function refreshBudget(): void {
  revalidatePath('/plan/budget');
}

function refreshForecast(): void {
  revalidatePath('/plan/forecast');
  revalidatePath('/dashboard');
}

/* ------------------------------------------------------------------ budget */

export async function createVersion(input: {
  name: string;
  fiscalYear: number;
  notes: string;
}): Promise<ActionResult<{ id: string }>> {
  try {
    const user = await requireCapability(CAPABILITY);
    const version = await createBudgetVersion(
      { name: input.name, fiscalYear: input.fiscalYear, notes: input.notes.trim() === '' ? null : input.notes.trim() },
      { userId: user.id },
    );
    refreshBudget();
    return ok({ id: version.id });
  } catch (error) {
    return fail(error);
  }
}

export async function setVersionStatus(
  versionId: string,
  status: 'active' | 'archived',
): Promise<ActionResult<null>> {
  try {
    const user = await requireCapability(CAPABILITY);
    if (!isUuid(versionId)) return refused('That budget version does not exist.');
    if (status === 'active') await activateBudgetVersion(versionId, { userId: user.id });
    else await archiveBudgetVersion(versionId, { userId: user.id });
    refreshBudget();
    return ok(null);
  } catch (error) {
    return fail(error);
  }
}

export async function saveBudgetCells(
  versionId: string,
  changes: readonly BudgetCellChange[],
): Promise<ActionResult<{ cellsWritten: number }>> {
  try {
    const user = await requireCapability(CAPABILITY);
    if (!isUuid(versionId)) return refused('That budget version does not exist.');
    for (const change of changes) {
      if (!Number.isSafeInteger(change.amountCents)) return refused('Every amount must be a whole number of cents.');
    }
    const cellsWritten = await setBudgetLines(
      versionId,
      changes.map((c) => ({ accountCode: c.accountCode, month: c.month, amountCents: c.amountCents })),
      { userId: user.id },
    );
    refreshBudget();
    return ok({ cellsWritten });
  } catch (error) {
    return fail(error);
  }
}

export async function importBudget(
  versionId: string,
  csvText: string,
  replace: boolean,
): Promise<ActionResult<{ cellsWritten: number; rowsRead: number; cellsRemoved: number }>> {
  try {
    const user = await requireCapability(CAPABILITY);
    if (!isUuid(versionId)) return refused('That budget version does not exist.');
    if (csvText.length > 2_000_000) return refused('That file is too large to be a budget.');
    const result = await importBudgetCsv(versionId, csvText, { userId: user.id }, { replace });
    refreshBudget();
    return ok(result);
  } catch (error) {
    return fail(error);
  }
}

export async function copyFromActuals(input: {
  versionId: string;
  sourceYear: number;
  growthBps: number;
  replace: boolean;
}): Promise<ActionResult<{ cellsWritten: number; sourceTotalCents: number }>> {
  try {
    const user = await requireCapability(CAPABILITY);
    if (!isUuid(input.versionId)) return refused('That budget version does not exist.');
    const result = await copyBudgetFromActuals(
      { versionId: input.versionId, sourceYear: input.sourceYear, growthBps: input.growthBps, replace: input.replace },
      { userId: user.id },
    );
    refreshBudget();
    return ok(result);
  } catch (error) {
    return fail(error);
  }
}

/* ---------------------------------------------------------------- forecast */

function toInput(form: ForecastItemForm): ForecastItemInput | string {
  if (form.direction !== 'inflow' && form.direction !== 'outflow') return 'Choose money in or money out.';
  if (!RECURRENCES.includes(form.recurrence as Recurrence)) return 'Choose how often it repeats.';
  if (!isCalendarDate(form.expectedDate)) return 'Give the expected date as YYYY-MM-DD.';
  if (form.endDate !== null && !isCalendarDate(form.endDate)) return 'Give the end date as YYYY-MM-DD.';
  if (form.bankAccountId !== null && !isUuid(form.bankAccountId)) return 'That bank account does not exist.';
  return {
    label: form.label,
    category: form.category,
    direction: form.direction,
    amountCents: form.amountCents,
    expectedDate: form.expectedDate,
    recurrence: form.recurrence as Recurrence,
    endDate: form.recurrence === 'none' ? null : form.endDate,
    bankAccountId: form.bankAccountId,
    confidence: form.confidence,
    notes: form.notes === null || form.notes.trim() === '' ? null : form.notes.trim(),
  };
}

export async function addForecastItem(form: ForecastItemForm): Promise<ActionResult<{ id: string }>> {
  try {
    const user = await requireCapability(CAPABILITY);
    const input = toInput(form);
    if (typeof input === 'string') return refused(input);
    const item = await createForecastItem(input, { userId: user.id });
    refreshForecast();
    return ok({ id: item.id });
  } catch (error) {
    return fail(error);
  }
}

/**
 * Changes an item by retiring it and recording its replacement in the same
 * transaction. Items are never edited in place, so a frozen forecast that
 * counted the old terms stays explicable.
 */
export async function updateForecastItem(itemId: string, form: ForecastItemForm): Promise<ActionResult<{ id: string }>> {
  try {
    const user = await requireCapability(CAPABILITY);
    if (!isUuid(itemId)) return refused('That forecast item does not exist.');
    const input = toInput(form);
    if (typeof input === 'string') return refused(input);
    const item = await withActor(user.id, async (tx) => {
      await deactivateForecastItem(itemId, { userId: user.id, tx });
      return createForecastItem(input, { userId: user.id, tx });
    });
    refreshForecast();
    return ok({ id: item.id });
  } catch (error) {
    return fail(error);
  }
}

export async function removeForecastItem(itemId: string): Promise<ActionResult<null>> {
  try {
    const user = await requireCapability(CAPABILITY);
    if (!isUuid(itemId)) return refused('That forecast item does not exist.');
    await deactivateForecastItem(itemId, { userId: user.id });
    refreshForecast();
    return ok(null);
  } catch (error) {
    return fail(error);
  }
}

/** Freezes today's forecast so it can be scored against what happens. */
export async function freezeForecast(replace: boolean): Promise<ActionResult<{ asOfDate: string }>> {
  try {
    const user = await requireCapability(CAPABILITY);
    const result = await snapshotForecast(today(), { userId: user.id }, { replace });
    refreshForecast();
    return ok({ asOfDate: result.asOfDate });
  } catch (error) {
    return fail(error);
  }
}

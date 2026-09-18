'use server';

/**
 * Every mutation the inventory screens can make.
 *
 * Each action checks `inventory.manage`, reads the typed input into the units
 * the library works in (cents, hundredths of a unit, 'YYYY-MM-DD'), hands the
 * work to `@/lib/inventory`, and turns a typed failure into the
 * `{ ok: false, error }` the client shows. Anything that posts goes through the
 * library, which goes through `postJournalEntry`; nothing here writes a row.
 */

import { revalidatePath } from 'next/cache';
import { sql } from 'drizzle-orm';

import { db } from '@/db/client';
import { isForbiddenError } from '@/lib/auth/roles';
import { requireCapability } from '@/lib/auth/session';
import { isCalendarDate, today, type CalendarDate } from '@/lib/dates';
import { isQueryError, postgresErrorOf } from '@/lib/db-errors';
import { describeItem } from '@/lib/importers/peasy';
import type { Issue } from '@/lib/importers/types';
import { CHANNEL_CODES, type ChannelCode } from '@/lib/ledger/coa';
import { isLedgerError } from '@/lib/ledger/errors';
import { translateLedgerDbError } from '@/lib/ledger/post';
import { STAGES, type Stage } from '@/lib/inventory/accounts';
import { planAdjustment, postInventoryAdjustment, type AdjustmentInput } from '@/lib/inventory/adjustments';
import { draftCogsBatch, postCogsBatch, reverseCogsBatch } from '@/lib/inventory/cogs';
import { InventoryError, isInventoryError } from '@/lib/inventory/errors';
import {
  commitPeasyInventory,
  commitPeasyShipments,
  previewPeasyInventory,
  previewPeasyShipments,
  type InventoryPreview,
  type ProductToCreate,
  type ShipmentsPreview,
} from '@/lib/inventory/peasy-intake';
import {
  addLandedCost,
  allocateBillLine,
  costRun,
  createProductionRun,
  recordRunOutput,
  removeLandedCost,
  reopenRun,
  type AllocationBasis,
} from '@/lib/inventory/production';
import { createProduct } from '@/lib/inventory/products';
import { QuantityError, parseQuantity } from '@/lib/inventory/quantity';
import { postTieoutAdjustment, recordTieout } from '@/lib/inventory/tieout';
import { parseMoney } from '@/lib/money';
import {
  COMPONENT_KEYS,
  REASON_KEYS,
  type AdjustmentFormInput,
  type AdjustmentPreviewData,
  type CostComponentKey,
  type InvActionFailure,
  type InvActionResult,
  type PreviewIssue,
  type ProductOption,
  type ShipmentsPreviewData,
  type SnapshotPreviewData,
  type StageKey,
} from '@/components/inventory/types';

import { previewLines } from './queries';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* ----------------------------------------------------------------- plumbing */

function failure(error: unknown): InvActionFailure {
  if (isInventoryError(error)) {
    return { code: error.code, message: error.message, ...(error.details.length > 0 ? { details: [...error.details] } : {}) };
  }
  if (error instanceof QuantityError) return { code: 'invalid_input', message: error.message };
  if (isForbiddenError(error)) return { code: 'forbidden', message: error.message };
  const translated = translateLedgerDbError(error);
  if (isLedgerError(translated)) return { code: translated.code, message: translated.message };
  const pg = postgresErrorOf(error);
  if (pg !== null) return { code: 'unexpected', message: `The database refused this change: ${pg.message}` };
  if (isQueryError(error)) return { code: 'unexpected', message: 'The database could not complete this request.' };
  if (error instanceof Error) return { code: 'unexpected', message: error.message };
  return { code: 'unexpected', message: 'Something went wrong.' };
}

async function run<T>(work: (userId: string) => Promise<T>, paths: readonly string[]): Promise<InvActionResult<T>> {
  try {
    const user = await requireCapability('inventory.manage');
    const value = await work(user.id);
    for (const path of paths) revalidatePath(path);
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error: failure(error) };
  }
}

function invalid(message: string): never {
  throw new InventoryError('invalid_input', message);
}

function uuid(value: string, what: string): string {
  if (!UUID.test(value)) invalid(`Choose ${what}.`);
  return value;
}

function date(value: string, what = 'The date'): CalendarDate {
  if (!isCalendarDate(value)) invalid(`${what} must be a date.`);
  return value;
}

/** Hundredths of a unit from what was typed; blank is `fallback`. */
function units(text: string, what: string, fallback: number | null = null): number {
  if (text.trim() === '') {
    if (fallback === null) invalid(`${what} is required.`);
    return fallback;
  }
  const { hundredths } = parseQuantity(text);
  if (hundredths < 0) invalid(`${what} cannot be negative.`);
  return hundredths;
}

/** Cents from what was typed, as dollars. */
function money(text: string, what: string): number {
  try {
    return parseMoney(text);
  } catch {
    return invalid(`${what} is not an amount.`);
  }
}

function component(value: string): CostComponentKey {
  if (!(COMPONENT_KEYS as readonly string[]).includes(value)) invalid('Choose what kind of cost this is.');
  return value as CostComponentKey;
}

function stage(value: string): Stage {
  if (!(STAGES as readonly string[]).includes(value)) invalid('Choose a stage.');
  return value as Stage;
}

const INVENTORY_PATHS = ['/inventory', '/inventory/production', '/inventory/valuation', '/inventory/cogs', '/inventory/adjustments', '/dashboard', '/ledger'];

/* ----------------------------------------------------------------- products */

export async function createProductAction(input: {
  sku: string;
  name: string;
  unit: string;
}): Promise<InvActionResult<ProductOption>> {
  return run(async (userId) => {
    const product = await createProduct({ sku: input.sku, name: input.name, unit: input.unit }, { userId });
    return { id: product.id, sku: product.sku, name: product.name, unit: product.unit, unitCostCents: null };
  }, ['/inventory/production', '/inventory/adjustments']);
}

/* ------------------------------------------------------------------- runs */

export interface CreateRunForm {
  runNo: string;
  productId: string;
  runDate: string;
  coManVendorId: string | null;
  lotCode: string;
  unitsPlanned: string;
  notes: string;
}

export async function createRunAction(input: CreateRunForm): Promise<InvActionResult<{ runId: string }>> {
  return run(async (userId) => {
    const planned = input.unitsPlanned.trim() === '' ? null : units(input.unitsPlanned, 'Planned units');
    const created = await createProductionRun(
      {
        runNo: input.runNo,
        productId: uuid(input.productId, 'the product the co-packer is making'),
        runDate: date(input.runDate, 'The run date'),
        coManVendorId: input.coManVendorId ? uuid(input.coManVendorId, 'a co-packer') : null,
        lotCode: input.lotCode.trim() || null,
        unitsPlanned: planned,
        notes: input.notes.trim() || null,
      },
      { userId },
    );
    return { runId: created.id };
  }, ['/inventory', '/inventory/production']);
}

export async function recordOutputAction(
  runId: string,
  produced: string,
  rejected: string,
): Promise<InvActionResult<null>> {
  return run(async (userId) => {
    await recordRunOutput(
      uuid(runId, 'a run'),
      { unitsProduced: units(produced, 'Units produced'), unitsRejected: units(rejected, 'Units rejected', 0) },
      { userId },
    );
    return null;
  }, ['/inventory/production', `/inventory/production/${runId}`]);
}

export async function addStockCostAction(input: {
  runId: string;
  component: string;
  amount: string;
  description: string;
}): Promise<InvActionResult<null>> {
  return run(async (userId) => {
    const kind = component(input.component);
    const amountCents = money(input.amount, 'The amount');
    if (amountCents <= 0) invalid('The amount must be more than zero.');
    await addLandedCost(
      {
        runId: uuid(input.runId, 'a run'),
        component: kind,
        amountCents,
        description: input.description.trim() || undefined,
      },
      { userId },
    );
    return null;
  }, ['/inventory/production', `/inventory/production/${input.runId}`]);
}

export async function removeLandedCostAction(runId: string, landedCostId: string): Promise<InvActionResult<null>> {
  return run(async (userId) => {
    await removeLandedCost(uuid(landedCostId, 'a cost'), { userId });
    return null;
  }, ['/inventory/production', `/inventory/production/${runId}`]);
}

export async function allocateBillLineAction(input: {
  billLineId: string;
  component: string;
  basis: AllocationBasis;
  runs: Array<{ runId: string; weight: string }>;
  amount: string;
  description: string;
}): Promise<InvActionResult<{ runs: number; amountCents: number }>> {
  return run(async (userId) => {
    if (!['units', 'value', 'manual'].includes(input.basis)) invalid('Choose how to split the line.');
    const runs = input.runs.map((r) => {
      const runId = uuid(r.runId, 'a run');
      if (input.basis === 'units') return { runId };
      // `value` weighs each run by the value it made; `manual` takes each run's
      // share as typed. Both are amounts, and allocateCents treats them as weights.
      const weight = money(r.weight, 'Each run’s amount');
      if (weight < 0) invalid('A run’s amount cannot be negative.');
      return { runId, weight };
    });
    const result = await allocateBillLine(
      {
        billLineId: uuid(input.billLineId, 'a bill line'),
        component: component(input.component),
        basis: input.basis,
        runs,
        ...(input.amount.trim() === '' ? {} : { amountCents: money(input.amount, 'The amount') }),
        ...(input.description.trim() === '' ? {} : { description: input.description.trim() }),
      },
      { userId },
    );
    for (const share of result.shares) revalidatePath(`/inventory/production/${share.runId}`);
    return { runs: result.shares.filter((s) => s.amountCents !== 0).length, amountCents: result.amountCents };
  }, ['/inventory/production']);
}

export async function costRunAction(
  runId: string,
  costDate: string,
): Promise<InvActionResult<{ unitCostCents: number; entryId: string | null }>> {
  return run(async (userId) => {
    const result = await costRun(uuid(runId, 'a run'), { userId, date: date(costDate, 'The costing date') });
    return { unitCostCents: result.unitCostCents, entryId: result.entryId };
  }, [...INVENTORY_PATHS, `/inventory/production/${runId}`]);
}

export async function reopenRunAction(runId: string): Promise<InvActionResult<null>> {
  return run(async (userId) => {
    await reopenRun(uuid(runId, 'a run'), { userId });
    return null;
  }, [...INVENTORY_PATHS, `/inventory/production/${runId}`]);
}

/* ------------------------------------------------------------ Peasy intake */

interface FileInput {
  filename: string;
  bytes: Uint8Array;
}

async function fileFrom(form: FormData): Promise<FileInput> {
  const file = form.get('file');
  if (!(file instanceof File) || file.size === 0) invalid('Choose the Peasy export to upload.');
  if (file.size > 5 * 1024 * 1024) invalid('That file is larger than 5 MB; a Peasy export is a few kilobytes.');
  return { filename: file.name, bytes: new Uint8Array(await file.arrayBuffer()) };
}

function text(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === 'string' ? value.trim() : '';
}

function json<T>(form: FormData, key: string, fallback: T): T {
  const value = text(form, key);
  if (value === '') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return invalid(`The ${key} field could not be read.`);
  }
}

function issuesOf(issues: readonly Issue[]): PreviewIssue[] {
  return issues.map((issue) => ({
    severity: issue.severity,
    message: issue.remedy ? `${issue.message} ${issue.remedy}` : issue.message,
    row: issue.rowIndex === undefined ? null : issue.rowIndex + 1,
  }));
}

function unknownOf(preview: InventoryPreview | ShipmentsPreview): SnapshotPreviewData['unknownItems'] {
  return preview.unknownItems.map((u) => ({
    key: u.key,
    label: describeItem(u.item),
    suggestedSku: u.suggestedSku,
    suggestedName: u.suggestedName,
  }));
}

function productsToCreate(form: FormData): ProductToCreate[] {
  const list = json<Array<{ key: unknown; sku: unknown; name: unknown }>>(form, 'createProducts', []);
  if (!Array.isArray(list)) invalid('The products to create could not be read.');
  return list.map((p) => ({ key: String(p.key), sku: String(p.sku).trim(), name: String(p.name).trim() }));
}

interface InventoryOptions {
  snapshotDate?: CalendarDate;
  defaultStage?: Stage;
  stageOverrides?: Record<string, Stage>;
}

function inventoryOptions(form: FormData): InventoryOptions {
  const snapshotDate = text(form, 'snapshotDate');
  const defaultStage = text(form, 'defaultStage');
  const overrides = json<Record<string, string>>(form, 'stageOverrides', {});
  const stageOverrides: Record<string, Stage> = {};
  for (const [key, value] of Object.entries(overrides)) stageOverrides[key] = stage(value);
  return {
    ...(snapshotDate === '' ? {} : { snapshotDate: date(snapshotDate, 'The snapshot date') }),
    ...(defaultStage === '' ? {} : { defaultStage: stage(defaultStage) }),
    ...(Object.keys(stageOverrides).length === 0 ? {} : { stageOverrides }),
  };
}

function overrideKey(item: { sku: string | null; peasyId: string | null; name: string | null }): string {
  return item.sku ?? item.peasyId ?? item.name ?? '';
}

export async function previewSnapshotAction(form: FormData): Promise<InvActionResult<SnapshotPreviewData>> {
  return run(async () => {
    const file = await fileFrom(form);
    const preview = await previewPeasyInventory({ ...file, ...inventoryOptions(form) });
    return {
      filename: preview.filename,
      snapshotDate: preview.snapshotDate,
      totalValueCents: preview.totalValueCents,
      totalsByStage: preview.totalsByStage as Partial<Record<StageKey, number>>,
      lines: preview.lines.map((l) => ({
        key: l.key,
        label: describeItem(l.item),
        overrideKey: overrideKey(l.item),
        productSku: l.product?.sku ?? null,
        location: l.location,
        stage: l.stage,
        quantity: l.quantity,
        valueCents: l.valueCents,
        valueSource: l.valueSource,
      })),
      unknownItems: unknownOf(preview),
      issues: issuesOf(preview.issues),
      blockers: [
        ...preview.blockers,
        ...(preview.snapshotDate === null ? ['The file carries no date; enter the date the count was taken.'] : []),
      ],
      replacesExisting: preview.existingImportIds.length > 0,
      rows: {
        data: preview.parse.stats.dataRows,
        used: preview.parse.stats.used,
        excluded: preview.parse.stats.excluded,
        unreadable: preview.parse.stats.unreadable,
      },
    };
  }, []);
}

export async function commitSnapshotAction(
  form: FormData,
): Promise<InvActionResult<{ snapshotDate: string; lineCount: number; totalValueCents: number }>> {
  return run(async (userId) => {
    const file = await fileFrom(form);
    const result = await commitPeasyInventory(
      {
        ...file,
        ...inventoryOptions(form),
        createProducts: productsToCreate(form),
        replaceExisting: text(form, 'replaceExisting') === '1',
      },
      { userId },
    );
    return { snapshotDate: result.snapshotDate, lineCount: result.lineCount, totalValueCents: result.totalValueCents };
  }, ['/inventory', '/inventory/valuation', '/inventory/production', '/inventory/adjustments']);
}

function shipmentOptions(form: FormData): { defaultChannelCode?: ChannelCode } {
  const code = text(form, 'defaultChannel');
  if (code === '') return {};
  if (!(CHANNEL_CODES as readonly string[]).includes(code)) invalid('Choose a channel.');
  return { defaultChannelCode: code as ChannelCode };
}

export async function previewShipmentsAction(form: FormData): Promise<InvActionResult<ShipmentsPreviewData>> {
  return run(async () => {
    const file = await fileFrom(form);
    const preview = await previewPeasyShipments({ ...file, ...shipmentOptions(form) });
    return {
      filename: preview.filename,
      lines: preview.lines.map((l) => ({
        key: l.key,
        label: describeItem(l.item),
        productSku: l.product?.sku ?? null,
        period: `${l.year}-${String(l.month).padStart(2, '0')}`,
        channelCode: l.channelCode,
        units: l.units,
        returns: l.returns,
      })),
      periods: preview.periods.map((p) => ({
        key: `${p.year}-${String(p.month).padStart(2, '0')}`,
        label: p.label,
        units: p.units,
        hasExisting: p.hasExisting,
        cogsPosted: p.cogsPosted,
      })),
      unknownItems: unknownOf(preview),
      issues: issuesOf(preview.issues),
      blockers: preview.blockers,
      rows: {
        data: preview.parse.stats.dataRows,
        used: preview.parse.stats.used,
        excluded: preview.parse.stats.excluded,
        unreadable: preview.parse.stats.unreadable,
      },
    };
  }, []);
}

export async function commitShipmentsAction(form: FormData): Promise<InvActionResult<{ months: number; lines: number }>> {
  return run(async (userId) => {
    const file = await fileFrom(form);
    const result = await commitPeasyShipments(
      {
        ...file,
        ...shipmentOptions(form),
        createProducts: productsToCreate(form),
        replaceExisting: text(form, 'replaceExisting') === '1',
      },
      { userId },
    );
    return { months: result.imports.length, lines: result.imports.reduce((s, i) => s + i.lineCount, 0) };
  }, ['/inventory', '/inventory/cogs']);
}

/* ---------------------------------------------------------------- tie-out */

export async function recordTieoutAction(explanation: string): Promise<InvActionResult<{ tieoutId: string }>> {
  return run(async (userId) => {
    const recorded = await recordTieout(today(), {
      userId,
      ...(explanation.trim() === '' ? {} : { explanation: explanation.trim() }),
    });
    return { tieoutId: recorded.tieout.id };
  }, ['/inventory', '/inventory/valuation']);
}

export async function postTieoutAdjustmentAction(tieoutId: string): Promise<InvActionResult<{ entryId: string }>> {
  return run(async (userId) => {
    const posted = await postTieoutAdjustment(uuid(tieoutId, 'a tie-out'), { userId });
    return { entryId: posted.entryId };
  }, INVENTORY_PATHS);
}

/* -------------------------------------------------------------------- COGS */

export async function draftCogsAction(period: string): Promise<InvActionResult<{ batchId: string }>> {
  return run(async (userId) => {
    const match = /^(\d{4})-(\d{2})$/.exec(period);
    if (!match) invalid('Choose a month.');
    const detail = await draftCogsBatch({ year: Number(match[1]), month: Number(match[2]) }, { userId });
    return { batchId: detail.batch.id };
  }, ['/inventory', '/inventory/cogs']);
}

export async function postCogsAction(batchId: string): Promise<InvActionResult<{ entryId: string; entryNo: number }>> {
  return run(async (userId) => {
    const posted = await postCogsBatch(uuid(batchId, 'a batch'), { userId });
    return { entryId: posted.entryId, entryNo: posted.entryNo };
  }, [...INVENTORY_PATHS, '/reports/margin']);
}

export async function reverseCogsAction(
  batchId: string,
  reversalDate: string,
): Promise<InvActionResult<{ reversalEntryId: string }>> {
  return run(async (userId) => {
    const reversed = await reverseCogsBatch(uuid(batchId, 'a batch'), {
      userId,
      ...(reversalDate === '' ? {} : { date: date(reversalDate, 'The reversal date') }),
    });
    return { reversalEntryId: reversed.reversalEntryId };
  }, [...INVENTORY_PATHS, '/reports/margin']);
}

/* ------------------------------------------------------------- adjustments */

function adjustmentInput(form: AdjustmentFormInput): AdjustmentInput {
  if (!(REASON_KEYS as readonly string[]).includes(form.reason)) invalid('Choose a reason.');
  const magnitude = units(form.quantity, 'Quantity');
  if (magnitude === 0) invalid('Enter how many units.');
  const input: AdjustmentInput = {
    date: date(form.date),
    productId: uuid(form.productId, 'a product'),
    reason: form.reason,
    stage: stage(form.stage),
    quantity: form.direction === 'in' ? magnitude : -magnitude,
    channelId: form.channelId ? uuid(form.channelId, 'a channel') : null,
    ...(form.memo.trim() === '' ? {} : { memo: form.memo.trim() }),
  };
  if (form.unitCost.trim() !== '') {
    const unitCostCents = money(form.unitCost, 'The unit cost');
    if (unitCostCents < 0) invalid('The unit cost cannot be negative.');
    input.unitCostCents = unitCostCents;
  }
  if (form.value.trim() !== '') input.valueCents = money(form.value, 'The value');
  return input;
}

/**
 * The entry an adjustment will post, before it posts. Same plan as the post
 * (`planAdjustment`, with the product's cost on the date), without writing.
 */
export async function previewAdjustmentAction(
  form: AdjustmentFormInput,
): Promise<InvActionResult<AdjustmentPreviewData>> {
  return run(async () => {
    const input = adjustmentInput(form);
    const rows = await db.execute<{ cost: string | number | null }>(
      sql`select unit_cost_at(${input.productId}::uuid, ${input.date}::date) as cost`,
    );
    const cost = [...rows][0]?.cost;
    const plan = planAdjustment(input, cost === null || cost === undefined ? null : Number(cost));
    const dims = { productId: input.productId, channelId: input.channelId ?? null };
    const lines = await previewLines([
      plan.valueCents > 0
        ? { accountCode: plan.inventoryAccountCode, debitCents: plan.valueCents, ...dims }
        : { accountCode: plan.expenseAccountCode, debitCents: -plan.valueCents, ...dims },
      plan.valueCents > 0
        ? { accountCode: plan.expenseAccountCode, creditCents: plan.valueCents, ...dims }
        : { accountCode: plan.inventoryAccountCode, creditCents: -plan.valueCents, ...dims },
    ]);
    return {
      unitCostCents: plan.unitCostCents,
      valueCents: plan.valueCents,
      entry: { date: input.date, memo: input.memo ?? `${input.reason.replace('_', ' ')} adjustment`, lines },
    };
  }, []);
}

export async function postAdjustmentAction(
  form: AdjustmentFormInput,
): Promise<InvActionResult<{ adjustmentNo: string; entryId: string }>> {
  return run(async (userId) => {
    const posted = await postInventoryAdjustment(adjustmentInput(form), { userId });
    return { adjustmentNo: posted.adjustment.adjustmentNo, entryId: posted.entryId };
  }, INVENTORY_PATHS);
}


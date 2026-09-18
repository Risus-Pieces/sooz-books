'use server';

/**
 * Every mutation the Trade screens can make, and the read-only previews that show what a
 * mutation will post before anyone presses the button.
 *
 * Each action checks `trade.manage`, hands the work to the trade engine (`@/lib/trade`),
 * turns a typed refusal into the `{ ok: false, error }` the client shows, and revalidates the
 * screens whose figures moved. A remittance posts only when a person presses Post after
 * seeing its split; a deduction moves only when a person picks the action.
 */

import { revalidatePath } from 'next/cache';

import { isForbiddenError } from '@/lib/auth/roles';
import { requireCapability } from '@/lib/auth/session';
import { UnreadableFileError, readFile } from '@/lib/banking/read-file';
import type { PromoType } from '@/db/schema';
import { isCalendarDate } from '@/lib/dates';
import { isQueryError, postgresErrorOf } from '@/lib/db-errors';
import { REMITTANCE_SOURCES, type RemittanceSource } from '@/lib/importers/remittance';
import { isLedgerError } from '@/lib/ledger/errors';
import { translateLedgerDbError } from '@/lib/ledger/post';
import { parseMoney } from '@/lib/money';
import { disputeDeduction, recoverDeduction, validateDeduction, writeOffDeduction } from '@/lib/trade/deductions';
import { isTradeError } from '@/lib/trade/errors';
import {
  PROMO_CONTRA_ACCOUNT,
  accrualSchedule,
  accruePromotion,
  allowanceCents,
  closePromotion,
  createPromotion,
} from '@/lib/trade/promotions';
import { importRemittanceFile } from '@/lib/trade/remittances';

import type {
  BulkValidationView,
  PlanPreviewView,
  PromotionDraft,
  RemittancePostView,
  RemittancePreviewView,
  TradeActionFailure,
  TradeActionResult,
  ValidationPreview,
} from '@/components/trade/types';

import { bulkValidationPreview, previewRemittanceFile, validationPreview } from './queries';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Server actions accept 1 MB; leave room for the form around the file. */
const MAX_BYTES = 950 * 1024;
const MAX_BULK = 200;

function failure(error: unknown): TradeActionFailure {
  if (isTradeError(error)) return { code: error.code, message: error.message };
  if (error instanceof UnreadableFileError) return { code: error.code, message: `${error.message} ${error.remedy}` };
  if (isForbiddenError(error)) return { code: 'forbidden', message: error.message };
  const translated = translateLedgerDbError(error);
  if (isLedgerError(translated)) return { code: translated.code, message: translated.message };
  const pg = postgresErrorOf(error);
  if (pg !== null) return { code: 'unexpected', message: `The database refused this change: ${pg.message}` };
  if (isQueryError(error)) return { code: 'unexpected', message: 'The database could not complete this request.' };
  if (error instanceof Error) return { code: 'unexpected', message: error.message };
  return { code: 'unexpected', message: 'Something went wrong.' };
}

function fail<T>(error: unknown): TradeActionResult<T> {
  return { ok: false, error: failure(error) };
}

function invalid<T>(message: string): TradeActionResult<T> {
  return { ok: false, error: { code: 'invalid', message } };
}

function refreshTrade(extra: readonly string[] = []): void {
  for (const path of ['/trade', '/trade/deductions', '/trade/promotions', '/trade/remittances', '/ledger', '/dashboard', '/sales/aging', ...extra]) {
    revalidatePath(path);
  }
}

function cents(text: string, field: string): number | string {
  try {
    return parseMoney(text);
  } catch {
    return `Enter ${field} as a dollar amount, like 123.45.`;
  }
}

// ---------------------------------------------------------------------------
// Remittances
// ---------------------------------------------------------------------------

interface RemittanceUpload {
  file: File;
  customerId: string;
  depositAccountId: string;
  sourceSystem?: RemittanceSource;
}

function readRemittanceForm(form: FormData): RemittanceUpload | string {
  const customerId = String(form.get('customerId') ?? '');
  if (!UUID.test(customerId)) return 'Choose the distributor this remittance came from.';
  const depositAccountId = String(form.get('depositAccountId') ?? '');
  if (!UUID.test(depositAccountId)) return 'Choose where the cash lands.';
  const source = String(form.get('sourceSystem') ?? '');
  const file = form.get('file');
  if (!(file instanceof File) || file.size === 0) return 'Choose the remittance file.';
  if (file.size > MAX_BYTES) return 'That file is larger than 950 KB. Export fewer payments at a time.';
  const known = (REMITTANCE_SOURCES as readonly string[]).includes(source);
  return { file, customerId, depositAccountId, ...(known ? { sourceSystem: source as RemittanceSource } : {}) };
}

/** Reads the file and plans every payment in it. Writes nothing. */
export async function previewRemittance(form: FormData): Promise<TradeActionResult<RemittancePreviewView>> {
  try {
    await requireCapability('trade.manage');
    const upload = readRemittanceForm(form);
    if (typeof upload === 'string') return invalid(upload);
    const parsed = await readFile(new Uint8Array(await upload.file.arrayBuffer()), upload.file.name);
    const value = await previewRemittanceFile(parsed, {
      customerId: upload.customerId,
      depositAccountId: upload.depositAccountId,
      ...(upload.sourceSystem === undefined ? {} : { sourceSystem: upload.sourceSystem }),
    });
    return { ok: true, value };
  } catch (error) {
    return fail(error);
  }
}

/** Posts every postable payment in the file, each in its own transaction. */
export async function postRemittance(form: FormData): Promise<TradeActionResult<RemittancePostView>> {
  try {
    const user = await requireCapability('trade.manage');
    const upload = readRemittanceForm(form);
    if (typeof upload === 'string') return invalid(upload);
    const parsed = await readFile(new Uint8Array(await upload.file.arrayBuffer()), upload.file.name);
    const result = await importRemittanceFile(
      parsed,
      {
        customerId: upload.customerId,
        depositAccountId: upload.depositAccountId,
        ...(upload.sourceSystem === undefined ? {} : { sourceSystem: upload.sourceSystem }),
      },
      { userId: user.id },
    );
    const fatal = result.issues.filter((i) => i.severity === 'fatal');
    if (fatal.length > 0) {
      return { ok: false, error: { code: 'unreadable', message: 'The file cannot be posted.', details: fatal.map((i) => i.message) } };
    }
    const value: RemittancePostView = { posted: [], skipped: [], quarantined: [] };
    for (const advice of result.advices) {
      if (advice.status === 'posted') {
        value.posted.push({ paymentNumber: advice.paymentNumber, entryId: advice.entryId, entryNo: advice.entryNo, deductions: advice.deductionIds.length });
      } else if (advice.status === 'skipped') {
        value.skipped.push({ paymentNumber: advice.paymentNumber, message: advice.message });
      } else {
        value.quarantined.push({
          paymentNumber: advice.paymentNumber,
          reasons: advice.issues.filter((i) => i.severity === 'fatal' || i.severity === 'error').map((i) => i.message),
        });
      }
    }
    if (value.posted.length > 0) refreshTrade();
    return { ok: true, value };
  } catch (error) {
    return fail(error);
  }
}

// ---------------------------------------------------------------------------
// Deductions
// ---------------------------------------------------------------------------

function idsOf(ids: readonly string[]): string[] | string {
  if (ids.length === 0) return 'Select at least one deduction.';
  if (ids.length > MAX_BULK) return `Select at most ${MAX_BULK} deductions at a time.`;
  if (ids.some((id) => !UUID.test(id))) return 'That deduction reference is not valid.';
  return [...new Set(ids)];
}

export async function previewValidation(
  deductionId: string,
  reasonCode: string | null,
  date: string,
): Promise<TradeActionResult<ValidationPreview>> {
  try {
    await requireCapability('trade.manage');
    if (!isCalendarDate(date)) return invalid('Give the validation date.');
    const code = reasonCode === null || reasonCode.trim() === '' ? null : reasonCode.trim();
    return { ok: true, value: await validationPreview(deductionId, code, date) };
  } catch (error) {
    return fail(error);
  }
}

export async function previewBulkValidation(ids: readonly string[], date: string): Promise<TradeActionResult<BulkValidationView>> {
  try {
    await requireCapability('trade.manage');
    const list = idsOf(ids);
    if (typeof list === 'string') return invalid(list);
    if (!isCalendarDate(date)) return invalid('Give the validation date.');
    return { ok: true, value: await bulkValidationPreview(list, date) };
  } catch (error) {
    return fail(error);
  }
}

export interface BulkOutcome {
  done: { deductionNo: string; entryNo: number | null }[];
  refused: { id: string; message: string }[];
}

export interface ValidateForm {
  date: string;
  reasonCode: string;
  memo: string;
}

/** Validates each deduction in its own entry; one refusal never holds back the rest. */
export async function validateDeductions(ids: readonly string[], form: ValidateForm): Promise<TradeActionResult<BulkOutcome>> {
  try {
    const user = await requireCapability('trade.manage');
    const list = idsOf(ids);
    if (typeof list === 'string') return invalid(list);
    if (!isCalendarDate(form.date)) return invalid('Give the validation date.');
    const code = form.reasonCode.trim();
    const memo = form.memo.trim();
    const outcome: BulkOutcome = { done: [], refused: [] };
    for (const id of list) {
      try {
        const result = await validateDeduction(
          id,
          { date: form.date, ...(code === '' ? {} : { reasonCode: code }), ...(memo === '' ? {} : { memo }) },
          { userId: user.id },
        );
        outcome.done.push({ deductionNo: result.deduction.deductionNo, entryNo: result.entryNo });
      } catch (error) {
        outcome.refused.push({ id, message: failure(error).message });
      }
    }
    if (outcome.done.length > 0) refreshTrade(list.map((id) => `/trade/deductions/${id}`));
    return { ok: true, value: outcome };
  } catch (error) {
    return fail(error);
  }
}

export interface DisputeForm {
  date: string;
  reference: string;
  notes: string;
  reasonCode: string;
}

/** Files a dispute on each deduction. No money moves; each case gets its deadline. */
export async function disputeDeductions(ids: readonly string[], form: DisputeForm): Promise<TradeActionResult<BulkOutcome>> {
  try {
    const user = await requireCapability('trade.manage');
    const list = idsOf(ids);
    if (typeof list === 'string') return invalid(list);
    if (!isCalendarDate(form.date)) return invalid('Give the date the dispute is filed.');
    const outcome: BulkOutcome = { done: [], refused: [] };
    for (const id of list) {
      try {
        const updated = await disputeDeduction(
          id,
          {
            date: form.date,
            ...(form.reference.trim() === '' ? {} : { reference: form.reference }),
            ...(form.notes.trim() === '' ? {} : { notes: form.notes }),
            ...(form.reasonCode.trim() === '' ? {} : { reasonCode: form.reasonCode.trim() }),
          },
          { userId: user.id },
        );
        outcome.done.push({ deductionNo: updated.deductionNo, entryNo: null });
      } catch (error) {
        outcome.refused.push({ id, message: failure(error).message });
      }
    }
    if (outcome.done.length > 0) refreshTrade(list.map((id) => `/trade/deductions/${id}`));
    return { ok: true, value: outcome };
  } catch (error) {
    return fail(error);
  }
}

export interface RecoverForm {
  date: string;
  amount: string;
  depositAccountId: string;
  writeOffRemainder: boolean;
  reference: string;
}

export async function recoverOne(deductionId: string, form: RecoverForm): Promise<TradeActionResult<{ entryNo: number }>> {
  try {
    const user = await requireCapability('trade.manage');
    if (!UUID.test(deductionId)) return invalid('That deduction reference is not valid.');
    if (!isCalendarDate(form.date)) return invalid('Give the date the money arrived.');
    if (!UUID.test(form.depositAccountId)) return invalid('Choose where the money arrived.');
    const amount = cents(form.amount, 'the amount recovered');
    if (typeof amount === 'string') return invalid(amount);
    const result = await recoverDeduction(
      deductionId,
      {
        date: form.date,
        amountCents: amount,
        depositAccountId: form.depositAccountId,
        writeOffRemainder: form.writeOffRemainder,
        ...(form.reference.trim() === '' ? {} : { reference: form.reference }),
      },
      { userId: user.id },
    );
    refreshTrade([`/trade/deductions/${deductionId}`]);
    return { ok: true, value: { entryNo: result.entryNo } };
  } catch (error) {
    return fail(error);
  }
}

export interface WriteOffForm {
  date: string;
  amount: string;
  reason: string;
}

export async function writeOffOne(deductionId: string, form: WriteOffForm): Promise<TradeActionResult<{ entryNo: number }>> {
  try {
    const user = await requireCapability('trade.manage');
    if (!UUID.test(deductionId)) return invalid('That deduction reference is not valid.');
    if (!isCalendarDate(form.date)) return invalid('Give the write-off date.');
    let amountCents: number | undefined;
    if (form.amount.trim() !== '') {
      const amount = cents(form.amount, 'the amount to write off');
      if (typeof amount === 'string') return invalid(amount);
      amountCents = amount;
    }
    if (form.reason.trim() === '') return invalid('Say why it is being written off; the entry carries the reason.');
    const result = await writeOffDeduction(
      deductionId,
      { date: form.date, reason: form.reason.slice(0, 200), ...(amountCents === undefined ? {} : { amountCents }) },
      { userId: user.id },
    );
    refreshTrade([`/trade/deductions/${deductionId}`]);
    return { ok: true, value: { entryNo: result.entryNo } };
  } catch (error) {
    return fail(error);
  }
}

// ---------------------------------------------------------------------------
// Promotions
// ---------------------------------------------------------------------------

function isPromoType(value: string): value is PromoType {
  return Object.prototype.hasOwnProperty.call(PROMO_CONTRA_ACCOUNT, value);
}

interface ReadDraft {
  promoType: PromoType;
  products: { productId: string; plannedUnits: string; allowancePerUnitCents: number }[];
  plannedUnits: string | null;
  allowancePerUnitCents: number | null;
  fixedFeeCents: number;
  window: { from: string; to: string };
}

const UNITS = /^\d+(\.\d{1,2})?$/;

function readDraft(draft: PromotionDraft): ReadDraft | string {
  if (!isPromoType(draft.promoType)) return 'Choose the kind of promotion.';
  if (!isCalendarDate(draft.startDate) || !isCalendarDate(draft.endDate)) return 'Give the promotion’s start and end dates.';
  if (draft.endDate < draft.startDate) return 'The promotion ends before it starts.';
  const shipGiven = draft.shipStartDate !== '' || draft.shipEndDate !== '';
  if (shipGiven && (!isCalendarDate(draft.shipStartDate) || !isCalendarDate(draft.shipEndDate))) return 'Give both ends of the ship window, or neither.';
  if (shipGiven && draft.shipEndDate < draft.shipStartDate) return 'The ship window ends before it starts.';
  const products: ReadDraft['products'] = [];
  for (const [index, line] of draft.products.entries()) {
    if (line.productId === '') continue;
    if (!UUID.test(line.productId)) return `Product line ${index + 1} is not a product.`;
    const units = line.plannedUnits.replace(/,/g, '').trim();
    if (!UNITS.test(units)) return `Give product line ${index + 1}’s units as a number, like 240 or 12.5.`;
    const allowance = cents(line.allowancePerUnit || '0', `product line ${index + 1}’s allowance`);
    if (typeof allowance === 'string') return allowance;
    products.push({ productId: line.productId, plannedUnits: units, allowancePerUnitCents: allowance });
  }
  let plannedUnits: string | null = null;
  let allowancePerUnitCents: number | null = null;
  if (products.length === 0 && (draft.plannedUnits.trim() !== '' || draft.allowancePerUnit.trim() !== '')) {
    const units = draft.plannedUnits.replace(/,/g, '').trim();
    if (!UNITS.test(units)) return 'Give the planned units as a number, like 240 or 12.5.';
    const allowance = cents(draft.allowancePerUnit || '0', 'the allowance per unit');
    if (typeof allowance === 'string') return allowance;
    plannedUnits = units;
    allowancePerUnitCents = allowance;
  }
  const fee = draft.fixedFee.trim() === '' ? 0 : cents(draft.fixedFee, 'the fixed fee');
  if (typeof fee === 'string') return fee;
  if (fee < 0) return 'The fixed fee cannot be negative.';
  return {
    promoType: draft.promoType,
    products,
    plannedUnits,
    allowancePerUnitCents,
    fixedFeeCents: fee,
    window: shipGiven ? { from: draft.shipStartDate, to: draft.shipEndDate } : { from: draft.startDate, to: draft.endDate },
  };
}

/** The plan's total and its month-by-month accrual, from the engine's own schedule. */
export async function previewPromotionPlan(draft: PromotionDraft): Promise<TradeActionResult<PlanPreviewView>> {
  try {
    await requireCapability('trade.manage');
    const read = readDraft(draft);
    if (typeof read === 'string') return invalid(read);
    const allowance =
      read.products.length > 0
        ? allowanceCents(read.products)
        : allowanceCents([{ plannedUnits: read.plannedUnits, allowancePerUnitCents: read.allowancePerUnitCents }]);
    const months = accrualSchedule(read.window, allowance, read.fixedFeeCents).map((m) => ({
      periodEnd: m.periodEnd,
      days: m.days,
      allowanceCents: m.allowanceCents,
      feeCents: m.feeCents,
    }));
    return { ok: true, value: { allowanceCents: allowance, feeCents: read.fixedFeeCents, totalCents: allowance + read.fixedFeeCents, months } };
  } catch (error) {
    return fail(error);
  }
}

export async function createPromotionAction(draft: PromotionDraft): Promise<TradeActionResult<{ id: string }>> {
  try {
    const user = await requireCapability('trade.manage');
    if (draft.name.trim() === '') return invalid('Name the promotion.');
    if (!UUID.test(draft.customerId)) return invalid('Choose the customer the promotion runs with.');
    const read = readDraft(draft);
    if (typeof read === 'string') return invalid(read);
    const created = await createPromotion(
      {
        name: draft.name,
        customerId: draft.customerId,
        promoType: read.promoType,
        startDate: draft.startDate,
        endDate: draft.endDate,
        ...(draft.shipStartDate === '' ? {} : { shipStartDate: draft.shipStartDate, shipEndDate: draft.shipEndDate }),
        ...(draft.authorizationNo.trim() === '' ? {} : { authorizationNo: draft.authorizationNo }),
        ...(read.products.length > 0 ? { products: read.products } : {}),
        ...(read.plannedUnits === null ? {} : { plannedUnits: read.plannedUnits, allowancePerUnitCents: read.allowancePerUnitCents ?? 0 }),
        fixedFeeCents: read.fixedFeeCents,
        ...(draft.notes.trim() === '' ? {} : { notes: draft.notes }),
      },
      { userId: user.id },
    );
    refreshTrade();
    return { ok: true, value: { id: created.promotion.id } };
  } catch (error) {
    return fail(error);
  }
}

export async function accruePromotionAction(promotionId: string, through: string): Promise<TradeActionResult<{ months: number; cents: number }>> {
  try {
    const user = await requireCapability('trade.manage');
    if (!UUID.test(promotionId)) return invalid('That promotion reference is not valid.');
    if (!isCalendarDate(through)) return invalid('Give the date to accrue through.');
    const posted = await accruePromotion(promotionId, { through }, { userId: user.id });
    refreshTrade([`/trade/promotions/${promotionId}`]);
    return { ok: true, value: { months: posted.length, cents: posted.reduce((s, p) => s + p.amountCents, 0) } };
  } catch (error) {
    return fail(error);
  }
}

export async function closePromotionAction(
  promotionId: string,
  date: string,
  cancel: boolean,
): Promise<TradeActionResult<{ releasedCents: number }>> {
  try {
    const user = await requireCapability('trade.manage');
    if (!UUID.test(promotionId)) return invalid('That promotion reference is not valid.');
    if (!isCalendarDate(date)) return invalid('Give the closing date.');
    const result = await closePromotion(promotionId, { date, cancel }, { userId: user.id });
    refreshTrade([`/trade/promotions/${promotionId}`]);
    return { ok: true, value: { releasedCents: result.releasedCents } };
  } catch (error) {
    return fail(error);
  }
}

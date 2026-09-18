'use server';

/**
 * Every mutation the channel screens can make.
 *
 * Each action checks the capability, hands the work to the channels engine
 * (`@/lib/channels`) or the Square intake, turns a typed refusal into the `{ ok: false, error }`
 * the client shows, and revalidates the screens whose figures moved. Importing never posts;
 * posting a settlement is its own action, taken by the person who pressed the button.
 */

import { revalidatePath } from 'next/cache';

import type { PayoutLineType } from '@/db/schema';
import { isForbiddenError } from '@/lib/auth/roles';
import { requireCapability } from '@/lib/auth/session';
import { roleOfLine } from '@/lib/channels/accounts';
import { isChannelError } from '@/lib/channels/errors';
import { type ChannelImportInput, importChannelSettlements } from '@/lib/channels/intake';
import { linkDepositsToPayout, postPayout, unpostPayout } from '@/lib/channels/post';
import { fileSalesTaxReturn, paySalesTax } from '@/lib/channels/sales-tax';
import { isCalendarDate } from '@/lib/dates';
import { isQueryError, postgresErrorOf } from '@/lib/db-errors';
import { SquareImportError, importSquareSettlements } from '@/lib/importers/square-intake';
import { isLedgerError } from '@/lib/ledger/errors';
import { translateLedgerDbError } from '@/lib/ledger/post';
import { formatMoney, parseMoney, sumCents } from '@/lib/money';

import {
  type ActionFailure,
  type ActionResult,
  type ProviderKey,
  type SettlementImportView,
  type SettlementIssueView,
  type SettlementPreviewView,
  isProviderKey,
} from '@/components/channels/types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Server actions accept 1 MB; leave room for the form around the file. */
const MAX_BYTES = 950 * 1024;

function failure(error: unknown): ActionFailure {
  if (isChannelError(error)) {
    return { code: error.code, message: error.remedy === null ? error.message : `${error.message} ${error.remedy}` };
  }
  if (error instanceof SquareImportError) {
    return { code: error.code, message: error.remedy === null ? error.message : `${error.message} ${error.remedy}` };
  }
  if (isForbiddenError(error)) return { code: 'forbidden', message: error.message };
  const translated = translateLedgerDbError(error);
  if (isLedgerError(translated)) return { code: translated.code, message: translated.message };
  const pg = postgresErrorOf(error);
  if (pg !== null) return { code: 'unexpected', message: `The database refused this change: ${pg.message}` };
  if (isQueryError(error)) return { code: 'unexpected', message: 'The database could not complete this request.' };
  if (error instanceof Error) return { code: 'unexpected', message: error.message };
  return { code: 'unexpected', message: 'Something went wrong.' };
}

function fail<T>(error: unknown): ActionResult<T> {
  return { ok: false, error: failure(error) };
}

function invalid<T>(message: string): ActionResult<T> {
  return { ok: false, error: { code: 'invalid', message } };
}

function refreshChannels(payoutId?: string): void {
  revalidatePath('/channels');
  revalidatePath('/channels/payouts');
  if (payoutId !== undefined) revalidatePath(`/channels/payouts/${payoutId}`);
  revalidatePath('/channels/sales-tax');
  revalidatePath('/ledger');
  revalidatePath('/dashboard');
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

interface Upload {
  provider: ProviderKey;
  primary: File;
  orders: File | null;
}

function readUpload(form: FormData): Upload | string {
  const provider = String(form.get('provider') ?? '');
  if (!isProviderKey(provider)) return 'Choose which channel this file came from.';
  const primary = form.get('file');
  if (!(primary instanceof File) || primary.size === 0) return 'Choose the settlement file to import.';
  const orders = form.get('orders');
  const second = orders instanceof File && orders.size > 0 ? orders : null;
  if (primary.size + (second?.size ?? 0) > MAX_BYTES) {
    return 'That upload is larger than 950 KB. Export a shorter date range and import it in parts.';
  }
  return { provider, primary, orders: provider === 'shopify' ? second : null };
}

const FEE_TYPES: ReadonlySet<PayoutLineType> = new Set<PayoutLineType>([
  'referral_fee',
  'processing_fee',
  'fulfillment_fee',
  'storage_fee',
  'shipping_cost',
  'advertising',
  'subscription_fee',
]);

async function channelInput(upload: Upload): Promise<ChannelImportInput> {
  const file = { filename: upload.primary.name, bytes: new Uint8Array(await upload.primary.arrayBuffer()) };
  switch (upload.provider) {
    case 'shopify':
      return {
        provider: 'shopify',
        balance: file,
        ...(upload.orders === null ? {} : { orders: { filename: upload.orders.name, bytes: new Uint8Array(await upload.orders.arrayBuffer()) } }),
      };
    case 'amazon':
      return { provider: 'amazon', file };
    case 'faire':
      return { provider: 'faire', file };
    case 'square':
      throw new Error('Square files go through the Square intake.');
  }
}

async function previewSquare(upload: Upload, userId: string): Promise<SettlementPreviewView> {
  const result = await importSquareSettlements({
    filename: upload.primary.name,
    bytes: new Uint8Array(await upload.primary.arrayBuffer()),
    userId,
    dryRun: true,
  });
  const preview = result.preview;
  const byKey = new Map(result.settlements.map((s) => [s.key, s]));
  const issues: SettlementIssueView[] = preview.warnings.map((w) => ({ severity: w.severity, code: w.code, message: w.message, remedy: null }));
  if (preview.blockingSkippedRows > 0) {
    issues.unshift({
      severity: 'fatal',
      code: 'square.rows_skipped',
      message: `${preview.blockingSkippedRows} row${preview.blockingSkippedRows === 1 ? ' was' : 's were'} skipped, so the file cannot prove it is complete.`,
      remedy: 'Export the full date range again from Square.',
    });
  }
  const settlements = preview.settlements.map((s) => {
    const outcome = byKey.get(s.key);
    const match = outcome?.match ?? null;
    return {
      key: s.key,
      periodEnd: s.date,
      grossCents: outcome?.grossCents ?? 0,
      feesCents: outcome?.feesCents ?? null,
      netCents: s.netTotalCents,
      lineCount: null,
      outcome: outcome?.outcome ?? 'new',
      ties: s.ok,
      checks: [
        {
          label: 'Net total = total collected + fees',
          passed: s.ok,
          severity: 'fatal' as const,
          expectedCents: s.netTotalCents,
          actualCents: s.netTotalCents + s.differenceCents,
          differenceCents: s.differenceCents,
          detail:
            s.ok
              ? null
              : s.diagnosis === 'ties_if_outflows_negated'
                ? 'It would tie if refunds and fees were read with the opposite sign.'
                : s.diagnosis === 'ties_without_unmapped'
                  ? 'It would tie without a column this importer does not recognise.'
                  : `Off by ${formatMoney(s.differenceCents)}.`,
        },
      ],
      deposit:
        match === null
          ? { status: 'none' as const, detail: `No ${s.bankReference} deposit found yet.` }
          : {
              status: match.status === 'matched' ? ('matched' as const) : match.status === 'unmatched' ? ('none' as const) : match.status,
              detail: match.reason,
            },
    };
  });
  return {
    provider: 'square',
    filename: preview.filename,
    rowCount: preview.rowCount,
    ok: preview.ok,
    settlements,
    issues,
    newCount: settlements.filter((s) => s.outcome === 'new').length,
    alreadyCount: settlements.filter((s) => s.outcome === 'already_imported').length,
    netTotalCents: preview.netTotalCents,
  };
}

async function previewChannel(upload: Upload, userId: string): Promise<SettlementPreviewView> {
  const result = await importChannelSettlements(await channelInput(upload), { userId }, { dryRun: true });
  const byKey = new Map(result.settlements.map((s) => [s.key, s]));
  const parsed = result.parsed;
  const issues: SettlementIssueView[] = [
    ...parsed.issues,
    ...parsed.settlements.flatMap((s) => s.issues),
  ].map((i) => ({ severity: i.severity, code: i.code, message: i.message, remedy: i.remedy ?? null }));
  const settlements = parsed.settlements.map((s) => {
    const outcome = byKey.get(s.key);
    const checks = s.assertions.map((a) => ({
      label: a.label,
      passed: a.passed,
      severity: a.severity,
      expectedCents: a.expectedCents,
      actualCents: a.actualCents,
      differenceCents: a.differenceCents,
      detail: a.detail ?? null,
    }));
    const facilitatorNet = sumCents(s.lines.filter((l) => roleOfLine(l.lineType, l.role) === 'facilitator_tax').map((l) => l.amountCents));
    const facilitatorGross = sumCents(s.lines.filter((l) => l.lineType === 'facilitator_tax').map((l) => Math.abs(l.amountCents)));
    if (facilitatorGross > 0 && !s.assertions.some((a) => /facilitator/i.test(`${a.id} ${a.label}`))) {
      checks.push({
        label: 'Marketplace-facilitator tax nets to zero',
        passed: facilitatorNet === 0,
        severity: 'fatal',
        expectedCents: 0,
        actualCents: facilitatorNet,
        differenceCents: facilitatorNet,
        detail: 'Collected and withheld by the marketplace, so it passes through and never reaches 2200.',
      });
    }
    return {
      key: s.key,
      periodEnd: s.periodEnd,
      grossCents: outcome?.grossCents ?? sumCents(s.lines.filter((l) => l.lineType === 'gross_sales').map((l) => l.amountCents)),
      feesCents: sumCents(s.lines.filter((l) => FEE_TYPES.has(l.lineType)).map((l) => l.amountCents)),
      netCents: s.reportedNetCents,
      lineCount: s.lines.length,
      outcome: outcome?.outcome ?? 'new',
      ties: checks.every((c) => c.passed || c.severity !== 'fatal'),
      checks,
      deposit:
        outcome?.depositId != null
          ? { status: 'matched' as const, detail: 'The one bank deposit for exactly this net will be linked.' }
          : { status: 'none' as const, detail: 'No matching deposit in the bank yet; it can be linked later.' },
    };
  });
  return {
    provider: upload.provider,
    filename: parsed.filename,
    rowCount: parsed.rowCount,
    ok: parsed.ok,
    settlements,
    issues,
    newCount: settlements.filter((s) => s.outcome === 'new').length,
    alreadyCount: settlements.filter((s) => s.outcome === 'already_imported').length,
    netTotalCents: sumCents(settlements.map((s) => s.netCents)),
  };
}

/** Reads the file, checks every settlement's identity and looks for its deposit. Writes nothing. */
export async function previewSettlementFile(form: FormData): Promise<ActionResult<SettlementPreviewView>> {
  try {
    const user = await requireCapability('bank.import');
    const upload = readUpload(form);
    if (typeof upload === 'string') return invalid(upload);
    const value = upload.provider === 'square' ? await previewSquare(upload, user.id) : await previewChannel(upload, user.id);
    return { ok: true, value };
  } catch (error) {
    return fail(error);
  }
}

/** Writes the file's settlements to the register. Posts nothing. */
export async function importSettlementFile(form: FormData): Promise<ActionResult<SettlementImportView>> {
  try {
    const user = await requireCapability('bank.import');
    const upload = readUpload(form);
    if (typeof upload === 'string') return invalid(upload);
    let value: SettlementImportView;
    if (upload.provider === 'square') {
      const result = await importSquareSettlements({
        filename: upload.primary.name,
        bytes: new Uint8Array(await upload.primary.arrayBuffer()),
        userId: user.id,
      });
      value = { provider: 'square', filename: result.filename, inserted: result.inserted, alreadyImported: result.alreadyImported, depositsLinked: result.depositsLinked };
    } else {
      const result = await importChannelSettlements(await channelInput(upload), { userId: user.id });
      value = { provider: upload.provider, filename: result.filename, inserted: result.inserted, alreadyImported: result.alreadyImported, depositsLinked: result.depositsLinked };
    }
    refreshChannels();
    revalidatePath('/banking');
    return { ok: true, value };
  } catch (error) {
    return fail(error);
  }
}

// ---------------------------------------------------------------------------
// Posting
// ---------------------------------------------------------------------------

export async function postSettlement(
  payoutId: string,
  taxState: string | null,
): Promise<ActionResult<{ entryId: string; entryNo: number; suspenseCents: number }>> {
  try {
    const user = await requireCapability('ledger.post');
    if (!UUID.test(payoutId)) return invalid('That settlement reference is not valid.');
    const state = taxState?.trim() ?? '';
    const posted = await postPayout(payoutId, { userId: user.id }, state === '' ? {} : { taxState: state });
    refreshChannels(payoutId);
    return { ok: true, value: { entryId: posted.entryId, entryNo: posted.entryNo, suspenseCents: posted.suspenseCents } };
  } catch (error) {
    return fail(error);
  }
}

export async function unpostSettlement(payoutId: string, reason: string): Promise<ActionResult<{ reversalEntryNo: number }>> {
  try {
    const user = await requireCapability('ledger.post');
    if (!UUID.test(payoutId)) return invalid('That settlement reference is not valid.');
    const trimmed = reason.trim();
    if (trimmed === '') return invalid('Say why the settlement is being unposted; the reversal carries the reason.');
    const result = await unpostPayout(payoutId, { userId: user.id }, { reason: trimmed.slice(0, 200) });
    refreshChannels(payoutId);
    return { ok: true, value: { reversalEntryNo: result.reversalEntryNo } };
  } catch (error) {
    return fail(error);
  }
}

export async function linkSettlementDeposits(payoutId: string, bankTransactionIds: readonly string[]): Promise<ActionResult<{ linked: number }>> {
  try {
    const user = await requireCapability('bank.approve');
    if (!UUID.test(payoutId) || bankTransactionIds.some((id) => !UUID.test(id))) return invalid('That reference is not valid.');
    const result = await linkDepositsToPayout(payoutId, bankTransactionIds, { userId: user.id });
    refreshChannels(payoutId);
    revalidatePath('/banking');
    return { ok: true, value: { linked: result.bankTransactionIds.length } };
  } catch (error) {
    return fail(error);
  }
}

// ---------------------------------------------------------------------------
// Sales tax
// ---------------------------------------------------------------------------

export interface FileReturnForm {
  state: string;
  periodStart: string;
  periodEnd: string;
  confirmation: string;
  notes: string;
}

export async function fileReturn(input: FileReturnForm): Promise<ActionResult<{ filingId: string; entriesReported: number; taxDueCents: number }>> {
  try {
    const user = await requireCapability('ledger.post');
    if (!isCalendarDate(input.periodStart) || !isCalendarDate(input.periodEnd)) return invalid('Give the period as two dates.');
    const filed = await fileSalesTaxReturn(
      {
        state: input.state,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        ...(input.confirmation.trim() === '' ? {} : { confirmation: input.confirmation }),
        ...(input.notes.trim() === '' ? {} : { notes: input.notes }),
      },
      { userId: user.id },
    );
    refreshChannels();
    return { ok: true, value: { filingId: filed.filing.id, entriesReported: filed.entriesReported, taxDueCents: filed.filing.taxDueCents } };
  } catch (error) {
    return fail(error);
  }
}

export interface PayReturnForm {
  filingId: string;
  bankAccountId: string;
  date: string;
  amount: string;
  discount: string;
}

export async function payReturn(input: PayReturnForm): Promise<ActionResult<{ entryId: string; entryNo: number }>> {
  try {
    const user = await requireCapability('ledger.post');
    if (!isCalendarDate(input.date)) return invalid('Give the payment date.');
    let amountCents: number;
    let discountCents: number;
    try {
      amountCents = parseMoney(input.amount);
      discountCents = input.discount.trim() === '' ? 0 : parseMoney(input.discount);
    } catch {
      return invalid('Enter the payment and discount as dollar amounts, like 123.45.');
    }
    const paid = await paySalesTax(
      { filingId: input.filingId, bankAccountId: input.bankAccountId, date: input.date, amountCents, discountCents },
      { userId: user.id },
    );
    refreshChannels();
    return { ok: true, value: { entryId: paid.entryId, entryNo: paid.entryNo } };
  } catch (error) {
    return fail(error);
  }
}

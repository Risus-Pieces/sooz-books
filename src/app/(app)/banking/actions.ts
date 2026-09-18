'use server';

/**
 * Every mutation the banking screens can make.
 *
 * Each action does the same things in the same order: check the capability, hand the work to
 * the banking engine (`@/lib/banking`) or to `./data` for the few writes the engine does not
 * cover, turn a typed refusal into the `{ ok: false, error }` the client shows, and revalidate
 * the routes whose figures moved. Nothing here decides for anyone: an approval is always the
 * decision of the person who pressed the key.
 */

import { revalidatePath } from 'next/cache';
import { sql } from 'drizzle-orm';

import { db } from '@/db/client';
import { applyMatch, isArapError, matchCandidates } from '@/lib/arap';
import { can, isForbiddenError } from '@/lib/auth/roles';
import { requireCapability } from '@/lib/auth/session';
import { ImportError, cancelPreview, commitImport, previewImport, saveImportProfile } from '@/lib/banking/import';
import type { ImportDecision, ImportPreview } from '@/lib/banking/import';
import {
  type ApprovalSplit,
  type ApproveInput,
  type BulkResult,
  approveMany,
  approveTransfer,
  createRuleFromTransaction,
  isBankingError,
  linkBankTransactionToEntry,
  linkTransfer,
  markPersonal,
  postAutoPostMatches,
  unlinkTransfer,
  unpostBankTransaction,
} from '@/lib/banking/post';
import {
  abandonReconciliation,
  completeReconciliation,
  startReconciliation,
  toggleCleared,
  undoReconciliation,
  type ReconciliationSummary,
} from '@/lib/banking/reconcile';
import { bookedCandidatesForTxn } from '@/lib/banking/booked';
import type { ImportProfile } from '@/lib/banking/types';
import { GENERIC_IMPORTER_ID } from '@/lib/importers/generic';
import { isCalendarDate } from '@/lib/dates';
import { isQueryError, postgresErrorOf } from '@/lib/db-errors';
import { isLedgerError } from '@/lib/ledger/errors';
import { translateLedgerDbError } from '@/lib/ledger/post';

import type {
  ActionFailure,
  ActionResult,
  ImportCommitView,
  ImportDecisionView,
  ImportIssueView,
  ImportPreviewView,
  MappingView,
  MatchOptionsView,
  ReconSummaryView,
  RuleCondition,
  RuleDirection,
  RuleDraft,
  RulePreview,
} from '@/components/banking/types';

import { excludeTransactions, includeTransactions, previewRule, saveRule, setRuleActive } from './data';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

function failure(error: unknown): ActionFailure {
  if (isBankingError(error)) return { code: error.code, message: error.message };
  if (isArapError(error)) return { code: error.code, message: error.message };
  if (error instanceof ImportError) {
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

function ok<T>(value: T): ActionResult<T> {
  return { ok: true, value };
}

function fail<T>(error: unknown): ActionResult<T> {
  return { ok: false, error: failure(error) };
}

function invalid<T>(message: string): ActionResult<T> {
  return { ok: false, error: { code: 'invalid', message } };
}

function assertIds(ids: readonly string[]): void {
  for (const id of ids) {
    if (!UUID.test(id)) throw new Error('That transaction reference is not valid.');
  }
}

/** Every screen a posting, an exclusion or a rule can change. */
function refreshBanking(): void {
  revalidatePath('/banking');
  revalidatePath('/banking/review');
  revalidatePath('/banking/reconcile');
  revalidatePath('/banking/rules');
  revalidatePath('/ledger');
  revalidatePath('/dashboard');
}

// ---------------------------------------------------------------------------
// Review queue
// ---------------------------------------------------------------------------

export interface AcceptItem {
  txnId: string;
  /** Omitted: the row's own suggestion (or a linked refund's charge account). */
  accountId?: string;
  vendorId?: string | null;
  memo?: string;
  /** The reviewer saw the entry that already records this amount and says this is a different transaction. */
  confirmedNew?: boolean;
}

export interface AcceptOutcome {
  posted: { txnId: string; entryNo: number }[];
  failed: { txnId: string; message: string; code: string }[];
}

function outcome(results: readonly BulkResult[]): AcceptOutcome {
  const out: AcceptOutcome = { posted: [], failed: [] };
  for (const result of results) {
    if (result.ok) out.posted.push({ txnId: result.txnId, entryNo: result.entryNo });
    else out.failed.push({ txnId: result.txnId, message: result.error, code: result.code });
  }
  return out;
}

/**
 * Posts each row to the account chosen for it — its suggestion unless the reviewer picked
 * another. Every row is its own transaction: one refusal never undoes the others.
 */
export async function acceptTransactions(items: readonly AcceptItem[]): Promise<ActionResult<AcceptOutcome>> {
  try {
    const user = await requireCapability('bank.approve');
    if (items.length === 0) return invalid('Choose at least one transaction.');
    if (items.length > 500) return invalid('Accept at most 500 transactions at a time.');
    assertIds(items.map((item) => item.txnId));
    for (const item of items) {
      if (item.accountId !== undefined && !UUID.test(item.accountId)) return invalid('That account is not valid.');
      if (item.vendorId !== undefined && item.vendorId !== null && !UUID.test(item.vendorId)) {
        return invalid('That vendor is not valid.');
      }
    }
    const inputs: ApproveInput[] = items.map((item) => ({
      txnId: item.txnId,
      ...(item.accountId === undefined ? {} : { accountId: item.accountId }),
      ...(item.vendorId === undefined ? {} : { vendorId: item.vendorId }),
      ...(item.memo === undefined || item.memo.trim() === '' ? {} : { memo: item.memo }),
      ...(item.confirmedNew === true ? { confirmedNew: true } : {}),
    }));
    const result = outcome(await approveMany(inputs, { userId: user.id }));
    if (result.posted.length > 0) refreshBanking();
    return ok(result);
  } catch (error) {
    return fail(error);
  }
}

/** Posts a mixed-use purchase that was personal to Owner Draws. */
export async function markPersonalTransaction(
  txnId: string,
  confirmedNew = false,
): Promise<ActionResult<{ entryNo: number }>> {
  try {
    const user = await requireCapability('bank.approve');
    assertIds([txnId]);
    const result = await markPersonal(txnId, { userId: user.id }, { confirmedNew });
    refreshBanking();
    return ok({ entryNo: result.entryNo });
  } catch (error) {
    return fail(error);
  }
}

export async function splitTransaction(
  txnId: string,
  splits: readonly { accountId: string; amountCents: number; memo: string }[],
  confirmedNew = false,
): Promise<ActionResult<{ entryNo: number }>> {
  try {
    const user = await requireCapability('bank.approve');
    assertIds([txnId]);
    if (splits.length < 2) return invalid('A split needs at least two lines.');
    for (const split of splits) {
      if (!UUID.test(split.accountId)) return invalid('Every split line needs an account.');
    }
    const lines: ApprovalSplit[] = splits.map((split) => ({
      accountId: split.accountId,
      amountCents: split.amountCents,
      ...(split.memo.trim() === '' ? {} : { memo: split.memo }),
    }));
    const [result] = await approveMany([{ txnId, splits: lines, confirmedNew }], { userId: user.id });
    if (!result.ok) return { ok: false, error: { code: result.code, message: result.error } };
    refreshBanking();
    return ok({ entryNo: result.entryNo });
  } catch (error) {
    return fail(error);
  }
}

/** Posts a paired internal transfer as one entry. */
export async function confirmTransfer(
  txnId: string,
  confirmedNew = false,
): Promise<ActionResult<{ entryNo: number }>> {
  try {
    const user = await requireCapability('bank.approve');
    assertIds([txnId]);
    const result = await approveTransfer(txnId, { userId: user.id }, { confirmedNew });
    refreshBanking();
    return ok({ entryNo: result.entryNo });
  } catch (error) {
    return fail(error);
  }
}

/** Pairs two legs the bank did not label, then posts them as one transfer. */
export async function pairAndConfirmTransfer(
  txnId: string,
  partnerId: string,
): Promise<ActionResult<{ entryNo: number }>> {
  try {
    const user = await requireCapability('bank.approve');
    assertIds([txnId, partnerId]);
    await linkTransfer(txnId, partnerId, { userId: user.id });
    refreshBanking();
    const result = await approveTransfer(txnId, { userId: user.id });
    refreshBanking();
    return ok({ entryNo: result.entryNo });
  } catch (error) {
    return fail(error);
  }
}

export async function unpairTransfer(txnId: string): Promise<ActionResult<{ txnId: string }>> {
  try {
    const user = await requireCapability('bank.approve');
    assertIds([txnId]);
    await unlinkTransfer(txnId, { userId: user.id });
    refreshBanking();
    return ok({ txnId });
  } catch (error) {
    return fail(error);
  }
}

export interface TransferCandidate {
  id: string;
  bankLabel: string;
  txnDate: string;
  payee: string;
  amountCents: number;
}

/**
 * Unposted rows on the company's other accounts that could be this row's other leg: the
 * opposite amount, within ten days. Read-only.
 */
export async function transferCandidates(txnId: string): Promise<ActionResult<TransferCandidate[]>> {
  try {
    await requireCapability('bank.approve');
    assertIds([txnId]);
    const rows = await db.execute<{
      id: string;
      name: string;
      mask: string | null;
      txn_date: string;
      payee: string;
      amount_cents: string;
    }>(sql`
      select o.id, ba.name, ba.mask, o.txn_date::text, coalesce(nullif(trim(o.counterparty), ''), o.description) as payee,
             o.amount_cents::text
        from bank_transactions me
        join bank_transactions o
          on o.bank_account_id <> me.bank_account_id
         and o.amount_cents = -me.amount_cents
         and abs(o.txn_date - me.txn_date) <= 10
        join bank_accounts ba on ba.id = o.bank_account_id
       where me.id = ${txnId}::uuid
         and o.journal_entry_id is null
         and o.status <> 'excluded'
         and o.transfer_pair_id is null
       order by abs(o.txn_date - me.txn_date), o.txn_date
       limit 20`);
    return ok(
      rows.map((row) => ({
        id: row.id,
        bankLabel: row.mask === null ? row.name : `••${row.mask}`,
        txnDate: row.txn_date,
        payee: row.payee,
        amountCents: Number(row.amount_cents),
      })),
    );
  } catch (error) {
    return fail(error);
  }
}

export async function excludeRows(txnIds: readonly string[]): Promise<ActionResult<{ changed: number }>> {
  try {
    const user = await requireCapability('bank.approve');
    assertIds(txnIds);
    const changed = await excludeTransactions(txnIds, { userId: user.id });
    refreshBanking();
    return ok({ changed });
  } catch (error) {
    return fail(error);
  }
}

export async function includeRows(txnIds: readonly string[]): Promise<ActionResult<{ changed: number }>> {
  try {
    const user = await requireCapability('bank.approve');
    assertIds(txnIds);
    const changed = await includeTransactions(txnIds, { userId: user.id });
    refreshBanking();
    return ok({ changed });
  } catch (error) {
    return fail(error);
  }
}

/**
 * Returns a posted row to review: reverses the entry the bank feed posted, or releases a
 * row linked to an entry that was already in the ledger (the entry stays).
 */
export async function unpostRow(
  txnId: string,
): Promise<ActionResult<{ reversalEntryNo: number | null; unlinkedEntryNo: number | null }>> {
  try {
    const user = await requireCapability('bank.approve');
    assertIds([txnId]);
    const result = await unpostBankTransaction(txnId, { userId: user.id });
    refreshBanking();
    return ok({ reversalEntryNo: result.reversalEntryNo, unlinkedEntryNo: result.unlinkedEntryNo });
  } catch (error) {
    return fail(error);
  }
}

// ---------------------------------------------------------------------------
// Matching a bank line to what the books already hold
// ---------------------------------------------------------------------------

/**
 * What a bank row could already be: entries in the ledger that record the same money on
 * this bank account (a receipt or bill payment entered by hand, a manual entry), and open
 * invoices or bills it could pay. Read-only.
 */
export async function matchOptions(txnId: string): Promise<ActionResult<MatchOptionsView>> {
  try {
    const user = await requireCapability('bank.approve');
    assertIds([txnId]);
    const [booked, docs] = await Promise.all([bookedCandidatesForTxn(txnId), matchCandidates(txnId, { limit: 8 })]);
    const documentCap = docs.direction === 'inflow' ? 'ar.manage' : 'ap.pay';
    return ok({
      direction: docs.direction,
      booked: booked.map((candidate) => ({
        entryId: candidate.entryId,
        entryNo: candidate.entryNo,
        entryDate: candidate.entryDate,
        memo: candidate.memo,
        sourceType: candidate.sourceType,
        documentNo: candidate.documentNo,
        partyName: candidate.partyName,
        amountCents: candidate.amountCents,
        daysApart: candidate.daysApart,
      })),
      documents: docs.candidates.map((candidate) => ({
        kind: candidate.kind,
        totalCents: candidate.totalCents,
        reasons: candidate.reasons,
        documents: candidate.documents.map((doc) => ({
          kind: doc.kind,
          id: doc.id,
          docNo: doc.docNo,
          partyName: doc.partyName,
          dueDate: doc.dueDate,
          balanceCents: doc.balanceCents,
        })),
      })),
      documentsBlocked: docs.blockedReason,
      mayRecordDocuments: can(user.role, documentCap),
    });
  } catch (error) {
    return fail(error);
  }
}

/** Links a bank row to an entry already in the ledger instead of posting it again. */
export async function linkToEntry(txnId: string, entryId: string): Promise<ActionResult<{ entryNo: number }>> {
  try {
    const user = await requireCapability('bank.approve');
    assertIds([txnId, entryId]);
    const result = await linkBankTransactionToEntry(txnId, entryId, { userId: user.id });
    refreshBanking();
    return ok({ entryNo: result.entryNo });
  } catch (error) {
    return fail(error);
  }
}

/**
 * Records the receipt (money in) or bill payment (money out) a bank row is, applied to the
 * chosen invoices or bills, and links the row to it.
 */
export async function matchToDocuments(
  txnId: string,
  kind: 'invoice' | 'bill',
  documentIds: readonly string[],
): Promise<ActionResult<{ documentNo: string; unappliedCents: number }>> {
  try {
    const user = await requireCapability('bank.approve');
    await requireCapability(kind === 'invoice' ? 'ar.manage' : 'ap.pay');
    assertIds([txnId, ...documentIds]);
    if (documentIds.length === 0) return invalid('Choose at least one document.');
    const result = await applyMatch(
      { bankTransactionId: txnId, documents: documentIds.map((id) => ({ id })) },
      { userId: user.id },
    );
    refreshBanking();
    revalidatePath(kind === 'invoice' ? '/sales' : '/purchases');
    return ok({ documentNo: result.documentNo, unappliedCents: result.unappliedCents });
  } catch (error) {
    return fail(error);
  }
}

/**
 * Posts every row an owner-marked auto-post rule categorized. The one path that posts without
 * a per-row decision — which is exactly what the owner said those rules may do.
 */
export async function postAutoPostRows(): Promise<ActionResult<{ posted: number; failed: string[] }>> {
  try {
    const user = await requireCapability('bank.approve');
    const report = await postAutoPostMatches({ userId: user.id });
    if (report.posted.length > 0) refreshBanking();
    return ok({ posted: report.posted.length, failed: report.failed.map((row) => row.error) });
  } catch (error) {
    return fail(error);
  }
}

export interface RuleFromRowInput {
  txnId: string;
  accountId: string;
  vendorId: string | null;
  conditions: RuleCondition[];
  direction: RuleDirection;
  name: string;
  thisAccountOnly: boolean;
  autoPost: boolean;
}

export async function createRuleFromRow(input: RuleFromRowInput): Promise<ActionResult<{ ruleId: string; name: string }>> {
  try {
    const user = await requireCapability('bank.import');
    assertIds([input.txnId]);
    if (input.autoPost && !can(user.role, 'settings.manage')) {
      return { ok: false, error: { code: 'forbidden', message: 'Only the owner can let a rule post without review.' } };
    }
    const rule = await createRuleFromTransaction(
      input.txnId,
      {
        accountId: input.accountId,
        vendorId: input.vendorId,
        conditions: input.conditions,
        direction: input.direction,
        ...(input.name.trim() === '' ? {} : { name: input.name }),
        thisAccountOnly: input.thisAccountOnly,
        autoPost: input.autoPost,
      },
      { userId: user.id },
    );
    revalidatePath('/banking/rules');
    return ok({ ruleId: rule.id, name: rule.name });
  } catch (error) {
    return fail(error);
  }
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

export async function saveRuleDraft(draft: RuleDraft): Promise<ActionResult<{ ruleId: string; name: string }>> {
  try {
    const user = await requireCapability('bank.import');
    const saved = await saveRule(draft, { userId: user.id, mayAutoPost: can(user.role, 'settings.manage') });
    revalidatePath('/banking/rules');
    return ok({ ruleId: saved.id, name: saved.name });
  } catch (error) {
    return fail(error);
  }
}

export async function setRuleEnabled(ruleId: string, active: boolean): Promise<ActionResult<{ ruleId: string }>> {
  try {
    const user = await requireCapability('bank.import');
    await setRuleActive(ruleId, active, { userId: user.id, mayAutoPost: can(user.role, 'settings.manage') });
    revalidatePath('/banking/rules');
    return ok({ ruleId });
  } catch (error) {
    return fail(error);
  }
}

/** "Would match N of your transactions" — read-only, run as the editor changes. */
export async function previewRuleDraft(draft: RuleDraft): Promise<ActionResult<RulePreview>> {
  try {
    await requireCapability('bank.import');
    return ok(await previewRule(draft));
  } catch (error) {
    return fail(error);
  }
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

function issueView(issue: {
  severity: ImportIssueView['severity'];
  code: string;
  message: string;
  rowIndex?: number;
  remedy?: string;
}): ImportIssueView {
  return {
    severity: issue.severity,
    code: issue.code,
    message: issue.message,
    rowIndex: issue.rowIndex ?? null,
    remedy: issue.remedy ?? null,
  };
}

function mappingView(profile: ImportProfile): MappingView {
  return {
    name: profile.name ?? '',
    date_column: profile.date_column,
    date_format: profile.date_format ?? null,
    description_columns: profile.description_columns ?? [],
    counterparty_column: profile.counterparty_column ?? null,
    mode: profile.mode,
    amount_column: profile.amount_column ?? null,
    debit_column: profile.debit_column ?? null,
    credit_column: profile.credit_column ?? null,
    type_column: profile.type_column ?? null,
    debit_type_values: profile.debit_type_values ?? [],
    credit_type_values: profile.credit_type_values ?? [],
    balance_column: profile.balance_column ?? null,
    reference_column: profile.reference_column ?? null,
    invert_sign: profile.invert_sign ?? false,
  };
}

async function accountLabels(ids: readonly string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await db.execute<{ id: string; code: string; name: string }>(sql`
    select id, code, name from accounts where id in (${sql.join(
      unique.map((id) => sql`${id}::uuid`),
      sql`, `,
    )})`);
  return new Map(rows.map((row) => [row.id, `${row.code} ${row.name}`]));
}

async function previewView(preview: ImportPreview): Promise<ImportPreviewView> {
  const labels = await accountLabels(
    preview.rows.flatMap((row) => (row.suggestion?.accountId ? [row.suggestion.accountId] : [])),
  );
  const headers = Object.keys(preview.rows[0]?.raw ?? {});
  return {
    batchId: preview.batchId,
    bankAccountId: preview.bankAccountId,
    bankAccountName: preview.bankAccountName,
    bankAccountMask: preview.bankAccountMask,
    importerId: preview.importerId,
    importerLabel: preview.importerLabel,
    detectionConfidence: preview.detection.confidence,
    detectionReasons: [...preview.detection.reasons],
    filename: preview.filename,
    profileId: preview.profileId,
    profileName: preview.profileName,
    mapping: mappingView(preview.columnMapping),
    baseMapping: preview.columnMapping,
    headers,
    profileConfirmationRequired: preview.profileConfirmationRequired,
    mappingEditable: preview.importerId === GENERIC_IMPORTER_ID,
    decisionsRequired: [...preview.decisionsRequired],
    counts: { ...preview.counts },
    dateRange: preview.dateRange === null ? null : { ...preview.dateRange },
    totals: { ...preview.totals },
    balanceChain:
      preview.balanceChain === null
        ? null
        : {
            ok: preview.balanceChain.ok,
            checked: preview.balanceChain.checked,
            openingBalanceCents: preview.balanceChain.openingBalanceCents,
            closingBalanceCents: preview.balanceChain.closingBalanceCents,
            breaks: preview.balanceChain.breaks.map((b) => ({ ...b })),
          },
    assertions: preview.assertions.map((a) => ({
      id: a.id,
      label: a.label,
      passed: a.passed,
      severity: a.severity,
      detail: a.detail ?? null,
    })),
    issues: preview.issues.map(issueView),
    issueCounts: {
      info: preview.issueCounts.info ?? 0,
      warn: preview.issueCounts.warn ?? 0,
      error: preview.issueCounts.error ?? 0,
      fatal: preview.issueCounts.fatal ?? 0,
    },
    rows: preview.rows.map((row) => ({
      rowIndex: row.rowIndex,
      class: row.class,
      txnDate: row.txnDate,
      payee: (row.counterparty ?? '').trim() || row.description,
      reference: row.reference,
      amountCents: row.amountCents,
      balanceCents: row.balanceCents,
      proposedStatus: row.proposedStatus,
      suggestion:
        row.suggestion === null
          ? null
          : {
              accountLabel: row.suggestion.accountId === null ? null : (labels.get(row.suggestion.accountId) ?? null),
              source: row.suggestion.source,
              confidence: row.suggestion.confidence,
              autoPost: row.suggestion.autoPost,
            },
      decisionRequired: row.decisionRequired,
    })),
    priorImport:
      preview.priorImport === null
        ? null
        : {
            filename: preview.priorImport.filename,
            importedAt: preview.priorImport.importedAt,
            importedCount: preview.priorImport.importedCount,
          },
    blocked: preview.blocked,
    partial: preview.header.partial,
  };
}

/** Largest statement the upload accepts; server actions refuse bodies over 1 MB. */
const MAX_FILE_BYTES = 950 * 1024;

function readUpload(form: FormData): { file: File } | { error: string } {
  const file = form.get('file');
  if (!(file instanceof File) || file.size === 0) return { error: 'Choose a statement file to import.' };
  if (file.size > MAX_FILE_BYTES) {
    return { error: 'That file is larger than 950 KB. Export a shorter date range and import it in parts.' };
  }
  return { file };
}

/** Reads a statement and shows what it would do. Writes only the batch recording the attempt. */
export async function previewStatement(form: FormData): Promise<ActionResult<ImportPreviewView>> {
  try {
    const user = await requireCapability('bank.import');
    const upload = readUpload(form);
    if ('error' in upload) return invalid(upload.error);
    const bankAccountId = String(form.get('bankAccountId') ?? '');
    if (!UUID.test(bankAccountId)) return invalid('Choose the bank account this statement belongs to.');
    const profileId = String(form.get('profileId') ?? '');
    const previous = String(form.get('previousBatchId') ?? '');
    if (UUID.test(previous)) await cancelPreview(previous, user.id);

    const preview = await previewImport({
      bankAccountId,
      filename: upload.file.name,
      bytes: new Uint8Array(await upload.file.arrayBuffer()),
      userId: user.id,
      ...(UUID.test(profileId) ? { profileId } : {}),
    });
    return ok(await previewView(preview));
  } catch (error) {
    return fail(error);
  }
}

/** Saves a confirmed or corrected column mapping as the account's own. */
export async function saveStatementMapping(
  bankAccountId: string,
  base: ImportProfile,
  mapping: MappingView,
  profileId: string | null,
): Promise<ActionResult<{ profileId: string; name: string }>> {
  try {
    const user = await requireCapability('bank.import');
    if (!UUID.test(bankAccountId)) return invalid('Choose the bank account this mapping is for.');
    const blank = (value: string | null): string | null => (value === null || value.trim() === '' ? null : value);
    const profile: ImportProfile = {
      ...base,
      name: mapping.name.trim() === '' ? base.name : mapping.name.trim(),
      date_column: mapping.date_column,
      date_format: blank(mapping.date_format),
      description_columns: mapping.description_columns.filter((column) => column.trim() !== ''),
      counterparty_column: blank(mapping.counterparty_column),
      mode: mapping.mode,
      amount_column: blank(mapping.amount_column),
      debit_column: blank(mapping.debit_column),
      credit_column: blank(mapping.credit_column),
      type_column: blank(mapping.type_column),
      debit_type_values: mapping.debit_type_values.filter((value) => value.trim() !== ''),
      credit_type_values: mapping.credit_type_values.filter((value) => value.trim() !== ''),
      balance_column: blank(mapping.balance_column),
      reference_column: blank(mapping.reference_column),
      invert_sign: mapping.invert_sign,
    };
    const saved = await saveImportProfile(
      {
        bankAccountId,
        profile,
        ...(profileId !== null && UUID.test(profileId) ? { profileId } : {}),
      },
      { userId: user.id },
    );
    return ok({ profileId: saved.id, name: saved.name });
  } catch (error) {
    return fail(error);
  }
}

function toDecision(view: ImportDecisionView): ImportDecision {
  switch (view.choice) {
    case 'skip':
      return { rowIndex: view.rowIndex, action: 'skip' };
    case 'exclude':
      return { rowIndex: view.rowIndex, status: 'excluded' };
    case 'review':
      return { rowIndex: view.rowIndex, status: 'unreviewed' };
  }
}

/** Writes the previewed rows. Nothing posts: every row lands in the review queue. */
export async function commitStatement(form: FormData): Promise<ActionResult<ImportCommitView>> {
  try {
    const user = await requireCapability('bank.import');
    const batchId = String(form.get('batchId') ?? '');
    if (!UUID.test(batchId)) return invalid('That import is no longer available. Preview the file again.');
    const upload = readUpload(form);
    if ('error' in upload) return invalid(upload.error);
    let decisions: ImportDecisionView[] = [];
    const rawDecisions = form.get('decisions');
    if (typeof rawDecisions === 'string' && rawDecisions !== '') {
      const parsed: unknown = JSON.parse(rawDecisions);
      if (!Array.isArray(parsed)) return invalid('The row decisions could not be read.');
      decisions = parsed.filter(
        (item): item is ImportDecisionView =>
          typeof item === 'object' &&
          item !== null &&
          Number.isSafeInteger((item as ImportDecisionView).rowIndex) &&
          ['exclude', 'skip', 'review'].includes((item as ImportDecisionView).choice),
      );
    }

    const result = await commitImport({
      batchId,
      userId: user.id,
      bytes: new Uint8Array(await upload.file.arrayBuffer()),
      decisions: decisions.map(toDecision),
    });
    refreshBanking();
    revalidatePath('/banking/import');
    return ok({
      inserted: result.inserted,
      duplicates: result.duplicates,
      skipped: result.skipped,
      conflicts: result.conflicts,
      transferPairsLinked: result.transferPairsLinked,
      returnedPairsLinked: result.returnedPairsLinked,
      issues: result.issues.map(issueView),
      ai:
        result.ai === null
          ? null
          : {
              attempted: result.ai.attempted,
              written: result.ai.written,
              discarded: result.ai.discarded,
              unanswered: result.ai.unanswered,
              modelId: result.ai.modelId,
              failures: [...result.ai.failures],
              skippedReason: result.ai.skippedReason,
            },
    });
  } catch (error) {
    return fail(error);
  }
}

export async function cancelStatement(batchId: string): Promise<ActionResult<{ batchId: string }>> {
  try {
    const user = await requireCapability('bank.import');
    if (!UUID.test(batchId)) return invalid('That import is no longer available.');
    await cancelPreview(batchId, user.id);
    return ok({ batchId });
  } catch (error) {
    return fail(error);
  }
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

function summaryView(summary: ReconciliationSummary): ReconSummaryView {
  return {
    id: summary.id,
    status: summary.status,
    statementStartDate: summary.statementStartDate,
    statementDate: summary.statementDate,
    openingBalanceCents: summary.openingBalanceCents,
    closingBalanceCents: summary.closingBalanceCents,
    previouslyClearedCents: summary.previouslyClearedCents,
    clearedThisPeriodCents: summary.clearedThisPeriodCents,
    clearedCount: summary.clearedCount,
    clearedBalanceCents: summary.clearedBalanceCents,
    differenceCents: summary.differenceCents,
    openingDifferenceCents: summary.openingDifferenceCents,
  };
}

function refreshReconcile(): void {
  revalidatePath('/banking/reconcile');
  revalidatePath('/banking');
}

export interface StartReconInput {
  bankAccountId: string;
  statementStartDate: string;
  statementDate: string;
  openingBalanceCents: number;
  closingBalanceCents: number;
  autoClear: boolean;
}

export async function startStatementReconciliation(input: StartReconInput): Promise<ActionResult<ReconSummaryView>> {
  try {
    const user = await requireCapability('bank.approve');
    if (!UUID.test(input.bankAccountId)) return invalid('Choose a bank account.');
    if (!isCalendarDate(input.statementStartDate) || !isCalendarDate(input.statementDate)) {
      return invalid('Enter the statement dates.');
    }
    const summary = await startReconciliation(
      {
        bankAccountId: input.bankAccountId,
        statementStartDate: input.statementStartDate,
        statementDate: input.statementDate,
        openingBalanceCents: input.openingBalanceCents,
        closingBalanceCents: input.closingBalanceCents,
        autoClear: input.autoClear,
      },
      { userId: user.id },
    );
    refreshReconcile();
    return ok(summaryView(summary));
  } catch (error) {
    return fail(error);
  }
}

export async function setLineCleared(
  reconciliationId: string,
  journalLineId: string,
  cleared: boolean,
): Promise<ActionResult<ReconSummaryView>> {
  try {
    const user = await requireCapability('bank.approve');
    if (!UUID.test(reconciliationId) || !UUID.test(journalLineId)) return invalid('That line is not valid.');
    const summary = await toggleCleared({ reconciliationId, journalLineId, cleared }, { userId: user.id });
    refreshReconcile();
    return ok(summaryView(summary));
  } catch (error) {
    return fail(error);
  }
}

export async function completeStatementReconciliation(reconciliationId: string): Promise<ActionResult<ReconSummaryView>> {
  try {
    const user = await requireCapability('bank.approve');
    if (!UUID.test(reconciliationId)) return invalid('That reconciliation is not valid.');
    const summary = await completeReconciliation(reconciliationId, { userId: user.id });
    refreshReconcile();
    refreshBanking();
    return ok(summaryView(summary));
  } catch (error) {
    return fail(error);
  }
}

export async function undoStatementReconciliation(reconciliationId: string): Promise<ActionResult<ReconSummaryView>> {
  try {
    const user = await requireCapability('bank.approve');
    if (!UUID.test(reconciliationId)) return invalid('That reconciliation is not valid.');
    const summary = await undoReconciliation(reconciliationId, { userId: user.id });
    refreshReconcile();
    refreshBanking();
    return ok(summaryView(summary));
  } catch (error) {
    return fail(error);
  }
}

export async function abandonStatementReconciliation(reconciliationId: string): Promise<ActionResult<{ id: string }>> {
  try {
    const user = await requireCapability('bank.approve');
    if (!UUID.test(reconciliationId)) return invalid('That reconciliation is not valid.');
    await abandonReconciliation(reconciliationId, { userId: user.id });
    refreshReconcile();
    return ok({ id: reconciliationId });
  } catch (error) {
    return fail(error);
  }
}
